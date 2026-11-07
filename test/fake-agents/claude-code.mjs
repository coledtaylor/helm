// A stand-in for the `claude` CLI, used by Helm's integration and end-to-end
// tests and by the Floti host's Claude Code tests. It does what they can
// observe of the real CLI, deterministically and with no network:
//
// - `--version` and `--help` answer the way the version guard and the
//   `--session-id` capability probe expect. `FAKE_AGENT_VERSION` changes the
//   version it reports (the default is 2.1.999).
// - Its arguments are read as the real CLI's parser reads them: a variadic
//   option (`--add-dir`, `--mcp-config`, `--plugin-dir`) takes every argument
//   up to the next that starts with a dash or `--`, and whatever follows `--`
//   is the prompt. An unknown option is the CLI's own error.
// - Every `--mcp-config` and `--settings` value names a file that exists, or
//   is inline JSON, or the run fails at once with the real CLI's error.
// - It loads settings (the user's, the project's and `--settings`) and
//   instruction files as the CLI does: every CLAUDE.md from the working folder
//   up, and an AGENTS.md only where no CLAUDE.md sits in its folder or above,
//   unless the settings set `instructionFiles` to `claude-md-and-agents-md`,
//   when both load, each once. `--append-system-prompt-file` is read and
//   logged as composed instructions.
// - An interactive run draws a prompt, echoes what is typed, and writes the
//   files a host reads: the session registry record
//   (`<config>/sessions/<pid>.json`) with a `<pid>.<hash>.key` credential
//   beside it as the real CLI keeps one, `history.jsonl`, and a transcript
//   under `projects/`.
// - `--resume <id>` succeeds only in the directory the conversation was
//   recorded in, as the real CLI does. A prompt given with it is the next turn,
//   and is logged as `openingPrompt` with `resumed` true.
// - `--remote-control [name]` is taken as the real CLI takes it, and the name it
//   was given is logged as `remoteControl` ('' for the flag alone, null when
//   absent). The other fake agent has no Remote Control.
// - `mcp add-json`, `mcp remove` and `mcp list` read and write the files the
//   real CLI does: the working folder's `.mcp.json`, and the global config,
//   `.claude.json` in `CLAUDE_CONFIG_DIR` when that is set and in the home
//   folder otherwise. `doctor` prints a report and exits 0, or prints and
//   exits with what `<config>/fake-doctor.json` says ({ output, exitCode,
//   held }).
//
// Everything it was given, loaded and received is written to
// `<config>/fake-agent/<pid>.json` in the shared run-log shape (`common.mjs`),
// so a test can assert what reached the session without reading the screen.
// The results it took as new turns are in `turns`, as `{ kind, text }`.
//
// An interactive run, and the child `/child` starts, exit once the test
// process that owns them is gone: the one a `test-owner` file names in the
// config folder or a folder above it (`watchOwner` in `common.mjs`).
//
// Its input is Claude Code's: it asks its terminal for bracketed paste, takes
// a paste as one block whose newlines do not submit, submits on CR, and ends a
// running turn on Escape. A CR that arrives in the same read as a paste's end
// is part of the paste, so a host that wants the paste submitted presses CR in
// a read of its own after a pause. Text submitted while a turn runs is queued
// and taken as the next turn once that one ends. The run log records each
// (`pastes`, `submitKeys`, `prompts`, `queued`, `interrupts`; `common.mjs`).
//
// Commands typed at its prompt:
//   /exit        exit 0
//   /crash       exit 3
//   /wait        report status "waiting" until y or n is pressed; everything
//                else typed, pasted or pressed is ignored until then
//   /busy <ms>   report status "busy" for that long, or until Escape
//   /busy hold   report status "busy" until `/idle` is typed or Escape is
//                pressed, so a test ends the turn when it means to and not
//                after a time
//   /idle        end the oldest turn `/busy hold` began and answer `Done.`
//   /child       start a long-running child process, for process-tree tests
//   /serve <port>  start a child serving HTTP on 127.0.0.1 at that port (any
//                free one for 0) and answer `serving <port>`: a GET is
//                answered with a line naming it, a POST with its body, byte
//                for byte. It exits with the test that owns it.
//   /flood <n>   write n numbered lines (`flood 000000 ...`) at once, then
//                answer `flood done`
//   /shell <command>  run the command in the shell, as the CLI's shell tool
//                does, with the session's own environment and folder, and
//                answer `shell <exit code>`. Its output and exit code are
//                logged in `shell`.
//   /mcp <server> <tool> [json]  call a tool of an MCP server it loaded from
//                `--mcp-config`, with the JSON object as its arguments and a
//                progress token, and answer the tool's text. It is busy while
//                the call is out. A call still unanswered after
//                `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` (two minutes unless the
//                environment says) is moved to the background, as the real
//                CLI moves a long MCP call: the session goes idle, and the
//                result is taken as a new turn once it arrives and the
//                session is idle. Each call is logged in `mcpCalls`, with
//                whether it was moved and how many progress notifications it
//                was sent.
//   /report <done|stuck|note> <text>  report to the parent that started it, as a
//                child does with `agents_report`: a tools/call POSTed to the
//                address in `FLOTI_AGENT_URL` with the token in
//                `FLOTI_AGENT_TOKEN`, the way `floti agent` reaches the
//                family from a session's shell, and answer `ok <the tool's
//                text>` or `error <the tool's text>`. It is busy while the
//                call is out, so it is a turn that ends with a report. With
//                either variable unset it answers saying so and calls nothing.
//                Each call is logged in `reports`, as `{ state, text, isError,
//                answer, progress }`; `isError` and `answer` are null while
//                the call is out.
//   /bg <command>  run the command in the shell as a background command: the
//                session is idle at once, and its output is taken as a new
//                turn when it finishes, as the real CLI wakes a session. Each
//                is logged in `background`.
//   /clear       move to a new conversation id under the same process, and
//                register under it, as the real CLI does
//   /links       ask for mouse and focus reports, as the real CLI's fullscreen
//                interface does, and print a link two ways: as an OSC 8
//                hyperlink when FORCE_HYPERLINK says the terminal shows them
//                (plain text otherwise), and as a bare web address. Mouse
//                reports received from then on are logged in `mouse`.
//   anything else  is a prompt: recorded in history and the transcript, answered

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  childScript,
  ENABLE_BRACKETED_PASTE,
  fakeVersion,
  InputReader,
  parseArgv,
  RunLog,
  runShell,
  UsageError,
  watchOwner,
  writeJsonAtomically
} from './common.mjs'

