import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createProfile } from '@helm/core'
import { createWorld, disposeWorld, seedSettings, type World } from '../../test/world'
import type { ConfigService } from './config'
import type { ContentService } from './content'
import type { Services } from './services'

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
 * The content viewer's main-process half against a real scope on disk: the
 * scopes it offers, the artifact protocol, the bootstrap it injects, the
 * highlighter's ceiling, and the one IPC handler that leaves the app.
 */
describe('content service', () => {
  let world: World
  let services: Services
  let content: ContentService
  let config: ConfigService
  let notes: string
  const SECRET = 'TOP SECRET BYTES'

  beforeAll(async () => {
    world = createWorld()
    seedSettings(world)
    // The data directory and Claude's home are read when the modules load,
    // so the world is in place before they are imported.
    Object.assign(process.env, {
      PORTABLE_EXECUTABLE_DIR: world.portableDir,
      USERPROFILE: world.home,
      HOME: world.home
    })
    delete process.env['CLAUDE_CONFIG_DIR']

    notes = join(world.projects.alpha, 'notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'first.md'), '# First\n\nSee [[second]].\n')
    writeFileSync(join(notes, 'second.md'), '# Second\n')
    writeFileSync(
      join(notes, 'lesson.html'),
      '<!doctype html><html><head><title>Lesson</title></head><body><p>Read [[second]] and [[unwritten]].</p></body></html>\n'
    )
    writeFileSync(join(notes, 'chart.js'), 'window.chart = 1\n')
    writeFileSync(join(world.projects.alpha, 'secret.txt'), SECRET)

    const { createServices, runScan } = await import('./services')
    const { createContentService, registerContentProtocol } = await import('./content')
    const { createConfigService } = await import('./config')
    services = createServices()
    await runScan(services, { includeGit: false })
    content = createContentService({ services })
    config = createConfigService({ services, onExternalChange: () => undefined })
    registerContentProtocol()
  })

  afterAll(() => {
    config.stop()
    services.store.close()
    disposeWorld(world)
  })

  const serve = async (url: string): Promise<Response> => {
    const handler = captured.protocols.get('helm-content')
    expect(handler).toBeDefined()
    return handler!(new Request(url))
  }

  it('offers a profile root outside every scan root as a scope, in both the viewer and the console', () => {
    const outside = join(world.root, 'elsewhere', 'tooling')
    mkdirSync(outside, { recursive: true })
    const lower = (paths: string[]): string[] => paths.map((path) => path.toLowerCase())

    expect(lower(content.scopes().map((scope) => scope.path))).toContain(world.projects.alpha.toLowerCase())
    expect(lower(content.scopes().map((scope) => scope.path))).not.toContain(outside.toLowerCase())
    expect(lower(config.scopes().map((scope) => scope.path))).not.toContain(outside.toLowerCase())

    createProfile(services.store, {
      name: 'Outside',
      root: outside,
      overlays: [],
      access: [],
      model: null,
      effort: null,
      permissionMode: null,
      agent: null,
      mcp: [],
      openingPrompt: null,
      pinnedOrder: null
    })

    // Asked again, which is what Refresh does: the list is read per call.
    expect(lower(content.scopes().map((scope) => scope.path))).toContain(outside.toLowerCase())
    expect(lower(config.scopes().map((scope) => scope.path))).toContain(outside.toLowerCase())
  })

  it('refuses a path out of the artifact directory, encoded or normalised, and leaks no bytes', async () => {
    const { url } = content.artifact(world.projects.alpha, join(notes, 'lesson.html'))
    const base = url.slice(0, url.lastIndexOf('/'))

    const encoded = await serve(`${base}/..%2fsecret.txt`)
    expect(encoded.status).toBe(403)
    expect(await encoded.text()).not.toContain(SECRET)

    // The URL parser folds `..` away before the handler sees it, so the token
    // segment is gone and nothing is addressable.
    const normalised = await serve(`${base}/../secret.txt`)
    expect(normalised.status).toBe(404)
    expect(await normalised.text()).not.toContain(SECRET)
  })

  it('serves a file beside the artifact under a policy that names no network', async () => {
    const { url } = content.artifact(world.projects.alpha, join(notes, 'lesson.html'))
    const sibling = await serve(`${url.slice(0, url.lastIndexOf('/'))}/chart.js`)

    expect(sibling.status).toBe(200)
    expect(await sibling.text()).toBe(readFileSync(join(notes, 'chart.js'), 'utf8'))
    const csp = sibling.headers.get('content-security-policy') ?? ''
    expect(csp.split(';').map((directive) => directive.trim())).toEqual(
      expect.arrayContaining(["default-src 'none'", "connect-src 'none'"])
    )
    expect(csp).not.toMatch(/https?:/)
  })

  it('tells the framed document which wikilinks resolve, and nothing about where', async () => {
    const { url } = content.artifact(world.projects.alpha, join(notes, 'lesson.html'))
    const entry = await serve(url)
    expect(entry.status).toBe(200)
    const html = await entry.text()

    const island = /<script type="application\/json" data-helm-wikilinks>(.*?)<\/script>/s.exec(html)
    expect(island).not.toBeNull()
    expect(JSON.parse(island![1]!)).toEqual({ second: true, unwritten: false })

    for (const path of [world.root, world.projects.alpha, notes]) {
      for (const spelling of [path, path.replaceAll('\\', '/'), JSON.stringify(path).slice(1, -1)]) {
        expect(html.toLowerCase()).not.toContain(spelling.toLowerCase())
      }
    }
  })

  it('stops highlighting past the ceiling and says so, for the editor and the source view', async () => {
    const { highlightForEditor } = await import('./content')
    const big = `${'const value = "x"\n'.repeat(Math.ceil((512 * 1024 + 1024) / 18))}`

    const tooLarge = await highlightForEditor(join(notes, 'big.ts'), big)
    expect(tooLarge).toMatchObject({ lines: [], highlighted: false, tooLarge: true })

    const small = await highlightForEditor(join(notes, 'small.ts'), 'const value = 1\n')
    expect(small.tooLarge).toBe(false)
    expect(small.highlighted).toBe(true)
    expect(small.lines.length).toBeGreaterThan(0)

    writeFileSync(join(notes, 'big.ts'), big)
    const document = await content.document(world.projects.alpha, join(notes, 'big.ts'))
    expect(document.source).toEqual({ html: '', language: 'plaintext', highlighted: false, tooLarge: true })
  })

  it('hands http, https and mailto links to the system, and refuses every other scheme', async () => {
    const { registerIpc } = await import('./ipc')
    registerIpc({
      services,
      content,
      config,
      window: () => null,
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
