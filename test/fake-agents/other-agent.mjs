// A stand-in for a second agent CLI, shaped unlike `claude`, used by the Floti
// host's tests of anything that must not assume Claude Code: a parent on one
// backend starting children on another, rules one agent can enforce and the
// other cannot. It does what a test can observe of such a CLI, deterministically
// and with no network:
//
// - `--version` and `--help`. `FAKE_AGENT_VERSION` changes the version it
//   reports (the default is 1.4.0).
// - The opening prompt is a positional argument, the last one, with no `--`
//   before it (a prompt that starts with a dash needs one). Options that repeat
//   take exactly one value each time, so the prompt after them stays a prompt.
// - Agent tools come from its own flag, `--tools-config <file>`: a JSON
//   document `{ "servers": [{ "name", "url", "bearer" }] }`, a list rather than
//   Claude Code's map, with the token as `bearer` and not in a header. A file
//   that is not there or is not JSON fails the run at once.
// - `--model <name>` and `--instructions-file <file>`, whose text it reads and
//   logs as `instructions`. It has no effort setting: `--effort` is an unknown
//   option, as it is for any agent without one.
// - Permission: `--mode plan|ask|edit|yolo`. Tools it may use without asking
//   are given one at a time: `--allow-tool <name>` (`read`, `write`, `edit`,
//   `find`, `search`, `shell`, or `<server>.<tool>` for an agent tool) and
//   `--allow-shell <command>` (a command, with any arguments after it). It has
//   no flag that disallows a tool, so none is accepted.
// - `--conversation <id>` names a new conversation; `--continue <id>` reopens
//   one, and succeeds only in the folder it was recorded in. A prompt given
//   with `--continue` is the next turn: it is answered and logged as
//   `openingPrompt`, with `resumed` true.
// - An interactive run draws a prompt, echoes what is typed and writes the
//   conversation record `<home>/conversations/<id>.json`. It reports no
//   status: a host sees only its output.
//
// Everything it was given, loaded and received is written to
// `<home>/fake-agent/<pid>.json` in the shared run-log shape (`common.mjs`), so
// a test can assert what reached the session without reading the screen.
// `<home>` is `OTHER_AGENT_HOME`, or `~/.other-agent`.
//
// An interactive run exits once the test process that owns it is gone: the one
// a `test-owner` file names in its home or a folder above it (`watchOwner` in
// `common.mjs`).
//
// Its input is its own and unlike Claude Code's: it asks its terminal for
// bracketed paste and takes a paste as one block whose newlines do not submit,
// but it submits on LF (a typed CR still submits, as Enter does) and its stop
// key is Ctrl-X, which ends a running turn; Escape does nothing. An LF that
// arrives in the same read as a paste's end is part of the paste, so a host
// that wants the paste submitted presses LF in a read of its own after a pause.
// Text submitted while a turn runs is queued and taken as the next turn once
// that one ends. The run log records each (`pastes`, `submitKeys`, `prompts`,
// `queued`, `interrupts`; `common.mjs`).
//
// Commands typed at its prompt:
//   /exit        exit 0
//   /crash       exit 3
//   /busy <ms>   run a turn for that long, or until Ctrl-X, reporting
//                `working` and then `idle` (OSC 7501)
//   /busy hold   run a turn until `/idle` is typed or Ctrl-X is pressed
//   /idle        end the oldest turn `/busy hold` began and answer `Done.`
//   /wait        report `blocked permission` (OSC 7501) and hold at a prompt
//                until y or n is pressed; everything else typed, pasted or
//                pressed is ignored until then
//   /shell <command>  run the command in the shell with the session's own
//                environment and folder, and answer `shell <exit code>`. Its
//                output and exit code are logged in `shell`.
//   /report <state> [text]  write the program status a CLI with no MCP tools
//                reports itself with (OSC 7501): `/report working`,
//                `/report idle`, `/report done All fixed.`, `/report blocked
//                permission` (the text is the kind: permission, question or
//                auth) and `/report error It broke.`. The text is the report's
//                message, base64 as the protocol has it.
//   anything else  is a prompt: recorded and answered

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ENABLE_BRACKETED_PASTE,
  fakeVersion,
  InputReader,
  parseArgv,
  RunLog,
  runShell,
  UsageError,
  watchOwner
} from './common.mjs'

