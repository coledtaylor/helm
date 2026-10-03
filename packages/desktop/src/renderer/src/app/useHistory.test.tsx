import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  archiveCursor,
  archiveTranscriptFile,
  directoryExists,
  historyCursor,
  historySummary,
  indexHistory,
  openStore,
  readArchiveStats,
  readArchiveTail,
  readArchivedConversation,
  readHistoryPrompts,
  readHistorySessions,
  readHistoryTail,
  renameHistorySession,
  scanTranscripts,
  type HistoryPage,
  type HistoryQuery,
  type HistorySummary,
  type Store
} from '@helm/core'
import { SessionHistory } from '@helm/ui'
import { bridge } from './bridge.testkit'
import { sessionHistoryProps, useHistory } from './useHistory'

/**
 * The history pane as the window runs it - `useHistory` feeding
 * `SessionHistory` through the app's own wiring - against a real index and
 * archive over a `.claude` tree on disk. Only the IPC hop is stood in for: each
 * channel answers with what its handler in `main/ipc.ts` calls. The main
 * process's side of keeping that index current is `main/history.test.ts`.
 */

vi.mock('./bridge', () => import('./bridge.testkit'))
// A resume measures a terminal cell in the DOM; no test here resumes anything.
vi.mock('./terminals', () => ({ estimateGrid: () => ({ cols: 100, rows: 30 }) }))

const T0 = Date.UTC(2026, 8, 1, 9, 0, 0)
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const S = { staging: uuid(1), notes: uuid(2), docs: uuid(3), parser: uuid(4), terminal: uuid(5) }

let root: string
let claudeDir: string
let store: Store
let alpha: string
/** Every page `history:sessions` answered, with the query that asked for it. */
let queries: Array<{ payload: HistoryQuery; result: HistoryPage }> = []

const historyFile = (): string => join(claudeDir, 'history.jsonl')
const projectsDir = (): string => join(claudeDir, 'projects')

/** Prompts as the CLI appends them on submit. */
function appendPrompts(prompts: Array<{ sessionId: string; project: string; display: string; at: number }>): void {
  for (const { sessionId, project, display, at } of prompts) {
    appendFileSync(historyFile(), `${JSON.stringify({ display, pastedContents: {}, timestamp: at, project, sessionId })}\n`)
  }
}

