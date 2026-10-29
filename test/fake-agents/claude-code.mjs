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
//   recorded in, as the real CLI does.
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
//
// An interactive run, and the child `/child` starts, exit once the test
// process that owns them is gone: the one a `test-owner` file names in the
// config folder or a folder above it (`watchOwner` in `common.mjs`).
//
// Commands typed at its prompt:
//   /exit        exit 0
//   /crash       exit 3
//   /wait        report status "waiting" until y or n is pressed
//   /busy <ms>   report status "busy" for that long
//   /child       start a long-running child process, for process-tree tests
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
import { childScript, fakeVersion, parseArgv, RunLog, UsageError, watchOwner, writeJsonAtomically } from './common.mjs'

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
  mouse: []
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
// Each value may hold several, split on commas or spaces, as the real CLI reads them.
log.allowedTools = (opts.allowedTools ?? []).flatMap((value) => value.split(/[\s,]+/).filter(Boolean))

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

const drawPrompt = () => out(`\r\x1b[2K> ${buffer}`)

function answer(text) {
  out(`\r\n${text}\r\n\r\n`)
  drawPrompt()
}

function submit(line) {
  log.received.push(line)
  saveLog()
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
    setStatus('busy')
    setTimeout(() => {
      setStatus('idle')
      answer('Done.')
    }, Number(arg) || 1000)
    return
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
  if (line.trim() === '') return drawPrompt()

  setStatus('busy')
  recordPrompt(line)
  setStatus('idle')
  answer(`You said: ${line}`)
}

function onKey(key) {
  if (asking) {
    if (key !== 'y' && key !== 'n') return
    asking = false
    setStatus('idle')
    return answer(key === 'y' ? 'Allowed.' : 'Denied.')
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
    return submit(line)
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
drawPrompt()
setStatus('idle')

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  // Escape sequences (arrows, focus reports) are dropped whole; matching ESC is
  // the point of the pattern. Mouse reports (`ESC [ <`) are logged first.
  // eslint-disable-next-line no-control-regex
  for (const part of chunk.split(/(\x1b\[[0-?]*[ -/]*[@-~]|\x1b.)/)) {
    if (part.startsWith('\x1b[<')) {
      log.mouse.push(part)
      saveLog()
    }
    if (part === '' || part.startsWith('\x1b')) continue
    for (const key of part) onKey(key)
  }
})
process.stdin.on('end', () => exit(0))
