import type { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import { release } from 'node:os'

/**
 * Environment variables Electron injects (or that leak from the dev toolchain)
 * which must not reach a hosted `claude` process. NODE_OPTIONS in particular
 * gets applied to every Node child the session spawns.
 */
const STRIPPED_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'ELECTRON_IS_DEV',
  'NODE_OPTIONS',
  'NODE_ENV',
  'VITE_DEV_SERVER_URL',
  // Claude Code stamps these on every process it spawns. If Helm is launched
  // from inside a session they are inherited, and the hosted `claude` decides
  // it is a nested child: it announces "Transcript saving is off - inherited
  // CLAUDE_CODE_CHILD_SESSION marker" and stops writing a transcript. Observed
  // during Spike C; a host has to hand every session a clean slate.
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID'
]

/**
 * A hosted TUI only renders in full colour if the host advertises it. Claude
 * Code, like most Ink apps, resolves colour depth from COLORTERM first and
 * falls back to a 256-colour palette without it - the single most likely cause
 * of a "the theme looks wrong in the app" report.
 */
export function ptyEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v
  }
  delete env.NO_COLOR
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return { ...env, ...extra }
}

/** Windows build number, e.g. 26100 from "10.0.26100". xterm uses it to pick
 * ConPTY quirk handling. */
export function windowsBuildNumber(): number | undefined {
  const parts = release().split('.')
  const build = Number(parts[2])
  return Number.isFinite(build) ? build : undefined
}

export interface PtyHandle {
  pty: pty.IPty
  /** Everything the process has written, unmodified. */
  output: () => string
  /** Everything the host has written *to* the process - the input side of the
   * wire, which is where bracketed paste and key encoding are provable. */
  input: () => string
  clearOutput: () => void
  clearInput: () => void
  exited: () => number | null
}

let current: PtyHandle | null = null

export function activePty(): PtyHandle | null {
  return current
}

export interface SpawnOptions {
  file: string
  args?: string[]
  cols: number
  rows: number
  cwd: string
  env?: Record<string, string>
}

export function spawnPty(win: BrowserWindow, opts: SpawnOptions): PtyHandle {
  const p = pty.spawn(opts.file, opts.args ?? [], {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: ptyEnv(opts.env),
    useConpty: true,
    conptyInheritCursor: false
  })

  let out = ''
  let inp = ''
  let exitCode: number | null = null

  p.onData((chunk) => {
    out += chunk
    win.webContents.send('term:write', chunk)
  })
  p.onExit(({ exitCode: code }) => {
    exitCode = code
  })

  const handle: PtyHandle = {
    pty: p,
    output: () => out,
    input: () => inp,
    clearOutput: () => {
      out = ''
    },
    clearInput: () => {
      inp = ''
    },
    exited: () => exitCode
  }
  // Record host->process bytes regardless of who writes them, so the driver can
  // assert on the exact encoding of a keystroke or a paste.
  const rawWrite = p.write.bind(p)
  p.write = (data: string): void => {
    inp += data
    rawWrite(data)
  }

  current = handle
  return handle
}

export function killPty(): void {
  try {
    current?.pty.kill()
  } catch {
    // already gone
  }
  current = null
}
