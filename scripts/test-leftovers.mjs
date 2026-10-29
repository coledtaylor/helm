// Fails a test step that left anything behind: a test temp folder or a
// process it started that is still running.
//
//   node scripts/test-leftovers.mjs <command> [args...]   # the local command
//   node scripts/test-leftovers.mjs before <state-file>   # CI: before the step
//   node scripts/test-leftovers.mjs after <state-file>    # CI: after it
//
// `before` records the process table, the test temp folders already in the
// temp folder, the folder it runs from (the checkout) and a random mark for
// the step. When `GITHUB_ENV` is set it appends `TEST_LEFTOVERS_MARK=<mark>`
// to that file, so the CI steps after it, and everything they start, carry
// the mark in their environment. `after` lists what the step left: each test
// temp folder that was not there before, by its full path, and each process of
// a kind tests start that the step started and is still alive, by pid, name
// and command line. It exits 1 when it lists anything, 0 otherwise. The
// wrapper form does both around one command, run through the shell as a
// package script is with the mark in its environment, and exits with the
// command's status when it failed, or 1 for leftovers.
//
// A process the step left on Windows names its dead parent, which is enough
// to tell it is the step's. On macOS and Linux it is adopted by init, launchd
// or a subreaper, which also starts every daemon (the runner's own updater,
// a systemd service), so the table alone cannot tell the two apart there. An
// adopted process counts as the step's only when the step marked it: it
// carries the step's mark in its environment, or it runs inside a test temp
// folder or the checkout. The second is what marks a leaked host session or
// plugin program, which the host starts with a cleared environment. A process
// whose environment and working folder cannot be read is not the step's.
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
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The environment variable that carries a step's mark into what it starts. */
export const MARK_VARIABLE = 'TEST_LEFTOVERS_MARK'

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
 * - running out of live parents means it was the step's, and it is reported:
 *   a Windows orphan names a dead parent;
 * - reaching one of the check's ancestors that was there before and adopts
 *   orphans (init, launchd or a subreaper) means it was orphaned by the step
 *   or started by that reaper as a daemon, and the table cannot say which. It
 *   is reported only when the step marked it or a process between it and the
 *   reaper (`inspect` says it carries the mark, or runs inside a test temp
 *   folder or the checkout, as `places` names them);
 * - reaching any other ancestor of the check that was there before means that
 *   ancestor started it beside the check (vitest's other workers around the
 *   check's own test, Helm's other sessions around a check run in one of its
 *   terminals), and it is not reported: what the step started descends from
 *   the check, or was orphaned and adopted by a reaper.
 *
 * `inspect` is asked only about processes that reach a reaper, once each.
 * `processes` is null on either side when the table could not be read, and
 * then only folders are judged.
 */
export function selectLeftovers({ before, after, self, tmp, places, inspect }) {
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

  const inspected = new Map()
  const markedByStep = (row) => {
    if (!inspected.has(row.pid)) {
      const { marked, cwd } = inspect(row.pid)
      inspected.set(row.pid, marked || (cwd !== null && inStepPlace(cwd, places)))
    }
    return inspected.get(row.pid)
  }

  const processes = after.processes.filter((row) => {
    if (existed.has(key(row)) || !isTestProcess(row.name) || checkAncestors.has(row.pid)) return false
    const adopted = [row]
    for (const parent of chain(row)) {
      if (parent.pid === self) return false
      const old = existed.has(key(parent))
      if (checkAncestors.has(parent.pid)) return old && isReaper(parent) && adopted.some(markedByStep)
      if (old) return false
      adopted.push(parent)
    }
    return true
  })
  return { folders, processes }
}

