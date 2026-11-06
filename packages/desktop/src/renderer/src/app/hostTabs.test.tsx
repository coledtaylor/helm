import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  EMPTY_LAYOUT,
  notOpenHere,
  openTab,
  returnsToFamily,
  sessionRef,
  sessionTabIds,
  type PaneLayout,
  type SessionRecord
} from '@helm/core/types'
import { FakeConnection, fakeReach, reconnectingReach } from '../../../../test/fake-connection'
import { CLAUDE_CODE_BACKEND } from '../../../shared/host/backend'
import type * as P from '../../../shared/host/protocol'
import type { RemoteHostStates } from '../../../shared/ipc'
import { bridge } from './bridge.testkit'
import { createHostBridges } from './host/hostBridges'
import type { PageLink } from './host/link'
import { createRemoteHosts, type RemoteHostsDeps } from './host/remoteHosts'
import {
  closeKeepingRunning,
  keepRemoteTab,
  useSessionConfirm,
  useShownSessionTabs,
  type FamilyScope,
  type RemoteTabsView
} from './hostTabs'

/**
 * A session's tab on build-box, a host on another computer, as the window
 * keeps it: the close question naming build-box, Close tab, keep running, and
 * the tab across build-box's connection dropping and coming back. The window's
 * bridges, its view of remote hosts and build-box's sessions adapter are the
 * real ones; build-box is a fake connection behind a link the test drops.
 */

const BUILD = 'h-build'

const row = (overrides: Partial<P.SessionRecord> = {}): P.SessionRecord => ({
  id: 7,
  name: 'deploy',
  label: null,
  cwd: '/srv/app',
  branch: 'main',
  projectPath: '/srv/app',
  profileId: null,
  argv: ['claude', '-n', 'deploy'],
  conversationId: 'c0ffee00-0000-4000-8000-000000000007',
  backend: CLAUDE_CODE_BACKEND,
  status: 'running',
  startedAt: '2026-11-03T09:00:00.000Z',
  endedAt: null,
  durationMs: null,
  exitCode: null,
  ...overrides
})

/** build-box, listing `rows` as its sessions. */
const buildBox = (rows: P.SessionRecord[]): FakeConnection => new FakeConnection().answer('session:list', () => rows)

/** Lets every promise already settled run its callbacks, inside React's act. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  })
}

/**
 * This PC and build-box, as the window reaches them: one bridge per host
 * (`createHostBridges`), and the window's view of build-box over the link its
 * bridge holds (`createRemoteHosts`), with main played by the test.
 */
function world(first: FakeConnection) {
  bridge.reset()
  bridge.answer('ownSettings:read', () => DEFAULT_SETTINGS)
  const here = new FakeConnection().answer('session:list', () => [])
  const link = reconnectingReach(first)
  const bridges = createHostBridges({
    own: bridge,
    localLink: fakeReach(here) as unknown as PageLink,
    remoteLink: (id) => {
      if (id !== BUILD) throw new Error(`no host ${id} in this test`)
      return link as unknown as PageLink
    },
    front: { focused: () => true, onChange: () => undefined },
    storage: null,
    nameOf: (id) => (id === BUILD ? 'build-box' : id),
    log: () => undefined
  })
  let changed: (states: RemoteHostStates) => void = () => undefined
  const remote = createRemoteHosts({
    bridge: {
      invoke: (() => Promise.resolve({})) as unknown as RemoteHostsDeps['bridge']['invoke'],
      send: () => undefined,
      on: ((channel: string, listener: (states: RemoteHostStates) => void) => {
        if (channel === 'remoteHosts:changed') changed = listener
        return () => undefined
      }) as RemoteHostsDeps['bridge']['on']
    },
    pageLink: (id) => bridges.hostBridge(id).link,
    log: () => undefined
  })
  remote.subscribe(() => undefined)
  const build = bridges.bridgeFor(BUILD)
  /** What build-box's terminals drew in this window, and the sessions it said ended. */
  const drawn: Array<{ id: number; data: string }> = []
  const exits: SessionRecord[] = []
  build.on('session:data', (payload) => drawn.push(payload))
  build.on('session:exit', (record) => exits.push(record))
  /** What the window tells each host's connection to carry, as App does. */
  const shown: Array<{ host: string; ids: readonly number[] }> = []
  const show = (ids: readonly number[], host: string): void => {
    shown.push({ host, ids })
    bridges.hostBridge(host).sessions.show(ids)
  }
  return {
    bridges,
    build,
    remote,
    link,
    here,
    drawn,
    exits,
    shown,
    show,
    tell: (states: RemoteHostStates) => changed(states),
    /** build-box's sessions, as the window lists them over its bridge. */
    listed: () => build.invoke('session:list')
  }
}

