import { type BrowserWindow } from 'electron'
import type { SessionRecord } from '@helm/core'
import { squash } from './bridge'
import type { BrowserHost } from './browser'
import type { BrowserMcpHost } from './browser-mcp'
import type { Confirm, ConfirmRequest, SessionHost, SessionObserver } from './sessions'
import type { Services } from './services'

/**
 * What the in-app driver (`packaging-check`) is handed once the window has
 * mounted. It is a diagnostic tool, not a test: see docs/TESTING.md.
 */
export interface CheckContext {
  win: BrowserWindow
  services: Services
  sessions: SessionHost
  /** The browser pane's native views, which are not in the DOM at all. */
  browsers: BrowserHost
  /** Null where the app started with every agent tool setting off. */
  browserMcp: BrowserMcpHost | null
}

export interface Collector extends SessionObserver {
  output: (id: number) => string
  notified: () => SessionRecord[]
  /** Stands in for the native confirmation dialog, which has no automation surface. */
  confirm: Confirm
  /** What the next confirmation will be answered with. */
  answerWith: (agreed: boolean) => void
  asked: () => ConfirmRequest[]
}

export function createCollector(): Collector {
  const output = new Map<number, string>()
  const notified: SessionRecord[] = []
  const asked: ConfirmRequest[] = []
  let answer = false

  return {
    onOutput: (id, chunk) => output.set(id, (output.get(id) ?? '') + chunk),
    onNotified: (record) => notified.push(record),
    output: (id) => output.get(id) ?? '',
    notified: () => [...notified],
    confirm: (request) => {
      asked.push(request)
      return Promise.resolve(answer)
    },
    answerWith: (agreed) => {
      answer = agreed
    },
    asked: () => [...asked]
  }
}

/**
 * Answers Claude Code's startup gates - folder trust, MCP enablement - for the
 * sessions a driver starts. The output is squashed because the TUI positions
 * text with cursor moves rather than spaces.
 */
export function answerStartupGates(
  ctx: { sessions: SessionHost },
  collector: Collector,
  ids: number[]
): () => void {
  const answered = new Set<string>()
  const timer = setInterval(() => {
    for (const id of ids) {
      const text = squash(collector.output(id))
      if (
        !answered.has(`trust:${String(id)}`) &&
        /doyoutrust|trustthisfolder|quicksafetycheck/.test(text)
      ) {
        answered.add(`trust:${String(id)}`)
        ctx.sessions.input(id, '\r')
      }
      if (!answered.has(`mcp:${String(id)}`) && /mcpservers/.test(text)) {
        answered.add(`mcp:${String(id)}`)
        ctx.sessions.input(id, '\x1b')
      }
    }
  }, 300)
  return () => clearInterval(timer)
}

/**
 * Whether a hosted session has reached its input prompt: the composer's hint
 * line in either of its forms, or the wide welcome banner as a fallback.
 */
export const atPrompt = (text: string): boolean =>
  /\?\s*for\s*shortcuts/.test(text) ||
  /shift\s*\+?\s*tab\s*to\s*cycle/i.test(text) ||
  /Claude\s*Code\s*v\d/.test(text)
