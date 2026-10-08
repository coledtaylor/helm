import { describe, expect, it } from 'vitest'
import {
  agentServerName,
  agentToolName,
  MANIFEST_LIMITS,
  normalizeEntry,
  originMatches,
  parseOrigin,
  placeholders,
  validateManifest,
  type ManifestResult,
  type NormalizedManifest
} from '../src/manifest.js'
import { MINIMAL, SAMPLE, TEMPLATE } from './fixtures'

/**
 * The validator Helm runs on every plugin it loads and `helm-plugin validate`
 * runs on every plugin somebody builds. What it accepts is what Helm will
 * load; what it says when it refuses is what the author reads.
 */


function accepted(result: ManifestResult): NormalizedManifest {
  if (!result.ok) throw new Error(`refused: ${result.errors.join('; ')}`)
  return result.manifest
}

/** The errors for `MINIMAL` with `patch` over it. */
function errorsFor(patch: Record<string, unknown>): string[] {
  const result = validateManifest({ ...MINIMAL, ...patch })
  return result.ok ? [] : result.errors
}

describe('validateManifest - plugins that ship', () => {
  it('accepts the sample plugin, the fixture every test drives, with nothing to warn about', () => {
    const result = validateManifest(SAMPLE)
    expect(result.warnings).toEqual([])
    const manifest = accepted(result)
    expect(manifest.id).toBe('sample')
    expect(manifest.service).toEqual({ kind: 'node', command: 'service/main.mjs', args: [], env: {}, start: 'demand' })
    expect(manifest.exec['echo']).toEqual({ command: 'node', args: ['programs/echo.mjs'], env: { SAMPLE_TOKEN: '{{sample-token}}' } })
    expect(manifest.network.map((pattern) => pattern.origin)).toEqual(['http://127.0.0.1:4790'])
  })

  it('accepts the template `helm-plugin create` writes, with nothing to warn about', () => {
    const result = validateManifest(TEMPLATE)
    expect(result.warnings).toEqual([])
    expect(accepted(result).commands).toEqual([{ id: 'open', title: 'Open a tab', tab: 'page' }])
  })
})