/** The window's knowledge of build-box for deciding whether its tabs stay. */
const viewOf = (sessions: readonly SessionRecord[], listed = [BUILD]): RemoteTabsView => ({
  settingsLoaded: true,
  listed,
  byHost: new Map([[BUILD, { discovery: null, sessions, listed: true }]]),
  pluginTab: () => null
})

beforeEach(() => {
  bridge.reset()
})

describe('a build-box session’s tab', () => {
  it('S17: closing it asks first naming build-box; Close tab, keep running ends nothing, and Open brings its tab back', async () => {
    const first = buildBox([row()])
    const w = world(first)
    w.tell({ [BUILD]: { state: 'connected' } })
    await settle()
    let layout: PaneLayout = openTab(EMPTY_LAYOUT, sessionRef(7, BUILD))
    const shownTabs = renderHook(({ at }) => useShownSessionTabs(at, [BUILD], w.show), {
      initialProps: { at: layout }
    })
    await settle()
    expect(first.streamsFor('session:data', 7)).toHaveLength(1)

    // The window answers every host's question on that host's bridge.
    const confirm = renderHook(() =>
      useSessionConfirm({
        each: (listener) => w.bridges.each((each) => listener(each.host, each.helm)),
        bridgeFor: (host) => w.bridges.bridgeFor(host)
      })
    )

    // Closing the tab: build-box's adapter asks in the window before anything ends.
    let closing: Promise<{ closed: boolean }> = Promise.resolve({ closed: true })
    await act(async () => {
      closing = w.build.invoke('session:close', { id: 7 })
    })
    await settle()
    expect(confirm.result.current.ask?.host).toBe(BUILD)
    expect(confirm.result.current.ask?.request).toMatchObject({
      kind: 'close-session',
      message: '“deploy” is still running on build-box.',
      folder: '/srv/app',
      sessionNames: ['deploy']
    })
    // Declined: the session runs on and the tab stays.
    act(() => confirm.result.current.answer(false))
    await expect(closing).resolves.toEqual({ closed: false })
    expect(confirm.result.current.ask).toBeNull()
    expect(first.payloads('session:close')).toEqual([])
    expect(w.here.payloads('session:close')).toEqual([])

    // Close tab, keep running, from the tab's menu: the tab goes and nothing is asked or ended.
    const disposed: Array<[number, string]> = []
    closeKeepingRunning(7, BUILD, {
      release: (id, host) => w.bridges.hostBridge(host).sessions.release(id),
      disposeTerminal: (id, host) => disposed.push([id, host]),
      commit: (op) => {
        layout = op(layout)
      }
    })
    shownTabs.rerender({ at: layout })
    await settle()
    expect(disposed).toEqual([[7, BUILD]])
    expect(first.streamsFor('session:data', 7)[0]?.closed).toBe(true)
    expect(first.payloads('session:close')).toEqual([])
    expect(confirm.result.current.ask).toBeNull()
    expect(w.exits).toEqual([])
    // Listed under build-box as not open here, still running there.
    const records = await w.listed()
    expect(notOpenHere(layout, records, BUILD).map((record) => record.id)).toEqual([7])
    expect(w.remote.get()[BUILD]?.sessions.map((session) => session.key)).toEqual([`${BUILD}:7`])
    // Its tab is kept while build-box lists it: nothing closes it behind the user's back.
    expect(keepRemoteTab(sessionRef(7, BUILD), viewOf(records))).toBe(true)

    // Open brings its tab back, on a new stream that starts with its screen as it is.
    layout = openTab(layout, sessionRef(7, BUILD))
    shownTabs.rerender({ at: layout })
    await settle()
    expect(w.shown.at(-1)).toEqual({ host: BUILD, ids: [7] })
    const reopened = first.streamsFor('session:data', 7)
    expect(reopened).toHaveLength(2)
    reopened[1]!.send('\x1b[H\x1b[2Jdeploy as it is')
    expect(w.drawn.at(-1)).toEqual({ id: 7, data: '\x1b[H\x1b[2Jdeploy as it is' })
    // None of it reached this PC's host.
    expect(w.here.payloads('session:close')).toEqual([])
    expect(w.shown.every((each) => each.host === BUILD)).toBe(true)
  })

  it('S18: keeps its tab while build-box’s connection is down, ends nothing there, and reattaches by itself once it is back', async () => {
    const first = buildBox([row()])
    const w = world(first)
    w.tell({ [BUILD]: { state: 'connected' } })
    await settle()
    const layout: PaneLayout = openTab(EMPTY_LAYOUT, sessionRef(7, BUILD))
    const shownTabs = renderHook(({ connected }) => useShownSessionTabs(layout, connected, w.show), {
      initialProps: { connected: [BUILD] as readonly string[] }
    })
    await settle()
    expect(w.shown).toEqual([{ host: BUILD, ids: [7] }])
    const before = first.streamsFor('session:data', 7)
    expect(before).toHaveLength(1)
    before[0]!.send('tick 11')
    expect(w.drawn).toEqual([{ id: 7, data: 'tick 11' }])

    // build-box's ssh ends: main says it is retrying, and the window's connection ends with it.
    w.link.lose({ planned: false, restarts: false })
    w.tell({ [BUILD]: { state: 'retrying' } })
    shownTabs.rerender({ connected: [] })
    await settle()

    // Nothing ended, here or there, and the tab stays with what it last drew.
    expect(w.exits).toEqual([])
    expect(first.payloads('session:close')).toEqual([])
    const whileDown = await w.listed()
    expect(whileDown.map((record) => [record.id, record.status])).toEqual([[7, 'running']])
    expect(keepRemoteTab(sessionRef(7, BUILD), viewOf(whileDown))).toBe(true)
    expect(w.remote.get()[BUILD]?.connection).toEqual({ state: 'retrying' })
    expect(w.remote.get()[BUILD]?.sessions.map((session) => session.key)).toEqual([`${BUILD}:7`])
    expect(w.drawn).toEqual([{ id: 7, data: 'tick 11' }])
    // Keys pressed meanwhile reach no session.
    w.build.send('session:input', { id: 7, data: 'y\r' })
    expect(before[0]!.text()).toBe('')
    // Nothing more is asked of the host while it is away.
    expect(w.shown).toHaveLength(1)

    // Main reaches build-box again: the window connects again and the tab takes up where the session is now.
    const second = buildBox([row()])
    w.tell({ [BUILD]: { state: 'connected' } })
    await w.link.reconnect(second)
    shownTabs.rerender({ connected: [BUILD] })
    await settle()

    expect(w.shown.at(-1)).toEqual({ host: BUILD, ids: [7] })
    const after = second.streamsFor('session:data', 7)
    expect(after).toHaveLength(1)
    // The host's redraw draws the screen as it is now, written while the window was away included.
    after[0]!.send('\x1bcdeploying…\r\ntick 40')
    expect(w.drawn.at(-1)).toEqual({ id: 7, data: '\x1bcdeploying…\r\ntick 40' })
    // And it takes input again by itself.
    w.build.send('session:input', { id: 7, data: 'carry on\r' })
    expect(after[0]!.text()).toBe('carry on\r')
    expect(w.exits).toEqual([])
    expect(second.payloads('session:close')).toEqual([])
    expect(w.remote.get()[BUILD]?.connection).toEqual({ state: 'connected' })
    // This PC's host carried none of it.
    expect(w.here.streamsFor('session:data', 7)).toEqual([])
  })

  it('goes once build-box is removed from this device or its own list no longer has the session, and is kept before either is known', () => {
    const ref = sessionRef(7, BUILD)
    const running = [{ ...row(), status: 'running' } as unknown as SessionRecord]
    expect(keepRemoteTab(ref, viewOf(running))).toBe(true)
    expect(keepRemoteTab(ref, viewOf([]))).toBe(false)
    expect(keepRemoteTab(ref, viewOf(running, []))).toBe(false)
    expect(keepRemoteTab(ref, { ...viewOf([]), settingsLoaded: false })).toBe(true)
    expect(keepRemoteTab(ref, { ...viewOf([]), byHost: new Map() })).toBe(true)
    // This PC's tabs are not this function's to decide.
    expect(keepRemoteTab(sessionRef(7), viewOf([]))).toBeUndefined()
  })
})

