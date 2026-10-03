import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { electronFake } from './electron'

/** A request channel's handler, as `registerIpc` installed it: payload in, answer out. */
export type IpcHandler = (payload?: unknown) => unknown

/**
 * `electronFake()`, with `ipcMain.handle` keeping each handler `registerIpc`
 * installs in `handlers`, so a test can invoke a channel the way the window
 * does:
 *
 *   const handlers = vi.hoisted(() => new Map<string, IpcHandler>())
 *   vi.mock('electron', async () => (await import('../../test/history-fixture')).electronRecordingIpc(handlers))
 */
export function electronRecordingIpc(handlers: Map<string, IpcHandler>): Record<string, unknown> {
  const fake = electronFake()
  return {
    ...fake,
    ipcMain: {
      ...(fake['ipcMain'] as Record<string, unknown>),
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        handlers.set(channel, (payload) => handler({}, payload))
      }
    }
  }
}

/**
 * A `.claude` tree for the session history and transcript archive tests,
 * written the way the CLI writes one (and `fake-claude.mjs` imitates): every
 * prompt appended to `history.jsonl`, and each conversation's transcript under
 * `projects/<directory>/<session id>.jsonl`.
 */
export interface ClaudeTree {
  dir: string
  historyFile: string
  projectsDir: string
}

export function claudeTree(dir: string): ClaudeTree {
  const projectsDir = join(dir, 'projects')
  mkdirSync(projectsDir, { recursive: true })
  return { dir, historyFile: join(dir, 'history.jsonl'), projectsDir }
}

/** A session id of the shape the transcript scan recognises, from a small number. */
export function sessionUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

export interface FixturePrompt {
  sessionId: string
  project: string
  display: string
  at: number
}

/** Appends prompts to `history.jsonl`, one record per line, as the CLI does on submit. */
export function appendPrompts(tree: ClaudeTree, prompts: readonly FixturePrompt[]): void {
  appendFileSync(
    tree.historyFile,
    prompts
      .map(({ sessionId, project, display, at }) =>
        JSON.stringify({ display, pastedContents: {}, timestamp: at, project, sessionId })
      )
      .map((line) => `${line}\n`)
      .join('')
  )
}

export interface FixtureMessage {
  role: 'user' | 'assistant'
  text: string
  at: number
}

/** The CLI's own directory naming under `projects/`: anything not alphanumeric becomes `-`. */
export function transcriptFile(tree: ClaudeTree, sessionId: string, cwd: string): string {
  return join(tree.projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
}

/**
 * Appends messages to a session's transcript, creating it if needed, and
 * returns its path. A user message's content is a string and an assistant's a
 * list of blocks, as the CLI writes them.
 */
export function appendTranscript(
  tree: ClaudeTree,
  session: { sessionId: string; cwd: string },
  messages: readonly FixtureMessage[]
): string {
  const file = transcriptFile(tree, session.sessionId, session.cwd)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(
    file,
    messages
      .map(({ role, text, at }) =>
        JSON.stringify({
          type: role,
          uuid: randomUUID(),
          sessionId: session.sessionId,
          cwd: session.cwd,
          timestamp: new Date(at).toISOString(),
          message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }
        })
      )
      .map((line) => `${line}\n`)
      .join('')
  )
  return file
}
