import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_INVENTORY,
  type HistorySession,
  type LiveSession,
  type Profile,
  type Project
} from '@helm/core/types'
import { NewSessionDialog, type NewSessionDialogProps } from './NewSessionDialog'

const HOME = 'C:\\Users\\someone'
const HARNESS = `${HOME}\\.harness\\dev`
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
const HOUR = 3_600_000

function project(name: string, path = `${HARNESS}\\repos\\${name}`): Project {
  return {
    path,
    name,
    kind: 'repo',
    harnessPath: HARNESS,
    hasClaudeDir: true,
    inventory: EMPTY_INVENTORY,
    git: null
  }
}

const dev: Project = { ...project('dev', HARNESS), kind: 'harness' }
const timeclick = project('timeclick')
const builder = project('TimeClick-Builder')
const helm = project('helm')
const PROJECTS = [dev, helm, builder, timeclick]

function profile(id: number, name: string, overlays: string[], patch: Partial<Profile> = {}): Profile {
  return {
    id,
    name,
    root: HARNESS,
    overlays,
    access: overlays,
    model: 'opus',
    effort: null,
    permissionMode: null,
    agent: null,
    mcp: [],
    openingPrompt: null,
    pinnedOrder: null,
    createdAt: '',
    updatedAt: '',
    ...patch
  }
}

const devProfile = profile(1, 'dev', [HARNESS], { permissionMode: 'auto' })
const timeclickProfile = profile(2, 'Timeclick', [HARNESS, timeclick.path], {
  permissionMode: 'bypassPermissions'
})
const PROFILES = [timeclickProfile, devProfile]

function conversation(sessionId: string, title: string, lastAt: number): HistorySession {
  return {
    sessionId,
    project: timeclick.path,
    projectName: 'timeclick',
    promptCount: 3,
    firstAt: lastAt - HOUR,
    lastAt,
    firstPrompt: title,
    title,
    titleFallback: false,
    label: null,
    transcriptFile: `${HOME}\\.claude\\projects\\x\\${sessionId}.jsonl`,
    transcriptBytes: 2048,
    projectExists: true,
    archive: null,
    archivedMessages: null
  }
}

const payroll = conversation('a1', 'payroll export fix', NOW - 20 * HOUR)
const breaks = conversation('a2', 'named breaks rollout', NOW - 4 * 24 * HOUR)

function renderDialog(overrides: Partial<NewSessionDialogProps> = {}): NewSessionDialogProps {
  const props: NewSessionDialogProps = {
    projects: PROJECTS,
    recency: new Map([
      [helm.path.toLowerCase(), NOW - HOUR],
      [timeclick.path.toLowerCase(), NOW - 2 * HOUR]
    ]),
    live: [],
    profiles: PROFILES,
    home: HOME,
    initialPath: null,
    resumable: new Map([[timeclick.path.toLowerCase(), [payroll, breaks]]]),
    onShowing: vi.fn(),
    busy: false,
    error: null,
    now: NOW,
    onStart: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides
  }
  render(<NewSessionDialog {...props} />)
  return props
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'New session' })
/** The folder list - the pickers' own options are options too. */
const list = (): HTMLElement => within(dialog()).getByRole('listbox', { name: 'Folders' })
const options = (): string[] =>
  within(list())
    .getAllByRole('option')
    .map((option) => option.getAttribute('aria-label') ?? '')
const highlighted = (): string | null =>
  within(list())
    .getAllByRole('option')
    .find((option) => option.getAttribute('aria-selected') === 'true')
    ?.getAttribute('aria-label') ?? null
const sentence = (): string => dialog().querySelector('[data-launch-sentence]')?.textContent ?? ''
const picker = (name: string): HTMLSelectElement =>
  within(dialog()).getByRole('combobox', { name }) as HTMLSelectElement

