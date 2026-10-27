// What every fake agent CLI shares: reading argv the way a commander-style
// parser does, and the run log each fake writes about itself.
//
// One fake per backend lives beside this file, named after the backend's id
// (`claude-code.mjs`). Each one does what Floti and Helm can observe of the
// real CLI, deterministically and with no network, and logs what it was given
// to `<its config dir>/fake-agent/<pid>.json` in the shape `RunLog` below, so
// the host's Rust tests and the desktop's TypeScript tests read one format.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
  try {
    renameSync(temporary, file)
  } catch {
    // A reader that opened the file without sharing delete holds the name on
    // Windows. Writing in place is the older behaviour and still whole once
    // the write returns.
    writeFileSync(file, text)
    rmSync(temporary, { force: true })
  }
}
