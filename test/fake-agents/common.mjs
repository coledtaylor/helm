// What every fake agent CLI shares: reading argv the way a commander-style
// parser does, reading what is typed at a prompt (keys, a bracketed paste, the
// agent's stop key), and the run log each fake writes about itself.
//
// One fake per backend lives beside this file, named after the backend's id
// (`claude-code.mjs`). Each one does what Floti and Helm can observe of the
// real CLI, deterministically and with no network, and logs what it was given
// to `<its config dir>/fake-agent/<pid>.json` in the shape `RunLog` below, so
// the host's Rust tests and the desktop's TypeScript tests read one format.

import { spawn } from 'node:child_process'
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
 *   `--`) or `repeat` (exactly one, taken whatever it looks like, and added to
 *   a list each time the option is given, so a positional argument after it
 *   stays a positional argument).
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
    } else if (arity === 'repeat') {
      const list = (options[key] ??= [])
      if (inline !== undefined) list.push(inline)
      else if (at + 1 < argv.length) list.push(argv[++at])
      else throw new UsageError(`option '${name}' argument missing`)
    } else {
      const list = (options[key] ??= [])
      if (inline !== undefined) list.push(inline)
      while (takesValue(argv[at + 1])) list.push(argv[++at])
      if (list.length === 0) throw new UsageError(`option '${name}' argument missing`)
    }
  }
  return { command: null, rest: [], options, positionals }
}

/** What a terminal sends before and after pasted text when the program asked for bracketed paste. */
export const PASTE_OPEN = '\x1b[200~'
export const PASTE_CLOSE = '\x1b[201~'

/** What a program writes to ask its terminal for bracketed paste. */
export const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'

/**
 * Reads what is typed at a fake's prompt, as the agent's own input handling
 * does:
 *
 * - Text between a paste's open and close markers is one block, whatever it
 *   holds: its newlines do not submit. `onPaste(text, withSubmit)` is called
 *   once the close arrives. A submit key that comes in the same read as the
 *   close is taken as part of the paste, not as a keypress: `withSubmit` is
 *   then true and nothing is submitted, as an agent that reads a paste and the
 *   key after it as one input does. A host that wants the paste submitted must
 *   press the key in a read of its own, after a pause.
 * - `stopKey` alone in a read (or as a control character among typed text) is
 *   the agent's stop key: `onStop()`.
 * - Every other escape sequence (arrows, focus and mouse reports) is dropped
 *   whole, after `onSequence(sequence)`.
 * - Each other character is `onKey(character)`.
 *
 * The close marker is looked for in the read it is in; a marker split across
 * two reads is not joined, which a host that writes one paste in one go never
 * does.
 */
export class InputReader {
  constructor({ submitKey, stopKey, onKey, onPaste, onStop, onSequence }) {
    this.submitKey = submitKey
    this.stopKey = stopKey
    this.onKey = onKey
    this.onPaste = onPaste
    this.onStop = onStop
    this.onSequence = onSequence ?? (() => {})
    this.pasting = false
    this.pasted = ''
  }

  /** Reads `chunk`, one read of the program's input. */
  feed(chunk) {
    let rest = chunk
    while (rest !== '') {
      if (this.pasting) {
        const end = rest.indexOf(PASTE_CLOSE)
        if (end < 0) {
          this.pasted += rest
          return
        }
        const text = (this.pasted + rest.slice(0, end)).replace(/\r\n?/g, '\n')
        this.pasted = ''
        this.pasting = false
        rest = rest.slice(end + PASTE_CLOSE.length)
        const withSubmit = rest.startsWith(this.submitKey)
        if (withSubmit) rest = rest.slice(this.submitKey.length)
        this.onPaste(text, withSubmit)
        continue
      }
      const open = rest.indexOf(PASTE_OPEN)
      this.keys(open < 0 ? rest : rest.slice(0, open))
      if (open < 0) return
      rest = rest.slice(open + PASTE_OPEN.length)
      this.pasting = true
    }
  }

  /** Typed text and escape sequences, without a paste. */
  keys(text) {
    // Matching ESC is the point of the pattern.
    // eslint-disable-next-line no-control-regex
    for (const part of text.split(/(\x1b\[[0-?]*[ -/]*[@-~]|\x1b.)/)) {
      if (part === '') continue
      if (part === this.stopKey) {
        this.onStop()
      } else if (part.startsWith('\x1b')) {
        this.onSequence(part)
      } else {
        for (const key of part) {
          if (key === this.stopKey) this.onStop()
          else this.onKey(key)
        }
      }
    }
  }
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
 * - `openingPrompt`: the prompt it was started with, or null. A reopened
 *   conversation records the prompt given with it, the next turn, the same way
 *   (`resumed` says it was reopened).
 * - `mcpServers`: the MCP servers it loaded, by name.
 * - `received`: every line typed at its prompt, in order, including a line
 *   that was queued behind a turn in progress.
 * - `submitKeys`: the key that submitted each of `received`, in order, as the
 *   text the key arrives as (CR or LF).
 * - `pastes`: every bracketed paste taken, as `{ text, withSubmit }`; `text`
 *   is the pasted block as one string, newlines inside it kept, and
 *   `withSubmit` is true when the submit key arrived in the same read as the
 *   end of the paste, which is then part of the paste and submits nothing.
 * - `prompts`: each line taken as a prompt turn, in the order the turns ran.
 * - `queued`: each line typed while a turn was running, in order; it is taken
 *   as the next turn once that turn ends.
 * - `interrupts`: how many times its stop key ended a running turn.
 * - `answers`: each key that answered the permission prompt `/wait` raised.
 * - `shell`: every command `/shell` ran, as `{ command, stdout, stderr, code }`
 *   (`runShell` below); `code` is null while it runs.
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
      submitKeys: [],
      pastes: [],
      prompts: [],
      queued: [],
      interrupts: 0,
      answers: [],
      shell: [],
      exitCode: null,
      ...fields
    }
  }

  save() {
    writeJsonAtomically(this.file, this.data)
  }
}

/**
 * Runs `command` in the shell with this process's own environment and working
 * folder, as an agent's shell tool does, and records it in `log.shell` as
 * `{ command, stdout, stderr, code }` (`code` is null until it ends). Calls
 * `done` with the finished entry. What the session was given reaches the
 * command, so a test sees what a program run from a session sees.
 */
export function runShell(command, log, save, done) {
  const entry = { command, stdout: '', stderr: '', code: null }
  log.shell.push(entry)
  save()
  const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    entry.stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    entry.stderr += chunk
  })
  let finished = false
  const finish = (code) => {
    if (finished) return
    finished = true
    entry.code = code
    save()
    done(entry)
  }
  child.on('error', (error) => {
    entry.stderr += String(error.message)
    finish(-1)
  })
  child.on('close', (code) => finish(code ?? -1))
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
