import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { cleanStaleShims, probeProcess, type ShimOwner, type ShimWorld } from './overlay'
import { plantShim } from './overlay.testkit'

let root: string
let shimRoot: string

const STAMP = '.helm-overlay.json'

/**
 * A machine that has rebooted since the shim was stamped.
 *
 * Which is what "the previous run" means once the sweep asks about processes: a
 * pid recorded before this boot cannot name anything running now, so every
 * owner on the stamp is dead by construction and the probe is never consulted.
 * The tests that predate ownership all describe exactly that situation.
 */
function rebooted(): Partial<ShimWorld> {
  return { bootAtMs: Date.now() + 1000 }
}

/** Rewrites a real shim's owner list, standing in for another Helm's claim. */
function setOwners(dir: string, owners: ShimOwner[] | undefined): void {
  const stamp: unknown = JSON.parse(readFileSync(join(dir, STAMP), 'utf8'))
  const next = { ...(stamp as Record<string, unknown>) }
  if (owners === undefined) delete next['owners']
  else next['owners'] = owners
  writeFileSync(join(dir, STAMP), JSON.stringify(next, null, 2))
}

/** Every file under `dir` with its contents, sorted: what a removal must not change. */
function filesUnder(dir: string): Array<[string, string]> {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry): [string, string] => {
      const path = join(entry.parentPath, entry.name)
      return [relative(dir, path), readFileSync(path, 'utf8')]
    })
    .sort(([a], [b]) => a.localeCompare(b))
}

/** A pid that is not this process, with a start time inside the current boot. */
function otherHelm(pid: number): ShimOwner {
  return { pid, startedAt: new Date().toISOString() }
}