/** A transcript where the CLI keeps it, under a directory named for the folder. */
function writeTranscript(sessionId: string, cwd: string, messages: Array<{ role: 'user' | 'assistant'; text: string }>): string {
  const file = join(projectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  for (const { role, text } of messages) {
    const content = role === 'user' ? text : [{ type: 'text', text }]
    const line = { type: role, uuid: randomUUID(), sessionId, cwd, timestamp: new Date(T0).toISOString(), message: { role, content } }
    appendFileSync(file, `${JSON.stringify(line)}\n`)
  }
  return file
}

/**
 * One pass of what the main process does when `history.jsonl` or a transcript
 * changes (`main/history.ts`, `main/archive.ts`): index what was appended, then
 * archive what the transcripts gained.
 */
function indexPass(): HistorySummary {
  const file = historyFile()
  const transcripts = scanTranscripts(projectsDir())
  const summary = indexHistory(store, {
    file,
    tail: readHistoryTail(file, historyCursor(store, file)),
    transcripts,
    directoryExists
  })
  for (const { file: transcript, sessionId } of transcripts.values()) {
    const tail = readArchiveTail(transcript, archiveCursor(store, transcript), sessionId)
    archiveTranscriptFile(store, { file: transcript, sessionId, tail })
  }
  return summary
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm history view-'))
  claudeDir = join(root, '.claude')
  alpha = join(root, 'alpha')
  const beta = join(root, 'beta')
  for (const dir of [claudeDir, alpha, beta]) mkdirSync(dir)

  appendPrompts([
    { sessionId: S.staging, project: alpha, display: 'deploy the staging site', at: T0 + 1000 },
    { sessionId: S.staging, project: alpha, display: 'then check the logs', at: T0 + 2000 },
    { sessionId: S.notes, project: beta, display: 'write the release notes', at: T0 + 3000 },
    { sessionId: S.docs, project: alpha, display: 'deploy the docs to pages', at: T0 + 4000 },
    { sessionId: S.parser, project: beta, display: 'refactor the parser', at: T0 + 5000 }
  ])
  writeTranscript(S.staging, alpha, [{ role: 'user', text: 'deploy the staging site' }])
  writeTranscript(S.notes, beta, [{ role: 'user', text: 'write the release notes' }])
  const parser = writeTranscript(S.parser, beta, [
    { role: 'user', text: 'refactor the parser' },
    { role: 'assistant', text: 'Done. The token is zorblatt.' }
  ])

  store = openStore({ file: join(root, 'helm.db') })
  indexPass()
  // Claude Code reaps the parser session's transcript after Helm archived it.
  // The docs session never had one Helm saw.
  rmSync(parser)
  indexPass()

  bridge.reset()
  queries = []
  bridge.answer('history:summary', () => historySummary(store, historyFile()))
  bridge.answer('history:sessions', (query) => {
    const result = readHistorySessions(store, query)
    queries.push({ payload: query, result })
    return result
  })
  bridge.answer('history:prompts', ({ sessionId }) => readHistoryPrompts(store, sessionId))
  bridge.answer('history:refresh', () => indexPass())
  bridge.answer('history:rename', ({ sessionId, name }) => renameHistorySession(store, sessionId, name))
  bridge.answer('archive:conversation', ({ sessionId }) => readArchivedConversation(store, sessionId))
  bridge.answer('archive:stats', () => readArchiveStats(store, 1024 ** 3))
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function HistoryPage(): JSX.Element {
  const state = useHistory()
  return <SessionHistory {...sessionHistoryProps(state)} onResume={() => undefined} onReveal={() => undefined} />
}

const list = (): HTMLElement => screen.getByRole('group', { name: 'Sessions' })
const rows = (): HTMLElement[] => within(list()).queryAllByRole('button')
const row = (title: string): HTMLElement => within(list()).getByRole('button', { name: new RegExp(`^${title}`) })

function section(heading: RegExp): HTMLElement {
  const found = screen.getByRole('heading', { name: heading }).closest('section')
  if (found === null) throw new Error(`no section under ${String(heading)}`)
  return found
}

const lastQuery = (): { payload: HistoryQuery; result: HistoryPage } | undefined => queries.at(-1)

describe('the history pane over the session index', () => {
  it('paints exactly the sessions the query for what was typed returns', async () => {
    const user = userEvent.setup()
    render(<HistoryPage />)
    await waitFor(() => expect(rows()).toHaveLength(4))

    await user.type(screen.getByRole('textbox', { name: 'Search prompts and projects' }), 'deploy')
    await waitFor(() => {
      expect(lastQuery()?.payload).toMatchObject({ search: 'deploy', scope: 'prompts' })
      expect(rows()).toHaveLength(2)
    })
    expect(lastQuery()?.result.sessions.map((s) => s.sessionId)).toEqual([S.docs, S.staging])
    expect(row('deploy the docs to pages')).toBeTruthy()
    expect(row('deploy the staging site')).toBeTruthy()
  })

  it('repaints the row and the heading with a hand-given name, and the derived title once it is cleared', async () => {
    const user = userEvent.setup()
    render(<HistoryPage />)
    await user.click(await waitFor(() => row('write the release notes')))

    await user.click(await screen.findByRole('button', { name: 'Name this session' }))
    const field = screen.getByRole('textbox', { name: 'Name this session' })
    await user.clear(field)
    await user.type(field, 'Release prep{Enter}')
    await waitFor(() => expect(row('Release prep')).toBeTruthy())
    expect(screen.getByRole('heading', { name: 'Release prep' })).toBeTruthy()
    expect(within(list()).queryByRole('button', { name: /^write the release notes/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Use the derived title' }))
    await waitFor(() => expect(row('write the release notes')).toBeTruthy())
    expect(screen.getByRole('heading', { name: 'write the release notes' })).toBeTruthy()
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM history_names').get()).toEqual({ n: 0 })
  })

  it('shows a session started outside Helm as soon as main indexes it, without the window asking', async () => {
    render(<HistoryPage />)
    await waitFor(() => expect(rows()).toHaveLength(4))

    appendPrompts([{ sessionId: S.terminal, project: alpha, display: 'a session from a terminal', at: T0 + 6000 }])
    // What the watch or the poll in `main/history.ts` does: a pass, and the
    // totals pushed to the window as `history:changed`.
    act(() => {
      bridge.emit('history:changed', indexPass())
    })

    await waitFor(() => expect(row('a session from a terminal')).toBeTruthy())
    expect(rows()).toHaveLength(5)
    expect(bridge.invoked('history:refresh')).toEqual([])
  })

  it('finds a word said in an archived conversation only when searching conversations', async () => {
    const user = userEvent.setup()
    render(<HistoryPage />)
    await waitFor(() => expect(rows()).toHaveLength(4))

    await user.type(screen.getByRole('textbox', { name: 'Search prompts and projects' }), 'zorblatt')
    await screen.findByText('No session matches that.')

    await user.click(screen.getByRole('button', { name: 'Conversations' }))
    await waitFor(() => {
      expect(lastQuery()?.payload).toMatchObject({ search: 'zorblatt', scope: 'messages' })
      expect(rows()).toHaveLength(1)
    })
    const hit = rows()[0] as HTMLElement
    expect(hit.textContent).toContain('zorblatt')
    expect(within(hit).getByText('matched')).toBeTruthy()

    await user.click(hit)
    expect(await screen.findByRole('heading', { name: 'refactor the parser' })).toBeTruthy()
  })

  it('opens an archived transcript, and an unavailable panel for a session reaped before Helm saw it', async () => {
    const user = userEvent.setup()
    render(<HistoryPage />)

    await user.click(await waitFor(() => row('refactor the parser')))
    expect(await screen.findByText('This conversation cannot be reopened, but Helm kept it')).toBeTruthy()
    await waitFor(() =>
      expect(within(section(/^Conversation/)).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        expect.stringMatching(/^You said: refactor the parser/),
        expect.stringMatching(/^Claude said: Done\. The token is zorblatt\./)
      ])
    )

    await user.click(row('deploy the docs to pages'))
    expect(await screen.findByText('This conversation cannot be reopened')).toBeTruthy()
    expect(screen.getByText(/already removed the transcript before Helm saw this session/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^Conversation/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resume in a tab' })).toBeNull()
  })
})
