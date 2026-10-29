// Fails a test step that left anything behind: a test temp folder or a
// process it started that is still running.
//
//   node scripts/test-leftovers.mjs <command> [args...]   # the local command
//   node scripts/test-leftovers.mjs before <state-file>   # CI: before the step
//   node scripts/test-leftovers.mjs after <state-file>    # CI: after it
//
// `before` records the process table and the test temp folders already in the
// temp folder. `after` lists what the step left: each test temp folder that
// was not there before, by its full path, and each process of a kind tests
// start that the step started and is still alive, by pid, name and command
// line. It exits 1 when it lists anything, 0 otherwise. The wrapper form does
// both around one command, run through the shell as a package script is, and
// exits with the command's status when it failed, or 1 for leftovers.
//
// It only reports. It never deletes a folder or ends a process: what a test
// left is evidence, and a process here may be someone else's.
//
// Only what appeared during the step is reported, so a machine already running
// other sessions, their hosts and fake agents, or holding earlier runs' folders
// in its temp folder, still passes. A tool's own cache in the temp folder
// (Node's node-compile-cache) is not a test's folder, and a process of a kind
// tests never start (a linker's PDB server) is not a test's process.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The folders tests make in the OS temp folder: the host testkit's `TestDirs`,
 * the desktop tests' world, and `pnpm test:posix`'s mirror. Rust's tempfile
 * uses the same temp folder as `os.tmpdir()`.
 */
export const TEST_FOLDER_PREFIXES = ['floti test ', 'helm world-', 'helm-test-posix-']

/**
 * The kinds of process tests start: every `floti*` binary of crates/host, Node
 * (the fake agents, vitest's workers), shells, and the console host Windows
 * gives a console program. Names are as `processName` normalises them.
 */
const TEST_PROCESS_NAMES = new Set(['node', 'sh', 'bash', 'dash', 'zsh', 'cmd', 'powershell', 'pwsh', 'conhost'])

/**
 * The processes that adopt an orphan on macOS and Linux: init (pid 1, and the
 * `/init` relay WSL runs each session under), systemd as a user's subreaper,
 * and launchd. Windows adopts nothing: an orphan keeps naming its dead parent.
 */
const REAPER_NAMES = new Set(['init', 'systemd', 'launchd'])

/** True for a process that adopts orphans, by its name or the program it runs. */
function isReaper(row) {
  const program = row.commandLine === null ? '' : processName(row.commandLine.split(/\s/, 1)[0])
  return row.pid === 1 || REAPER_NAMES.has(row.name) || REAPER_NAMES.has(program)
}

