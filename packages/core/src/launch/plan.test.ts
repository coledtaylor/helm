import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { cleanStaleMcpConfigs, removeSessionMcpConfig, writeSessionMcpConfig } from './mcp'
import { buildLaunchArgs, prepareLaunch } from './plan'

let root: string
let shimRoot: string

function makeProject(name: string, claudeMd?: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, '.claude', 'skills', 'think'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'skills', 'think', 'SKILL.md'), `# ${name} think\n`)
  if (claudeMd !== undefined) writeFileSync(join(dir, 'CLAUDE.md'), claudeMd)
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-plan-'))
  shimRoot = join(root, '.shims')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('buildLaunchArgs', () => {
  it('is just the name when nothing is composed', () => {
    expect(buildLaunchArgs({ root: '/x', name: 'plain' })).toEqual(['-n', 'plain'])
  })

  it('emits the flags the composition needs', () => {
    expect(
      buildLaunchArgs({
        root: '/x',
        name: 'cloud sync',
        access: ['/repos/a', '/repos/b'],
        pluginDirs: ['/shims/overlay-a'],
        memoryFile: '/shims/memory.md',
        model: 'opus',
        effort: 'high',
        permissionMode: 'auto',
        agent: 'reviewer'
      })
    ).toEqual([
      '--add-dir',
      resolve('/repos/a'),
      resolve('/repos/b'),
      '-n',
      'cloud sync',
      '--plugin-dir',
      '/shims/overlay-a',
      '--append-system-prompt-file',
      '/shims/memory.md',
      '--model',
      'opus',
      '--effort',
      'high',
      '--permission-mode',
      'auto',
      '--agent',
      'reviewer'
    ])
  })

  /**
   * `--add-dir` is variadic: it eats arguments until one starts with a dash. If
   * the opening prompt were reachable from it, `/recap` would be added as a
   * directory instead of submitted, and the session would start with neither.
   */
  it('terminates the variadic --add-dir before the opening prompt', () => {
    const argv = buildLaunchArgs({
      root: '/x',
      name: 'session',
      access: ['/repos/a'],
      openingPrompt: '/recap'
    })
    expect(argv).toEqual(['--add-dir', resolve('/repos/a'), '-n', 'session', '/recap'])
    expect(argv.indexOf('-n')).toBeGreaterThan(argv.indexOf('--add-dir'))
    expect(argv.at(-1)).toBe('/recap')
  })

  it('puts the opening prompt last, after every flag', () => {
    const argv = buildLaunchArgs({
      root: '/x',
      name: 'session',
      pluginDirs: ['/shims/a'],
      model: 'opus',
      openingPrompt: '/recap'
    })
    expect(argv.at(-1)).toBe('/recap')
  })

  it('omits an opening prompt that is only whitespace', () => {
    expect(buildLaunchArgs({ root: '/x', name: 's', openingPrompt: '   ' })).toEqual(['-n', 's'])
  })

  it('passes each access dir once, however many times it was listed', () => {
    const argv = buildLaunchArgs({
      root: '/x',
      name: 's',
      access: ['/repos/a', '/repos/a/', '/repos/A']
    })
    expect(argv.filter((a) => a !== '-n' && a !== 's' && a !== '--add-dir')).toHaveLength(1)
  })
})

