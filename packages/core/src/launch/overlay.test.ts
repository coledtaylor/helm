import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanStaleShims,
  composeOverlayMemory,
  overlayPluginName,
  overlayPluginNames,
  planOverlays,
  syncOverlay
} from './overlay'

let root: string
let shimRoot: string

/** A repo with a `.claude/` tree, the way the fixtures in `repos/` look. */
function makeProject(
  name: string,
  opts: { skills?: string[]; agents?: string[]; commands?: string[]; claudeMd?: string } = {}
): string {
  const dir = join(root, name)
  for (const skill of opts.skills ?? []) {
    mkdirSync(join(dir, '.claude', 'skills', skill), { recursive: true })
    writeFileSync(join(dir, '.claude', 'skills', skill, 'SKILL.md'), `# ${skill}\n`)
  }
  for (const agent of opts.agents ?? []) {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'agents', `${agent}.md`), `# ${agent}\n`)
  }
  for (const command of opts.commands ?? []) {
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'commands', `${command}.md`), `# ${command}\n`)
  }
  if (opts.claudeMd !== undefined) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), opts.claudeMd)
  }
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-overlay-'))
  shimRoot = join(root, '.shims')
  mkdirSync(shimRoot, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('overlayPluginName', () => {
  it('uses the repo name, which is what skills get prefixed with', () => {
    expect(overlayPluginName('C:/repos/atlas')).toBe('atlas')
    expect(overlayPluginName('/home/x/repos/atlas-reporting')).toBe('atlas-reporting')
  })

  it('reduces to something a namespace can carry', () => {
    expect(overlayPluginName('/repos/atlas Project')).toBe('atlas-project')
    expect(overlayPluginName('/repos/my repo!!')).toBe('my-repo')
  })

  it('falls back rather than producing an empty prefix', () => {
    expect(overlayPluginName('/repos/!!!')).toBe('overlay')
  })

  it('distinguishes same-named repos from different harnesses', () => {
    expect(overlayPluginNames(['/a/repos/atlas', '/b/repos/atlas'])).toEqual([
      'atlas',
      'atlas-2'
    ])
  })
})

describe('syncOverlay', () => {
  it('builds a plugin the CLI can load: manifest plus the convention dirs', () => {
    const project = makeProject('atlas', { skills: ['think'], agents: ['reviewer'] })
    const [plan] = planOverlays([project], shimRoot)
    const shim = syncOverlay(plan!)

    expect(shim.name).toBe('atlas')
    expect(shim.rebuilt).toBe(true)
    expect(shim.linked.sort()).toEqual(['agents', 'skills'])

    const manifest: unknown = JSON.parse(
      readFileSync(join(shim.dir, '.claude-plugin', 'plugin.json'), 'utf8')
    )
    expect(manifest).toMatchObject({ name: 'atlas' })
    // Read through the link, which is the thing that has to work.
    expect(readFileSync(join(shim.dir, 'skills', 'think', 'SKILL.md'), 'utf8')).toBe('# think\n')
  })

  it('only links the convention dirs the source actually has', () => {
    const project = makeProject('bare', { skills: ['one'] })
    const [plan] = planOverlays([project], shimRoot)
    expect(syncOverlay(plan!).linked).toEqual(['skills'])
    expect(existsSync(join(shimRoot, 'overlay-bare', 'agents'))).toBe(false)
  })

  it('reuses an unchanged shim instead of rebuilding it', () => {
    const project = makeProject('atlas', { skills: ['think'] })
    const [plan] = planOverlays([project], shimRoot)
    expect(syncOverlay(plan!).rebuilt).toBe(true)

    const [again] = planOverlays([project], shimRoot)
    expect(syncOverlay(again!).rebuilt).toBe(false)
  })

  it('rebuilds when the source .claude tree changes', () => {
    const project = makeProject('atlas', { skills: ['think'] })
    syncOverlay(planOverlays([project], shimRoot)[0]!)

    mkdirSync(join(project, '.claude', 'skills', 'newer'), { recursive: true })
    writeFileSync(join(project, '.claude', 'skills', 'newer', 'SKILL.md'), '# newer\n')

    expect(syncOverlay(planOverlays([project], shimRoot)[0]!).rebuilt).toBe(true)
  })

  it('rebuilds when a convention dir appears that was not there before', () => {
    const project = makeProject('atlas', { skills: ['think'] })
    expect(syncOverlay(planOverlays([project], shimRoot)[0]!).linked).toEqual(['skills'])

    mkdirSync(join(project, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(project, '.claude', 'agents', 'reviewer.md'), '# reviewer\n')

    const shim = syncOverlay(planOverlays([project], shimRoot)[0]!)
    expect(shim.rebuilt).toBe(true)
    expect(shim.linked.sort()).toEqual(['agents', 'skills'])
  })

  it('rebuilds when only CLAUDE.md changed, since that one is copied not linked', () => {
    const project = makeProject('atlas', { skills: ['think'], claudeMd: '# first\n' })
    syncOverlay(planOverlays([project], shimRoot)[0]!)

    writeFileSync(join(project, 'CLAUDE.md'), '# second\n')
    expect(syncOverlay(planOverlays([project], shimRoot)[0]!).rebuilt).toBe(true)
  })

  /**
   * The rebuild path deletes the shim, and the shim's `skills` is a junction
   * into the real repository. Observed for real during M3's acceptance run: the
   * source's skill directory was emptied by a rebuild, and the next session
   * loaded a plugin pointing at nothing. Asserted on the source, not on the
   * shim, because the shim being right is not the property that matters here.
   */
  it('a rebuild leaves the source repo untouched behind the junction', () => {
    const project = makeProject('atlas', { skills: ['think'], agents: ['reviewer'] })
    syncOverlay(planOverlays([project], shimRoot)[0]!)

    // The edit that forces the rebuild.
    writeFileSync(join(project, '.claude', 'skills', 'think', 'SKILL.md'), '# edited\n')
    const shim = syncOverlay(planOverlays([project], shimRoot)[0]!)
    expect(shim.rebuilt).toBe(true)

    expect(readdirSync(join(project, '.claude', 'skills'))).toEqual(['think'])
    expect(readFileSync(join(project, '.claude', 'skills', 'think', 'SKILL.md'), 'utf8')).toBe(
      '# edited\n'
    )
    expect(existsSync(join(project, '.claude', 'agents', 'reviewer.md'))).toBe(true)
    // And the rebuilt shim reaches it.
    expect(readFileSync(join(shim.dir, 'skills', 'think', 'SKILL.md'), 'utf8')).toBe('# edited\n')
  })

  it('an edit to a skill is visible through the link without a rebuild', () => {
    const project = makeProject('atlas', { skills: ['think'] })
    const shim = syncOverlay(planOverlays([project], shimRoot)[0]!)

    writeFileSync(join(project, '.claude', 'skills', 'think', 'SKILL.md'), '# edited\n')
    expect(readFileSync(join(shim.dir, 'skills', 'think', 'SKILL.md'), 'utf8')).toBe('# edited\n')
  })
})

describe('cleanStaleShims', () => {
  it('removes shims nothing asked to keep', () => {
    const a = makeProject('alpha', { skills: ['one'] })
    const b = makeProject('beta', { skills: ['two'] })
    syncOverlay(planOverlays([a], shimRoot)[0]!)
    syncOverlay(planOverlays([b], shimRoot)[0]!)

    const removed = cleanStaleShims(shimRoot, ['alpha'])
    expect(removed).toEqual([join(shimRoot, 'overlay-beta')])
    expect(existsSync(join(shimRoot, 'overlay-alpha'))).toBe(true)
    expect(existsSync(join(shimRoot, 'overlay-beta'))).toBe(false)
  })

  it('removes every shim when nothing is running', () => {
    const a = makeProject('alpha', { skills: ['one'] })
    syncOverlay(planOverlays([a], shimRoot)[0]!)
    expect(cleanStaleShims(shimRoot)).toHaveLength(1)
    expect(existsSync(join(shimRoot, 'overlay-alpha'))).toBe(false)
  })

  /**
   * The one that matters. A shim's subdirectories are junctions into the user's
   * real repo, so a cleanup that descended through them would delete the skills
   * it exists to expose.
   */
  it('unlinks junctions rather than deleting the repo behind them', () => {
    const project = makeProject('atlas', { skills: ['think'], agents: ['reviewer'] })
    syncOverlay(planOverlays([project], shimRoot)[0]!)

    cleanStaleShims(shimRoot)

    expect(existsSync(join(shimRoot, 'overlay-atlas'))).toBe(false)
    expect(readFileSync(join(project, '.claude', 'skills', 'think', 'SKILL.md'), 'utf8')).toBe(
      '# think\n'
    )
    expect(existsSync(join(project, '.claude', 'agents', 'reviewer.md'))).toBe(true)
  })

  it('leaves directories that are not Helm shims alone', () => {
    mkdirSync(join(shimRoot, 'overlay-not-ours'), { recursive: true })
    writeFileSync(join(shimRoot, 'overlay-not-ours', 'keep.txt'), 'x')
    mkdirSync(join(shimRoot, 'unrelated'), { recursive: true })

    expect(cleanStaleShims(shimRoot)).toEqual([])
    expect(existsSync(join(shimRoot, 'overlay-not-ours', 'keep.txt'))).toBe(true)
    expect(existsSync(join(shimRoot, 'unrelated'))).toBe(true)
  })

  it('is fine with a shim root that does not exist yet', () => {
    expect(cleanStaleShims(join(root, 'nope'))).toEqual([])
  })

  /** One per distinct session name, and nothing else ever collects them. */
  it('collects the composed instruction files too', () => {
    writeFileSync(join(shimRoot, 'memory-cloud-sync.md'), '# composed')
    writeFileSync(join(shimRoot, 'notes.md'), 'not ours')

    const removed = cleanStaleShims(shimRoot)
    expect(removed).toEqual([join(shimRoot, 'memory-cloud-sync.md')])
    expect(existsSync(join(shimRoot, 'notes.md'))).toBe(true)
  })
})

describe('composeOverlayMemory', () => {
  it('carries each overlay CLAUDE.md, attributed to the project it governs', () => {
    const a = makeProject('atlas', { skills: ['think'], claudeMd: '# atlas\nPyQt5 app.' })
    const b = makeProject('reporting', { skills: ['think'], claudeMd: '# Reporting\ndotnet API.' })
    const memory = composeOverlayMemory(planOverlays([a, b], shimRoot))

    expect(memory).not.toBeNull()
    expect(memory).toContain('PyQt5 app.')
    expect(memory).toContain('dotnet API.')
    // Attribution, because the instructions inside say "this repo" and the
    // session's cwd is neither of them.
    expect(memory).toContain(a)
    expect(memory).toContain(b)
  })

  it('is null when no overlay has one, so no flag gets emitted', () => {
    const project = makeProject('atlas', { skills: ['think'] })
    expect(composeOverlayMemory(planOverlays([project], shimRoot))).toBeNull()
  })
})