describe('a child shown in its parent’s tab on build-box', () => {
  const lead = row({ id: 7, name: 'lead' })
  const reviewer = row({ id: 8, name: 'reviewer', parentId: 7, parentName: 'lead', role: 'reviewer' })
  const worker = row({ id: 9, name: 'worker', parentId: 7, parentName: 'lead', role: 'worker' })
  const hasRoom = (): boolean => true
  const noRoom = (): boolean => false

  /** build-box listing a parent and two children, connected, with the parent’s tab the only one here. */
  async function connected() {
    const first = buildBox([lead, reviewer, worker])
    const w = world(first)
    w.tell({ [BUILD]: { state: 'connected' } })
    await settle()
    const records = await w.listed()
    const scope = (roomOf: (tab: string) => boolean): FamilyScope => ({
      sessions: new Map([[BUILD, records]]),
      roomOf
    })
    return { first, w, records, scope }
  }

  it('is open here: the connection carries its terminal live, and the sessions pane does not list it as not open here', async () => {
    const { first, w, records, scope } = await connected()
    const layout = openTab(EMPTY_LAYOUT, sessionRef(7, BUILD))
    const family = scope(hasRoom)
    renderHook(() => useShownSessionTabs(layout, [BUILD], w.show, family))
    await settle()

    expect(w.shown.at(-1)).toEqual({ host: BUILD, ids: [7, 8, 9] })
    for (const id of [7, 8, 9]) expect(first.streamsFor('session:data', id)).toHaveLength(1)
    first.streamsFor('session:data', 8)[0]!.send('reviewing…')
    expect(w.drawn).toContainEqual({ id: 8, data: 'reviewing…' })
    expect(notOpenHere(layout, records, BUILD, family.roomOf)).toEqual([])
  })

  it('is listed as not open here, and not carried, while this device does not show children in their parent’s tab', async () => {
    const { first, w, records } = await connected()
    const layout = openTab(EMPTY_LAYOUT, sessionRef(7, BUILD))
    renderHook(() => useShownSessionTabs(layout, [BUILD], w.show, null))
    await settle()

    expect(w.shown.at(-1)).toEqual({ host: BUILD, ids: [7] })
    expect(first.streamsFor('session:data', 8)).toEqual([])
    expect(notOpenHere(layout, records, BUILD).map((record) => record.id)).toEqual([8, 9])
  })

  it('is carried again by itself when its pane gains room, and let go when the room goes', async () => {
    const { first, w, scope } = await connected()
    const layout = openTab(EMPTY_LAYOUT, sessionRef(7, BUILD))
    const crowded = scope(noRoom)
    const roomy = scope(hasRoom)
    const shown = renderHook(({ family }) => useShownSessionTabs(layout, [BUILD], w.show, family), {
      initialProps: { family: crowded }
    })
    await settle()
    expect(w.shown.at(-1)).toEqual({ host: BUILD, ids: [7] })

    shown.rerender({ family: roomy })
    await settle()
    expect(w.shown.at(-1)).toEqual({ host: BUILD, ids: [7, 8, 9] })
    expect(first.streamsFor('session:data', 8)).toHaveLength(1)

    shown.rerender({ family: crowded })
    await settle()
    expect(w.shown.at(-1)).toEqual({ host: BUILD, ids: [7] })
    expect(first.streamsFor('session:data', 8)[0]?.closed).toBe(true)
  })

  it('goes back to its parent’s family view on Close tab, keep running, keeping its stream and its terminal', async () => {
    const { first, w, records, scope } = await connected()
    let layout: PaneLayout = openTab(openTab(EMPTY_LAYOUT, sessionRef(7, BUILD)), sessionRef(8, BUILD))
    const family = scope(hasRoom)
    const shown = renderHook(({ at }) => useShownSessionTabs(at, [BUILD], w.show, family), {
      initialProps: { at: layout }
    })
    await settle()
    expect(w.shown.at(-1)).toEqual({ host: BUILD, ids: [7, 8, 9] })
    const stream = first.streamsFor('session:data', 8)[0]!

    const disposed: Array<[number, string]> = []
    closeKeepingRunning(
      8,
      BUILD,
      {
        release: (id, host) => w.bridges.hostBridge(host).sessions.release(id),
        disposeTerminal: (id, host) => disposed.push([id, host]),
        commit: (op) => {
          layout = op(layout)
        }
      },
      returnsToFamily(layout, records, 8, BUILD, family.roomOf)
    )
    shown.rerender({ at: layout })
    await settle()

    expect(sessionTabIds(layout, BUILD)).toEqual(new Set([7]))
    expect(disposed).toEqual([])
    expect(stream.closed).toBe(false)
    expect(first.streamsFor('session:data', 8)).toHaveLength(1)
    expect(notOpenHere(layout, records, BUILD, family.roomOf)).toEqual([])
    expect(first.payloads('session:close')).toEqual([])
  })

  it('lets go of its stream and terminal on Close tab, keep running where its parent’s tab would not show it', async () => {
    const { first, w, records } = await connected()
    let layout: PaneLayout = openTab(EMPTY_LAYOUT, sessionRef(8, BUILD))
    const shown = renderHook(({ at }) => useShownSessionTabs(at, [BUILD], w.show, null), {
      initialProps: { at: layout }
    })
    await settle()
    const stream = first.streamsFor('session:data', 8)[0]!

    const disposed: Array<[number, string]> = []
    closeKeepingRunning(
      8,
      BUILD,
      {
        release: (id, host) => w.bridges.hostBridge(host).sessions.release(id),
        disposeTerminal: (id, host) => disposed.push([id, host]),
        commit: (op) => {
          layout = op(layout)
        }
      },
      returnsToFamily(layout, records, 8, BUILD, null)
    )
    shown.rerender({ at: layout })
    await settle()

    expect(disposed).toEqual([[8, BUILD]])
    expect(stream.closed).toBe(true)
    expect(notOpenHere(layout, records, BUILD).map((record) => record.id)).toEqual([7, 8, 9])
  })
})
