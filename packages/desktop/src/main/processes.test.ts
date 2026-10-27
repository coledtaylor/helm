import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sessionResources } from '@helm/core'
import { parseWindowsPass, processTableReader, readProcessSnapshot } from './processes'
import {
  LSOF_ARGS,
  lsofResult,
  parseLsofListening,
  parsePsArgs,
  parsePsNames,
  PS_ARGS_ARGS,
  PS_NAMES_ARGS,
  readDarwinProcesses
} from './processes-darwin'
import {
  parseProcCmdline,
  parseProcStat,
  parseSsListening,
  readLinuxProcesses,
  readProcTable
} from './processes-linux'
import type { ToolOutput, ToolRunner } from './processes-tool'

/**
 * The processes-and-ports pass on each OS: a parser per tool, fed what the tool
 * prints, run on every OS; and one live read per OS, run only on the OS it
 * reads, of a process tree with a listening server under it.
 */

/** `ps -axww -o pid=,ppid=,comm=` as macOS prints it: right-aligned pids, a path that may hold spaces. */
const PS_NAMES = `    1     0 /sbin/launchd
  612     1 /Applications/Helm.app/Contents/MacOS/Helm
  640   612 /Applications/Helm.app/Contents/Frameworks/Helm Helper.app/Contents/MacOS/Helm Helper
  701   612 /bin/zsh
  702   701 /Users/me/.local/bin/claude
  733   702 node
`

/** `ps -axww -o pid=,args=`: the command line, spaces and all. */
const PS_ARGS = `    1 /sbin/launchd
  612 /Applications/Helm.app/Contents/MacOS/Helm
  640 /Applications/Helm.app/Contents/Frameworks/Helm Helper.app/Contents/MacOS/Helm Helper --type=gpu-process
  701 -zsh
  702 claude --session-id 1b4e28ba-2fa1-11d2-883f-0016d3cca427 --name my session
  733 node /Users/me/work/app/server.mjs --port 5173
`

/** `lsof -nP -w -iTCP -sTCP:LISTEN -F ptn`: one server on both families, one on every address. */
const LSOF = `p733
f21
tIPv4
n127.0.0.1:5173
f22
tIPv6
n[::1]:5173
p902
f7
tIPv4
n*:8080
f8
tIPv6
n*:8080
`

/** `/proc/<pid>/stat` lines, one with a name that holds spaces and parentheses. */
const STAT_PLAIN = '733 (node) S 702 733 701 34816 733 4194304 1534 0 0 0 12 3 0 0 20 0 11 0 2271 1194373120 12114'
const STAT_ODD = '901 (tmux: server (1)) S 1 901 901 0 -1 4194624 300 0 0 0 0 0 0 0 20 0 1 0 2300 9000 100'

/** `ss -ltnpH` as an unprivileged user sees it: other users' sockets carry no process. */
const SS = `LISTEN 0      511        127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=733,fd=21))
LISTEN 0      511            [::1]:5173          [::]:*    users:(("node",pid=733,fd=22))
LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*
LISTEN 0      511                *:8080             *:*    users:(("node",pid=902,fd=7),("node",pid=903,fd=7))
`

const ok = (stdout: string): ToolOutput => ({ stdout, stderr: '', code: 0 })

/** A runner answering by program and first argument, so a test can fail one tool. */
function runner(answers: Record<string, ToolOutput | null>): ToolRunner {
  return (file, args) => Promise.resolve(answers[`${file} ${args.join(' ')}`] ?? null)
}

const darwinAnswers = (overrides: Record<string, ToolOutput | null> = {}): Record<string, ToolOutput | null> => ({
  [`ps ${PS_NAMES_ARGS.join(' ')}`]: ok(PS_NAMES),
  [`ps ${PS_ARGS_ARGS.join(' ')}`]: ok(PS_ARGS),
  [`lsof ${LSOF_ARGS.join(' ')}`]: ok(LSOF),
  ...overrides
})

