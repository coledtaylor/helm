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