const BACKEND = 'other-agent'
const VERSION = fakeVersion('1.4.0')
const argv = process.argv.slice(2)
const out = (text) => process.stdout.write(text)

const MODES = ['plan', 'ask', 'edit', 'yolo']

/** Its options, as its parser declares them. */
const OPTION_SPEC = (() => {
  const options = {}
  const add = (spellings, key, arity) => {
    for (const spelling of spellings) options[spelling] = { key, arity }
  }
  add(['-V', '--version'], 'version', 'flag')
  add(['-h', '--help'], 'help', 'flag')
  add(['--conversation'], 'conversation', 'value')
  add(['--continue'], 'continue', 'value')
  add(['--title'], 'title', 'value')
  add(['--model'], 'model', 'value')
  add(['--instructions-file'], 'instructionsFile', 'value')
  add(['--mode'], 'mode', 'value')
  add(['--tools-config'], 'toolsConfig', 'value')
  add(['--allow-tool'], 'allowTool', 'repeat')
  add(['--allow-shell'], 'allowShell', 'repeat')
  return { options, commands: [] }
})()

let parsed
try {
  parsed = parseArgv(argv, OPTION_SPEC)
} catch (err) {
  if (!(err instanceof UsageError)) throw err
  process.stderr.write(`error: ${err.message}\n`)
  process.exit(1)
}
const opts = parsed.options

if (opts.version) {
  out(`other-agent ${VERSION}\n`)
  process.exit(0)
}

if (opts.help) {
  out(
    [
      'Usage: other-agent [options] [prompt]',
      '',
      'Arguments:',
      '  prompt                      What to start with',
      '',
      'Options:',
      '  --conversation <id>         Name the new conversation',
      '  --continue <id>             Reopen a conversation',
      '  --title <text>              Title the conversation',
      '  --model <model>             Model to use',
      '  --instructions-file <file>  Add the file to its instructions',
      '  --mode <mode>               plan, ask, edit or yolo',
      '  --tools-config <file>       Load agent tool servers from a JSON file',
      '  --allow-tool <name>         Use this tool without asking (repeat for more)',
      '  --allow-shell <command>     Run this command without asking (repeat for more)',
      '  -V, --version               Print the version',
      '  -h, --help                  Print this help',
      ''
    ].join('\n')
  )
  process.exit(0)
}

if (parsed.positionals.length > 1) {
  process.stderr.write(
    `error: too many arguments. Expected 1 argument but got ${String(parsed.positionals.length)}.\n`
  )
  process.exit(1)
}
if (opts.mode !== undefined && !MODES.includes(opts.mode)) {
  process.stderr.write(`error: option '--mode' must be one of ${MODES.join(', ')}, not '${opts.mode}'\n`)
  process.exit(1)
}

const home = (process.env.OTHER_AGENT_HOME ?? '').trim() || join(homedir(), '.other-agent')
const cwd = process.cwd()
const onWindows = process.platform === 'win32'
const sameDir = (a, b) => (onWindows ? a.toLowerCase() === b.toLowerCase() : a === b)

const reopened = opts.continue
const conversation = reopened ?? opts.conversation ?? `other-${String(process.pid)}`
const conversationFile = join(home, 'conversations', `${conversation}.json`)

const runLog = new RunLog(home, {
  backend: BACKEND,
  argv,
  conversation,
  resumed: reopened !== undefined,
  title: opts.title ?? null,
  model: opts.model ?? null,
  instructions: null,
  mode: opts.mode ?? null,
  allowedTools: opts.allowTool ?? [],
  allowedShell: opts.allowShell ?? []
})
const log = runLog.data
const saveLog = () => runLog.save()