describe('NewSessionDialog', () => {
  it('opens on the field, with the folder it was opened on first and the rest by when they were last used', () => {
    const props = renderDialog({ initialPath: dev.path })
    expect(document.activeElement).toBe(within(dialog()).getByRole('combobox', { name: 'Folder' }))
    expect(options().slice(0, 4)).toEqual(['dev', 'helm', 'timeclick', 'TimeClick-Builder'])
    expect(highlighted()).toBe('dev')
    expect(props.onShowing).toHaveBeenLastCalledWith([dev.path, helm.path, timeclick.path, builder.path])
  })

  it('narrows to what is typed, marks the match, and starts the first folder with the profile most about it', async () => {
    const props = renderDialog()
    await userEvent.keyboard('time')
    expect(options()).toEqual([
      'timeclick',
      'Resume payroll export fix',
      'Resume named breaks rollout',
      'TimeClick-Builder'
    ])
    const first = within(list()).getByRole('option', { name: 'timeclick' })
    expect(first.querySelector('.text-accent-text')?.textContent).toBe('time')

    expect(picker('Profile').selectedOptions[0]?.textContent).toBe('Timeclick')
    expect(picker('Permissions').value).toBe('bypassPermissions')
    expect(sentence()).toBe(
      'Runs claude in ~\\.harness\\dev\\repos\\timeclick with the Timeclick profile, composing dev and timeclick, and --model opus --permission-mode bypassPermissions.'
    )

    await userEvent.keyboard('{Enter}')
    expect(props.onStart).toHaveBeenCalledWith({
      project: timeclick,
      profileId: timeclickProfile.id,
      permissionMode: 'bypassPermissions',
      resume: null,
      beside: false
    })
  })

  it('walks into a folder’s conversations with the arrows and reopens one', async () => {
    const props = renderDialog()
    await userEvent.keyboard('timeclick{ArrowDown}{ArrowDown}')
    expect(highlighted()).toBe('Resume named breaks rollout')
    expect(within(list()).getByRole('option', { name: 'Resume named breaks rollout' }).textContent).toContain(
      '4d'
    )
    expect(sentence()).toMatch(/^Reopens “named breaks rollout” with claude --resume in ~\\\.harness/)

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}')
    expect(highlighted()).toBe('timeclick')
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(props.onStart).toHaveBeenCalledWith(
      expect.objectContaining({ project: timeclick, resume: payroll, profileId: timeclickProfile.id })
    )
  })

  it('shows conversations only under the highlighted folder, which moves them as it moves', async () => {
    renderDialog({ initialPath: helm.path })
    expect(options()).not.toContain('Resume payroll export fix')
    await userEvent.keyboard('{ArrowDown}')
    expect(highlighted()).toBe('timeclick')
    expect(options().slice(0, 4)).toEqual([
      'helm',
      'timeclick',
      'Resume payroll export fix',
      'Resume named breaks rollout'
    ])
  })

  it('keeps a profile that was picked for whatever folder is highlighted next, and the mode follows it until changed', async () => {
    const props = renderDialog({ initialPath: helm.path })
    expect(picker('Profile').value).toBe('')
    expect(picker('Permissions').value).toBe('')
    expect(sentence()).toBe('Runs claude in ~\\.harness\\dev\\repos\\helm.')

    await userEvent.selectOptions(picker('Profile'), 'dev')
    expect(picker('Permissions').value).toBe('auto')
    await userEvent.click(within(list()).getByRole('option', { name: 'timeclick' }))
    expect(picker('Profile').selectedOptions[0]?.textContent).toBe('dev')

    await userEvent.selectOptions(picker('Permissions'), 'Plan')
    await userEvent.selectOptions(picker('Profile'), 'Timeclick')
    expect(picker('Permissions').value).toBe('plan')

    // Enter from a picker starts it too, with what the pickers say.
    picker('Profile').focus()
    await userEvent.keyboard('{Enter}')
    expect(props.onStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: timeclick, profileId: timeclickProfile.id, permissionMode: 'plan' })
    )

    await userEvent.selectOptions(picker('Profile'), 'No profile')
    await userEvent.selectOptions(picker('Permissions'), 'Default')
    await userEvent.click(within(dialog()).getByRole('button', { name: /Start$/ }))
    expect(props.onStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId: null, permissionMode: null, beside: false })
    )
  })

  it('starts beside with Ctrl+Enter or its button, and only highlights on a click', async () => {
    const props = renderDialog()
    await userEvent.click(within(list()).getByRole('option', { name: 'TimeClick-Builder' }))
    expect(props.onStart).not.toHaveBeenCalled()
    expect(highlighted()).toBe('TimeClick-Builder')
    // The click left the field focused, so the keyboard carries on from there.
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(props.onStart).toHaveBeenLastCalledWith(expect.objectContaining({ project: builder, beside: true }))

    await userEvent.click(within(dialog()).getByRole('button', { name: /Start beside/ }))
    expect(props.onStart).toHaveBeenCalledTimes(2)

    await userEvent.dblClick(within(list()).getByRole('option', { name: 'dev' }))
    expect(props.onStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: dev, profileId: devProfile.id, beside: false })
    )
  })

  it('opens a terminal in the highlighted folder with Alt+Enter or its button, beside with Ctrl', async () => {
    const onTerminal = vi.fn()
    const props = renderDialog({ onTerminal })
    await userEvent.click(within(list()).getByRole('option', { name: 'TimeClick-Builder' }))
    await userEvent.keyboard('{Alt>}{Enter}{/Alt}')
    expect(onTerminal).toHaveBeenLastCalledWith(builder, false)
    await userEvent.keyboard('{Control>}{Alt>}{Enter}{/Alt}{/Control}')
    expect(onTerminal).toHaveBeenLastCalledWith(builder, true)
    await userEvent.click(within(dialog()).getByRole('button', { name: /Terminal$/ }))
    expect(onTerminal).toHaveBeenCalledTimes(3)
    expect(props.onStart).not.toHaveBeenCalled()
  })

  it('offers no terminal when nothing handles one', () => {
    renderDialog()
    expect(within(dialog()).queryByRole('button', { name: /Terminal$/ })).toBeNull()
  })

  it('says what is already running in the folder, and why a launch failed', () => {
    const live = [
      { pid: 41, cwd: timeclick.path.toUpperCase(), name: 'accruals report', helmSessionId: 3 },
      { pid: 42, cwd: timeclick.path, name: null, helmSessionId: null }
    ] as LiveSession[]
    renderDialog({ initialPath: timeclick.path, live, error: 'Claude Code CLI not found.' })

    expect(within(list()).getByRole('option', { name: 'timeclick' }).textContent).toContain('2 running')
    expect(within(dialog()).getByRole('note').textContent).toBe(
      'Already running here: accruals report, pid 42. Another one means two agents in one working tree.'
    )
    expect(within(dialog()).getByRole('alert').textContent).toBe('Claude Code CLI not found.')
  })

  it('starts nothing while a launch is in flight', async () => {
    const props = renderDialog({ busy: true })
    expect(within(dialog()).getByRole('button', { name: /Starting/ })).toHaveProperty('disabled', true)
    await userEvent.keyboard('{Enter}')
    expect(props.onStart).not.toHaveBeenCalled()
  })

  it('says when nothing matches, and how many more there are past the first few', async () => {
    const many = Array.from({ length: 9 }, (_, i) => project(`repo-${String(i)}`))
    renderDialog({ projects: many })
    expect(within(dialog()).getByText('3 more - keep typing to narrow them')).toBeTruthy()
    await userEvent.keyboard('zzz')
    expect(within(dialog()).getByText('Nothing is called “zzz”.')).toBeTruthy()
    expect(sentence()).toBe('')
  })

  it('closes on Escape and gives focus back to where it was', async () => {
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    const props = renderDialog()
    expect(document.activeElement).not.toBe(before)
    await userEvent.keyboard('{Escape}')
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(before)
    before.remove()
  })
})