/** True when `path` is `folder` or inside it. */
function isWithin(folder, path) {
  const rest = relative(folder, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/** True for a working folder inside a test temp folder or the checkout. */
function inStepPlace(cwd, { temps, checkouts }) {
  return (
    checkouts.some((checkout) => isWithin(checkout, cwd)) ||
    temps.some((temp) => {
      const rest = relative(temp, cwd)
      return rest !== '' && isWithin(temp, cwd) && isTestFolder(rest.split(sep, 1)[0])
    })
  )
}

/** A path as given and as the file system resolves it, which is how a process's working folder reads. */
function bothSpellings(path) {
  try {
    const real = realpathSync(path)
    return real === path ? [path] : [path, real]
  } catch {
    return [path]
  }
}

/**
 * The folders a step's processes run in: the temp folder its test folders are
 * made in, and the checkout. macOS reaches its temp folder through a link
 * (`/var` is `/private/var`), and a process's working folder reads resolved.
 */
export function stepPlaces(tmp, checkout) {
  return { temps: bothSpellings(tmp), checkouts: bothSpellings(checkout) }
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
 * The process table, read the one way each OS offers: with `inspectProcess`
 * below, the only place this script branches on the OS. Null for an OS it
 * has no listing for, which leaves the folders still checked. `run` is
 * `execFileSync`'s shape, passed in so a test can see what each listing is
 * run with.
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

/** The working folder in `lsof -Fn` output: the line starting with `n`. Null when there is none. */
export function parseLsofCwd(text) {
  const line = text.split('\n').find((l) => l.startsWith('n'))
  return line === undefined || line.length === 1 ? null : line.slice(1).trimEnd()
}

/** What `inspectProcess` reads with, passed in so a test can answer for the OS. */
const SYSTEM_IO = { run: execFileSync, readFile: readFileSync, readLink: readlinkSync }

const attempt = (read, fallback) => {
  try {
    return read()
  } catch {
    return fallback
  }
}

/**
 * Whether a process carries the step's mark in its environment, and its
 * working folder, read beside the process table the way each OS offers, and
 * asked only about a process a reaper adopted. Either reads as unmarked or null
 * when the OS will not say (another user's process, or one that has ended).
 * Linux has both under `/proc`, where a working folder that was removed
 * reads with ` (deleted)` after its path. macOS prints the environment after
 * the command line in `ps -E` and the working folder in `lsof`.
 */
export function inspectProcess(pid, mark, platform = process.platform, io = SYSTEM_IO) {
  const entry = `${MARK_VARIABLE}=${mark}`
  const carries = (words) => typeof mark === 'string' && mark !== '' && words.includes(entry)
  switch (platform) {
    case 'linux':
      return {
        marked: attempt(() => carries(io.readFile(`/proc/${pid}/environ`, 'utf8').split('\0')), false),
        cwd: attempt(() => io.readLink(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ''), null)
      }
    case 'darwin':
      return {
        marked: attempt(() => carries(io.run('ps', ['-wwE', '-o', 'command=', '-p', String(pid)], LIST_OPTIONS).split(/\s+/)), false),
        cwd: attempt(() => parseLsofCwd(io.run('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], LIST_OPTIONS)), null)
      }
    default:
      return { marked: false, cwd: null }
  }
}

/** The process table and the temp folder's test folders, now. */
export function snapshot(tmp = tmpdir()) {
  return { tmp, processes: readProcessTable(), folders: readdirSync(tmp).filter(isTestFolder) }
}

/**
 * The state a step is checked against: a snapshot, the folder the check runs
 * from, and a new mark. With `githubEnv`, the mark is appended to that file,
 * so the CI steps after this one inherit it.
 */
export function begin({ githubEnv, tmp = tmpdir(), checkout = process.cwd() } = {}) {
  const mark = randomBytes(16).toString('hex')
  if (githubEnv) appendFileSync(githubEnv, `${MARK_VARIABLE}=${mark}\n`)
  return { ...snapshot(tmp), checkout, mark }
}

/** Checks a state taken before the step against now, prints what was left, and answers the exit code. */
export function check(before) {
  const after = snapshot(before.tmp)
  const leftovers = selectLeftovers({
    before,
    after,
    self: process.pid,
    tmp: before.tmp,
    places: stepPlaces(before.tmp, before.checkout),
    inspect: (pid) => inspectProcess(pid, before.mark)
  })
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
      writeFileSync(rest[0], JSON.stringify(begin({ githubEnv: process.env.GITHUB_ENV })))
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

  const before = begin()
  // The command is a test command's own words (`pnpm check`, `cargo nextest
  // run`), found on the PATH, so it goes through the shell as a package
  // script's does.
  const result = spawnSync(argv.map(word).join(' '), {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, [MARK_VARIABLE]: before.mark }
  })
  if (result.error) console.error(result.error.message)
  const status = result.error ? 1 : (result.status ?? 1)
  const leftovers = check(before)
  return status !== 0 ? status : leftovers
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