describe('validateManifest - what a manifest leaves out', () => {
  it('fills every optional part in, so nothing downstream asks whether it is there', () => {
    expect(accepted(validateManifest(MINIMAL))).toEqual({
      apiVersion: 1,
      id: 'minimal',
      name: 'Minimal',
      version: null,
      description: null,
      icon: null,
      rail: null,
      panels: {},
      tabs: {},
      pageStrip: false,
      background: null,
      commands: [],
      settings: [],
      network: [],
      secrets: [],
      exec: {},
      service: null,
      agent: null,
      sessions: { start: false, list: false }
    })
  })

  it('writes every path one way and every origin canonically', () => {
    const manifest = accepted(
      validateManifest({
        ...MINIMAL,
        name: '  Spaced  ',
        icon: './art\\icon.SVG',
        tabs: { run: { title: 'Run', entry: 'dist//tabs/./run.html' } },
        network: ['HTTPS://API.Example.com:443/', 'http://127.0.0.1:8080', 'https://api.example.com'],
        exec: { git: 'git' },
        service: { command: 'srv', start: 'enable' }
      })
    )
    expect(manifest.name).toBe('Spaced')
    expect(manifest.icon).toBe('art/icon.SVG')
    expect(manifest.tabs['run']?.entry).toBe('dist/tabs/run.html')
    // The duplicate spelled differently is one origin.
    expect(manifest.network.map((pattern) => pattern.origin)).toEqual(['https://api.example.com', 'http://127.0.0.1:8080'])
    expect(manifest.exec['git']).toEqual({ command: 'git', args: [], env: {} })
    expect(manifest.service).toEqual({ kind: 'command', command: 'srv', args: [], env: {}, start: 'enable' })
  })

  it('gathers the tabs into one page strip only when asked, and says when there are no tabs to gather', () => {
    const tabs = { run: { title: 'Run', entry: 'run.html' } }
    const strip = validateManifest({ ...MINIMAL, tabs, pageStrip: true })
    expect(accepted(strip).pageStrip).toBe(true)
    expect(strip.warnings).toEqual([])
    expect(accepted(validateManifest({ ...MINIMAL, tabs, pageStrip: false })).pageStrip).toBe(false)

    expect(validateManifest({ ...MINIMAL, pageStrip: true }).warnings).toEqual([
      'pageStrip has no tabs to hold: it gathers the tabs the manifest declares, and this one declares none'
    ])
    expect(errorsFor({ ...MINIMAL, tabs, pageStrip: 'yes' })).toEqual(['pageStrip must be true or false'])
  })

  it('gives its pages what sessions lists and nothing more, and says when it has no page to ask from', () => {
    const panels = { main: { title: 'Main', entry: 'main.html' } }
    const both = validateManifest({ ...MINIMAL, panels, sessions: ['start', 'list'] })
    expect(accepted(both).sessions).toEqual({ start: true, list: true })
    expect(both.warnings).toEqual([])
    expect(accepted(validateManifest({ ...MINIMAL, panels, sessions: ['list'] })).sessions).toEqual({ start: false, list: true })
    expect(accepted(validateManifest({ ...MINIMAL, panels, sessions: [] })).sessions).toEqual({ start: false, list: false })

    // Seeing the list needs no page of its own: the background page may read it.
    expect(validateManifest({ ...MINIMAL, sessions: ['list'] }).warnings).toEqual([])
    expect(validateManifest({ ...MINIMAL, sessions: ['start'] }).warnings).toEqual([
      'sessions "start" needs a panel or a tab: only a click in one of its pages can ask for a session, and this manifest declares neither'
    ])
    const shape = 'sessions must be a list of "start" and "list"'
    expect(errorsFor({ ...MINIMAL, panels, sessions: true })).toEqual([shape])
    expect(errorsFor({ ...MINIMAL, panels, sessions: ['start', 'stop'] })).toEqual([shape])
    expect(errorsFor({ ...MINIMAL, panels, sessions: ['list', 'list'] })).toEqual(['sessions lists the same thing twice'])
  })

  it('starts a service on demand unless it says otherwise, and takes null for none', () => {
    expect(accepted(validateManifest({ ...MINIMAL, service: { node: 'srv.mjs' } })).service?.start).toBe('demand')
    expect(accepted(validateManifest({ ...MINIMAL, service: null })).service).toBeNull()
  })
})

describe('validateManifest - apiVersion', () => {
  it('says an unsupported version first and alone: a newer plugin fails everything else for reasons not its own', () => {
    const result = validateManifest({ apiVersion: 2, id: 'NOT VALID', name: '', panels: 'nope' })
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.errors).toEqual(['apiVersion 2 is not supported by this Helm, which supports 1'])
  })

  it('says a missing version, and a version that is not a number', () => {
    expect(validateManifest({ id: 'x', name: 'X' })).toMatchObject({ ok: false, errors: ['apiVersion is missing; this Helm supports 1'] })
    expect(validateManifest({ apiVersion: '1', id: 'x', name: 'X' })).toMatchObject({
      ok: false,
      errors: ['apiVersion "1" is not supported by this Helm, which supports 1']
    })
  })

  it('refuses anything that is not an object', () => {
    for (const value of [null, [], 'helm', 1]) {
      expect(validateManifest(value)).toMatchObject({ ok: false, errors: ['helm-plugin.json must be a JSON object'] })
    }
  })
})

describe('validateManifest - unknown fields', () => {
  it('warns about a field it does not know and still loads the plugin', () => {
    const result = validateManifest({ ...MINIMAL, $schema: './schema.json', tab: {}, colour: 'red' })
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([
      '"tab" is not a manifest field and is ignored',
      '"colour" is not a manifest field and is ignored'
    ])
  })
})