describe('the macOS reader', () => {
  it('reads names from the executable path and the command line from args, joined on the pid', () => {
    const rows = parsePsNames(PS_NAMES)
    expect(rows).toHaveLength(6)
    expect(rows[2]).toEqual({ pid: 640, parentPid: 612, name: 'Helm Helper', commandLine: null })
    const lines = parsePsArgs(PS_ARGS)
    expect(lines.get(702)).toBe('claude --session-id 1b4e28ba-2fa1-11d2-883f-0016d3cca427 --name my session')
    expect(lines.get(640)).toMatch(/Helm Helper --type=gpu-process$/)
  })

  it('reads listening sockets from lsof, with * as every address of its family', () => {
    expect(parseLsofListening(LSOF)).toEqual([
      { pid: 733, port: 5173, address: '127.0.0.1' },
      { pid: 733, port: 5173, address: '::1' },
      { pid: 902, port: 8080, address: '0.0.0.0' },
      { pid: 902, port: 8080, address: '::' }
    ])
  })

  it('lists a session’s process tree with command lines and the ports its processes hold', async () => {
    const facts = await readDarwinProcesses(1000, runner(darwinAnswers()))
    const session = sessionResources(1, 702, { ...facts, atMs: 0, durationMs: 0 })
    expect(session.processes?.map((row) => [row.pid, row.name, row.commandLine, row.ports])).toEqual([
      [702, 'claude', 'claude --session-id 1b4e28ba-2fa1-11d2-883f-0016d3cca427 --name my session', []],
      [733, 'node', 'node /Users/me/work/app/server.mjs --port 5173', [5173]]
    ])
    expect(session.ports).toEqual([{ port: 5173, pid: 733, process: 'node', addresses: ['127.0.0.1', '::1'] }])
  })

  it('says nothing is listening when lsof exits 1 with nothing to say', () => {
    expect(lsofResult({ stdout: '', stderr: '', code: 1 })).toEqual([])
  })

  it('shows the ports as unknown, never empty, when lsof cannot be run or fails, and keeps the tree', async () => {
    for (const lsof of [null, { stdout: '', stderr: 'lsof: unknown option', code: 1 }]) {
      const facts = await readDarwinProcesses(1000, runner(darwinAnswers({ [`lsof ${LSOF_ARGS.join(' ')}`]: lsof })))
      expect(facts.ports).toBeNull()
      expect(facts.processes).toHaveLength(6)
      const session = sessionResources(1, 702, { ...facts, atMs: 0, durationMs: 0 })
      expect(session.ports).toBeNull()
      expect(session.processes?.map((row) => row.pid)).toEqual([702, 733])
    }
  })

  it('shows the processes as unknown when ps cannot be run, and still reads the ports', async () => {
    const facts = await readDarwinProcesses(1000, runner(darwinAnswers({ [`ps ${PS_NAMES_ARGS.join(' ')}`]: null })))
    expect(facts.processes).toBeNull()
    expect(facts.ports).toHaveLength(4)
  })

  it('keeps the tree with unknown command lines when only the args read fails', async () => {
    const facts = await readDarwinProcesses(1000, runner(darwinAnswers({ [`ps ${PS_ARGS_ARGS.join(' ')}`]: null })))
    expect(facts.processes?.every((row) => row.commandLine === null)).toBe(true)
    expect(facts.processes).toHaveLength(6)
  })
})

describe('the Linux reader', () => {
  it('reads a stat line, including a name with spaces and parentheses', () => {
    expect(parseProcStat(STAT_PLAIN)).toEqual({ pid: 733, parentPid: 702, name: 'node' })
    expect(parseProcStat(STAT_ODD)).toEqual({ pid: 901, parentPid: 1, name: 'tmux: server (1)' })
    expect(parseProcStat('garbage')).toBeNull()
  })

  it('reads a NUL-separated command line, and none for a kernel thread', () => {
    expect(parseProcCmdline(Buffer.from('node\0/srv/app server.mjs\0--port\x005173\0'))).toBe(
      'node /srv/app server.mjs --port 5173'
    )
    expect(parseProcCmdline(Buffer.alloc(0))).toBeNull()
  })

  it('reads listening sockets from ss, one row per process holding one, and skips a row with none', () => {
    expect(parseSsListening(SS)).toEqual([
      { pid: 733, port: 5173, address: '127.0.0.1' },
      { pid: 733, port: 5173, address: '::1' },
      { pid: 902, port: 8080, address: '::' },
      { pid: 903, port: 8080, address: '::' }
    ])
  })

  describe('against a directory shaped like /proc', () => {
    let proc: string
    beforeAll(() => {
      proc = mkdtempSync(join(tmpdir(), 'helm proc-'))
      const add = (pid: number, stat: string, cmdline: string | null): void => {
        mkdirSync(join(proc, String(pid)))
        writeFileSync(join(proc, String(pid), 'stat'), stat)
        if (cmdline !== null) writeFileSync(join(proc, String(pid), 'cmdline'), cmdline)
      }
      add(702, '702 (claude) S 701 702 701 0 -1 0', 'claude\0--name\0my session\0')
      add(733, STAT_PLAIN, 'node\0server.mjs\0')
      add(2, '2 (kthreadd) S 0 0 0 0 -1 0', '')
      mkdirSync(join(proc, 'self'))
      mkdirSync(join(proc, '999'))
    })
    afterAll(() => rmSync(proc, { recursive: true, force: true }))

    it('lists the table, leaving out what vanished between the listing and the read', async () => {
      const rows = await readProcTable(proc)
      expect(rows?.sort((a, b) => a.pid - b.pid)).toEqual([
        { pid: 2, parentPid: 0, name: 'kthreadd', commandLine: null },
        { pid: 702, parentPid: 701, name: 'claude', commandLine: 'claude --name my session' },
        { pid: 733, parentPid: 702, name: 'node', commandLine: 'node server.mjs' }
      ])
    })

    it('lists a session’s tree and its ports from the process and socket tables', async () => {
      const facts = await readLinuxProcesses(1000, runner({ 'ss -ltnpH': ok(SS) }), proc)
      const session = sessionResources(1, 702, { ...facts, atMs: 0, durationMs: 0 })
      expect(session.processes?.map((row) => [row.pid, row.commandLine, row.ports])).toEqual([
        [702, 'claude --name my session', []],
        [733, 'node server.mjs', [5173]]
      ])
      expect(session.ports).toEqual([{ port: 5173, pid: 733, process: 'node', addresses: ['127.0.0.1', '::1'] }])
    })

    it('shows the ports as unknown, never empty, when ss cannot be run or fails, and keeps the tree', async () => {
      for (const ss of [null, { stdout: '', stderr: 'Cannot open netlink socket', code: 1 }]) {
        const facts = await readLinuxProcesses(1000, runner({ 'ss -ltnpH': ss }), proc)
        expect(facts.ports).toBeNull()
        const session = sessionResources(1, 702, { ...facts, atMs: 0, durationMs: 0 })
        expect(session.ports).toBeNull()
        expect(session.processes?.map((row) => row.pid)).toEqual([702, 733])
      }
    })

    it('shows the processes as unknown when the process table cannot be listed', async () => {
      const facts = await readLinuxProcesses(1000, runner({ 'ss -ltnpH': ok(SS) }), join(proc, 'missing'))
      expect(facts.processes).toBeNull()
      expect(facts.ports).toHaveLength(4)
      expect(sessionResources(1, 702, { ...facts, atMs: 0, durationMs: 0 }).processes).toBeNull()
    })
  })
})

