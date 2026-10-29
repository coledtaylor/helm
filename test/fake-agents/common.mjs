// What every fake agent CLI shares: reading argv the way a commander-style
// parser does, and the run log each fake writes about itself.
//
// One fake per backend lives beside this file, named after the backend's id
// (`claude-code.mjs`). Each one does what Floti and Helm can observe of the
// real CLI, deterministically and with no network, and logs what it was given
// to `<its config dir>/fake-agent/<pid>.json` in the shape `RunLog` below, so
// the host's Rust tests and the desktop's TypeScript tests read one format.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The file that names the test process owning every fake started under the
 * folder it is in: a test's world (`createWorld`) or the host testkit's
 * `TestDirs` writes its own pid there. A fake looks for it from its run-log
 * folder up, and exits once that process is gone, so a fake whose test
 * crashed or was killed does not outlive it. The owner is the test process,
 * never the fake's parent: a session that leaves its agent running when it is
 * closed still leaves it running for as long as the test does.
 *
 * A file rather than a variable or an argument, because the fake must read
 * its arguments as the CLI does, and the host clears a session's environment.
 */
export const OWNER_FILE = 'test-owner'

/** How often a fake asks whether its owner is still running. */
export const OWNER_POLL_MS = 250

/**
 * The pid in the nearest `OWNER_FILE` at or above `folder`, or null when
 * there is none: a fake run outside any test's folder has no owner.
 */
export function findOwner(folder) {
  for (let dir = folder; ; dir = dirname(dir)) {
    let text = null
    try {
      text = readFileSync(join(dir, OWNER_FILE), 'utf8')
    } catch {
      // None here; look further up.
    }
    const pid = text === null ? NaN : Number(text.trim())
    if (Number.isSafeInteger(pid) && pid > 0) return pid
    if (dirname(dir) === dir) return null
  }
}

/** Whether `pid` is running: signal 0 sends nothing, and EPERM means it runs as someone else. */
export function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Calls `onGone` once the owner `findOwner(folder)` names has exited, polling
 * on a timer that keeps nothing alive by itself. Does nothing when there is
 * no owner.
 */
export function watchOwner(folder, onGone) {
  const owner = findOwner(folder)
  if (owner === null) return
  const timer = setInterval(() => {
    if (isRunning(owner)) return
    clearInterval(timer)
    onGone()
  }, OWNER_POLL_MS)
  timer.unref()
}

/**
 * The script for `node -e` that a fake runs as a long-lived child of its own:
 * it does nothing until the owner `findOwner(folder)` names has exited, and
 * nothing forever when there is none.
 */
export function childScript(folder) {
  const owner = findOwner(folder)
  if (owner === null) return 'setInterval(() => {}, 1 << 30)'
  return (
    `setInterval(() => { try { process.kill(${String(owner)}, 0) } ` +
    `catch (error) { if (error.code !== 'EPERM') process.exit(0) } }, ${String(OWNER_POLL_MS)})`
  )
}

/**
 * The version a fake reports: its own default, or the one a test asks for
 * through `FAKE_AGENT_VERSION`, so a version-range check can be driven to
 * either side of a boundary.
 */
export function fakeVersion(fallback) {
  const asked = (process.env.FAKE_AGENT_VERSION ?? '').trim()
  return asked === '' ? fallback : asked
}

/**
 * The error a commander-style CLI prints for bad usage, and its exit code.
 */
export class UsageError extends Error {}

/**
 * Reads `argv` against `spec`, the way commander does:
 *
 * - `spec.options` maps every spelling of an option (`-n`, `--name`) to
 *   `{ key, arity }`, where `arity` is `flag` (no value), `value` (exactly
 *   one), `optional` (one, unless the next argument starts with a dash) or
 *   `variadic` (every argument up to the next one that starts with a dash, or
 *   `--`).
 * - `--flag=value` is accepted for an option that takes a value.
 * - `--` ends the options: everything after it is positional, whatever it
 *   starts with. That is what keeps a prompt out of a variadic list.
 * - An option it does not know is the CLI's `error: unknown option '<it>'`.
 * - `spec.commands` names the subcommands; when the first argument is one,
 *   parsing stops and the rest is returned unread.
 *
 * Answers `{ command, rest, options, positionals }`. A repeated variadic option
 * adds to its list; a repeated single one keeps the last value.
 */