/** True for a temp folder entry a test made. */
export function isTestFolder(name) {
  return TEST_FOLDER_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** True for a process name of a kind tests start. */
export function isTestProcess(name) {
  return name.startsWith('floti') || TEST_PROCESS_NAMES.has(name)
}

/**
 * A process's name the same way on every OS: the executable's base name,
 * lower case, without `.exe`. macOS reports a path, Windows `node.exe`.
 */
export function processName(raw) {
  const base = raw.split(/[\\/]/).pop() ?? raw
  return base.replace(/\.exe$/i, '').toLowerCase()
}

/**
 * What the step left behind, from the table before it and the table after.
 *
 * A process counts when it is alive after the step, was not in the table
 * before (by pid and start time, so a reused pid is a different process), is
 * of a kind tests start, and is neither the check, one of its ancestors nor
 * something the check started (its lister). Its parents are then walked while
 * they are alive (a parent that started after its child is a reused pid, so
 * the walk ends there):
 *
 * - reaching a process that was there before and is not one of the check's
 *   ancestors means it belongs to someone else (another session's agent), and
 *   it is not reported;
 * - reaching one of the check's ancestors that started after the snapshot
 *   (the after-step's own shell and its console host in CI) means it is the
 *   check's, and it is not reported;
 * - reaching one of the check's ancestors that was there before and adopts
 *   orphans (init or a subreaper), or running out of live parents, means it
 *   was the step's, and it is reported. A Windows orphan names a dead parent,
 *   and a POSIX orphan is re-parented to init or a subreaper, which are the
 *   check's ancestors too;
 * - reaching any other ancestor of the check that was there before means that
 *   ancestor started it beside the check (vitest's other workers around the
 *   check's own test, Helm's other sessions around a check run in one of its
 *   terminals), and it is not reported: what the step started descends from
 *   the check, or was orphaned and adopted by a reaper.
 *
 * `processes` is null on either side when the table could not be read, and
 * then only folders are judged.
 */
export function selectLeftovers({ before, after, self, tmp }) {
  const beforeFolders = new Set(before.folders)
  const folders = after.folders.filter((name) => isTestFolder(name) && !beforeFolders.has(name)).map((name) => join(tmp, name))
  if (before.processes === null || after.processes === null) return { folders, processes: null }

  const key = (row) => `${row.pid}@${row.start}`
  const existed = new Set(before.processes.map(key))
  const byPid = new Map(after.processes.map((row) => [row.pid, row]))
  const parentOf = (row) => {
    const parent = byPid.get(row.parentPid)
    return parent !== undefined && parent.pid !== row.pid && parent.start <= row.start ? parent : undefined
  }
  const chain = (row) => {
    const seen = []
    const visited = new Set()
    for (let at = parentOf(row); at !== undefined && !visited.has(at.pid); at = parentOf(at)) {
      visited.add(at.pid)
      seen.push(at)
    }
    return seen
  }

  const selfRow = byPid.get(self)
  const checkAncestors = new Set(selfRow === undefined ? [self] : [self, ...chain(selfRow).map((row) => row.pid)])

  const processes = after.processes.filter((row) => {
    if (existed.has(key(row)) || !isTestProcess(row.name) || checkAncestors.has(row.pid)) return false
    for (const parent of chain(row)) {
      if (parent.pid === self) return false
      const old = existed.has(key(parent))
      if (checkAncestors.has(parent.pid)) return old && isReaper(parent)
      if (old) return false
    }
    return true
  })
  return { folders, processes }
}

/** One report line per leftover, or none when there are none. */
export function formatLeftovers({ folders, processes }) {
  return [
    ...folders.map((path) => `  folder   ${path}`),
    ...(processes ?? []).map((row) => `  process  ${row.pid} ${row.name} ${row.commandLine ?? '(command line not readable)'}`)
  ]
}

/**
 * The Windows table, as one PowerShell pass with no double quote in it (see
 * `PASS_SCRIPT` in packages/desktop/src/main/processes.ts for why). A process
 * Windows gives no creation time (System, Idle) reads 0.
 */
const WINDOWS_TABLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate |
  ForEach-Object {
    $start = 0
    if ($_.CreationDate) { $start = [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }
    [pscustomobject]@{ p = [int]$_.ProcessId; r = [int]$_.ParentProcessId; n = $_.Name; c = $_.CommandLine; s = $start }
  })
ConvertTo-Json -InputObject $rows -Compress -Depth 2
`

/** Parses the Windows pass's JSON into table rows. */
export function parseWindowsTable(text) {
  const value = JSON.parse(text)
  const rows = Array.isArray(value) ? value : [value]
  return rows.flatMap((row) =>
    typeof row?.p === 'number'
      ? [
          {
            pid: row.p,
            parentPid: typeof row.r === 'number' ? row.r : 0,
            name: processName(typeof row.n === 'string' ? row.n : String(row.p)),
            commandLine: typeof row.c === 'string' && row.c !== '' ? row.c : null,
            start: typeof row.s === 'number' ? row.s : 0
          }
        ]
      : []
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Parses `ps -o pid=,ppid=,lstart=,comm=` (under the C locale, so `lstart` is
 * `Wed Oct 29 00:54:12 2026`) and `ps -o pid=,args=` into table rows. The
 * name is everything after the start time, so a name with a space survives.
 */
export function parsePsTable(table, args) {
  const commandLines = new Map()
  for (const line of args.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line)
    if (match) commandLines.set(Number(match[1]), match[2].trim() || null)
  }
  return table.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)\s(.*)$/.exec(line)
    if (!match) return []
    const [, pid, parentPid, month, day, hour, minute, second, year, comm] = match
    const start = new Date(+year, MONTHS.indexOf(month), +day, +hour, +minute, +second).getTime()
    const commandLine = commandLines.get(Number(pid)) ?? null
    // Linux names a process after its main thread, which Node 24 calls
    // `MainThread`, so the program the command line ran names a test kind
    // when the thread name does not.
    const program = commandLine === null ? '' : processName(commandLine.split(/\s/, 1)[0])
    const name = processName(comm.trim())
    return [
      {
        pid: Number(pid),
        parentPid: Number(parentPid),
        name: !isTestProcess(name) && isTestProcess(program) ? program : name,
        commandLine,
        start
      }
    ]
  })
}

// The lister's stderr is captured rather than inherited, so it reaches the
// report only as the error of a listing that failed.
const LIST_OPTIONS = { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }

/**
 * Runs the Windows pass with a temp folder of its own, removed once it ends.
 * PowerShell writes a pair of `__PSScriptPolicyTest_*` files into its TEMP at
 * every start and, on a loaded machine, does not always manage to delete them;
 * in the temp folder this script checks, they would be the check's own litter.
 */
function readWindowsTable(run) {
  const own = mkdtempSync(join(tmpdir(), 'test-leftovers powershell-'))
  try {
    return parseWindowsTable(
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TABLE_SCRIPT], {
        ...LIST_OPTIONS,
        env: { ...process.env, TEMP: own, TMP: own }
      })
    )
  } finally {
    // Retried because an antivirus scan of PowerShell's files can hold them a moment.
    rmSync(own, { recursive: true, force: true, maxRetries: 5 })
  }
}

/**
 * The process table, read the one way each OS offers: the one place this
 * script branches on the OS. Null for an OS it has no listing for, which
 * leaves the folders still checked. `run` is `execFileSync`'s shape, passed
 * in so a test can see what each listing is run with.
 */
export function readProcessTable(platform = process.platform, run = execFileSync) {
  switch (platform) {
    case 'win32':
      return readWindowsTable(run)
    case 'darwin':
    case 'linux': {
      const env = { ...process.env, LC_ALL: 'C' }
      return parsePsTable(
        run('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], { ...LIST_OPTIONS, env }),
        run('ps', ['-A', '-o', 'pid=,args='], { ...LIST_OPTIONS, env })
      )
    }
    default:
      return null
  }
}

/** The process table and the temp folder's test folders, now. */
export function snapshot(tmp = tmpdir()) {
  return { tmp, processes: readProcessTable(), folders: readdirSync(tmp).filter(isTestFolder) }
}

/** Checks a snapshot taken before the step against now, prints what was left, and answers the exit code. */
export function check(before) {
  const after = snapshot(before.tmp)
  const leftovers = selectLeftovers({ before, after, self: process.pid, tmp: before.tmp })
  if (leftovers.processes === null) {
    console.log(`test-leftovers: no process listing on ${process.platform}; checked the temp folder only`)
  }
  const lines = formatLeftovers(leftovers)
  if (lines.length === 0) {
    console.log('test-leftovers: the step left nothing behind')
    return 0
  }
  console.error(['test-leftovers: the step left these behind:', ...lines].join('\n'))
  return 1
}

// A word with no space or quote goes as it is, anything else in double
// quotes, which cmd.exe and sh both read back as one argument.
const word = (arg) => (/^[^\s"']+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`)

function main(argv) {
  const [first, ...rest] = argv
  if ((first === 'before' || first === 'after') && rest.length === 1) {
    if (first === 'before') {
      writeFileSync(rest[0], JSON.stringify(snapshot()))
      return 0
    }
    return check(JSON.parse(readFileSync(rest[0], 'utf8')))
  }
  if (first === undefined || first === 'before' || first === 'after') {
    console.error(
      'usage: node scripts/test-leftovers.mjs <command> [args...]\n' +
        '       node scripts/test-leftovers.mjs before|after <state-file>'
    )
    return 2
  }

  const before = snapshot()
  // The command is a test command's own words (`pnpm check`, `cargo nextest
  // run`), found on the PATH, so it goes through the shell as a package
  // script's does.
  const result = spawnSync(argv.map(word).join(' '), { stdio: 'inherit', shell: true })
  if (result.error) console.error(result.error.message)
  const status = result.error ? 1 : (result.status ?? 1)
  const leftovers = check(before)
  return status !== 0 ? status : leftovers
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
