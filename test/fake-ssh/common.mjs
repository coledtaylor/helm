// What the fake transports share: recording how each was run, and running
// the line it was given on "the other computer", which in a test is this one,
// in the test's own folders.
//
// A transport carries bytes unchanged: the line's program gets this process's
// standard input, output and error as they are, and its exit status is this
// process's. `floti` in the line is the `floti` binary the test built, named
// by FAKE_SSH_FLOTI; `wsl.exe` (or `wsl`) is the fake wsl beside this file,
// never the real one; every other program is looked up on PATH. Nothing runs
// through a shell.

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { machine, type } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { watchOwner } from '../fake-agents/common.mjs'

/** The fake `wsl.exe` (wsl.mjs), which a line naming `wsl.exe` runs. */
const FAKE_WSL = join(dirname(fileURLToPath(import.meta.url)), 'wsl.mjs')

/** The desktop's line for a computer's OS and CPU (`SYSTEM_LINE` in packages/core/src/hostInstall.ts). */
export const SYSTEM_LINE = 'uname -sm || echo %OS% %PROCESSOR_ARCHITECTURE%'

/** What `SYSTEM_LINE` answers on this computer: `Windows_NT AMD64` from `cmd`, `uname -sm` elsewhere. */
function ownSystem() {
  if (process.platform === 'win32') return `Windows_NT ${process.arch === 'arm64' ? 'ARM64' : 'AMD64'}`
  return `${type()} ${machine()}`
}

/** Plays `floti setup` as it ends: its line and status (crates/host/src/setup.rs). */
function playSetup(outcome) {
  if (outcome === 'next-sign-in') {
    process.stdout.write('The Floti host starts at the next sign-in.\n')
    process.exit(10)
  }
  // A Linux server: lingering was turned on, so the host keeps running with
  // nobody signed in.
  // A WSL distro with no systemd user manager: nothing is registered, and
  // the host starts when a client connects.
  if (outcome === 'on-connect') {
    process.stdout.write('The Floti host starts when a client connects.\n')
    process.exit(0)
  }
  if (outcome === 'server') {
    process.stdout.write('The Floti host is running, and keeps running with nobody signed in.\n')
    process.exit(0)
  }
  if (outcome.startsWith('fail:')) {
    process.stderr.write(`${outcome.slice('fail:'.length)}\n`)
    process.exit(1)
  }
  process.stdout.write('The Floti host is running, and starts at each sign-in.\n')
  process.exit(0)
}

/**
 * Appends `entry` to the JSON-lines file FAKE_SSH_LOG names, one line per
 * run, when it is set. A test reads it to see exactly how it was run.
 */
export function record(entry) {
  const log = process.env.FAKE_SSH_LOG
  if (!log) return
  appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
}

/**
 * Splits `line` into words the way a POSIX shell does for a plain command:
 * on blanks, with single and double quotes grouping, a backslash escaping the
 * next character outside quotes, and, inside double quotes, only `$`, a
 * backtick, `"`, `\` or a newline, so a Windows path in double quotes keeps
 * its backslashes. Nothing is expanded.
 */
export function splitWords(line) {
  const words = []
  let word = null
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && i + 1 < line.length && '$`"\\\n'.includes(line[i + 1]))
        word += line[++i]
      else word += c
    } else if (c === ' ' || c === '\t') {
      if (word !== null) words.push(word)
      word = null
    } else if (c === "'" || c === '"') {
      word ??= ''
      quote = c
    } else if (c === '\\' && i + 1 < line.length) {
      word = (word ?? '') + line[++i]
    } else {
      word = (word ?? '') + c
    }
  }
  if (word !== null) words.push(word)
  return words
}

/**
 * Runs `line` as the login on the other side would, and exits with its
 * status. A program that is not found fails as `sh` says it, with 127.
 */
export function runLine(line) {
  const [program, ...args] = splitWords(line)
  if (program === undefined) process.exit(0)
  // The line the desktop's check runs to name the computer's OS and CPU:
  // answered as `uname -sm` or Windows' `cmd` would answer it, with
  // FAKE_SSH_SYSTEM when set (`Linux x86_64`), or this computer's own.
  if (line === SYSTEM_LINE) {
    process.stdout.write(`${process.env.FAKE_SSH_SYSTEM || ownSystem()}\n`)
    process.exit(0)
  }
  // FAKE_SSH_FLOTI_VERSION plays the floti there by its version line alone:
  // a line `floti version` is answered with it, and nothing is run.
  if (process.env.FAKE_SSH_FLOTI_VERSION && args.length === 1 && args[0] === 'version') {
    process.stdout.write(`${process.env.FAKE_SSH_FLOTI_VERSION}\n`)
    process.exit(0)
  }
  // `<floti> setup` is played, never run: a real one registers the host to
  // start at sign-in with this computer's own scheduler. FAKE_SSH_SETUP picks
  // what it says: `running` (the default), `server` (a Linux server, with
  // lingering on), `on-connect` (a WSL distro with no systemd), `next-sign-in`,
  // or `fail:<line>`.
  if (args.length === 1 && args[0] === 'setup') playSetup(process.env.FAKE_SSH_SETUP || 'running')
  // FAKE_SSH_MISSING_LINE plays a computer that cannot run one line: a line
  // starting with it fails as `sh` says a program it cannot find, with 127.
  const missing = process.env.FAKE_SSH_MISSING_LINE
  if (missing && line.startsWith(missing)) {
    process.stderr.write(`sh: 1: ${program}: not found\n`)
    process.exit(127)
  }
  // FAKE_SSH_ELSEWHERE_LINE and FAKE_SSH_ELSEWHERE_RUNTIME play a login
  // that finds no host for one line: a line starting with the first runs
  // with FLOTI_RUNTIME_DIR set to the second, a folder no host listens in.
  const elsewhere = process.env.FAKE_SSH_ELSEWHERE_LINE
  const env =
    elsewhere && process.env.FAKE_SSH_ELSEWHERE_RUNTIME && line.startsWith(elsewhere)
      ? { ...process.env, FLOTI_RUNTIME_DIR: process.env.FAKE_SSH_ELSEWHERE_RUNTIME }
      : process.env
  const floti = process.env.FAKE_SSH_FLOTI
  // `wsl.exe` in a line is the fake wsl, never the real one.
  const wsl = program === 'wsl.exe' || program === 'wsl'
  const resolved = wsl ? process.execPath : program === 'floti' && floti ? floti : program
  const resolvedArgs = wsl ? [FAKE_WSL, ...args] : args
  const child = spawn(resolved, resolvedArgs, { stdio: 'inherit', windowsHide: true, env })
  child.on('error', () => {
    process.stderr.write(`sh: 1: ${program}: not found\n`)
    process.exit(127)
  })
  child.on('exit', (code) => process.exit(code ?? 1))
  // A run whose test has gone ends with it, taking the line's program along.
  if (process.env.FAKE_SSH_LOG) {
    watchOwner(dirname(process.env.FAKE_SSH_LOG), () => {
      child.kill()
      process.exit(1)
    })
  }
}
