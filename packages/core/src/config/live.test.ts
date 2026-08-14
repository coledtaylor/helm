import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConfigFile, EffectiveView } from '../types'
import { computeEffectiveView } from './effective'
import {
  computeConfigLive,
  configFileNote,
  hookBindings,
  isRedactedConfigFile,
  settingsDeclaredBy
} from './live'
import { projectConfigScope, readConfigTree, userConfigScope } from './tree'

/**
 * The join between a tree and a resolution, against real directories.
 *
 * Both halves are computed by the code that computes them in the app -
 * `readConfigTree` and `computeEffectiveView` - because the thing under test is
 * the *join*, and feeding it a hand-built view would be testing it against a
 * shape rather than against an answer. The expectations are written from the
 * fixture files below, by hand, which is where the second opinion comes from.
 */

let root: string
let home: string
let project: string

function write(base: string, relPath: string, content: string): string {
  const path = join(base, relPath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

function skill(base: string, name: string, body = 'Ponder.'): string {
  return write(
    base,
    `.claude/skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: ${body}\n---\n\n# ${name}\n`
  )
}

/** The user scope *is* `.claude`, so its skills sit one level higher. */
function userSkill(name: string, body = 'Ponder.'): string {
  return write(home, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${body}\n---\n`)
}

/** The tree and the resolution the console shows side by side. */
function resolve(scopePath: string, opts: { user?: boolean; overlays?: string[] } = {}): {
  files: Map<string, ConfigFile>
  view: EffectiveView
} {
  const scope = opts.user === true ? userConfigScope(scopePath) : projectConfigScope(scopePath)
  const tree = readConfigTree(scope)
  const view = computeEffectiveView({
    cwd: project,
    userHome: home,
    ...(opts.overlays ? { overlays: opts.overlays } : {})
  })
  return { files: new Map(tree.files.map((file) => [file.relPath, file])), view }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-live-'))
  home = join(root, 'home')
  project = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('computeConfigLive: settings', () => {
  it('says which of a file’s keys are outranked, and by which layer', () => {
    write(
      project,
      '.claude/settings.json',
      JSON.stringify({ model: 'sonnet', env: { A: 'from-project' } })
    )
    write(project, '.claude/settings.local.json', JSON.stringify({ model: 'opus' }))

    const { files, view } = resolve(project)
    const settings = files.get('.claude/settings.json')
    const local = files.get('.claude/settings.local.json')
    expect(settings).toBeDefined()
    expect(local).toBeDefined()

    // The project file sets two leaves; the local file overrides one of them.
    const live = computeConfigLive(settings as ConfigFile, view)
    expect(live?.state).toBe('partial')
    expect(live?.note).toContain('1 of 2')
    expect(live?.note).toContain('local')

    const rows = live?.settings ?? []
    expect(rows.map((row) => row.key).sort()).toEqual(['env.A', 'model'])
    expect(rows.find((row) => row.key === 'env.A')?.wins).toBe(true)
    const model = rows.find((row) => row.key === 'model')
    expect(model?.wins).toBe(false)
    expect(model?.value).toBe('"sonnet"')
    expect(model?.outrankedBy?.layer).toBe('local')
    expect(model?.outrankedBy?.value).toBe('"opus"')

    // And the file that won says so, from the same computation.
    expect(computeConfigLive(local as ConfigFile, view)?.state).toBe('live')
  })

  it('calls two layers that agree on a value live rather than shadowed', () => {
    // Agreement is not an override: nobody decided anything, and marking the
    // lower file shadowed would invent a disagreement.
    write(project, '.claude/settings.json', JSON.stringify({ model: 'opus' }))
    write(project, '.claude/settings.local.json', JSON.stringify({ model: 'opus' }))

    const { files, view } = resolve(project)
    const live = computeConfigLive(files.get('.claude/settings.json') as ConfigFile, view)
    expect(live?.state).toBe('live')
    expect(live?.settings[0]?.wins).toBe(true)
  })

  it('separates a file that says nothing from one the CLI cannot parse', () => {
    write(project, '.claude/settings.json', '{}')
    const empty = resolve(project)
    expect(computeConfigLive(empty.files.get('.claude/settings.json') as ConfigFile, empty.view)?.state).toBe(
      'inert'
    )

    write(project, '.claude/settings.json', '{ "model": "opus", }')
    const broken = resolve(project)
    const live = computeConfigLive(broken.files.get('.claude/settings.json') as ConfigFile, broken.view)
    expect(live?.state).toBe('inert')
    expect(live?.note).toBe('not valid JSON')
  })

  it('marks a settings file this resolution never reads as absent', () => {
    // The CLI reads a `settings.local.json` beside a *project's* settings, not
    // in the user directory - so the user copy is not one of the three layers.
    write(home, 'settings.local.json', JSON.stringify({ model: 'opus' }))
    const { files, view } = resolve(home, { user: true })
    const live = computeConfigLive(files.get('settings.local.json') as ConfigFile, view)
    expect(live?.state).toBe('absent')
    expect(live?.settings).toEqual([])
  })

  it('reads a file’s own keys back out of the resolution', () => {
    write(home, 'settings.json', JSON.stringify({ env: { A: '1', B: '2' } }))
    const { view } = resolve(home, { user: true })
    const rows = settingsDeclaredBy(join(home, 'settings.json'), view)
    expect(rows.map((row) => row.key)).toEqual(['env.A', 'env.B'])
    expect(rows.every((row) => row.layer === 'user')).toBe(true)
  })
})

describe('computeConfigLive: skills, commands, agents', () => {
  it('carries the invocation, namespaced when it comes from an overlay', () => {
    const overlay = join(root, 'overlay')
    skill(project, 'think')
    skill(overlay, 'review')
    write(project, '.claude/commands/spec/plan.md', '# plan\n')

    const { files, view } = resolve(project, { overlays: [overlay] })
    const think = computeConfigLive(files.get('.claude/skills/think/SKILL.md') as ConfigFile, view)
    expect(think?.state).toBe('live')
    expect(think?.invocation).toBe('think')

    const plan = computeConfigLive(files.get('.claude/commands/spec/plan.md') as ConfigFile, view)
    expect(plan?.invocation).toBe('/spec:plan')
    expect(plan?.note).toBe('available as /spec:plan')

    // The overlay's copy is addressed through the plugin name Helm assigns.
    const overlayTree = resolve(overlay, { overlays: [overlay] })
    const review = computeConfigLive(
      overlayTree.files.get('.claude/skills/review/SKILL.md') as ConfigFile,
      overlayTree.view
    )
    expect(review?.invocation).toBe('overlay:review')
    expect(review?.note).toContain('under the overlay overlay')
  })

  it('does not predict a winner when two unprefixed sources define one name', () => {
    skill(project, 'think', 'The project’s.')
    userSkill('think', 'The user’s.')

    const { files, view } = resolve(project)
    const live = computeConfigLive(files.get('.claude/skills/think/SKILL.md') as ConfigFile, view)
    expect(live?.contested).toBe(true)
    expect(live?.state).toBe('partial')
    expect(live?.alsoDefinedBy).toHaveLength(1)
    expect(live?.alsoDefinedBy[0]?.source).toBe('user')
  })

  it('does not call an overlay’s copy of a name a contest', () => {
    // The platform prefixes everything an overlay contributes, so both resolve
    // and neither hides the other. It is worth *saying* on the row, which is
    // what `alsoDefinedBy` is for, but it is not a contest.
    skill(project, 'think')
    const overlay = join(root, 'overlay')
    skill(overlay, 'think')

    const { files, view } = resolve(project, { overlays: [overlay] })
    const live = computeConfigLive(files.get('.claude/skills/think/SKILL.md') as ConfigFile, view)
    expect(live?.contested).toBe(false)
    expect(live?.state).toBe('live')
    expect(live?.alsoDefinedBy.map((entry) => entry.invocation)).toEqual(['overlay:think'])
  })

  it('marks a skill no session in this directory composes as absent', () => {
    const elsewhere = join(root, 'elsewhere')
    skill(elsewhere, 'unreachable')
    const scope = readConfigTree(projectConfigScope(elsewhere))
    const view = computeEffectiveView({ cwd: project, userHome: home })
    const file = scope.files.find((candidate) => candidate.kind === 'skill')
    expect(file).toBeDefined()
    expect(computeConfigLive(file as ConfigFile, view)?.state).toBe('absent')
  })
})

describe('computeConfigLive: instructions', () => {
  it('is live for the CLAUDE.md a session in this directory is handed', () => {
    write(project, 'CLAUDE.md', '# Project\n')
    const { files, view } = resolve(project)
    const live = computeConfigLive(files.get('CLAUDE.md') as ConfigFile, view)
    expect(live?.state).toBe('live')
    expect(live?.note).toBe('read at session start')
  })
})

describe('computeConfigLive: hooks', () => {
  const settingsWithHook = (command: string): string =>
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }]
      }
    })

  it('names the event, the matcher and the settings block that runs it', () => {
    write(project, '.claude/hooks/guard.js', 'process.exit(0)\n')
    write(project, '.claude/settings.json', settingsWithHook('node .claude/hooks/guard.js'))

    const { files, view } = resolve(project)
    const file = files.get('.claude/hooks/guard.js') as ConfigFile
    const live = computeConfigLive(file, view)
    expect(live?.state).toBe('live')
    expect(live?.note).toBe('runs on PreToolUse')

    const bindings = hookBindings(file, view)
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.event).toBe('PreToolUse')
    expect(bindings[0]?.matcher).toBe('Bash')
    expect(bindings[0]?.layer).toBe('project')
    expect(bindings[0]?.file).toBe(join(project, '.claude', 'settings.json'))
  })

  it('is inert when nothing names it, and shadowed when hooks are switched off', () => {
    write(project, '.claude/hooks/guard.js', 'process.exit(0)\n')
    const alone = resolve(project)
    const inert = computeConfigLive(alone.files.get('.claude/hooks/guard.js') as ConfigFile, alone.view)
    expect(inert?.state).toBe('inert')
    expect(inert?.hooks).toEqual([])

    write(
      project,
      '.claude/settings.json',
      JSON.stringify({
        disableAllHooks: true,
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/guard.js' }] }] }
      })
    )
    const off = resolve(project)
    const live = computeConfigLive(off.files.get('.claude/hooks/guard.js') as ConfigFile, off.view)
    expect(live?.state).toBe('shadowed')
    expect(live?.hooks[0]?.matcher).toBeNull()
  })

  it('does not claim a hook for a command that merely contains its name', () => {
    write(project, '.claude/hooks/guard.js', 'process.exit(0)\n')
    write(project, '.claude/settings.json', settingsWithHook('node .claude/hooks/my-guard.js'))
    const { files, view } = resolve(project)
    expect(hookBindings(files.get('.claude/hooks/guard.js') as ConfigFile, view)).toEqual([])
  })
})

describe('computeConfigLive: everything else', () => {
  it('finds the script a settings value runs', () => {
    write(home, 'statusline-command.js', 'module.exports = () => ""\n')
    write(
      home,
      'settings.json',
      JSON.stringify({ statusLine: { type: 'command', command: 'node ~/.claude/statusline-command.js' } })
    )
    const { files, view } = resolve(home, { user: true })
    const live = computeConfigLive(files.get('statusline-command.js') as ConfigFile, view)
    expect(live?.state).toBe('live')
    expect(live?.references[0]?.key).toBe('statusLine.command')
  })

  it('describes the CLI’s own working files and claims nothing about the rest', () => {
    write(home, 'history.jsonl', '{}\n')
    write(home, 'scratch.txt', 'notes\n')
    const { files, view } = resolve(home, { user: true })

    const history = computeConfigLive(files.get('history.jsonl') as ConfigFile, view)
    expect(history?.state).toBe('inert')
    expect(history?.note).toBe('not part of a session')
    expect(configFileNote(files.get('history.jsonl') as ConfigFile)).toContain('prompt')

    // A file Helm knows nothing about gets no claim at all rather than a
    // confident "not loaded" - the usage figures' rule.
    const unknown = computeConfigLive(files.get('scratch.txt') as ConfigFile, view)
    expect(unknown?.state).toBe('none')
    expect(unknown?.note).toBeNull()
  })

  it('names the credentials file as one Helm never opens', () => {
    expect(isRedactedConfigFile('.credentials.json')).toBe(true)
    expect(isRedactedConfigFile('settings.json')).toBe(false)
    // Not by suffix: a hook's own credentials file is not the CLI's.
    expect(isRedactedConfigFile('hooks/.credentials.json')).toBe(false)
  })

  it('says nothing at all when there is no resolution to read', () => {
    write(project, '.claude/settings.json', JSON.stringify({ model: 'opus' }))
    const { files } = resolve(project)
    expect(computeConfigLive(files.get('.claude/settings.json') as ConfigFile, null)).toBeNull()
  })
})