describe('validateManifest - every problem, in one pass', () => {
  it('reports all of them rather than the first', () => {
    const errors = errorsFor({ id: 'Bad Id', name: '', icon: 'icon.gif', network: ['ftp://x.example'] })
    expect(errors).toHaveLength(4)
  })

  it.each([
    ['an id that is not lower-case letters, digits and dashes', { id: 'My_Plugin' }, 'id must be 1-63'],
    ['an id too long', { id: 'a'.repeat(64) }, 'id must be 1-63'],
    ['no name', { name: undefined }, 'name must be a non-empty string'],
    ['a blank name', { name: '   ' }, 'name must be a non-empty string'],
    ['a name too long', { name: 'x'.repeat(61) }, 'name must be at most 60 characters'],
    ['an icon that is not svg or png', { icon: 'icon.gif' }, 'icon must be a .svg or .png file'],
    ['a page outside the folder', { tabs: { a: { title: 'A', entry: '../a.html' } } }, 'must be a relative path that stays inside'],
    ['a page by absolute path', { tabs: { a: { title: 'A', entry: 'C:\\a.html' } } }, 'must be a relative path that stays inside'],
    ['a page under Helm runtime prefix', { tabs: { a: { title: 'A', entry: './__helm/a.html' } } }, 'may not be under __helm/'],
    ['a page that is not html', { tabs: { a: { title: 'A', entry: 'a.js' } } }, 'must be a .html file'],
    ['a surface key that is not a name', { panels: { Main: { title: 'M', entry: 'm.html' } } }, 'panels key "Main"'],
    [
      'an action icon Helm does not have',
      { panels: { main: { title: 'M', entry: 'm.html', actions: [{ id: 'go', title: 'Go', icon: 'rocket' }] } } },
      'icon must be one of refresh'
    ],
    [
      'too many actions',
      {
        panels: {
          main: {
            title: 'M',
            entry: 'm.html',
            actions: Array.from({ length: MANIFEST_LIMITS.actions + 1 }, (_, n) => ({ id: `a${String(n)}`, title: 'A', icon: 'plus' }))
          }
        }
      },
      'actions may hold at most 5'
    ],
    ['a rail naming no panel', { rail: { title: 'R', panel: 'missing' } }, 'rail.panel must name one of the panels - "missing" is not one'],
    [
      'a command naming no tab',
      { background: 'bg.html', commands: [{ id: 'go', title: 'Go', tab: 'missing' }] },
      'commands[0].tab must name one of the tabs'
    ],
    ['a command nothing can receive', { commands: [{ id: 'go', title: 'Go' }] }, 'needs a background page or a rail panel'],
    [
      'a command id used twice',
      { background: 'bg.html', commands: [{ id: 'go', title: 'Go' }, { id: 'go', title: 'Again' }] },
      'commands[1].id "go" is used twice'
    ],
    ['a setting type Helm does not draw', { settings: [{ key: 'a', label: 'A', type: 'colour' }] }, 'type must be one of text'],
    ['a setting key used twice', { settings: [{ key: 'a', label: 'A', type: 'toggle' }, { key: 'a', label: 'B', type: 'toggle' }] }, 'is used twice'],
    ['a select with no options', { settings: [{ key: 'a', label: 'A', type: 'select', options: [] }] }, 'options must be a non-empty array'],
    [
      'a select default that is not an option',
      { settings: [{ key: 'a', label: 'A', type: 'select', options: [{ value: 'x', label: 'X' }], default: 'y' }] },
      "default must be one of the options' values"
    ],
    ['a number default outside its bounds', { settings: [{ key: 'a', label: 'A', type: 'number', min: 1, max: 5, default: 9 }] }, 'default is outside min and max'],
    ['a number whose min is above its max', { settings: [{ key: 'a', label: 'A', type: 'number', min: 5, max: 1 }] }, 'min is above'],
    ['a toggle default that is not a boolean', { settings: [{ key: 'a', label: 'A', type: 'toggle', default: 'yes' }] }, 'default must be true or false'],
    ['a secret setting for an undeclared key', { settings: [{ key: 'a', label: 'A', type: 'secret', secret: 'token' }] }, 'secret must name a key from secrets'],
    ['a secret key with spaces', { secrets: ['my token'] }, 'secrets[0] must be letters'],
    ['a secret key listed twice', { secrets: ['token', 'token'] }, 'secrets lists "token" twice'],
    ['an origin with a path', { network: ['https://api.example.com/v1'] }, 'network[0] must be an origin'],
    ['an origin on another scheme', { network: ['ftp://files.example.com'] }, 'network[0] must be an origin'],
    ['a wildcard over an address', { network: ['https://*.127.0.0.1'] }, 'network[0] must be an origin'],
    ['a wildcard over a bare host', { network: ['https://*.localhost'] }, 'network[0] must be an origin'],
    ['a port out of range', { network: ['http://127.0.0.1:70000'] }, 'network[0] must be an origin'],
    ['a program with leading space', { exec: { git: ' git' } }, 'exec.git must be a program name or path'],
    ['program arguments that are not strings', { exec: { git: { command: 'git', args: ['log', 3] } } }, 'exec.git.args must be an array of strings'],
    ['an environment name that is not one', { exec: { git: { command: 'git', env: { 'BAD-NAME': 'x' } } } }, 'is not an environment variable name'],
    ['an undeclared secret in an environment', { exec: { git: { command: 'git', env: { TOKEN: '{{token}}' } } } }, 'exec.git.env.TOKEN uses {{token}}, which secrets does not declare'],
    ['a service with both command and node', { service: { command: 'srv', node: 'srv.mjs' } }, 'service must have exactly one of command and node'],
    ['a service with neither', { service: {} }, 'service must have exactly one of command and node'],
    ['a node service that is not a script', { service: { node: 'srv.py' } }, 'service.node must be a .js or .mjs or .cjs file'],
    ['a service start Helm does not know', { service: { node: 'srv.mjs', start: 'boot' } }, 'service.start must be "enable" or "demand"']
  ])('refuses %s', (_what, patch, message) => {
    const errors = errorsFor(patch)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join('\n')).toContain(message)
  })
})