const BACKEND = 'claude-code'
const VERSION = fakeVersion('2.1.999')
const argv = process.argv.slice(2)
const out = (text) => process.stdout.write(text)

/** The real CLI's options, as its parser declares them. */
const OPTION_SPEC = (() => {
  const options = {}
  const add = (spellings, key, arity) => {
    for (const spelling of spellings) options[spelling] = { key, arity }
  }
  add(['-v', '--version'], 'version', 'flag')
  add(['-h', '--help'], 'help', 'flag')
  add(['-p', '--print'], 'print', 'flag')
  add(['-c', '--continue'], 'continue', 'flag')
  add(['--verbose'], 'verbose', 'flag')
  add(['--dangerously-skip-permissions'], 'skipPermissions', 'flag')
  add(['--strict-mcp-config'], 'strictMcpConfig', 'flag')
  add(['--fork-session'], 'forkSession', 'flag')
  add(['--ide'], 'ide', 'flag')
  add(['-r', '--resume'], 'resume', 'optional')
  add(['-d', '--debug'], 'debug', 'optional')
  add(['--remote-control'], 'remoteControl', 'optional')
  add(['--session-id'], 'sessionId', 'value')
  add(['-n', '--name'], 'name', 'value')
  add(['--model'], 'model', 'value')
  add(['--fallback-model'], 'fallbackModel', 'value')
  add(['--effort'], 'effort', 'value')
  add(['--agent'], 'agent', 'value')
  add(['--agents'], 'agents', 'value')
  add(['--permission-mode'], 'permissionMode', 'value')
  add(['--settings'], 'settings', 'value')
  add(['--setting-sources'], 'settingSources', 'value')
  add(['--system-prompt'], 'systemPrompt', 'value')
  add(['--append-system-prompt'], 'appendSystemPrompt', 'value')
  add(['--append-system-prompt-file'], 'appendSystemPromptFile', 'value')
  add(['--output-format'], 'outputFormat', 'value')
  add(['--input-format'], 'inputFormat', 'value')
  add(['--add-dir'], 'addDir', 'variadic')
  add(['--mcp-config'], 'mcpConfig', 'variadic')
  // One path per flag, repeated for more (`--plugin-dir A --plugin-dir B`), as
  // the real CLI's `--help` declares it.
  add(['--plugin-dir'], 'pluginDir', 'value')
  add(['--allowedTools', '--allowed-tools'], 'allowedTools', 'variadic')
  add(['--disallowedTools', '--disallowed-tools'], 'disallowedTools', 'variadic')
  add(['--tools'], 'tools', 'variadic')
  add(['--betas'], 'betas', 'variadic')
  return { options, commands: ['mcp', 'config', 'doctor', 'update', 'install', 'plugin', 'setup-token'] }
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
  out(`${VERSION} (Claude Code)\n`)
  process.exit(0)
}

if (opts.help) {
  out(
    [
      'Usage: claude [options] [command] [prompt]',
      '',
      'Arguments:',
      '  prompt                                  Your prompt',
      '',
      'Options:',
      '  -r, --resume [sessionId]                Resume a conversation',
      '  --session-id <uuid>                     Use a specific session ID for the conversation',
      '  -n, --name <name>                       Name the session',
      '  --remote-control [name]                 Start an interactive session with Remote Control enabled (optionally named)',
      '  --model <model>                         Model for the current session',
      '  --effort <level>                        Effort level for the current session',
      '  --agent <agent>                         Agent for the current session',
      '  --permission-mode <mode>                Permission mode to use for the session',
      '  --settings <file-or-json>               Path to a settings JSON file or a JSON string to load additional settings from',
      '  --append-system-prompt-file <file>      Append the contents of a file to the system prompt',
      '  --mcp-config <configs...>               Load MCP servers from JSON files or strings',
      '  --add-dir <directories...>              Additional directories to allow tool access to',
      '  --plugin-dir <paths...>                 Load plugins from directories',
      '  -v, --version                           Output the version number',
      '  -h, --help                              Display help for command',
      ''
    ].join('\n')
  )
  process.exit(0)
}

// `claude mcp add-json <name> <json> -s <scope>` and `claude mcp remove <name>
// -s <scope>` write the file the real CLI writes for that scope: `.mcp.json` in
// the working directory for `project`, `~/.claude.json` for `user` and, under
// the working directory's entry, for `local`.
const configHome = (process.env.CLAUDE_CONFIG_DIR ?? '').trim()
const globalConfig = join(configHome || homedir(), '.claude.json')

if (parsed.command === 'mcp' && (parsed.rest[0] === 'add-json' || parsed.rest[0] === 'remove')) {
  const rest = parsed.rest
  const at = rest.indexOf('-s')
  const scope = at >= 0 ? rest[at + 1] : 'local'
  const name = rest[1]
  const file = scope === 'project' ? join(process.cwd(), '.mcp.json') : globalConfig
  const document = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8') || '{}') : {}
  const holder = scope === 'local' ? (((document.projects ??= {})[process.cwd()]) ??= {}) : document
  const servers = (holder.mcpServers ??= {})
  if (rest[0] === 'add-json') {
    servers[name] = JSON.parse(rest[2])
    out(`Added stdio MCP server ${name} to ${scope} config\n`)
  } else {
    if (!(name in servers)) {
      process.stderr.write(`No MCP server named ${name} in ${scope} config\n`)
      process.exit(1)
    }
    delete servers[name]
    out(`Removed MCP server ${name} from ${scope} config\n`)
  }
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`)
  process.exit(0)
}

// `claude mcp list`: every server a session here could load, one a line, the
// way the real CLI lays its health check out.
if (parsed.command === 'mcp' && parsed.rest[0] === 'list') {
  const read = (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }
  const global = read(globalConfig)
  const local = (global.projects ?? {})[process.cwd()] ?? {}
  const servers = {
    ...(global.mcpServers ?? {}),
    ...(read(join(process.cwd(), '.mcp.json')).mcpServers ?? {}),
    ...(local.mcpServers ?? {})
  }
  const names = Object.keys(servers)
  if (names.length === 0) {
    out('No MCP servers configured. Use `claude mcp add` to add a server.\n')
  } else {
    out('Checking MCP server health...\n\n')
    for (const name of names) {
      const server = servers[name] ?? {}
      const target = server.url ?? [server.command, ...(server.args ?? [])].join(' ')
      out(`${name}: ${target} - ✓ Connected\n`)
    }
  }
  process.exit(0)
}

// `claude doctor`: a report shaped like the real one, or the one
// `<config>/fake-doctor.json` gives, with its exit code. A `held` one stands
// for the real doctor taking seconds: it writes `fake-doctor.running` beside
// the script once it has started and answers once the test has written
// `fake-doctor.release` there.
if (parsed.command === 'doctor') {
  const config = configHome || join(homedir(), '.claude')
  const scripted = join(config, 'fake-doctor.json')
  const report = existsSync(scripted)
    ? JSON.parse(readFileSync(scripted, 'utf8'))
    : {
        output: [
          'Diagnostics',
          ` └ Currently running: native (${VERSION})`,
          'Auto-update channel: latest',
          `Install path: ${process.argv[1]}`
        ].join('\n'),
        exitCode: 0
      }
  if (report.held) {
    writeFileSync(join(config, 'fake-doctor.running'), '')
    while (!existsSync(join(config, 'fake-doctor.release'))) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  out(`${report.output}\n`)
  process.exit(report.exitCode ?? 0)
}

// Any other command and a `-p` run answer nothing and succeed.
if (parsed.command !== null || opts.print) process.exit(0)

if (parsed.positionals.length > 1) {
  process.stderr.write(
    `error: too many arguments. Expected 1 argument but got ${String(parsed.positionals.length)}.\n`
  )
  process.exit(1)
}

const configDir = (process.env.CLAUDE_CONFIG_DIR ?? '').trim() || join(homedir(), '.claude')
const cwd = process.cwd()
const onWindows = process.platform === 'win32'

/** The CLI's own directory naming under `projects/`: anything not alphanumeric becomes `-`. */
const projectDirName = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-')
const sameDir = (a, b) => (onWindows ? a.toLowerCase() === b.toLowerCase() : a === b)

const isFile = (path) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const resumeArg = opts.resume
const resume = resumeArg === undefined ? undefined : resumeArg === true ? null : resumeArg
let sessionId = opts.sessionId ?? randomUUID()
const name = opts.name ?? null
const startedAt = Date.now()
const registryFile = join(configDir, 'sessions', `${String(process.pid)}.json`)
const keyFile = join(
  configDir,
  'sessions',
  `${String(process.pid)}.${createHash('sha256').update(String(process.pid)).digest('hex')}.key`
)
const transcriptOf = (id) => join(configDir, 'projects', projectDirName(cwd), `${id}.jsonl`)

// `sessionId` is the conversation the run began in; `current` follows a /clear.
const runLog = new RunLog(configDir, {
  backend: BACKEND,
  argv,
  sessionId,
  current: sessionId,
  resumed: resume !== undefined,
  resized: [],
  mouse: [],
  mcpCalls: [],
  reports: [],
  background: [],
  turns: []
})
const log = runLog.data
const saveLog = () => runLog.save()
const children = []

/** Fails the run the way the real CLI does: a message, then exit 1. */
function fail(message) {
  out(`${message}\r\n`)
  log.exitCode = 1
  saveLog()
  process.exit(1)
}

// ---------------------------------------------------------------------------
// What it loads before it draws anything
// ---------------------------------------------------------------------------

/** A JSON document from a file, or `undefined` when it is absent or not JSON. */
function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** A value that is a file or inline JSON, as `--settings` and `--mcp-config` take. */
function fileOrJson(value, notFound) {
  if (value.trim().startsWith('{')) {
    try {
      return { path: null, value: JSON.parse(value) }
    } catch {
      return { error: `${notFound}: ${value}` }
    }
  }
  const file = resolve(cwd, value)
  if (!existsSync(file)) return { error: `${notFound}: ${file}` }
  const parsedValue = readJsonFile(file)
  if (parsedValue === undefined) return { error: `${notFound.replace('not found', 'is not valid JSON')}: ${file}` }
  return { path: file, value: parsedValue }
}

function loadSettings() {
  const sources = [
    ['user', join(configDir, 'settings.json')],
    ['project', join(cwd, '.claude', 'settings.json')],
    ['local', join(cwd, '.claude', 'settings.local.json')]
  ]
  for (const [source, file] of sources) {
    if (!isFile(file)) continue
    const value = readJsonFile(file)
    if (value !== undefined) log.settings.push({ source, path: file, value })
  }
  if (opts.settings !== undefined) {
    const found = fileOrJson(opts.settings, 'Settings file not found')
    if (found.error !== undefined) fail(`Error: ${found.error}`)
    log.settings.push({ source: 'flag', path: found.path, value: found.value })
  }
}

function loadMcpServers() {
  for (const value of opts.mcpConfig ?? []) {
    const found = fileOrJson(value, 'MCP config file not found')
    if (found.error !== undefined) fail(`Error: Invalid MCP configuration:\r\n${found.error}`)
    const servers = found.value?.mcpServers
    if (servers !== null && typeof servers === 'object') Object.assign(log.mcpServers, servers)
  }
}

/** The settings' `instructionFiles`, the most specific source winning. */
function instructionMode() {
  let mode = 'claude-md'
  for (const { value } of log.settings) {
    if (value !== null && typeof value === 'object' && typeof value.instructionFiles === 'string') {
      mode = value.instructionFiles
    }
  }
  return mode
}

/**
 * The instruction files the CLI loads, outermost first: the user's CLAUDE.md,
 * then each folder from the filesystem root down to the working folder.
 */
function loadInstructions() {
  const both = instructionMode() === 'claude-md-and-agents-md'
  const seen = new Set()
  const add = (file) => {
    let key
    try {
      key = realpathSync(file)
    } catch {
      key = file
    }
    if (onWindows) key = key.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    log.instructionFiles.push(file)
  }
  if (isFile(join(configDir, 'CLAUDE.md'))) add(join(configDir, 'CLAUDE.md'))

  const folders = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    folders.unshift(dir)
    if (dirname(dir) === dir) break
  }
  let claudeAtOrAbove = false
  for (const dir of folders) {
    const claudeMd = join(dir, 'CLAUDE.md')
    const agentsMd = join(dir, 'AGENTS.md')
    if (isFile(claudeMd)) {
      claudeAtOrAbove = true
      add(claudeMd)
    }
    if (isFile(agentsMd) && (both || !claudeAtOrAbove)) add(agentsMd)
  }

  if (opts.appendSystemPromptFile !== undefined) {
    const file = resolve(cwd, opts.appendSystemPromptFile)
    if (!isFile(file)) fail(`Error: Append system prompt file not found: ${file}`)
    log.composedInstructions = readFileSync(file, 'utf8')
  }
}

loadSettings()
loadMcpServers()
loadInstructions()
log.openingPrompt = parsed.positionals[0] ?? null
// `--remote-control` alone is Remote Control without a name, which is the empty
// string here; absent is null.
log.remoteControl =
  opts.remoteControl === undefined ? null : opts.remoteControl === true ? '' : opts.remoteControl
log.allowedTools = toolRules(opts.allowedTools ?? [])
log.disallowedTools = toolRules(opts.disallowedTools ?? [])

/**
 * The tool rules in `values`. Each value may hold several, split on commas or
 * spaces outside parentheses, as the real CLI reads them: `Bash(git log:*)` is
 * one rule.
 */
function toolRules(values) {
  const rules = []
  for (const value of values) {
    let depth = 0
    let current = ''
    for (const char of value) {
      if (char === '(') depth += 1
      if (char === ')' && depth > 0) depth -= 1
      if (depth === 0 && (char === ',' || /\s/.test(char))) {
        if (current !== '') rules.push(current)
        current = ''
      } else {
        current += char
      }
    }
    if (current !== '') rules.push(current)
  }
  return rules
}

if (resume !== undefined) {
  const recorded = resume === null ? null : findTranscript(resume)
  if (recorded === null || !sameDir(recorded.cwd, cwd)) {
    fail(`No conversation found with session ID: ${String(resume)}`)
  }
  sessionId = resume
  log.sessionId = sessionId
  log.current = sessionId
}

let transcriptFile = transcriptOf(sessionId)

function findTranscript(id) {
  const root = join(configDir, 'projects')
  if (!existsSync(root)) return null
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, `${id}.jsonl`)
    if (!existsSync(file)) continue
    const first = readFileSync(file, 'utf8').split('\n').find((line) => line.trim() !== '')
    try {
      return { file, cwd: JSON.parse(first ?? '{}').cwd ?? '' }
    } catch {
      return { file, cwd: '' }
    }
  }
  return null
}

/** The registry record. The first one carries no status, as the real CLI's does. */
function setStatus(status, waitingFor) {
  const record = {
    pid: process.pid,
    sessionId,
    cwd,
    startedAt,
    version: VERSION,
    entrypoint: 'cli',
    ...(name !== null ? { name } : {}),
    ...(status !== undefined ? { status, statusUpdatedAt: Date.now() } : {}),
    ...(waitingFor !== undefined ? { waitingFor } : {})
  }
  writeJsonAtomically(registryFile, record)
}

/** The peer credential the real CLI keeps beside its record. Nothing may open it. */
function writeKey() {
  mkdirSync(dirname(keyFile), { recursive: true })
  writeFileSync(keyFile, JSON.stringify({ peerToken: `fake-peer-token-${String(process.pid)}`, procStartFt: '0' }))
}

function recordPrompt(text) {
  const timestamp = Date.now()
  mkdirSync(configDir, { recursive: true })
  appendFileSync(
    join(configDir, 'history.jsonl'),
    JSON.stringify({ display: text, pastedContents: {}, timestamp, project: cwd, sessionId }) + '\n'
  )
  mkdirSync(dirname(transcriptFile), { recursive: true })
  const at = new Date(timestamp).toISOString()
  appendFileSync(
    transcriptFile,
    JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId, cwd, timestamp: at, message: { role: 'user', content: text } }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        uuid: randomUUID(),
        sessionId,
        cwd,
        timestamp: at,
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: `You said: ${text}` }],
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }) +
      '\n'
  )
}

/**
 * The script for `node -e` that `/serve` runs: an HTTP server on 127.0.0.1
 * at `port` (any free one for 0) that answers a GET with a line naming the
 * request, as an HTML page the way a dev server serves one (a browser shows
 * it rather than downloading it), and a POST with its body, byte for byte. It prints
 * `listening <port>` once it listens, and exits with the test that owns it.
 */
function serveScript(port) {
  return (
    `${childScript(configDir)};` +
    `const server = require('node:http').createServer((req, res) => {` +
    `  const body = [];` +
    `  req.on('data', (chunk) => body.push(chunk));` +
    `  req.on('end', () => {` +
    `    res.setHeader('content-type', req.method === 'POST' ? 'application/octet-stream' : 'text/html; charset=utf-8');` +
    `    res.end(req.method === 'POST' ? Buffer.concat(body) : 'fake dev server: ' + req.method + ' ' + req.url);` +
    `  });` +
    `});` +
    `server.listen(${String(port)}, '127.0.0.1', () => process.stdout.write('listening ' + server.address().port + '\\n'));`
  )
}

let exiting = false
function exit(code) {
  if (exiting) return
  exiting = true
  log.exitCode = code
  saveLog()
  rmSync(registryFile, { force: true })
  rmSync(keyFile, { force: true })
  for (const child of children) child.kill()
  process.exit(code)
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

let buffer = ''
let asking = false
let lastInterrupt = 0
/** Turns in progress: `/busy` and a foreground MCP call each hold one. */
let working = 0
/** The `/busy` turns in progress, oldest first: `{ held, timer }`. */
const runningTurns = []
/** Lines typed while a `/busy` turn ran, to be taken as the next turns. */
const queuedLines = []
/** Results waiting for the session to be idle, to be taken as new turns. */
const waitingTurns = []

const drawPrompt = () => out(`\r\x1b[2K> ${buffer.replaceAll('\n', '\r\n  ')}`)

/** Ends a `/busy` turn, answers `text`, and takes what waited for it. */
function endTurn(turn, text) {
  const at = runningTurns.indexOf(turn)
  if (at < 0) return
  runningTurns.splice(at, 1)
  if (turn.timer !== null) clearTimeout(turn.timer)
  working -= 1
  setStatus(working === 0 ? 'idle' : 'busy')
  answer(text)
  drainTurns()
  drainQueue()
}

/** Takes the lines typed during a turn as turns, one at a time, once idle. */
function drainQueue() {
  while (queuedLines.length > 0 && !asking && working === 0) run(queuedLines.shift())
}

function answer(text) {
  out(`\r\n${text}\r\n\r\n`)
  drawPrompt()
}

/**
 * Takes `text` as a new turn, as the real CLI hands a session the result of
 * something it moved to the background: now when the session is idle, else when
 * the turn in progress ends.
 */
function takeAsTurn(kind, text) {
  waitingTurns.push({ kind, text })
  drainTurns()
}

function drainTurns() {
  while (waitingTurns.length > 0 && !asking && working === 0) {
    const turn = waitingTurns.shift()
    log.turns.push(turn)
    saveLog()
    setStatus('busy')
    recordPrompt(turn.text)
    setStatus('idle')
    answer(`You said: ${turn.text}`)
  }
}

/** What an MCP call is moved to the background after. */
const AUTO_BACKGROUND_MS = Number(process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS) || 120000

/**
 * Calls tool `tool` of the MCP server `server` it loaded, with `args`, over
 * streamable HTTP, and resolves to `{ text, isError }`. Progress notifications
 * the server sends on the call's token are counted in `entry.progress`.
 */
async function callMcpTool(server, tool, args, entry) {
  const config = log.mcpServers[server]
  if (config === undefined || typeof config.url !== 'string') {
    return { text: `No MCP server named ${server}.`, isError: true }
  }
  return callTool(config.url, config.headers ?? {}, tool, args, entry)
}

/**
 * Calls `tool` at `url` with a JSON-RPC tools/call and `headers`, reads the
 * reply whether it is JSON or a stream, and resolves to `{ text, isError }`.
 */
async function callTool(url, headers, tool, args, entry) {
  const token = `fake-${String(process.pid)}-${String(log.mcpCalls.length + log.reports.length)}`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args, _meta: { progressToken: token } }
    })
  })
  const messages = []
  const take = (text) => {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('')
      if (data === '') continue
      try {
        const message = JSON.parse(data)
        if (message.method === 'notifications/progress') {
          entry.progress += 1
          saveLog()
        } else {
          messages.push(message)
        }
      } catch {
        // A line that is not a message is not one.
      }
    }
  }
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    // Events are taken as they arrive, so progress is counted while the call is out.
    const decoder = new TextDecoder()
    let pending = ''
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true })
      const end = pending.lastIndexOf('\n\n')
      if (end >= 0) {
        take(pending.slice(0, end + 2))
        pending = pending.slice(end + 2)
      }
    }
    take(pending)
  } else {
    const body = await response.text()
    try {
      messages.push(JSON.parse(body))
    } catch {
      return { text: `The server answered ${String(response.status)}.`, isError: true }
    }
  }
  const answered = messages.find((message) => message.id === 1)
  if (answered === undefined) return { text: 'The server answered nothing.', isError: true }
  if (answered.error !== undefined) return { text: String(answered.error.message), isError: true }
  const blocks = answered.result?.content ?? []
  return { text: blocks.map((block) => block.text ?? '').join('\n'), isError: answered.result?.isError === true }
}

/** `/mcp`: a call that holds the session busy until it answers or is moved. */
async function mcpCommand(server, tool, argumentsText) {
  let args = {}
  if (argumentsText !== '') {
    try {
      args = JSON.parse(argumentsText)
    } catch {
      return answer(`mcp: the arguments are not JSON: ${argumentsText}`)
    }
  }
  const entry = { server, tool, arguments: args, backgrounded: false, progress: 0, isError: null, text: null }
  log.mcpCalls.push(entry)
  working += 1
  setStatus('busy')
  saveLog()
  let moved = false
  const timer = setTimeout(() => {
    moved = true
    entry.backgrounded = true
    working -= 1
    setStatus('idle')
    saveLog()
    answer(`${tool} is running in the background`)
    drainTurns()
  }, AUTO_BACKGROUND_MS)
  let result
  try {
    result = await callMcpTool(server, tool, args, entry)
  } catch (error) {
    result = { text: `The call failed: ${String(error.message)}`, isError: true }
  }
  clearTimeout(timer)
  entry.text = result.text
  entry.isError = result.isError
  saveLog()
  if (moved) return takeAsTurn('mcp', `${tool} finished: ${result.text}`)
  working -= 1
  setStatus('idle')
  answer(`${result.isError ? 'error' : 'ok'} ${result.text}`)
  drainTurns()
}

/**
 * `/report`: a call to `agents_report` on the session's floti-agents family,
 * made with the address and token the host gave its environment. It holds the
 * session busy until it answers.
 */
async function reportCommand(state, text) {
  const entry = { state, text, isError: null, answer: null, progress: 0 }
  log.reports.push(entry)
  const url = process.env.FLOTI_AGENT_URL ?? ''
  const token = process.env.FLOTI_AGENT_TOKEN ?? ''
  if (url === '' || token === '') {
    entry.isError = true
    entry.answer = 'FLOTI_AGENT_URL and FLOTI_AGENT_TOKEN are not set'
    saveLog()
    return answer(`report: ${entry.answer}`)
  }
  working += 1
  setStatus('busy')
  saveLog()
  let result
  try {
    result = await callTool(url, { authorization: `Bearer ${token}` }, 'agents_report', { state, text }, entry)
  } catch (error) {
    result = { text: `The call failed: ${String(error.message)}`, isError: true }
  }
  entry.isError = result.isError
  entry.answer = result.text
  saveLog()
  working -= 1
  setStatus(working === 0 ? 'idle' : 'busy')
  answer(`${result.isError ? 'error' : 'ok'} ${result.text}`)
  drainTurns()
}

/** `/bg`: a shell command whose output comes back as a new turn. */
function backgroundCommand(command) {
  const entry = { command, stdout: '', stderr: '', code: null }
  log.background.push(entry)
  saveLog()
  const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
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
    saveLog()
    takeAsTurn('background', `Background command finished (exit ${String(code)}): ${entry.stdout.trim()}`)
  }
  child.on('error', (error) => {
    entry.stderr += String(error.message)
    finish(-1)
  })
  child.on('close', (code) => finish(code ?? -1))
  answer(`running in the background: ${command}`)
}

/**
 * A line the user submitted with `key`: taken at once, or queued behind a
 * turn in progress as the real CLI queues it. `/idle` is how a test ends a
 * held turn, so it is never queued.
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
  if (command === '/clear') {
    sessionId = randomUUID()
    transcriptFile = transcriptOf(sessionId)
    log.current = sessionId
    saveLog()
    setStatus('idle')
    return answer('(no content)')
  }
  if (command === '/wait') {
    asking = true
    setStatus('waiting', 'permission prompt')
    out('\r\nAllow fake tool? (y/n)')
    return
  }
  if (command === '/busy') {
    working += 1
    setStatus('busy')
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
  if (command === '/mcp') {
    const typed = /^\/mcp\s+(\S+)\s+(\S+)\s*([\s\S]*)$/.exec(line.trim())
    if (typed === null) return answer('usage: /mcp <server> <tool> [json arguments]')
    void mcpCommand(typed[1], typed[2], typed[3])
    return
  }
  if (command === '/report') {
    const typed = /^\/report\s+(\S+)\s+([\s\S]+)$/.exec(line.trim())
    if (typed === null) return answer('usage: /report <done|stuck|note> <text>')
    void reportCommand(typed[1], typed[2])
    return
  }
  if (command === '/bg') {
    const typed = line.trim().slice('/bg'.length).trim()
    if (typed === '') return answer('usage: /bg <command>')
    return backgroundCommand(typed)
  }
  if (command === '/links') {
    // The real CLI's rule, from `supports-hyperlinks`: a non-empty value other
    // than 0 turns them on.
    const forced = process.env.FORCE_HYPERLINK ?? ''
    const hyperlinks = forced !== '' && Number.parseInt(forced, 10) !== 0
    const docs = 'https://example.test/docs'
    // SGR mouse reports (1000, 1006) and focus reports (1004).
    out('\x1b[?1000h\x1b[?1006h\x1b[?1004h')
    out(`\r\n${hyperlinks ? `\x1b]8;;${docs}\x1b\\Read the docs\x1b]8;;\x1b\\` : `Read the docs (${docs})`}`)
    return answer('Or see https://example.test/bare for more.')
  }
  if (command === '/child') {
    const child = spawn(process.execPath, ['-e', childScript(configDir)], { stdio: 'ignore' })
    children.push(child)
    return answer(`child ${String(child.pid)}`)
  }
  if (command === '/serve') {
    const child = spawn(process.execPath, ['-e', serveScript(Number(arg) || 0)], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    children.push(child)
    let said = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      said += chunk
      const port = /^listening (\d+)\n/.exec(said)
      if (port !== null) {
        child.stdout.removeAllListeners('data')
        answer(`serving ${port[1]}`)
      }
    })
    return
  }
  if (command === '/shell') {
    const typed = line.trim().slice('/shell'.length).trim()
    runShell(typed, log, saveLog, (ran) => answer(`shell ${String(ran.code)}`))
    return
  }
  if (command === '/flood') {
    const lines = Number(arg) || 1000
    const all = []
    for (let n = 0; n < lines; n += 1) all.push(`flood ${String(n).padStart(6, '0')} ${'.'.repeat(50)}\r\n`)
    out(all.join(''))
    return answer('flood done')
  }
  if (line.trim() === '') return drawPrompt()

  log.prompts.push(line)
  saveLog()
  setStatus('busy')
  recordPrompt(line)
  setStatus('idle')
  answer(`You said: ${line}`)
}

/** Escape, Claude Code's stop key: it ends the oldest turn in progress. */
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
    setStatus('idle')
    answer(key === 'y' ? 'Allowed.' : 'Denied.')
    drainTurns()
    return drainQueue()
  }
  if (key === '\x03') {
    if (buffer !== '') {
      buffer = ''
      return drawPrompt()
    }
    if (Date.now() - lastInterrupt < 2000) return exit(0)
    lastInterrupt = Date.now()
    return out('\r\n  Press Ctrl-C again to exit\r\n> ')
  }
  if (key === '\x04' && buffer === '') return exit(0)
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
// The test that owns this run is gone (crashed or killed), so nothing will
// end it: it ends itself, as closing it would.
watchOwner(configDir, () => exit(0))
process.stdout.on('resize', () => {
  log.resized.push({ cols: process.stdout.columns, rows: process.stdout.rows })
  saveLog()
})

setStatus(undefined)
writeKey()
saveLog()
out(
  `\x1b[2J\x1b[H* Claude Code v${VERSION} (fake)\r\n` +
    `  ${cwd}\r\n` +
    (resume !== undefined ? `  Resumed ${sessionId}\r\n` : '') +
    '\r\n  ? for shortcuts\r\n'
)
out(ENABLE_BRACKETED_PASTE)
drawPrompt()
setStatus('idle')

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
// Escape sequences (arrows, focus reports) are dropped whole. Mouse reports
// (`ESC [ <`) are logged first.
const input = new InputReader({
  submitKey: '\r',
  stopKey: '\x1b',
  onKey,
  onPaste,
  onStop,
  onSequence: (sequence) => {
    if (!sequence.startsWith('\x1b[<')) return
    log.mouse.push(sequence)
    saveLog()
  }
})
process.stdin.on('data', (chunk) => input.feed(chunk))
process.stdin.on('end', () => exit(0))
log.listening = true
saveLog()