export function parseArgv(argv, spec) {
  if (argv.length > 0 && (spec.commands ?? []).includes(argv[0])) {
    return { command: argv[0], rest: argv.slice(1), options: {}, positionals: [] }
  }
  const options = {}
  const positionals = []
  const takesValue = (arg) => arg !== undefined && !arg.startsWith('-')
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]
    if (arg === '--') {
      positionals.push(...argv.slice(at + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg)
      continue
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined
    const option = spec.options[name]
    if (option === undefined) throw new UsageError(`unknown option '${name}'`)
    const { key, arity } = option
    if (arity === 'flag') {
      if (inline !== undefined) throw new UsageError(`option '${name}' does not take a value`)
      options[key] = true
    } else if (arity === 'value') {
      if (inline !== undefined) {
        options[key] = inline
      } else if (at + 1 < argv.length) {
        // A required value is taken whatever it looks like, as commander does.
        options[key] = argv[++at]
      } else {
        throw new UsageError(`option '${name}' argument missing`)
      }
    } else if (arity === 'optional') {
      if (inline !== undefined) options[key] = inline
      else if (takesValue(argv[at + 1])) options[key] = argv[++at]
      else options[key] = true
    } else {
      const list = (options[key] ??= [])
      if (inline !== undefined) list.push(inline)
      while (takesValue(argv[at + 1])) list.push(argv[++at])
      if (list.length === 0) throw new UsageError(`option '${name}' argument missing`)
    }
  }
  return { command: null, rest: [], options, positionals }
}

/**
 * The run log: one JSON file per run, rewritten whole on every change through
 * a temporary file and a rename, so a reader never sees half of one.
 *
 * Every fake fills the same fields:
 *
 * - `backend`: the backend id the fake stands in for.
 * - `pid`, `argv` (without the program), `cwd`.
 * - `settings`: each settings source it loaded, in load order, as
 *   `{ source, path, value }`; `path` is null for settings given inline.
 * - `instructionFiles`: every instruction file it loaded, outermost first.
 * - `composedInstructions`: text it was handed to add to its instructions
 *   (Claude Code's `--append-system-prompt-file`), or null.
 * - `openingPrompt`: the prompt it was started with, or null.
 * - `mcpServers`: the MCP servers it loaded, by name.
 * - `received`: every line typed at its prompt.
 * - `exitCode`: null while it runs.
 *
 * A fake adds fields of its own after these.
 */
export class RunLog {
  constructor(configDir, fields) {
    this.file = join(configDir, 'fake-agent', `${String(process.pid)}.json`)
    this.data = {
      backend: fields.backend,
      pid: process.pid,
      argv: fields.argv,
      cwd: process.cwd(),
      settings: [],
      instructionFiles: [],
      composedInstructions: null,
      openingPrompt: null,
      mcpServers: {},
      received: [],
      exitCode: null,
      ...fields
    }
  }

  save() {
    writeJsonAtomically(this.file, this.data)
  }
}

/** Writes `value` as JSON through a temporary file and a rename. */
export function writeJsonAtomically(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  const text = JSON.stringify(value, null, 2)
  writeFileSync(temporary, text)
  // A reader holding the file open makes the rename fail on Windows for as long
  // as it reads, which is a moment, so the rename is tried again. Writing in
  // place instead would truncate the file first, and a test polling the log
  // would read it empty.
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temporary, file)
      return
    } catch (error) {
      if (attempt === RENAME_ATTEMPTS) {
        rmSync(temporary, { force: true })
        throw error
      }
      sleepSync(RENAME_RETRY_MS)
    }
  }
}

/** About a second of tries, far longer than any reader holds the file. */
const RENAME_ATTEMPTS = 100
const RENAME_RETRY_MS = 10

/** Blocks for `ms`: the fake writes synchronously, from handlers that cannot wait. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
