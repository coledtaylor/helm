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

async function register(): Promise<string[]> {
  registered.handle.length = 0
  registered.on.length = 0
  vi.resetModules()
  const { registerIpc } = await import('./ipc')
  registerIpc(anything() as never)
  return [...registered.handle, ...registered.on]
}

describe('what main handles over Electron IPC', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('S6: registers no channel boundary.rs does not list as client-only or host-internal', async () => {
    const channels = await register()
    expect(channels.length).toBeGreaterThan(0)
    expect(channels.filter((channel) => !isClientOnly(channel) && !isHostInternal(channel)).sort()).toEqual([])
    // The window's answer to a session's close is the host's, never main's.
    expect(channels).not.toContain('session:confirmed')
    expect(channels).not.toContain('session:start')
    expect(channels).not.toContain('pterm:open')
    expect(channels).toContain('windowSessions:quitConfirmed')
    expect(channels).toContain('hostLink:open')
  })

  it('S6: registers every client-only and host-internal request and send the desktop declares', async () => {
    const channels = new Set(await register())
    const declared = [...REQUEST_CHANNELS, ...SEND_CHANNELS]
    const missing = declared.filter(
      (channel) => (isClientOnly(channel) || isHostInternal(channel)) && !channels.has(channel)
    )
    expect(missing).toEqual([])
    // Main's pushes are not registrations.
    expect(EVENT_CHANNELS.filter((channel) => channels.has(channel) && !declared.includes(channel as never))).toEqual([])
  })
})
