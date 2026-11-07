// @vitest-environment jsdom
import { LOCAL_HOST_KEY, type SessionRecord } from '@helm/core/types'
import { afterEach, describe, expect, it } from 'vitest'
import { chipKey, markLabel, peekAnchorFor, peekFacts, peekPlace, peekState } from './peekView'

const child = (overrides: Record<string, unknown> = {}): SessionRecord =>
  ({
    id: 8,
    name: 'reviewer-8',
    label: 'reviewer',
    cwd: 'C:\\work\\helm',
    branch: 'main',
    status: 'running',
    role: 'reviewer',
    permissionMode: 'plan',
    ...overrides
  }) as SessionRecord

describe('what the peek says of a child', () => {
  it('S1: names its role, folder, branch and mode, and carries its last report', () => {
    const facts = peekFacts(
      child({ lastReport: { state: 'done', text: 'Reviewed it.', at: '2026-11-07T10:00:00Z' } }),
      'busy',
      { glyph: 'dot', state: 'busy' }
    )
    expect(facts).toMatchObject({
      name: 'reviewer',
      role: 'reviewer',
      folder: 'helm',
      folderPath: 'C:\\work\\helm',
      branch: 'main',
      mode: 'plan',
      state: { label: 'working', tone: 'working' },
      report: { state: 'done', text: 'Reviewed it.' }
    })
    expect(facts.command).toBeUndefined()
  })

  it('S1: a child with no role, mode or report says none of them, and a blank report is none', () => {
    const facts = peekFacts(
      child({ role: undefined, permissionMode: undefined, branch: null, lastReport: { state: 'note', text: '  ', at: 'x' } }),
      'idle',
      { glyph: 'dot', state: 'idle' }
    )
    expect(facts).toMatchObject({ role: null, mode: null, branch: null, report: null })
  })

  it('S1: a command child carries its command and runs-in, and never a report', () => {
    const facts = peekFacts(
      child({ lastReport: { state: 'done', text: 'x', at: 'y' } }),
      'running',
      { glyph: 'command', state: 'running' },
      { line: 'pnpm test', runsIn: 'your shell, pwsh' }
    )
    expect(facts).toMatchObject({ command: 'pnpm test', runsIn: 'your shell, pwsh', report: null })
  })

  it('words the mode as the launcher does, and tones each state as its dot', () => {
    expect(peekFacts(child({ permissionMode: 'acceptEdits' }), 'idle', { glyph: 'dot', state: 'idle' }).mode).toBe(
      'accept edits'
    )
    expect(peekFacts(child({ permissionMode: 'manual' }), 'idle', { glyph: 'dot', state: 'idle' }).mode).toBe('manual')
    expect(peekState('waiting')).toEqual({ label: 'needs you', tone: 'needs' })
    expect(peekState('shell')).toEqual({ label: 'idle', tone: 'idle' })
    expect(peekState('running')).toEqual({ label: 'running', tone: 'idle' })
    expect(peekState('error').tone).toBe('danger')
    expect(markLabel({ glyph: 'dot', state: 'waiting' })).toBe('waiting for you')
    expect(markLabel({ glyph: 'dot', state: null })).toBe('state unknown')
  })
})

describe('how an ended child says it ended', () => {
  it('S1: stopped when the host ended it, ended when its agent exited, and a command exit code', () => {
    const ended = (overrides: Record<string, unknown>, command?: { line: string; exitCode?: number }) =>
      peekFacts(child({ status: 'ended', ...overrides }), 'ended', { glyph: 'dot', state: 'ended' }, command).state.label
    expect(ended({ stopped: true })).toBe('stopped')
    expect(ended({})).toBe('ended')
    expect(ended({}, { line: 'pnpm test', exitCode: 0 })).toBe('exited 0')
    expect(ended({ stopped: true }, { line: 'pnpm test', exitCode: 2 })).toBe('exited 2')
  })
})