/** A repo with a `.claude/` tree, the way the fixtures in `repos/` look. */
function makeProject(
  name: string,
  opts: { skills?: string[]; agents?: string[]; commands?: string[] } = {}
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

describe('cleanStaleShims', () => {
  it('removes shims nothing asked to keep', () => {
    const a = makeProject('alpha', { skills: ['one'] })
    const b = makeProject('beta', { skills: ['two'] })
    plantShim(a, shimRoot)
    plantShim(b, shimRoot)

    const removed = cleanStaleShims(shimRoot, ['alpha'], rebooted())
    expect(removed).toEqual([join(shimRoot, 'overlay-beta')])
    expect(existsSync(join(shimRoot, 'overlay-alpha'))).toBe(true)
    expect(existsSync(join(shimRoot, 'overlay-beta'))).toBe(false)
  })

  it('removes every shim when nothing is running', () => {
    const a = makeProject('alpha', { skills: ['one'] })
    plantShim(a, shimRoot)
    expect(cleanStaleShims(shimRoot, [], rebooted())).toHaveLength(1)
    expect(existsSync(join(shimRoot, 'overlay-alpha'))).toBe(false)
  })

  /**
   * The one that matters. A shim's subdirectories are junctions into the user's
   * real repo, so a cleanup that descended through them would delete the skills
   * it exists to expose.
   */
  it('unlinks the links rather than deleting the repo behind them', () => {
    const project = makeProject('acme', { skills: ['think'], agents: ['reviewer'] })
    plantShim(project, shimRoot)

    cleanStaleShims(shimRoot, [], rebooted())

    expect(existsSync(join(shimRoot, 'overlay-acme'))).toBe(false)
    expect(readFileSync(join(project, '.claude', 'skills', 'think', 'SKILL.md'), 'utf8')).toBe(
      '# think\n'
    )
    expect(existsSync(join(project, '.claude', 'agents', 'reviewer.md'))).toBe(true)
  })

  /**
   * Swept: every file in the repository behind the links is still there, byte
   * for byte, nested folders included. With real symlinks on macOS and Linux
   * and real junctions on Windows.
   */
  it('leaves every file in the repository behind the links through a sweep', () => {
    const project = makeProject('acme', { skills: ['think', 'plan'], agents: ['reviewer'], commands: ['ship'] })
    mkdirSync(join(project, '.claude', 'skills', 'think', 'references', 'deep'), { recursive: true })
    writeFileSync(join(project, '.claude', 'skills', 'think', 'references', 'deep', 'notes.md'), 'nested\n')
    const shim = plantShim(project, shimRoot)
    expect(shim.linked).toEqual(['skills', 'commands', 'agents'])
    expect(lstatSync(join(shim.dir, 'skills')).isSymbolicLink()).toBe(true)
    const before = filesUnder(join(project, '.claude'))
    expect(before.length).toBeGreaterThanOrEqual(5)

    expect(cleanStaleShims(shimRoot, [], rebooted())).toEqual([shim.dir])
    expect(existsSync(shim.dir)).toBe(false)
    expect(filesUnder(join(project, '.claude'))).toEqual(before)
  })

  it('leaves directories that are not Helm shims alone', () => {
    mkdirSync(join(shimRoot, 'overlay-not-ours'), { recursive: true })
    writeFileSync(join(shimRoot, 'overlay-not-ours', 'keep.txt'), 'x')
    mkdirSync(join(shimRoot, 'unrelated'), { recursive: true })

    expect(cleanStaleShims(shimRoot, [], rebooted())).toEqual([])
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

    const removed = cleanStaleShims(shimRoot, [], rebooted())
    expect(removed).toEqual([join(shimRoot, 'memory-cloud-sync.md')])
    expect(existsSync(join(shimRoot, 'notes.md'))).toBe(true)
  })
})

/**
 * Who is allowed to delete a shim.
 *
 * The failure being ruled out is one process removing another's live
 * `--plugin-dir`: the session keeps running and silently loses its skills, so
 * there is no symptom to notice. Every case below is therefore written from the
 * sweep's point of view, and the ones with no clear answer assert that nothing
 * happened.
 */
describe('cleanStaleShims and the process holding the shim', () => {
  /** Builds a real shim and returns where it landed. */
  function plant(name: string): string {
    return plantShim(makeProject(name, { skills: ['one'] }), shimRoot).dir
  }

  it('leaves a shim whose owner is still running', () => {
    const dir = plant('alpha')
    setOwners(dir, [otherHelm(4321)])

    const removed = cleanStaleShims(shimRoot, [], { probe: () => 'alive' })
    expect(removed).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  it('removes a shim whose owner is gone', () => {
    const dir = plant('alpha')
    setOwners(dir, [otherHelm(4321)])

    expect(cleanStaleShims(shimRoot, [], { probe: () => 'gone' })).toEqual([dir])
    expect(existsSync(dir)).toBe(false)
  })

  /**
   * The pre-boot rule, which is what makes pid reuse safe rather than merely
   * unlikely: a pid recorded before this boot names nothing that is running
   * now, whatever the kernel says about the number today.
   */
  it('removes a shim stamped before the current boot even if the pid is live', () => {
    const dir = plant('alpha')
    setOwners(dir, [{ pid: 4321, startedAt: new Date(Date.now() - 86_400_000).toISOString() }])

    const removed = cleanStaleShims(shimRoot, [], {
      probe: () => 'alive',
      bootAtMs: Date.now() - 60_000
    })
    expect(removed).toEqual([dir])
    expect(existsSync(dir)).toBe(false)
  })

  it('leaves a shim when the kernel will not say', () => {
    const dir = plant('alpha')
    setOwners(dir, [otherHelm(4321)])

    expect(cleanStaleShims(shimRoot, [], { probe: () => 'unknown' })).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  it('leaves a shim when one of several owners is still running', () => {
    const dir = plant('alpha')
    setOwners(dir, [otherHelm(4321), otherHelm(8765)])

    const removed = cleanStaleShims(shimRoot, [], {
      probe: (pid) => (pid === 8765 ? 'alive' : 'gone')
    })
    expect(removed).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  it('removes a shim once every owner has gone', () => {
    const dir = plant('alpha')
    setOwners(dir, [otherHelm(4321), otherHelm(8765)])

    expect(cleanStaleShims(shimRoot, [], { probe: () => 'gone' })).toEqual([dir])
    expect(existsSync(dir)).toBe(false)
  })

  it('never removes a shim this process itself holds', () => {
    const dir = plant('alpha')
    // The probe would say gone for anything it is asked about; the self entry
    // must not reach it.
    expect(cleanStaleShims(shimRoot, [], { probe: () => 'gone' })).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  /**
   * A shim built by a Helm from before ownership was recorded. Nothing can be
   * said about who holds it, so the clock decides: within this boot it is left
   * alone, and the next boot collects it.
   */
  it('leaves a stamp with no owners that was built during this boot', () => {
    const dir = plant('alpha')
    setOwners(dir, undefined)

    expect(cleanStaleShims(shimRoot, [], { probe: () => 'gone' })).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  it('removes a stamp with no owners that predates this boot', () => {
    const dir = plant('alpha')
    setOwners(dir, undefined)

    const removed = cleanStaleShims(shimRoot, [], {
      probe: () => 'gone',
      bootAtMs: Date.now() + 1000
    })
    expect(removed).toEqual([dir])
    expect(existsSync(dir)).toBe(false)
  })
})

/**
 * The probe itself, against the kernel where the answer is unambiguous and
 * against a stubbed `process.kill` where it is not.
 *
 * `EPERM` is the case worth stubbing. A machine cannot be relied on to hold a
 * process this one may not signal - and the pid that would, on Windows, is a
 * protected system process, which is a brittle thing to build a test on - but
 * getting it wrong is what deletes a live session's plugin directory, so it is
 * not a branch to leave unexercised.
 */
describe('probeProcess', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('says a process that is running is alive', () => {
    expect(probeProcess(process.pid)).toBe('alive')
  })

  it('says a process that has exited is gone', () => {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    expect(child.status).toBe(0)
    expect(child.pid).toBeGreaterThan(0)
    expect(probeProcess(child.pid!)).toBe('gone')
  })

  it('reads a pid it may not signal as alive rather than absent', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('operation not permitted')
      err.code = 'EPERM'
      throw err
    })
    expect(probeProcess(4321)).toBe('alive')
  })

  it('says unknown for anything else the platform raises', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('invalid argument')
      err.code = 'EINVAL'
      throw err
    })
    expect(probeProcess(4321)).toBe('unknown')
  })
})

/**
 * And the sweep's own reading of an EPERM, end to end: the probe classifies,
 * `ownerVerdict` refuses to delete on anything but `gone`, and the directory is
 * still there afterwards.
 */
describe('cleanStaleShims against a pid it may not signal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leaves the shim', () => {
    const project = makeProject('alpha', { skills: ['one'] })
    const dir = plantShim(project, shimRoot).dir
    setOwners(dir, [{ pid: 4321, startedAt: new Date().toISOString() }])

    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('operation not permitted')
      err.code = 'EPERM'
      throw err
    })

    expect(cleanStaleShims(shimRoot)).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })
})
