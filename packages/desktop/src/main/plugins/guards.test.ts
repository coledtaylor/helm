import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

/**
 * The two guards main holds a plugin frame to: a frame on a plugin's origin
 * stays on it, only a Helm page that frames plugins puts one there, and a
 * plugin page gets the clipboard write and no other permission. Helm's own
 * pages and every non-plugin navigation are left as they were.
 */

const handlers = vi.hoisted(() => ({
  request: null as ((contents: unknown, permission: string, callback: (granted: boolean) => void, details: object) => void) | null,
  check: null as ((contents: unknown, permission: string, origin: string, details: object) => boolean) | null
}))

vi.mock('electron', async () => ({
  ...(await import('../../../test/electron')).electronFake(),
  session: {
    defaultSession: {
      setPermissionRequestHandler: (handler: typeof handlers.request) => {
        handlers.request = handler
      },
      setPermissionCheckHandler: (handler: typeof handlers.check) => {
        handlers.check = handler
      }
    }
  }
}))

const { guardPluginFrames, installPluginPermissions, pluginNavigationAllowed, pluginOriginOf } = await import('./guards')

describe('pluginOriginOf', () => {
  it.each([
    ['helm-plugin://sample/dist/panel.html', 'helm-plugin://sample'],
    ['helm-plugin://sample/', 'helm-plugin://sample'],
    ['helm-plugin://sample.build-box/dist/panel.html', 'helm-plugin://sample.build-box'],
    ['floti-plugin://sample/dist/panel.html', 'floti-plugin://sample'],
    ['floti-plugin://sample.build-box/dist/panel.html', 'floti-plugin://sample.build-box'],
    ['https://example.com/', null],
    ['http://localhost:5173/', null],
    ['helm-content://abc/x.html', null],
    ['', null],
    [null, null],
    [undefined, null]
  ])('%s is %s', (url, origin) => {
    expect(pluginOriginOf(url)).toBe(origin)
  })
})

describe('pluginNavigationAllowed', () => {
  const base = {
    target: 'helm-plugin://sample/dist/other.html',
    frameOrigin: 'helm-plugin://sample',
    initiatorOrigin: 'helm-plugin://sample',
    initiatorIsHelm: false,
    framesPlugins: true
  }

  it.each([
    ['a plugin frame to its own other page', {}, true],
    ['a plugin frame to another plugin', { target: 'helm-plugin://other/x.html' }, false],
    ['a plugin frame started by another plugin', { initiatorOrigin: 'helm-plugin://other' }, false],
    ['a plugin frame to a website', { target: 'https://example.com/' }, false],
    ['a plugin frame to plain http on this machine', { target: 'http://127.0.0.1:4790/' }, false],
    ['a plugin frame to about:blank', { target: 'about:blank' }, false],
    [
      'Helm putting a fresh frame on a plugin page',
      { frameOrigin: 'http://localhost:5173', initiatorOrigin: 'http://localhost:5173', initiatorIsHelm: true },
      true
    ],
    [
      'Helm reloading a plugin frame onto another plugin it made it for',
      { target: 'helm-plugin://other/x.html', initiatorIsHelm: true },
      true
    ],
    [
      'a page that does not frame plugins putting a frame on the scheme',
      { frameOrigin: 'https://example.com', initiatorOrigin: 'https://example.com', initiatorIsHelm: true, framesPlugins: false },
      false
    ],
    [
      'a frame on another site trying to reach a plugin page itself',
      { frameOrigin: 'https://example.com', initiatorOrigin: 'https://example.com' },
      false
    ],
    [
      'a navigation with nothing to do with plugins',
      { target: 'https://example.com/b', frameOrigin: 'https://example.com', initiatorOrigin: 'https://example.com', framesPlugins: false },
      true
    ],
    ['a frame whose origin could not be read', { frameOrigin: null }, false]
  ])('%s', (_name, patch, allowed) => {
    expect(pluginNavigationAllowed({ ...base, ...patch })).toBe(allowed)
  })
})

describe('the same plugin on two hosts', () => {
  const ours = 'helm-plugin://sample'
  const theirs = 'helm-plugin://sample.build-box'

  it('s19: neither frame can navigate to the other’s origin, and each moves between its own pages', () => {
    const from = (origin: string, target: string): boolean =>
      pluginNavigationAllowed({
        target,
        frameOrigin: origin,
        initiatorOrigin: origin,
        initiatorIsHelm: false,
        framesPlugins: true
      })
    expect(from(ours, `${theirs}/dist/panel.html`)).toBe(false)
    expect(from(theirs, `${ours}/dist/panel.html`)).toBe(false)
    expect(from(theirs, 'helm-plugin://sample.lab/dist/panel.html')).toBe(false)
    expect(from(ours, `${ours}/dist/other.html`)).toBe(true)
    expect(from(theirs, `${theirs}/dist/other.html`)).toBe(true)
  })

  it('gives build-box’s plugin page the same one permission as This PC’s', () => {
    installPluginPermissions()
    const request = handlers.request!
    for (const origin of [ours, theirs]) {
      const answers: boolean[] = []
      request(null, 'clipboard-sanitized-write', (granted) => answers.push(granted), { requestingUrl: `${origin}/x.html` })
      request(null, 'notifications', (granted) => answers.push(granted), { requestingUrl: `${origin}/x.html` })
      expect(answers).toEqual([true, false])
    }
  })
})

