import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PATIENCE } from '../../../../test/patience'
import {
  formatLeftovers,
  parsePsTable,
  parseWindowsTable,
  processName,
  selectLeftovers,
  type ProcessRow
} from '../../../../scripts/test-leftovers.mjs'
import { REPO_ROOT } from '../../scripts/test-posix.mjs'

/**
 * `scripts/test-leftovers.mjs`, which CI runs after the host tests and after
 * `pnpm check`, and a developer runs around either: it fails a step that left
 * a test temp folder or a process it started behind, and reports only what
 * the step left.
 */

const SCRIPT = join(REPO_ROOT, 'scripts', 'test-leftovers.mjs')
const FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'leaky-step.mjs')
const TMP = join('/', 'tmp')

/** One row of a hand-written table. */
function row(pid: number, parentPid: number, name: string, start: number, commandLine = `${name} ${pid}`): ProcessRow {
  return { pid, parentPid, name, commandLine, start }
}

const pids = (rows: ProcessRow[] | null): number[] | null => (rows === null ? null : rows.map((r) => r.pid))

/**
 * A machine before the step: the system, the installed Helm with another
 * session's agent and its fake agent, the CI runner, and the shell the check
 * runs from with its own ancestors.
 */
const BEFORE: ProcessRow[] = [
  row(1, 0, 'init', 1),
  row(10, 1, 'helm', 2),
  row(11, 10, 'claude', 3),
  row(12, 11, 'node', 4, 'node fake-claude.mjs'),
  row(20, 1, 'runner', 5),
  row(30, 20, 'bash', 6)
]