describe('validateManifest - tools for sessions', () => {
  const tool = { description: 'Lists the things.' }

  it('reads the tools in the order the manifest lists them, with an empty object schema where it wrote none', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
    const manifest = accepted(
      validateManifest({
        ...MINIMAL,
        background: 'bg.html',
        agent: {
          instructions: '  Use these for the list.  ',
          tools: { list_things: tool, 'add-thing': { description: 'Adds one.', inputSchema: schema } }
        }
      })
    )
    expect(manifest.agent).toEqual({
      instructions: 'Use these for the list.',
      tools: [
        { name: 'list_things', description: 'Lists the things.', inputSchema: { type: 'object', properties: {} } },
        { name: 'add-thing', description: 'Adds one.', inputSchema: schema }
      ]
    })
  })

  it('names the server and every tool the way a session sees them', () => {
    expect(agentServerName('sample')).toBe('helm-plugin-sample')
    expect(agentToolName('sample', 'list_items')).toBe('mcp__helm-plugin-sample__list_items')
  })

  it('takes no instructions as none', () => {
    const manifest = accepted(validateManifest({ ...MINIMAL, background: 'bg.html', agent: { tools: { go: tool } } }))
    expect(manifest.agent?.instructions).toBeNull()
  })

  it.each([
    ['an agent that is not an object', { background: 'bg.html', agent: [] }, 'agent must be an object'],
    ['no tools', { background: 'bg.html', agent: { instructions: 'x' } }, 'agent.tools must be an object with at least one tool'],
    ['an empty tools object', { background: 'bg.html', agent: { tools: {} } }, 'agent.tools must be an object with at least one tool'],
    ['tools with no background page to answer them', { agent: { tools: { go: tool } } }, 'needs a background'],
    ['a tool name with capitals', { background: 'bg.html', agent: { tools: { ListThings: tool } } }, 'agent.tools key "ListThings"'],
    ['a tool name starting with a digit', { background: 'bg.html', agent: { tools: { '1go': tool } } }, 'agent.tools key "1go"'],
    ['a tool with no description', { background: 'bg.html', agent: { tools: { go: {} } } }, 'agent.tools.go.description must be a non-empty string'],
    ['a tool that is not an object', { background: 'bg.html', agent: { tools: { go: 'Lists.' } } }, 'agent.tools.go must be an object'],
    [
      'a description too long',
      { background: 'bg.html', agent: { tools: { go: { description: 'd'.repeat(2001) } } } },
      'agent.tools.go.description must be at most 2000 characters'
    ],
    ['instructions too long', { background: 'bg.html', agent: { instructions: 'i'.repeat(2001), tools: { go: tool } } }, 'at most 2000'],
    [
      'an input schema that is not an object schema',
      { background: 'bg.html', agent: { tools: { go: { ...tool, inputSchema: { type: 'string' } } } } },
      'agent.tools.go.inputSchema must be a JSON Schema whose type is "object"'
    ],
    [
      'an input schema too large',
      { background: 'bg.html', agent: { tools: { go: { ...tool, inputSchema: { type: 'object', description: 'x'.repeat(17_000) } } } } },
      'agent.tools.go.inputSchema must be at most 16 KB'
    ],
    [
      'more tools than a session should be handed',
      {
        background: 'bg.html',
        agent: { tools: Object.fromEntries(Array.from({ length: MANIFEST_LIMITS.tools + 1 }, (_, n) => [`t${String(n)}`, tool])) }
      },
      'agent.tools may hold at most 50'
    ],
    [
      'a name a session would be handed past 64 characters',
      { id: 'a-plugin-with-a-rather-long-id', background: 'bg.html', agent: { tools: { list_every_single_thing: tool } } },
      'a session sees it as mcp__helm-plugin-a-plugin-with-a-rather-long-id__list_every_single_thing, which is 72 characters'
    ]
  ])('refuses %s', (_what, patch, message) => {
    const errors = errorsFor(patch)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join('\n')).toContain(message)
  })
})

