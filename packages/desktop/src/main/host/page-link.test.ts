import { describe, expect, it } from 'vitest'
import type { EventPayload } from '../../shared/ipc'
import type { PageBridge } from './launcher'
import { FOREIGN_PAGE, createPageLinks, type HelmPage, type PageLinksDeps } from './page-link'

class FakeBridge implements PageBridge {
  readonly written: Uint8Array[] = []
  endedByHelm = false
  private settle: (why: string | null) => void = () => undefined
  readonly ended = new Promise<string | null>((resolve) => {
    this.settle = resolve
  })
  constructor(readonly data: (bytes: Uint8Array) => void) {}
  write(bytes: Uint8Array): void {
    this.written.push(bytes)
  }
  end(): void {
    this.endedByHelm = true
    this.settle(null)
  }
  /** The bridge exits on its own. */
  exit(why: string | null): void {
    this.settle(why)
  }
}

class FakePage implements HelmPage {
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  private gone: Array<() => void> = []
  constructor(readonly id: number) {}
  send<K extends 'hostLink:data' | 'hostLink:ended'>(channel: K, payload: EventPayload<K>): void {
    this.sent.push({ channel, payload })
  }
  onGone(listener: () => void): void {
    this.gone.push(listener)
  }
  /** Navigates, reloads or closes. */
  leave(): void {
    for (const listener of this.gone) listener()
  }
}

const WINDOW = 1
const BACKGROUND = 2

function world(overrides: Partial<PageLinksDeps> = {}) {
  const bridges: FakeBridge[] = []
  const links = createPageLinks({
    inHost: true,
    appVersion: '2.9.0',
    isHelmPage: (id) => id === WINDOW || id === BACKGROUND,
    ready: () => Promise.resolve(),
    openBridge: (data) => {
      const bridge = new FakeBridge(data)
      bridges.push(bridge)
      return bridge
    },
    log: () => undefined,
    ...overrides
  })
  return { links, bridges }
}

describe('each Helm page’s own connection to the local host', () => {
  it('refuses a page that is not one of Helm’s own, and starts no bridge for it', async () => {
    const w = world()
    await expect(w.links.open(new FakePage(77))).rejects.toThrow(FOREIGN_PAGE)
    expect(w.bridges).toEqual([])
  })

  it('drops bytes a foreign page sends on a Helm page’s connection', async () => {
    const w = world()
    const opened = await w.links.open(new FakePage(WINDOW))
    if (!('connection' in opened)) throw new Error('not opened')
    w.links.send(77, opened.connection, Uint8Array.of(1))
    w.links.close(77, opened.connection)
    expect(w.bridges[0]?.written).toEqual([])
    expect(w.bridges[0]?.endedByHelm).toBe(false)
  })

  it('says sessions do not run in the host when the setting is off, and opens nothing', async () => {
    const w = world({ inHost: false })
    expect(await w.links.open(new FakePage(WINDOW))).toEqual({ inHost: false })
    expect(w.bridges).toEqual([])
  })

  it('passes bytes both ways unread, under the connection’s number', async () => {
    const w = world()
    const page = new FakePage(WINDOW)
    const opened = await w.links.open(page)
    expect(opened).toEqual({ inHost: true, connection: 1, appVersion: '2.9.0' })
    const frame = Uint8Array.of(0, 0, 0, 1, 0xa0)
    w.links.send(WINDOW, 1, frame)
    expect(w.bridges[0]?.written).toEqual([frame])
    const reply = Uint8Array.of(9, 8, 7)
    w.bridges[0]?.data(reply)
    expect(page.sent).toEqual([{ channel: 'hostLink:data', payload: { connection: 1, bytes: reply } }])
  })

  it('opens a page’s bridge only after main’s own link has connected, and says why when it could not', async () => {
    let connect: () => void = () => undefined
    const w = world({ ready: () => new Promise<void>((resolve) => (connect = resolve)) })
    const opening = w.links.open(new FakePage(WINDOW))
    await Promise.resolve()
    expect(w.bridges).toEqual([])
    connect()
    await opening
    expect(w.bridges).toHaveLength(1)

    const sentence = 'No local host answered on its socket; turn off “Run sessions in the local host” in Settings.'
    const failing = world({ ready: () => Promise.reject(new Error(sentence)) })
    expect(await failing.links.open(new FakePage(WINDOW))).toEqual({ inHost: true, unreachable: sentence })
    expect(failing.bridges).toEqual([])
  })

  it('ends the page’s bridge when it reloads, navigates or closes, and when it opens again', async () => {
    const w = world()
    const page = new FakePage(WINDOW)
    await w.links.open(page)
    page.leave()
    expect(w.bridges[0]?.endedByHelm).toBe(true)

    await w.links.open(page)
    await w.links.open(page)
    expect(w.bridges[1]?.endedByHelm).toBe(true)
    expect(w.bridges[2]?.endedByHelm).toBe(false)
    // The page that left was not told: it is gone.
    expect(page.sent.filter((s) => s.channel === 'hostLink:ended')).toEqual([])
  })

  it('tells the page when its bridge ends on its own, with the sentence', async () => {
    const w = world()
    const page = new FakePage(BACKGROUND)
    await w.links.open(page)
    w.bridges[0]?.exit('The local host closed the connection; turn off …')
    await w.bridges[0]?.ended
    await Promise.resolve()
    expect(page.sent).toEqual([
      { channel: 'hostLink:ended', payload: { connection: 1, why: 'The local host closed the connection; turn off …' } }
    ])
    // Its bytes go nowhere now.
    w.links.send(BACKGROUND, 1, Uint8Array.of(1))
    expect(w.bridges[0]?.written).toEqual([])
  })

  it('ends every bridge at quit, and opens none after', async () => {
    const w = world()
    await w.links.open(new FakePage(WINDOW))
    await w.links.open(new FakePage(BACKGROUND))
    await w.links.stop()
    expect(w.bridges.map((b) => b.endedByHelm)).toEqual([true, true])
    expect(await w.links.open(new FakePage(WINDOW))).toEqual({ inHost: true, unreachable: 'Helm is quitting.' })
    expect(w.bridges).toHaveLength(2)
  })
})
