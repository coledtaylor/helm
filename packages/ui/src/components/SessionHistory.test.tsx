import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchiveMessage, ArchivedConversation, HistoryPrompt, HistorySession } from '@helm/core'
import { SessionHistory, type SessionHistoryProps } from './SessionHistory'
import { expectOnThePane } from './page.testkit'

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const ALPHA = 'C:\\repos\\alpha'
const BETA = 'C:\\repos\\beta'

function session(id: string, overrides: Partial<HistorySession> = {}): HistorySession {
  const text = overrides.title ?? `prompt for ${id}`
  return {
    sessionId: id,
    project: ALPHA,
    projectName: 'alpha',
    promptCount: 1,
    firstAt: NOW - HOUR,
    lastAt: NOW - HOUR,
    firstPrompt: text,
    title: text,
    titleFallback: false,
    label: null,
    transcriptFile: `C:\\Users\\x\\.claude\\projects\\C--repos-alpha\\${id}.jsonl`,
    transcriptBytes: 2048,
    projectExists: true,
    archive: null,
    archivedMessages: null,
    ...overrides
  }
}

/** A session whose transcript Claude Code has reaped. */
const reaped = (id: string, overrides: Partial<HistorySession> = {}): HistorySession =>
  session(id, { transcriptFile: null, transcriptBytes: null, ...overrides })

function renderHistory(overrides: Partial<SessionHistoryProps> = {}, sessions: HistorySession[] = []) {
  const props: SessionHistoryProps = {
    summary: null,
    page: { sessions, total: sessions.length, tookMs: 0.4 },
    loading: false,
    search: '',
    onSearchChange: vi.fn(),
    scope: 'prompts',
    onScopeChange: vi.fn(),
    archiveStats: null,
    grouping: 'recent',
    onGroupingChange: vi.fn(),
    resumableOnly: false,
    onResumableOnlyChange: vi.fn(),
    project: null,
    onProjectChange: vi.fn(),
    selected: null,
    onSelect: vi.fn(),
    prompts: [],
    promptsLoading: false,
    conversation: null,
    conversationLoading: false,
    onRename: vi.fn(),
    onRefresh: vi.fn(),
    refreshing: false,
    onResume: vi.fn(),
    resuming: null,
    onDismissResumeError: vi.fn(),
    onReveal: vi.fn(),
    ...overrides
  }
  const view = render(<SessionHistory {...props} />)
  return {
    props,
    rerender: (next: Partial<SessionHistoryProps>) => {
      Object.assign(props, next)
      view.rerender(<SessionHistory {...props} />)
    }
  }
}

const list = (): HTMLElement => screen.getByRole('group', { name: 'Sessions' })

/** A row, by the title it starts with. */
const row = (title: string): HTMLElement =>
  within(list()).getByRole('button', { name: new RegExp(`^${title}`) })

/** The section under a caps heading, such as "Prompts" or "Conversation". */
function section(heading: RegExp): HTMLElement {
  const found = screen.getByRole('heading', { name: heading }).closest('section')
  if (found === null) throw new Error(`no section under ${String(heading)}`)
  return found
}

const BADGES = ['history only', 'archived', 'dropped', 'folder gone']