describe('the helpers Helm uses on what the validator accepted', () => {
  it('finds every placeholder, repeats kept', () => {
    expect(placeholders('Bearer {{token}} and {{token}} {{a.b-c_d}} {{ not }} {{}}')).toEqual(['token', 'token', 'a.b-c_d'])
  })

  it('reads an origin, and matches a wildcard against subdomains only', () => {
    const wildcard = parseOrigin('https://*.example.com')
    expect(wildcard).toMatchObject({ host: 'example.com', wildcard: true, port: 443, origin: 'https://*.example.com' })
    if (wildcard === null) throw new Error('unreachable')
    expect(originMatches(wildcard, new URL('https://api.example.com/x'))).toBe(true)
    expect(originMatches(wildcard, new URL('https://example.com/x'))).toBe(false)
    expect(originMatches(wildcard, new URL('http://api.example.com/x'))).toBe(false)
    expect(originMatches(wildcard, new URL('https://api.example.com:8443/x'))).toBe(false)
    const local = parseOrigin(' http://127.0.0.1:4790/ ')
    expect(local?.origin).toBe('http://127.0.0.1:4790')
  })

  it('writes a path in one spelling, or refuses it', () => {
    expect(normalizeEntry('./dist\\a//b.html')).toBe('dist/a/b.html')
    expect(normalizeEntry('a/../b.html')).toBeNull()
    expect(normalizeEntry('/abs.html')).toBeNull()
    expect(normalizeEntry('C:x.html')).toBeNull()
    expect(normalizeEntry(' a.html')).toBeNull()
    expect(normalizeEntry('./')).toBeNull()
  })
})
