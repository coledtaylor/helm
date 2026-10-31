import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isClientOnly, isHostInternal } from '../shared/host/protocol'
import { EVENT_CHANNELS, REQUEST_CHANNELS, SEND_CHANNELS } from '../shared/ipc'

/** Every channel main registers, by how: a handled request, or a listened-for send. */
const registered = vi.hoisted(() => ({ handle: [] as string[], on: [] as string[] }))

vi.mock('electron', async () => {
  const fake = (await import('../../test/electron')).electronFake()
  return {
    ...fake,
    ipcMain: {
      handle: (channel: string) => registered.handle.push(channel),
      on: (channel: string) => registered.on.push(channel),
      removeHandler: () => undefined,
      removeAllListeners: () => undefined
    }
  }
})

/**
 * Anything at all, for a context whose services registration never calls: a
 * property read gives another, and so does a call.
 */
function anything(): unknown {
  const target = function nothing(): void {}
  const proxy: unknown = new Proxy(target, {
    get: (_target, key) => (key === 'then' ? undefined : proxy),
    apply: () => proxy
  })
  return proxy
}

async function registerWith(sessionsInHost: boolean): Promise<string[]> {
  registered.handle.length = 0
  registered.on.length = 0
  vi.resetModules()
  const { registerIpc } = await import('./ipc')
  const ctx = new Proxy(
    { sessionsInHost },
    { get: (target, key) => (key in target ? (target as Record<string | symbol, unknown>)[key] : anything()) }
  )
  registerIpc(ctx as never)
  return [...registered.handle, ...registered.on]
}

describe('what main handles over Electron IPC', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('with sessions in the local host, registers no channel boundary.rs does not list as client-only or host-internal', async () => {
    const channels = await registerWith(true)
    expect(channels.length).toBeGreaterThan(0)
    expect(channels.filter((channel) => !isClientOnly(channel) && !isHostInternal(channel)).sort()).toEqual([])
    // The window's answer to a session's close is the host's, never main's.
    expect(channels).not.toContain('session:confirmed')
    expect(channels).toContain('windowSessions:quitConfirmed')
    expect(channels).toContain('hostLink:open')
  })

  it('with the setting off, registers every channel as today', async () => {
    const channels = new Set(await registerWith(false))
    const declared = [...REQUEST_CHANNELS, ...SEND_CHANNELS]
    const missing = declared.filter((channel) => !channels.has(channel))
    expect(missing).toEqual([])
    expect(channels.has('session:confirmed')).toBe(true)
    // Main's pushes are not registrations.
    expect(EVENT_CHANNELS.filter((channel) => channels.has(channel) && !declared.includes(channel as never))).toEqual([])
  })
})