describe('SessionHistory', () => {
  beforeEach(() => {
    // Only the clock: ages are read against it, and user events keep real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists every session with its project and how long ago it was active', () => {
    const ages: Array<[string, string, number, string]> = [
      ['tidy the readme', 'alpha', NOW - 20_000, 'now'],
      ['fix the flaky test', 'beta', NOW - 5 * MINUTE, '5m'],
      ['plan the release', 'alpha', NOW - 3 * HOUR, '3h'],
      ['review the schema', 'beta', NOW - 2 * DAY, '2d'],
      ['port the parser', 'alpha', NOW - 21 * DAY, '3w'],
      ['first experiment', 'beta', NOW - 400 * DAY, '1y']
    ]
    renderHistory(
      { summary: { sessions: 6, prompts: 9, projects: 2, resumable: 4, latestAt: NOW, historyFile: 'h', indexedBytes: 1 } },
      ages.map(([title, project, lastAt], i) =>
        session(`s${String(i)}`, { title, projectName: project, project: project === 'alpha' ? ALPHA : BETA, lastAt })
      )
    )

    expect(within(list()).getAllByRole('button')).toHaveLength(ages.length)
    for (const [title, project, , age] of ages) {
      expect(within(row(title)).getByText(project)).toBeTruthy()
      expect(within(row(title)).getByText(age)).toBeTruthy()
    }
    for (const figure of ['6 sessions', '9 prompts', '2 projects', '4 resumable']) {
      expect(screen.getByText(figure)).toBeTruthy()
    }
  })

  it('groups by project under one counted header per directory, whatever its case, and keeps every row', async () => {
    const sessions = [
      session('a1', { title: 'alpha one' }),
      session('b1', { title: 'beta one', project: BETA, projectName: 'beta' }),
      session('a2', { title: 'alpha two', project: 'C:\\Repos\\Alpha', projectName: 'Alpha' }),
      session('a3', { title: 'alpha three' })
    ]
    const { props } = renderHistory({ grouping: 'project' }, sessions)

    const headers = [/^alpha\s*3$/, /^beta\s*1$/]
    for (const header of headers) expect(within(list()).getByRole('button', { name: header })).toBeTruthy()
    expect(within(list()).getAllByRole('button')).toHaveLength(headers.length + sessions.length)
    for (const title of ['alpha one', 'alpha two', 'alpha three', 'beta one']) expect(row(title)).toBeTruthy()

    await userEvent.click(within(list()).getByRole('button', { name: /^alpha\s*3$/ }))
    expect(props.onProjectChange).toHaveBeenCalledWith(ALPHA)
  })

  it('switches between recent and by-project grouping', async () => {
    const { props } = renderHistory({}, [session('a')])
    const grouping = screen.getByRole('group', { name: 'Grouping' })
    expect(within(grouping).getByRole('button', { name: 'Recent' }).getAttribute('aria-pressed')).toBe('true')

    await userEvent.click(within(grouping).getByRole('button', { name: 'By project' }))
    expect(props.onGroupingChange).toHaveBeenCalledWith('project')
  })

  it('marks every session that cannot be reopened with a word, and offers a resume only on the rest', () => {
    const cases: Array<[HistorySession, string | null]> = [
      [session('open', { title: 'still on disk' }), null],
      [reaped('gone', { title: 'reaped before helm' }), 'history only'],
      [reaped('kept', { title: 'kept by helm', archive: 'archived', archivedMessages: 4 }), 'archived'],
      [reaped('evicted', { title: 'dropped by the ceiling', archive: 'evicted', archivedMessages: 0 }), 'dropped'],
      [session('moved', { title: 'folder deleted', projectExists: false }), 'folder gone']
    ]
    const { rerender } = renderHistory({}, cases.map(([s]) => s))

    for (const [s, badge] of cases) {
      const shown = BADGES.filter((word) => within(row(s.title)).queryByText(word) !== null)
      expect(shown).toEqual(badge === null ? [] : [badge])

      rerender({ selected: s })
      const resume = screen.queryByRole('button', { name: 'Resume in a tab' })
      expect(resume !== null).toBe(badge === null)
    }
  })

  it('explains a reaped session instead of offering a resume, and lists all of its prompts', () => {
    const gone = reaped('gone', { title: 'reaped before helm', promptCount: 3 })
    const prompts: HistoryPrompt[] = ['reaped before helm', 'now the tests', 'and the docs'].map((text, seq) => ({
      sessionId: 'gone',
      seq,
      text,
      at: NOW - HOUR + seq * MINUTE
    }))
    renderHistory({ selected: gone, prompts, summary: { sessions: 10, prompts: 30, projects: 2, resumable: 4, latestAt: NOW, historyFile: 'h', indexedBytes: 1 } }, [gone])

    expect(screen.queryByRole('button', { name: 'Resume in a tab' })).toBeNull()
    expect(screen.getByText('This conversation cannot be reopened')).toBeTruthy()
    expect(screen.getByText(/already removed the transcript before Helm saw this session/)).toBeTruthy()
    expect(screen.getByText(/4 of 10 sessions on\s+this machine still have one/)).toBeTruthy()

    const items = within(section(/^Prompts/)).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      '1hreaped before helm',
      '59mnow the tests',
      '58mand the docs'
    ])
  })

  it('opens an archived conversation read-only beside the sentence that says Helm kept it', () => {
    const kept = reaped('kept', { title: 'kept by helm', archive: 'archived', archivedMessages: 2 })
    renderHistory(
      {
        selected: kept,
        conversation: conversation('kept', [
          message('user', 'what changed in the schema'),
          message('assistant', 'Two columns were added.')
        ])
      },
      [kept]
    )

    expect(screen.queryByRole('button', { name: 'Resume in a tab' })).toBeNull()
    expect(screen.getByText('This conversation cannot be reopened, but Helm kept it')).toBeTruthy()
    expect(screen.getByText('archived here')).toBeTruthy()
    const items = within(section(/^Conversation/)).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^You said: what changed in the schema/),
      expect.stringMatching(/^Claude said: Two columns were added\./)
    ])
    // Read-only: nothing in the conversation can be typed into or pressed.
    expect(within(section(/^Conversation/)).queryAllByRole('textbox')).toEqual([])
    expect(within(section(/^Conversation/)).queryAllByRole('button')).toEqual([])
  })

  it('renders each message as a row and folds each run of tool-only messages into one line', () => {
    const kept = reaped('kept', { title: 'kept by helm', archive: 'archived', archivedMessages: 6 })
    renderHistory(
      {
        selected: kept,
        conversation: conversation('kept', [
          message('user', 'why does the build fail'),
          message('assistant', '[tool: Read]'),
          message('assistant', '[tool: Read]\n\n[tool: Bash]'),
          message('assistant', 'The lockfile is stale.'),
          message('assistant', '[tool: Edit]'),
          message('user', 'thanks')
        ])
      },
      [kept]
    )

    const items = within(section(/^Conversation/)).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^You said: why does the build fail/),
      'Read ×2 · Bash',
      expect.stringMatching(/^Claude said: The lockfile is stale\./),
      'Edit',
      expect.stringMatching(/^You said: thanks/)
    ])
  })

  it('switches the search box between prompts and archived conversations', async () => {
    const { props, rerender } = renderHistory({}, [session('a')])
    const scope = screen.getByRole('group', { name: 'What to search' })
    expect(screen.getByRole('textbox', { name: 'Search prompts and projects' })).toBeTruthy()
    expect(within(scope).getByRole('button', { name: 'Prompts' }).getAttribute('aria-pressed')).toBe('true')

    await userEvent.click(within(scope).getByRole('button', { name: 'Conversations' }))
    expect(props.onScopeChange).toHaveBeenCalledWith('messages')

    rerender({ scope: 'messages' })
    expect(screen.getByRole('textbox', { name: 'Search archived conversations' })).toBeTruthy()
    expect(within(scope).getByRole('button', { name: 'Conversations' }).getAttribute('aria-pressed')).toBe('true')

    await userEvent.type(screen.getByRole('textbox', { name: 'Search archived conversations' }), 'z')
    expect(props.onSearchChange).toHaveBeenCalledWith('z')
  })

  it('names a session from its detail: Enter commits, Escape abandons, and the derived title comes back', async () => {
    const user = userEvent.setup()
    const s = session('a', { title: 'add geofencing to the map' })
    const { props, rerender } = renderHistory({ selected: s }, [s])

    await user.click(screen.getByRole('button', { name: 'Name this session' }))
    const field = screen.getByRole('textbox', { name: 'Name this session' })
    expect((field as HTMLInputElement).value).toBe('add geofencing to the map')
    await user.clear(field)
    await user.type(field, '  Geofencing  {Enter}')
    expect(props.onRename).toHaveBeenLastCalledWith('a', 'Geofencing')
    const committed = vi.mocked(props.onRename).mock.calls.length

    await user.click(screen.getByRole('button', { name: 'Name this session' }))
    await user.type(screen.getByRole('textbox', { name: 'Name this session' }), 'abandoned{Escape}')
    expect(vi.mocked(props.onRename).mock.calls.length).toBe(committed)

    rerender({ selected: { ...s, label: 'Geofencing' } })
    expect(screen.getByRole('heading', { name: 'Geofencing' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Use the derived title' }))
    expect(props.onRename).toHaveBeenLastCalledWith('a', null)
  })

  it('resumes a session and shows why a resume could not start', async () => {
    const s = session('a', { title: 'plan the release' })
    const { props, rerender } = renderHistory({ selected: s }, [s])

    await userEvent.click(screen.getByRole('button', { name: 'Resume in a tab' }))
    expect(props.onResume).toHaveBeenCalledWith(s)

    rerender({ resumeError: 'C:\\repos\\alpha is no longer on disk.' })
    expect(screen.getByRole('alert').textContent).toContain('C:\\repos\\alpha is no longer on disk.')
    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' }))
    expect(props.onDismissResumeError).toHaveBeenCalled()
  })
})

let uuidSeq = 0

function message(role: ArchiveMessage['role'], text: string): ArchiveMessage {
  uuidSeq++
  return { uuid: `m${String(uuidSeq)}`, role, at: NOW - HOUR, text }
}

function conversation(sessionId: string, messages: ArchiveMessage[]): ArchivedConversation {
  return {
    sessionId,
    sourceFile: `C:\\Users\\x\\.claude\\projects\\C--repos-alpha\\${sessionId}.jsonl`,
    state: 'archived',
    firstAt: NOW - HOUR,
    lastAt: NOW - HOUR,
    messageCount: messages.length,
    rawBytes: 400,
    storedBytes: 300,
    capturedAt: new Date(NOW - HOUR).toISOString(),
    evictedAt: null,
    messages
  }
}

describe('SessionHistory on its pane', () => {
  it('draws no island of its own, and its bar repeats no title the tab already says', () => {
    renderHistory()
    expectOnThePane(document.body, 'history')
    // Nothing picked is a real empty state, not a paragraph.
    expect(document.querySelector('[data-empty-state="history-detail"]')).not.toBeNull()
  })
})
