import { beforeAll, describe, expect, it, vi } from 'vitest'
import type * as ContentModule from './content'

/**
 * What the electron fake does not keep: the handler `protocol.handle` was given,
 * the IPC handlers `registerIpc` installed, and the URLs `shell.openExternal`
 * was asked to open.
 */
const captured = vi.hoisted(() => ({
  protocols: new Map<string, (request: Request) => Response | Promise<Response>>(),
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  opened: [] as string[]
}))

vi.mock('electron', async () => {
  const fake = (await import('../../test/electron')).electronFake()
  return {
    ...fake,
    protocol: {
      ...(fake['protocol'] as object),
      handle: (scheme: string, handler: (request: Request) => Response) => captured.protocols.set(scheme, handler)
    },
    ipcMain: {
      ...(fake['ipcMain'] as object),
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
        captured.handlers.set(channel, handler)
    },
    shell: {
      ...(fake['shell'] as object),
      openExternal: (url: string) => {
        captured.opened.push(url)
        return Promise.resolve()
      }
    }
  }
})

/**
 * The window's half of the artifacts: the scheme a sandboxed frame loads them
 * on, answered from the local host under the window's own policy, and the one
 * IPC handler that leaves the app.
 */
describe('the artifact scheme', () => {
  let serveArtifactsFrom: (typeof ContentModule)['serveArtifactsFrom']

  beforeAll(async () => {
    const content = await import('./content')
    serveArtifactsFrom = content.serveArtifactsFrom
    content.registerContentProtocol()
  })

  const serve = async (url: string): Promise<Response> => {
    const handler = captured.protocols.get('helm-content')
    expect(handler).toBeDefined()
    return handler!(new Request(url))
  }

  it('answers nothing before the host is there to answer', async () => {
    serveArtifactsFrom(null)
    expect((await serve('helm-content://artifact/tok/report.html')).status).toBe(404)
  })

  it("answers an artifact from the host's bytes, under the window's policy", async () => {
    const asked: string[] = []
    serveArtifactsFrom((url) => {
      asked.push(url)
      if (url.endsWith('/missing.js')) return Promise.resolve({ status: 404, headers: [], body: new Uint8Array() })
      if (url.endsWith('/broken.js')) return Promise.reject(new Error('The connection to the local host was closed.'))
      return Promise.resolve({
        status: 200,
        headers: [
          ['content-type', 'text/html; charset=utf-8'],
          ['content-security-policy', "default-src floti-artifact:"]
        ],
        body: new TextEncoder().encode('<p>from the host</p>')
      })
    })
    try {
      const page = await serve('helm-content://artifact/tok/report.html')
      expect(page.status).toBe(200)
      expect(await page.text()).toBe('<p>from the host</p>')
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
      const csp = page.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("connect-src 'none'")
      expect(csp).not.toContain('floti-artifact:')
      expect(page.headers.get('x-content-type-options')).toBe('nosniff')

      expect((await serve('helm-content://artifact/tok/missing.js')).status).toBe(404)
      const broken = await serve('helm-content://artifact/tok/broken.js')
      expect(broken.status).toBe(502)
      expect(await broken.text()).toMatch(/local host was closed/)
      expect(asked[0]).toBe('helm-content://artifact/tok/report.html')
    } finally {
      serveArtifactsFrom(null)
    }
  })

  it('hands http, https and mailto links to the system, and refuses every other scheme', async () => {
    const { registerIpc } = await import('./ipc')
    registerIpc({
      window: () => null,
      services: { settings: { theme: 'system' } },
      themes: { onChange: () => () => undefined }
    } as unknown as Parameters<typeof registerIpc>[0])
    const open = captured.handlers.get('shell:openExternal')
    expect(open).toBeDefined()
    const ask = (url: string): Promise<unknown> => Promise.resolve(open!({}, { url }))

    for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'not a url']) {
      expect(await ask(url), url).toEqual({ opened: false })
    }
    expect(captured.opened).toEqual([])

    expect(await ask('https://example.com/a?b=1')).toEqual({ opened: true })
    expect(await ask('http://example.com/')).toEqual({ opened: true })
    expect(await ask('mailto:someone@example.com')).toEqual({ opened: true })
    expect(captured.opened).toEqual(['https://example.com/a?b=1', 'http://example.com/', 'mailto:someone@example.com'])
  })
})
