// A stand-in for the `claude` CLI, used by Helm's integration and end-to-end
// tests. It does what Helm can observe of the real CLI, deterministically and
// with no network:
//
// - `--version` and `--help` answer the way the version guard and the
//   `--session-id` capability probe expect.
// - An interactive run draws a prompt, echoes what is typed, and writes the
//   files Helm reads: the session registry record
//   (`<config>/sessions/<pid>.json`), `history.jsonl`, and a transcript under
//   `projects/`.
// - `--resume <id>` succeeds only in the directory the conversation was
//   recorded in, as the real CLI does.
//
// Everything it was given and everything it received is written to
// `<config>/fake-claude/<pid>.json`, so a test can assert what reached the
// session without reading the screen.
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
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const VERSION = '2.1.999'
const argv = process.argv.slice(2)
const out = (text) => process.stdout.write(text)

if (argv.includes('--version') || argv.includes('-v')) {
  out(`${VERSION} (Claude Code)\n`)
  process.exit(0)
}

if (argv.includes('--help') || argv.includes('-h')) {
  out(
    [
      'Usage: claude [options] [command] [prompt]',
      '',
      'Options:',
      '  -r, --resume [sessionId]       Resume a conversation',
      '  --session-id <uuid>            Use a specific session ID for the conversation',
      '  -n, --name <name>              Name the session',
      '  --model <model>                Model for the current session',
      '  --permission-mode <mode>       Permission mode to use for the session',
      '  --mcp-config <configs...>      Load MCP servers from JSON files or strings',
      '  --add-dir <directories...>     Additional directories to allow tool access to',
      '  --plugin-dir <paths...>        Load plugins from directories',
      '  -v, --version                  Output the version number',
      '  -h, --help                     Display help for command',
      ''
    ].join('\n')
  )
  process.exit(0)
}

// `claude mcp add-json <name> <json> -s <scope>` and `claude mcp remove <name>
// -s <scope>` write the file the real CLI writes for that scope: `.mcp.json` in
// the working directory for `project`, `~/.claude.json` for `user` and, under
// the working directory's entry, for `local`.
if (argv[0] === 'mcp' && (argv[1] === 'add-json' || argv[1] === 'remove')) {
  const at = argv.indexOf('-s')
  const scope = at >= 0 ? argv[at + 1] : 'local'
  const name = argv[2]
  const file = scope === 'project' ? join(process.cwd(), '.mcp.json') : join(homedir(), '.claude.json')
  const document = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8') || '{}') : {}
  const holder = scope === 'local' ? (((document.projects ??= {})[process.cwd()]) ??= {}) : document
  const servers = (holder.mcpServers ??= {})
  if (argv[1] === 'add-json') {
    servers[name] = JSON.parse(argv[3])
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

// Anything else that is not interactive (`claude mcp list`, `claude -p ...`)
// answers nothing and succeeds.
if (argv[0] === 'mcp' || argv.includes('-p') || argv.includes('--print')) process.exit(0)

const configDir = (process.env.CLAUDE_CONFIG_DIR ?? '').trim() || join(homedir(), '.claude')
const cwd = process.cwd()
const option = (...names) => {
  for (const name of names) {
    const at = argv.indexOf(name)
    if (at >= 0 && at + 1 < argv.length) return argv[at + 1]
  }
  return undefined
}

/** The CLI's own directory naming under `projects/`: anything not alphanumeric becomes `-`. */
const projectDirName = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-')
const sameDir = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

let sessionId = option('--session-id') ?? randomUUID()
const resume = option('--resume', '-r')
if (resume !== undefined) {
  const recorded = findTranscript(resume)
  if (recorded === null || !sameDir(recorded.cwd, cwd)) {
    out(`No conversation found with session ID: ${resume}\r\n`)
    process.exit(1)
  }
  sessionId = resume
}

const name = option('--name', '-n') ?? null
const startedAt = Date.now()
const registryFile = join(configDir, 'sessions', `${String(process.pid)}.json`)
const logFile = join(configDir, 'fake-claude', `${String(process.pid)}.json`)
const transcriptOf = (id) => join(configDir, 'projects', projectDirName(cwd), `${id}.jsonl`)
let transcriptFile = transcriptOf(sessionId)
// `sessionId` is the conversation the run began in; `current` follows a /clear.
const log = {
  pid: process.pid,
  argv,
  cwd,
  sessionId,
  current: sessionId,
  resumed: resume !== undefined,
  received: [],
  resized: [],
  mouse: [],
  exitCode: null
}
const children = []

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

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}

function saveLog() {
  writeJson(logFile, log)
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
  writeJson(registryFile, record)
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
        message: { role: 'assistant', content: [{ type: 'text', text: `You said: ${text}` }] }
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
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
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
process.stdout.on('resize', () => {
  log.resized.push({ cols: process.stdout.columns, rows: process.stdout.rows })
  saveLog()
})

setStatus(undefined)
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
