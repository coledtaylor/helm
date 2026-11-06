import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SDK_DIR } from './fixtures'

/**
 * The SDK's types, met the way an author meets them: a plugin's own files,
 * checked by TypeScript with the SDK installed in its node_modules, so the
 * package's exports resolve as they do for anybody. A page and a background
 * module are checked apart, each with its own tsconfig, because each has its
 * own `floti`.
 *
 * Each `@ts-expect-error` is an assertion: TypeScript fails the check when
 * the line under it is not an error, so what must not type is shown not to.
 */

const require = createRequire(import.meta.url)
const TSC = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')

let root: string

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'helm sdk types-')))
  mkdirSync(join(root, 'node_modules', '@coledtaylor'), { recursive: true })
  // The SDK as installed: a junction on Windows, which needs no elevation, and a symlink elsewhere.
  symlinkSync(SDK_DIR, join(root, 'node_modules', '@coledtaylor', 'helm-plugin-sdk'), 'junction')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Writes a plugin's file and a tsconfig for it, and checks it. */
function check(name: string, lib: string[], source: string): { status: number | null; output: string } {
  const folder = join(root, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `${name}.ts`), source)
  writeFileSync(
    join(folder, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2023',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        lib,
        types: [],
        typeRoots: []
      },
      files: [`${name}.ts`]
    })
  )
  const result = spawnSync(process.execPath, [TSC, '-p', join(folder, 'tsconfig.json')], { cwd: root, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const PAGE = `/// <reference types="@coledtaylor/helm-plugin-sdk/global" />
import type { ApiVersion, FlotiBridge, HelmBridge, PluginManifest, PluginSession } from '@coledtaylor/helm-plugin-sdk'

// A version 2 page's floti, and a version 1 page's helm: the same calls, each at its version.
export const two: 2 = floti.apiVersion
export const one: 1 = window.helm.apiVersion
export const page: FlotiBridge = window.floti
export const old: HelmBridge = helm
export const opened: Promise<void> = floti.tabs.open('page', { n: 1 }, { preview: true })
export const linked: Promise<void> = floti.open('https://example.com')
export const sessions: Promise<PluginSession[]> = floti.sessions.list()
export const kind: 'dark' | 'light' = floti.theme.kind
export const here: boolean = floti.onHostComputer

// apiVersion is 1 or 2.
export const versions: ApiVersion[] = [1, 2]
// @ts-expect-error there is no apiVersion 3
export const three: ApiVersion = 3
export const manifest: PluginManifest = { apiVersion: 2, id: 'x', name: 'X', background: 'background/main.js' }
// @ts-expect-error a version 2 page's bridge is not version 1's
export const crossed: HelmBridge = floti
`

const BACKGROUND = `/// <reference types="@coledtaylor/helm-plugin-sdk/background" />
import type { FlotiBackground, SecretState, SettingValue } from '@coledtaylor/helm-plugin-sdk'

export const bridge: FlotiBackground = floti
export const two: 2 = floti.apiVersion
export const surface: 'background' = floti.context.surface
export const reply: Promise<Response> = floti.fetch('service:/items')
export const values: Promise<Record<string, SettingValue>> = floti.settings.get()
export const state: Promise<SecretState> = floti.secrets.state('token')
export const badge: Promise<void> = floti.badge.set(3)
export const off: () => void = floti.tools.handle('find', async (args, call) => ({ args, from: call.session.name }))
floti.on('settings', (settings) => settings['query'])
floti.on('command', ({ id }) => id)

// What needs a window rejects: each is typed as a promise that never resolves.
export const link: Promise<never> = floti.open('https://example.com')
export const tab: Promise<never> = floti.tabs.open('page', { n: 1 })
export const asked: Promise<never> = floti.secrets.request('token')
export const started: Promise<never> = floti.sessions.start({ cwd: '/work', prompt: 'hello' })
export const listed: Promise<never> = floti.sessions.list()

// @ts-expect-error a background has no theme
export const theme = floti.theme
// @ts-expect-error nor a page's events
floti.on('action', () => undefined)
// @ts-expect-error nor a window
export const page = window
`

describe('the SDK types', () => {
  it('S4: type floti and helm for a page, and apiVersion as 1 or 2', () => {
    const result = check('page', ['ES2023', 'DOM'], PAGE)
    expect(result.output).toBe('')
    expect(result.status).toBe(0)
  })

  it('S4: type floti for a background module, its calls that need a window as rejecting', () => {
    const result = check('background', ['ES2023', 'WebWorker'], BACKGROUND)
    expect(result.output).toBe('')
    expect(result.status).toBe(0)
  })

  it('fail a file that misuses them, so the two checks above can fail', () => {
    const result = check('wrong', ['ES2023', 'WebWorker'], BACKGROUND.replace('// @ts-expect-error a background has no theme\n', ''))
    expect(result.status).not.toBe(0)
    expect(result.output).toContain("Property 'theme' does not exist")
  })
})