describe('prepareLaunch', () => {
  it('composes two overlays into one launch', () => {
    const a = makeProject('acme', '# Acme\nPyQt5 desktop app.')
    const b = makeProject('acme-reporting', '# Reporting\ndotnet sync receiver.')

    const plan = prepareLaunch({
      root,
      name: 'cloud sync',
      overlays: [a, b],
      access: [a, b],
      shimRoot,
      model: 'opus',
      openingPrompt: '/recap'
    })

    expect(plan.cwd).toBe(resolve(root))
    expect(plan.overlays.map((o) => o.name)).toEqual(['acme', 'acme-reporting'])

    // Both shims on the argv, as separate repeated flags.
    expect(plan.argv.filter((a2) => a2 === '--plugin-dir')).toHaveLength(2)
    for (const shim of plan.overlays) expect(plan.argv).toContain(shim.dir)

    // And the composed instructions, which is the part `--add-dir` does not do.
    expect(plan.memoryFile).not.toBeNull()
    const memory = readFileSync(plan.memoryFile!, 'utf8')
    expect(memory).toContain('PyQt5 desktop app.')
    expect(memory).toContain('dotnet sync receiver.')
    expect(plan.argv).toContain('--append-system-prompt-file')
    expect(plan.warnings).toEqual([])
  })

  it('emits no memory flag when no overlay has a CLAUDE.md', () => {
    const a = makeProject('acme')
    const plan = prepareLaunch({ root, name: 's', overlays: [a], shimRoot })
    expect(plan.memoryFile).toBeNull()
    expect(plan.argv).not.toContain('--append-system-prompt-file')
    expect(plan.warnings).toContain('No overlay had a CLAUDE.md, so no project instructions were composed.')
  })

  it('skips an overlay whose directory has gone and says so', () => {
    const a = makeProject('acme', '# Acme')
    const gone = join(root, 'deleted')
    const plan = prepareLaunch({ root, name: 's', overlays: [a, gone], shimRoot })

    expect(plan.overlays.map((o) => o.name)).toEqual(['acme'])
    expect(plan.warnings.some((w) => w.includes('deleted'))).toBe(true)
  })

  it('reuses shims across launches and rebuilds when the source changed', () => {
    const a = makeProject('acme', '# Acme')
    expect(prepareLaunch({ root, name: 's', overlays: [a], shimRoot }).overlays[0]?.rebuilt).toBe(
      true
    )
    expect(prepareLaunch({ root, name: 's', overlays: [a], shimRoot }).overlays[0]?.rebuilt).toBe(
      false
    )

    writeFileSync(join(a, '.claude', 'skills', 'think', 'SKILL.md'), '# edited\n')
    expect(prepareLaunch({ root, name: 's', overlays: [a], shimRoot }).overlays[0]?.rebuilt).toBe(
      true
    )
  })

  /**
   * Two profiles can be open at once, and the second one's launch must not
   * remove the first one's plugin directory - a live session reads skills out
   * of it. Sweeping is `cleanStaleShims`, at app start.
   */
  it('leaves another profile’s shim in place', () => {
    const a = makeProject('alpha', '# A')
    const b = makeProject('beta', '# B')
    const first = prepareLaunch({ root, name: 'first', overlays: [a], shimRoot })
    prepareLaunch({ root, name: 'second', overlays: [b], shimRoot })

    expect(readFileSync(join(first.overlays[0]!.dir, '.claude-plugin', 'plugin.json'), 'utf8')).toContain(
      'alpha'
    )
  })

  /*
   * Helm's own MCP endpoint, registered per session.
   *
   * The two halves are asserted together on purpose: an argv carrying
   * `--mcp-config` and no file, or a file nothing points at, are both states
   * that would look fine from one side.
   */
  describe('the per-session MCP registration', () => {
    const server = {
      name: 'helm-browser',
      url: 'http://127.0.0.1:51234/mcp',
      headers: { Authorization: 'Bearer 0123456789abcdef' }
    }

    it('writes a file under the directory it was given and points the argv at it', () => {
      const dir = join(root, 'mcp')
      const plan = prepareLaunch({ root, name: 'with tools', shimRoot, mcp: { dir, server } })

      expect(plan.mcpConfigFile).not.toBeNull()
      expect(resolve(plan.mcpConfigFile!)).toBe(resolve(join(dir, basename(plan.mcpConfigFile!))))
      const at = plan.argv.indexOf('--mcp-config')
      expect(at).toBeGreaterThan(-1)
      expect(plan.argv[at + 1]).toBe(plan.mcpConfigFile)

      const written = JSON.parse(readFileSync(plan.mcpConfigFile!, 'utf8')) as {
        mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
      }
      expect(written.mcpServers['helm-browser']).toEqual({
        type: 'http',
        url: server.url,
        headers: server.headers
      })
    })

    it('passes no flag at all when there is nothing to register', () => {
      const plan = prepareLaunch({ root, name: 'no tools', shimRoot })
      expect(plan.mcpConfigFile).toBeNull()
      expect(plan.argv).not.toContain('--mcp-config')
    })

    it('gives two sessions two files, so releasing one cannot disarm the other', () => {
      const dir = join(root, 'mcp')
      const first = prepareLaunch({ root, name: 'one', shimRoot, mcp: { dir, server } })
      const second = prepareLaunch({ root, name: 'two', shimRoot, mcp: { dir, server } })
      expect(first.mcpConfigFile).not.toBe(second.mcpConfigFile)
    })

    /**
     * The flag lands where the CLI can read it: after `-n`, which terminates
     * the variadic `--add-dir` list, and before the positional prompt.
     */
    it('sits between the name and the opening prompt', () => {
      const dir = join(root, 'mcp')
      const plan = prepareLaunch({
        root,
        name: 'ordered',
        shimRoot,
        access: [root],
        openingPrompt: 'go',
        mcp: { dir, server }
      })
      const at = plan.argv.indexOf('--mcp-config')
      expect(at).toBeGreaterThan(plan.argv.indexOf('-n'))
      expect(at + 1).toBeLessThan(plan.argv.length - 1)
      expect(plan.argv[plan.argv.length - 1]).toBe('go')
    })
  })
})

describe('the ephemeral MCP config sweep', () => {
  const server = {
    name: 'helm-browser',
    url: 'http://127.0.0.1:51234/mcp',
    headers: { Authorization: 'Bearer 0123456789abcdef' }
  }

  it('removes what a dead process left and keeps everything else', () => {
    const dir = join(root, 'mcp')
    const mine = writeSessionMcpConfig(dir, server)
    writeFileSync(join(dir, 'mcp-999999-deadbeef.json'), '{}')
    writeFileSync(join(dir, 'mcp-424242-c0ffee.json'), '{}')
    writeFileSync(join(dir, 'not-ours.json'), '{}')

    // `999999` is gone; `424242` answers EPERM, which means alive.
    const removed = cleanStaleMcpConfigs(dir, (pid) =>
      pid === 999999 ? 'gone' : pid === 424242 ? 'alive' : 'unknown'
    )

    expect(removed.map((path) => basename(path))).toEqual(['mcp-999999-deadbeef.json'])
    // This process's own file is not stale, whatever the probe says about it.
    expect(existsSync(mine)).toBe(true)
    expect(existsSync(join(dir, 'mcp-424242-c0ffee.json'))).toBe(true)
    expect(existsSync(join(dir, 'not-ours.json'))).toBe(true)
  })

  it('leaves a file alone when the owner cannot be established', () => {
    const dir = join(root, 'mcp')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mcp-777777-abc123.json'), '{}')
    expect(cleanStaleMcpConfigs(dir, () => 'unknown')).toEqual([])
    expect(existsSync(join(dir, 'mcp-777777-abc123.json'))).toBe(true)
  })

  it('removes one by name, and says nothing about one that is already gone', () => {
    const dir = join(root, 'mcp')
    const file = writeSessionMcpConfig(dir, server)
    removeSessionMcpConfig(file)
    expect(existsSync(file)).toBe(false)
    expect(() => {
      removeSessionMcpConfig(file)
      removeSessionMcpConfig(null)
    }).not.toThrow()
  })
})