/** Fails the run with a message, then exit 1. */
function fail(message) {
  process.stderr.write(`error: ${message}\n`)
  log.exitCode = 1
  saveLog()
  process.exit(1)
}

function loadToolServers() {
  if (opts.toolsConfig === undefined) return
  const file = resolve(cwd, opts.toolsConfig)
  if (!existsSync(file)) fail(`tools config not found: ${file}`)
  let document
  try {
    document = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    fail(`tools config is not valid JSON: ${file}`)
  }
  for (const server of document?.servers ?? []) {
    log.mcpServers[server.name] = { url: server.url, bearer: server.bearer }
  }
}

function openConversation() {
  if (reopened !== undefined) {
    let recorded
    try {
      recorded = JSON.parse(readFileSync(conversationFile, 'utf8'))
    } catch {
      recorded = null
    }
    if (recorded === null || !sameDir(recorded.cwd, cwd)) {
      fail(`no conversation ${reopened} in this folder`)
    }
    return
  }
  mkdirSync(join(home, 'conversations'), { recursive: true })
  writeFileSync(conversationFile, JSON.stringify({ id: conversation, cwd, title: opts.title ?? null }))
}

/** Reads the instructions file it was given, which a bad path fails the run on. */
function loadInstructions() {
  if (opts.instructionsFile === undefined) return
  const file = resolve(cwd, opts.instructionsFile)
  if (!existsSync(file)) fail(`instructions file not found: ${file}`)
  log.instructions = readFileSync(file, 'utf8')
}

loadToolServers()
loadInstructions()
openConversation()
log.openingPrompt = parsed.positionals[0] ?? null