describe('a version 1 and a version 2 plugin side by side', () => {
  const v1 = 'helm-plugin://sample'
  const v2 = 'floti-plugin://sample'
  const from = (origin: string, target: string, initiatorIsHelm = false): boolean =>
    pluginNavigationAllowed({ target, frameOrigin: origin, initiatorOrigin: origin, initiatorIsHelm, framesPlugins: true })

  it('s1: keeps a version 2 frame on its own floti-plugin origin, scheme included, as a version 1 frame is kept on helm-plugin', () => {
    expect(from(v2, `${v2}/dist/other.html`)).toBe(true)
    expect(from(v2, `${v1}/dist/panel.html`)).toBe(false)
    expect(from(v1, `${v2}/dist/panel.html`)).toBe(false)
    expect(from(v2, 'floti-plugin://other/x.html')).toBe(false)
    expect(from(v2, 'https://example.com/')).toBe(false)
    // Helm itself puts a frame on either.
    expect(from('http://localhost:5173', `${v2}/dist/panel.html`, true)).toBe(true)
    expect(
      pluginNavigationAllowed({
        target: `${v2}/dist/panel.html`,
        frameOrigin: 'https://example.com',
        initiatorOrigin: 'https://example.com',
        initiatorIsHelm: true,
        framesPlugins: false
      })
    ).toBe(false)
  })

  it('s1: gives a version 2 page the clipboard write and nothing else, as a version 1 page', () => {
    installPluginPermissions()
    const request = handlers.request!
    const check = handlers.check!
    for (const origin of [v1, v2, 'floti-plugin://sample.build-box']) {
      const answers: boolean[] = []
      request(null, 'clipboard-sanitized-write', (granted) => answers.push(granted), { requestingUrl: `${origin}/x.html` })
      request(null, 'notifications', (granted) => answers.push(granted), { requestingUrl: `${origin}/x.html` })
      expect(answers).toEqual([true, false])
      expect(check(null, 'media', origin, {})).toBe(false)
      expect(check(null, 'clipboard-sanitized-write', origin, {})).toBe(true)
    }
  })
})

describe('guardPluginFrames', () => {
  interface Navigation {
    url: string
    isMainFrame: boolean
    frame: { origin: string } | null
    initiator?: unknown
    preventDefault: () => void
  }

  function contents(id: number): { contents: WebContents; navigate: (navigation: Omit<Navigation, 'preventDefault'>) => boolean; top: object } {
    const emitter = new EventEmitter()
    const top = { origin: 'http://localhost:5173' }
    const fake = Object.assign(emitter, { id, mainFrame: top }) as unknown as WebContents
    return {
      contents: fake,
      top,
      navigate: (navigation) => {
        let prevented = false
        emitter.emit('will-frame-navigate', {
          ...navigation,
          preventDefault: () => {
            prevented = true
          }
        })
        return prevented
      }
    }
  }

  it('lets Helm frame a plugin page in a page that frames plugins, and stops a plugin frame leaving its origin', () => {
    const page = contents(7)
    guardPluginFrames(page.contents, (id) => id === 7)
    expect(
      page.navigate({ url: 'helm-plugin://sample/a.html', isMainFrame: false, frame: { origin: 'http://localhost:5173' }, initiator: page.top })
    ).toBe(false)
    expect(
      page.navigate({
        url: 'https://example.com/',
        isMainFrame: false,
        frame: { origin: 'helm-plugin://sample' },
        initiator: { origin: 'helm-plugin://sample' }
      })
    ).toBe(true)
  })

  it('refuses a plugin page in any other web contents', () => {
    const view = contents(8)
    guardPluginFrames(view.contents, () => false)
    expect(
      view.navigate({ url: 'helm-plugin://sample/a.html', isMainFrame: false, frame: { origin: 'https://example.com' }, initiator: view.top })
    ).toBe(true)
  })

  it('leaves main-frame navigations to the will-navigate guard', () => {
    const page = contents(9)
    guardPluginFrames(page.contents, () => true)
    expect(page.navigate({ url: 'https://example.com/', isMainFrame: true, frame: null, initiator: null })).toBe(false)
  })

  it('counts a frame that went away as one whose origin is unknown', () => {
    const page = contents(10)
    guardPluginFrames(page.contents, () => true)
    const gone = {
      get origin(): string {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
    }
    expect(
      page.navigate({ url: 'helm-plugin://sample/a.html', isMainFrame: false, frame: gone as never, initiator: gone })
    ).toBe(true)
  })
})

describe('installPluginPermissions', () => {
  installPluginPermissions()

  const request = (permission: string, requestingUrl: string): boolean => {
    let granted: boolean | null = null
    handlers.request!(null, permission, (answer) => (granted = answer), { requestingUrl, isMainFrame: false })
    return granted!
  }

  it('gives a plugin page the clipboard write and nothing else', () => {
    expect(request('clipboard-sanitized-write', 'helm-plugin://sample/a.html')).toBe(true)
    for (const permission of ['media', 'notifications', 'geolocation', 'openExternal', 'clipboard-read', 'fullscreen']) {
      expect(request(permission, 'helm-plugin://sample/a.html')).toBe(false)
    }
  })

  it("answers as before for Helm's own pages", () => {
    expect(request('notifications', 'http://localhost:5173/')).toBe(true)
  })

  it('applies the same rule to permission checks, by URL or by origin', () => {
    expect(handlers.check!(null, 'media', 'helm-plugin://sample', { isMainFrame: false })).toBe(false)
    expect(
      handlers.check!(null, 'clipboard-sanitized-write', '', { requestingUrl: 'helm-plugin://sample/x.html', isMainFrame: false })
    ).toBe(true)
    expect(handlers.check!(null, 'media', 'http://localhost:5173', { isMainFrame: true })).toBe(true)
  })
})