describe('what the leftover check selects', () => {
  it('fails a step that left a test temp folder and a process, naming each', () => {
    const after = [
      ...BEFORE,
      // An orphan on Windows names a parent that is gone.
      row(40, 999, 'floti', 10, 'floti host --listen 127.0.0.1:0'),
      // An orphan on POSIX was re-parented to init, the check's ancestor.
      row(41, 1, 'floti-fake-agent', 11),
      // A process under a process the step left is the step's too.
      row(42, 40, 'node', 12),
      row(50, 30, 'node', 20, 'node scripts/test-leftovers.mjs after state.json')
    ]
    const leftovers = selectLeftovers({
      before: { processes: BEFORE, folders: ['helm world-old'] },
      after: {
        processes: after,
        folders: ['helm world-old', 'floti test abc', 'helm world-xyz', 'helm-test-posix-1']
      },
      self: 50,
      tmp: TMP
    })
    expect(leftovers.folders).toEqual([join(TMP, 'floti test abc'), join(TMP, 'helm world-xyz'), join(TMP, 'helm-test-posix-1')])
    expect(pids(leftovers.processes)).toEqual([40, 41, 42])
    expect(formatLeftovers(leftovers)).toContain('  process  40 floti floti host --listen 127.0.0.1:0')
    expect(formatLeftovers(leftovers)).toContain(`  folder   ${join(TMP, 'floti test abc')}`)
  })

  it('passes a step that left nothing behind', () => {
    const leftovers = selectLeftovers({
      before: { processes: BEFORE, folders: [] },
      after: { processes: [...BEFORE, row(50, 30, 'node', 20)], folders: [] },
      self: 50,
      tmp: TMP
    })
    expect(leftovers).toEqual({ folders: [], processes: [] })
    expect(formatLeftovers(leftovers)).toEqual([])
  })

  it('never reports what was there before the step or what other sessions start during it', () => {
    const after = [
      ...BEFORE,
      // Another session starts a shell and a fake agent under its own agent.
      row(60, 11, 'bash', 15),
      row(61, 60, 'node', 16),
      row(62, 12, 'floti', 17),
      row(50, 30, 'node', 20)
    ]
    const leftovers = selectLeftovers({
      before: { processes: BEFORE, folders: ['floti test earlier run', 'helm world-earlier'] },
      after: { processes: after, folders: ['floti test earlier run', 'helm world-earlier'] },
      self: 50,
      tmp: TMP
    })
    expect(leftovers).toEqual({ folders: [], processes: [] })
  })

  it('never reports what a process the check runs under starts beside it', () => {
    // The check runs under a test runner or an app that keeps starting work of
    // its own: vitest's other workers, Helm's other sessions. Only init or a
    // subreaper adopts what the step left, so a new process under any other
    // ancestor of the check was started by that ancestor, not by the step.
    const after = [
      ...BEFORE,
      row(95, 20, 'node', 18, 'node vitest/dist/workers/forks.js'),
      row(96, 95, 'floti', 19),
      row(97, 10, 'bash', 19),
      row(50, 30, 'node', 20)
    ]
    const leftovers = selectLeftovers({
      before: { processes: BEFORE, folders: [] },
      after: { processes: after, folders: [] },
      self: 50,
      tmp: TMP
    })
    expect(leftovers).toEqual({ folders: [], processes: [] })
  })

  it('reports an orphan a subreaper adopted, as WSL and systemd adopt them', () => {
    const before = [...BEFORE, row(25, 20, 'Relay(274)', 5, '/init'), row(26, 25, 'systemd', 5, '/usr/lib/systemd/systemd --user')]
    const after = [...before, row(43, 25, 'node', 12), row(44, 26, 'floti', 13), row(50, 26, 'node', 20)]
    const leftovers = selectLeftovers({
      before: { processes: before, folders: [] },
      after: { processes: after, folders: [] },
      self: 50,
      tmp: TMP
    })
    expect(pids(leftovers.processes)).toEqual([43, 44])
  })

  it('takes a reused pid for a different process', () => {
    // pid 12 was another session's fake agent; it ended, and the step left a
    // node that Windows gave the same pid.
    const after = [...BEFORE.filter((r) => r.pid !== 12), row(12, 999, 'node', 14), row(50, 30, 'node', 20)]
    // A parent pid reused by a process that started after its child is not
    // its parent: the walk ends, and the orphan is reported.
    after.push(row(70, 71, 'floti', 15), row(71, 10, 'node', 16))
    const leftovers = selectLeftovers({
      before: { processes: BEFORE, folders: [] },
      after: { processes: after, folders: [] },
      self: 50,
      tmp: TMP
    })
    expect(pids(leftovers.processes)).toEqual([12, 70])
  })

  it('never reports a tool cache or a process of a kind tests do not start', () => {
    const leftovers = selectLeftovers({
      before: { processes: BEFORE, folders: [] },
      after: {
        processes: [...BEFORE, row(80, 999, 'mspdbsrv', 12), row(81, 999, 'rustc', 13), row(50, 30, 'node', 20)],
        folders: ['node-compile-cache', 'helm compile cache probe-1']
      },
      self: 50,
      tmp: TMP
    })
    expect(leftovers).toEqual({ folders: [], processes: [] })
  })

  it("never reports the check's own shell, its console host or its lister", () => {
    // In CI the after-step's shell started after the snapshot.
    const after = [
      ...BEFORE,
      row(90, 20, 'pwsh', 18),
      row(91, 90, 'conhost', 19),
      row(50, 90, 'node', 20),
      row(92, 50, 'powershell', 21),
      row(93, 92, 'conhost', 22)
    ]
    const leftovers = selectLeftovers({
      before: { processes: BEFORE, folders: [] },
      after: { processes: after, folders: [] },
      self: 50,
      tmp: TMP
    })
    expect(leftovers).toEqual({ folders: [], processes: [] })
  })

  it('still judges folders when the process table could not be read', () => {
    const leftovers = selectLeftovers({
      before: { processes: null, folders: [] },
      after: { processes: null, folders: ['helm world-1'] },
      self: 50,
      tmp: TMP
    })
    expect(leftovers).toEqual({ folders: [join(TMP, 'helm world-1')], processes: null })
  })
})

describe('the per-OS process listing', () => {
  it('names a process the same way on every OS', () => {
    expect(processName('node.exe')).toBe('node')
    expect(processName('Floti-Fake-Agent.EXE')).toBe('floti-fake-agent')
    expect(processName('/usr/local/bin/node')).toBe('node')
    expect(processName('C:\\Windows\\System32\\conhost.exe')).toBe('conhost')
  })

  it('reads the Windows pass, a single row included', () => {
    expect(parseWindowsTable('{"p":4,"r":0,"n":"System","c":null,"s":0}')).toEqual([
      { pid: 4, parentPid: 0, name: 'system', commandLine: null, start: 0 }
    ])
    expect(
      parseWindowsTable('[{"p":7,"r":4,"n":"node.exe","c":"node a.js","s":1730000000000},{"n":"no pid"}]')
    ).toEqual([{ pid: 7, parentPid: 4, name: 'node', commandLine: 'node a.js', start: 1730000000000 }])
  })

  it('reads ps, with a padded day and a name with a space in it', () => {
    const table = ['    1     0 Wed Oct 29 00:54:12 2026 init', '  345     1 Thu Oct  9 07:05:01 2026 Web Content', 'junk'].join('\n')
    const args = ['    1 /sbin/init', '  345 /Applications/Firefox -contentproc'].join('\n')
    expect(parsePsTable(table, args)).toEqual([
      { pid: 1, parentPid: 0, name: 'init', commandLine: '/sbin/init', start: new Date(2026, 9, 29, 0, 54, 12).getTime() },
      {
        pid: 345,
        parentPid: 1,
        name: 'web content',
        commandLine: '/Applications/Firefox -contentproc',
        start: new Date(2026, 9, 9, 7, 5, 1).getTime()
      }
    ])
  })

  it('names a Node whose main thread Linux reports as MainThread after its program', () => {
    const table = '  603   274 Thu Oct 29 01:10:52 2026 MainThread'
    const args = '  603 /home/dev/.nvm/versions/node/v24.14.0/bin/node -e setInterval(() => {}, 60_000)'
    expect(parsePsTable(table, args).map((r) => r.name)).toEqual(['node'])
  })
})