let exiting = false
function exit(code) {
  if (exiting) return
  exiting = true
  log.exitCode = code
  saveLog()
  process.exit(code)
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

let buffer = ''
let asking = false
/** The `/busy` turns in progress, oldest first: `{ held, timer }`. */
const runningTurns = []
/** Lines typed while a `/busy` turn ran, to be taken as the next turns. */
const queuedLines = []

const drawPrompt = () => out(`\r\x1b[2K other> ${buffer.replaceAll('\n', '\r\n  ')}`)

function answer(text) {
  out(`\r\n${text}\r\n\r\n`)
  drawPrompt()
}

/** Writes the program status a CLI with no MCP tools reports itself with (OSC 7501). */
const reportStatus = (fields) => out(`\x1b]7501;${fields.join(':')}\x07`)

/** Ends a `/busy` turn, answers `text`, and takes the lines that waited for it. */
function endTurn(turn, text) {
  const at = runningTurns.indexOf(turn)
  if (at < 0) return
  runningTurns.splice(at, 1)
  if (turn.timer !== null) clearTimeout(turn.timer)
  if (runningTurns.length === 0) reportStatus(['state=idle'])
  answer(text)
  drainQueue()
}

/** Takes the lines typed during a turn as turns, one at a time, once idle. */
function drainQueue() {
  while (queuedLines.length > 0 && !asking && runningTurns.length === 0) run(queuedLines.shift())
}

/**
 * A line the user submitted with `key`: taken at once, or queued behind a
 * turn in progress. `/idle` is how a test ends a held turn, so it is never
 * queued.
 */
function submit(line, key) {
  log.received.push(line)
  log.submitKeys.push(key)
  if (runningTurns.length > 0 && line.trim() !== '/idle') {
    queuedLines.push(line)
    log.queued.push(line)
    saveLog()
    return
  }
  saveLog()
  run(line)
}

/** Takes `line` as a command or a prompt. */
function run(line) {
  const [command, arg] = line.trim().split(/\s+/, 2)
  if (command === '/exit') return exit(0)
  if (command === '/crash') return exit(3)
  if (command === '/busy') {
    if (runningTurns.length === 0) reportStatus(['state=working'])
    const turn = { held: arg === 'hold', timer: null }
    runningTurns.push(turn)
    if (!turn.held) turn.timer = setTimeout(() => endTurn(turn, 'Done.'), Number(arg) || 1000)
    return
  }
  if (command === '/idle') {
    const turn = runningTurns.find((running) => running.held)
    if (turn === undefined) return answer('no turn is held')
    endTurn(turn, 'Done.')
    return
  }
  if (command === '/wait') {
    asking = true
    reportStatus(['state=blocked', 'kind=permission'])
    out('\r\nAllow fake tool? (y/n)')
    return
  }
  if (command === '/shell') {
    const typed = line.trim().slice('/shell'.length).trim()
    runShell(typed, log, saveLog, (ran) => answer(`shell ${String(ran.code)}`))
    return
  }
  if (command === '/report') {
    const [, state, ...rest] = line.trim().split(/\s+/)
    const text = rest.join(' ')
    const fields = [`state=${state ?? ''}`]
    if (state === 'blocked' && text !== '') fields.push(`kind=${text}`)
    else if (text !== '') fields.push(`msg=${Buffer.from(text, 'utf8').toString('base64')}`)
    reportStatus(fields)
    return answer(`reported ${state ?? ''}`)
  }
  if (line.trim() === '') return drawPrompt()
  log.prompts.push(line)
  saveLog()
  answer(`Noted: ${line}`)
}

/** Ctrl-X, its stop key: it ends the oldest turn in progress. */
function onStop() {
  if (asking || runningTurns.length === 0) return
  log.interrupts += 1
  saveLog()
  endTurn(runningTurns[0], 'Interrupted.')
}

/** A paste: one block into the prompt, newlines and all, submitting nothing. */
function onPaste(text, withSubmit) {
  log.pastes.push({ text, withSubmit })
  saveLog()
  if (asking) return
  // A submit key that came with the paste is part of it, as a line break.
  buffer += withSubmit ? `${text}\n` : text
  drawPrompt()
}

function onKey(key) {
  if (asking) {
    if (key !== 'y' && key !== 'n') return
    asking = false
    log.answers.push(key)
    saveLog()
    reportStatus(['state=idle'])
    answer(key === 'y' ? 'Allowed.' : 'Denied.')
    return drainQueue()
  }
  if (key === '\x03' || (key === '\x04' && buffer === '')) return exit(0)
  if (key === '\r' || key === '\n') {
    const line = buffer
    buffer = ''
    return submit(line, key)
  }
  if (key === '\x7f' || key === '\b') {
    buffer = buffer.slice(0, -1)
    return drawPrompt()
  }
  if (key >= ' ') {
    buffer += key
    out(key)
  }
}

process.on('SIGINT', () => exit(130))
process.on('SIGTERM', () => exit(143))
// The test that owns this run is gone (crashed or killed), so nothing will end
// it: it ends itself, as closing it would.
watchOwner(home, () => exit(0))

saveLog()
out(
  `\x1b[2J\x1b[H* Other Agent ${VERSION} (fake)\r\n` +
    `  ${cwd}\r\n` +
    (reopened !== undefined ? `  Reopened ${conversation}\r\n` : '') +
    '\r\n'
)
out(ENABLE_BRACKETED_PASTE)
if (log.openingPrompt !== null) {
  out(` other> ${log.openingPrompt}\r\n`)
  answer(`Noted: ${log.openingPrompt}`)
} else {
  drawPrompt()
}

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
// Escape sequences (arrows, focus reports) are dropped whole. Its submit key
// is LF and its stop key Ctrl-X.
const input = new InputReader({ submitKey: '\n', stopKey: '\x18', onKey, onPaste, onStop })
process.stdin.on('data', (chunk) => input.feed(chunk))
process.stdin.on('end', () => exit(0))