describe('the Windows reader', () => {
  it('reads the CIM pass, keeping a failed half apart from an empty one', () => {
    const pass = JSON.stringify({
      processesRead: true,
      portsRead: false,
      processes: [{ p: 10, r: 4, n: 'cmd.exe', c: 'cmd /c claude' }, { p: 11, r: 10, n: 'claude.exe', c: null }],
      ports: []
    })
    expect(parseWindowsPass(pass)).toEqual({
      processes: [
        { pid: 10, parentPid: 4, name: 'cmd.exe', commandLine: 'cmd /c claude' },
        { pid: 11, parentPid: 10, name: 'claude.exe', commandLine: null }
      ],
      ports: null
    })
    expect(parseWindowsPass('not json')).toEqual({ processes: null, ports: null })
  })
})

describe('the pass', () => {
  it('has a reader for Windows, macOS and Linux, and reports unknown elsewhere', async () => {
    expect(processTableReader('win32')).not.toBeNull()
    expect(processTableReader('darwin')).not.toBeNull()
    expect(processTableReader('linux')).not.toBeNull()
    expect(processTableReader('aix')).toBeNull()
    const snapshot = await readProcessSnapshot(1000, 'aix')
    expect(snapshot).toMatchObject({ processes: null, ports: null })
  })
})

/**
 * The live read, on the OS that is running the tests: a parent that starts a
 * child, and the child listening on a port. The pass has to find both and say
 * which one holds the port.
 */
describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('a live read on this machine', () => {
  let root: string
  let parent: ChildProcess
  let found: { child: number; port: number }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'helm live pass-'))
    writeFileSync(
      join(root, 'listen.mjs'),
      `import { createServer } from 'node:http'
const server = createServer(() => undefined)
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ child: process.pid, port: server.address().port }) + '\\n'))`
    )
    writeFileSync(
      join(root, 'parent.mjs'),
      `import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
spawn(process.execPath, [fileURLToPath(new URL('./listen.mjs', import.meta.url)),'--helm-live-pass'], { stdio: ['ignore', 'inherit', 'inherit'] })
setInterval(() => {}, 1000)`
    )
    parent = spawn(process.execPath, [join(root, 'parent.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] })
    found = await new Promise((resolve, reject) => {
      parent.stdout?.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8')) as typeof found))
      parent.once('exit', () => reject(new Error('the parent exited before its child listened')))
    })
  })

  afterAll(() => {
    try {
      process.kill(found.child, 'SIGKILL')
    } catch {
      // Already gone.
    }
    parent.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  })

  it('lists the session’s processes with their command lines and the port its child holds', async () => {
    const snapshot = await readProcessSnapshot()
    expect(snapshot.processes).not.toBeNull()
    expect(snapshot.ports).not.toBeNull()
    const session = sessionResources(1, parent.pid ?? -1, snapshot)
    expect(session.rootSeen).toBe(true)
    const child = session.processes?.find((row) => row.pid === found.child)
    expect(child).toMatchObject({ parentPid: parent.pid, depth: 1, ports: [found.port] })
    expect(child?.commandLine).toContain('--helm-live-pass')
    expect(session.ports).toEqual([
      expect.objectContaining({ port: found.port, pid: found.child, addresses: ['127.0.0.1'] })
    ])
  })
})