let temp: string
const started: number[] = []

beforeEach(() => {
  // A private temp folder, so what the script lists is only what this test makes.
  temp = mkdtempSync(join(tmpdir(), 'helm leftovers temp-'))
})

afterEach(() => {
  for (const pid of started.splice(0)) {
    if (alive(pid)) process.kill(pid)
  }
  rmSync(temp, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function inPrivateTemp(command: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const script = (...args: string[]) => inPrivateTemp(process.execPath, [SCRIPT, ...args])

/** The folder and process the fixture says it left, recorded so the test ends them. */
function leaked(stdout: string): { pid: number; folder: string } {
  const line = stdout.split('\n').find((l) => l.startsWith('{"pid"'))
  expect(line, 'the fixture printed what it left').toBeDefined()
  const found = JSON.parse(line as string) as { pid: number; folder: string }
  started.push(found.pid)
  expect(existsSync(found.folder)).toBe(true)
  expect(alive(found.pid)).toBe(true)
  return found
}

/** Ends what the fixture left and waits until it is gone. */
async function clearUp({ pid, folder }: { pid: number; folder: string }): Promise<void> {
  process.kill(pid)
  await vi.waitFor(() => expect(alive(pid), `fixture process ${pid} has ended`).toBe(false), { timeout: PATIENCE })
  rmSync(folder, { recursive: true, force: true })
}

/**
 * Runs a check until it passes, within the patience. The check reads the whole
 * machine's process table, and in the full suite another file can be ending a
 * process tree at that instant, whose child, for the moment its parent is gone
 * and it is not yet, is an orphan like the fixture's. What this test left is
 * already gone, so a pass is what the check comes to.
 */
async function expectPasses(run: () => { status: number | null; stderr: string }): Promise<void> {
  await vi.waitFor(
    () => {
      const result = run()
      expect(result.stderr, 'the check reported nothing').toBe('')
      expect(result.status).toBe(0)
    },
    { timeout: PATIENCE, interval: 0 }
  )
}

function expectReported(stderr: string, { pid, folder }: { pid: number; folder: string }): void {
  expect(stderr).toContain(`  folder   ${folder}`)
  expect(stderr).toMatch(new RegExp(`  process  ${pid} node .*leaky-step-child`))
}

describe('the leftover check around a step', () => {
  it('reports a leaked folder and process and fails, then passes once they are gone, deleting and ending nothing itself', async () => {
    const state = join(temp, 'state.json')
    expect(script('before', state).status).toBe(0)
    const left = leaked(inPrivateTemp(process.execPath, [FIXTURE]).stdout)

    const failed = script('after', state)
    expect(failed.status).toBe(1)
    expectReported(failed.stderr, left)
    // The check deletes nothing and ends nothing.
    expect(existsSync(left.folder)).toBe(true)
    expect(alive(left.pid)).toBe(true)

    await clearUp(left)
    await expectPasses(() => script('after', state))
  })

  it('runs a command as the one local command and fails it for what it left', async () => {
    const run = script(process.execPath, FIXTURE)
    const left = leaked(run.stdout)
    expect(run.status).toBe(1)
    expectReported(run.stderr, left)
    await clearUp(left)
  })

  it("exits with the command's own status when the command fails", async () => {
    // Polled for the reason `expectPasses` gives: the check must come to
    // finding nothing, and the status stays the command's either way.
    await vi.waitFor(
      () => {
        const run = script(process.execPath, '-e', 'process.exitCode = 3')
        expect(run.status).toBe(3)
        expect(run.stdout, run.stderr).toContain('the step left nothing behind')
      },
      { timeout: PATIENCE, interval: 0 }
    )
  })

  it('passes a command that left nothing behind', async () => {
    await expectPasses(() => script(process.execPath, '-e', 'const done = true'))
  })

  it('refuses no command at all', () => {
    expect(script().status).toBe(2)
  })
})