describe('where the peek goes', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const rect = (left: number, top: number, width: number, height: number): (() => DOMRect) => () =>
    new DOMRect(left, top, width, height)

  it('S1: beside the row it opened from, on the host the row is under', () => {
    document.body.innerHTML = `
      <section data-host-group="${LOCAL_HOST_KEY}"><button data-session-row="session:8"></button></section>
      <section data-host-group="home"><button data-session-row="session:8"></button></section>`
    const rows = document.querySelectorAll<HTMLElement>('[data-session-row]')
    rows[0]!.getBoundingClientRect = rect(10, 200, 240, 24)
    rows[1]!.getBoundingClientRect = rect(10, 500, 240, 24)
    expect(peekPlace({ host: LOCAL_HOST_KEY, id: 8, anchor: { kind: 'row' } })).toEqual({
      at: { x: 260, y: 184 },
      element: rows[0]
    })
    expect(peekPlace({ host: 'home', id: 8, anchor: { kind: 'row' } }).at).toEqual({ x: 260, y: 484 })
  })

  it('S1: beside the row in a tree that is not grouped by host, which holds only this PC', () => {
    document.body.innerHTML = '<button data-session-row="session:8"></button>'
    const row = document.querySelector<HTMLElement>('[data-session-row]')!
    row.getBoundingClientRect = rect(10, 200, 240, 24)
    expect(peekPlace({ host: LOCAL_HOST_KEY, id: 8, anchor: { kind: 'row' } })).toEqual({
      at: { x: 260, y: 184 },
      element: row
    })
    expect(peekPlace({ host: 'home', id: 8, anchor: { kind: 'row' } }).element).toBeNull()
  })

  it('S7: under the chip it opened from, its left edge 8px left of the chip and 8px inside the window', () => {
    document.body.innerHTML = `<button data-crumb-chip="${chipKey(LOCAL_HOST_KEY, 8)}"></button>`
    const chip = document.querySelector<HTMLElement>('[data-crumb-chip]')!
    window.innerWidth = 1400
    const anchor = { kind: 'chip', parentId: 3 } as const
    chip.getBoundingClientRect = rect(300, 40, 80, 18)
    const place = peekPlace({ host: LOCAL_HOST_KEY, id: 8, anchor })
    expect(place.element).toBe(chip)
    expect(place.at).toEqual({ x: 292, y: 40 + 18 + 6 })
    chip.getBoundingClientRect = rect(3, 40, 80, 18)
    expect(peekPlace({ host: LOCAL_HOST_KEY, id: 8, anchor }).at).toMatchObject({ x: 8 })
    chip.getBoundingClientRect = rect(1350, 40, 40, 18)
    expect(peekPlace({ host: LOCAL_HOST_KEY, id: 8, anchor }).at).toMatchObject({ x: 1400 - 470 - 8 })
  })

  it('S11: a toast peek opens under the child chip when its parent crumb has one, and beside its row otherwise', () => {
    document.body.innerHTML = `<button data-crumb-chip="${chipKey(LOCAL_HOST_KEY, 8)}"></button>`
    expect(peekAnchorFor(LOCAL_HOST_KEY, { id: 8, parentId: 3 })).toEqual({ kind: 'chip', parentId: 3 })
    expect(peekAnchorFor('home', { id: 8, parentId: 3 })).toEqual({ kind: 'row' })
    expect(peekAnchorFor(LOCAL_HOST_KEY, { id: 9, parentId: 3 })).toEqual({ kind: 'row' })
    expect(peekAnchorFor(LOCAL_HOST_KEY, { id: 8 })).toEqual({ kind: 'row' })
  })

  it('opens near the top of the window when what it opened from is not on screen', () => {
    const place = peekPlace({ host: LOCAL_HOST_KEY, id: 8, anchor: { kind: 'row' } })
    expect(place.element).toBeNull()
    expect(place.at).toMatchObject({ y: 80 })
  })
})
