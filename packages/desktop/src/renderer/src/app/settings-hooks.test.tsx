import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_THEMES,
  DEFAULT_SETTINGS,
  type AppSettings,
  type ThemeDefinition,
  type ThemeListing,
  type ThemeState
} from '@helm/core/types'
import type { AppInfo, ClaudeStatus, UpdateCheck } from '../../../shared/ipc'
import { bridge } from './bridge.testkit'
import { useLauncher } from './useLauncher'
import { useSetup } from './useSetup'
import { useThemes } from './useThemes'
import { useUpdate } from './useUpdate'

vi.mock('./bridge', () => import('./bridge.testkit'))
// The terminal registries live outside React and are not what these tests are
// about; loading them would bring xterm into a document that cannot draw it.
vi.mock('./termprefs', () => ({ applyTerminalSettings: () => undefined }))

/**
 * The renderer's half of the settings surface: what reaches `<html>` and the
 * panes when the main process answers or pushes, and what the renderer asks
 * main for. The main half is `main/settings-ipc.test.ts`.
 */

beforeEach(() => {
  bridge.reset()
  // These hooks ask main for more than any one test is about. What a test does
  // not answer stays pending, so the hook waits quietly instead of throwing
  // into an unhandled rejection.
  bridge.whenUnanswered('pending')
})

const theme = (id: string): ThemeDefinition => {
  const found = BUILTIN_THEMES.find((t) => t.id === id)
  if (!found) throw new Error(`no built-in theme ${id}`)
  return found
}

const stateOf = (t: ThemeDefinition): ThemeState => ({
  preference: t.kind,
  resolved: t.kind,
  applied: { id: t.id, name: t.name, kind: t.kind, tokens: t.tokens, shadow: '', fallback: false }
})

/** A promise the test settles, for a request that has to stay in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('useThemes', () => {
  it('paints the theme main reports, and every theme it pushes afterwards', async () => {
    bridge.answer('theme:current', () => stateOf(theme('graphite')))
    bridge.answer('themes:list', () => ({ dir: 'C:\\themes', themes: [...BUILTIN_THEMES], errors: [] }))
    const { result } = renderHook(() => useThemes())

    await vi.waitFor(() => expect(result.current.state?.applied.id).toBe('graphite'))
    const root = document.documentElement
    expect(root.dataset['theme']).toBe('graphite')
    expect(root.classList.contains('dark')).toBe(true)

    act(() => bridge.emit('theme:changed', stateOf(theme('daylight'))))
    expect(result.current.state?.applied.id).toBe('daylight')
    expect(root.dataset['theme']).toBe('daylight')
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.style.colorScheme).toBe('light')
  })

  it('takes a new listing when the themes folder changes, with no restart', async () => {
    bridge.answer('themes:list', () => ({ dir: 'C:\\themes', themes: [...BUILTIN_THEMES], errors: [] }))
    const { result } = renderHook(() => useThemes())
    await vi.waitFor(() => expect(result.current.listing?.themes).toHaveLength(BUILTIN_THEMES.length))

    const ink: ThemeDefinition = { ...theme('nocturne'), id: 'ink', name: 'Ink', builtin: false, file: 'ink.json' }
    const next: ThemeListing = {
      dir: 'C:\\themes',
      themes: [...BUILTIN_THEMES, ink],
      errors: [{ file: 'broken.json', message: 'not JSON' }]
    }
    act(() => bridge.emit('themes:changed', next))
    expect(result.current.listing?.themes.map((t) => t.id)).toContain('ink')
    expect(result.current.listing?.errors).toEqual([{ file: 'broken.json', message: 'not JSON' }])
  })

  it('duplicates a theme in main, then shows the copy in the file manager', async () => {
    bridge.answer('themes:duplicate', ({ id }) => ({ file: `C:\\themes\\${id}-copy.json` }))
    bridge.answer('shell:showItem', () => undefined)
    const { result } = renderHook(() => useThemes())

    act(() => result.current.duplicate('graphite'))
    expect(bridge.invoked('themes:duplicate')).toEqual([{ id: 'graphite' }])
    await vi.waitFor(() => expect(bridge.invoked('shell:showItem')).toEqual([{ path: 'C:\\themes\\graphite-copy.json' }]))
  })
})

describe('useUpdate', () => {
  const answer = (over: Partial<UpdateCheck>): UpdateCheck => ({
    current: '1.2.0',
    latest: '1.2.0',
    newer: false,
    url: 'https://github.com/example/helm/releases/latest',
    error: null,
    checkedAt: '2026-10-02T12:00:00.000Z',
    ...over
  })

  it('asks main on every press, and is checking only while a request is in flight', async () => {
    const pending = [deferred<UpdateCheck>(), deferred<UpdateCheck>()]
    let asked = 0
    bridge.answer('update:check', () => (pending[asked++] as { promise: Promise<UpdateCheck> }).promise)
    const { result } = renderHook(() => useUpdate())
    expect(result.current.checking).toBe(false)

    act(() => result.current.check())
    expect(result.current.checking).toBe(true)
    const newer = answer({ latest: '1.3.0', newer: true })
    await act(async () => pending[0]?.resolve(newer))
    expect(result.current.checking).toBe(false)
    expect(result.current.attempted).toEqual(newer)
    expect(result.current.answered).toEqual(newer)

    act(() => result.current.check())
    expect(result.current.checking).toBe(true)
    const offline = answer({ latest: null, error: 'offline' })
    await act(async () => pending[1]?.resolve(offline))
    expect(result.current.checking).toBe(false)
    expect(bridge.invoked('update:check')).toHaveLength(2)
    // The pane reads the last attempt; the status bar keeps the last answer.
    expect(result.current.attempted).toEqual(offline)
    expect(result.current.answered).toEqual(newer)
  })

  it('adopts the launch check main pushes, and never asks on its own', () => {
    const { result } = renderHook(() => useUpdate())
    const pushed = answer({ latest: '1.3.0', newer: true })
    act(() => bridge.emit('update:checked', pushed))
    expect(result.current.answered).toEqual(pushed)
    expect(bridge.invoked('update:check')).toEqual([])
  })
})

describe('useLauncher', () => {
  const settings = (over: Partial<AppSettings> = {}): AppSettings => ({ ...DEFAULT_SETTINGS, ...over })
  const APP_INFO: AppInfo = {
    version: '1.2.0',
    mode: 'portable',
    dataDir: 'C:\\helm-data',
    dbFile: 'C:\\helm-data\\helm.db',
    migrations: [],
    versions: { electron: '43', chrome: '150', node: '24' },
    claudeVersion: null,
    windowsBuild: null,
    releasesUrl: 'https://github.com/example/helm/releases/latest'
  }

  it('puts the shape settings on <html> whenever main says the settings changed', () => {
    const { result } = renderHook(() => useLauncher())
    act(() => bridge.emit('settings:changed', settings({ density: 'compact', paneGap: 9, cornerRadius: 5 })))

    expect(result.current.settings?.density).toBe('compact')
    const root = document.documentElement
    expect(root.dataset['density']).toBe('compact')
    expect(root.style.getPropertyValue('--helm-gap')).toBe('9px')
    expect(root.style.getPropertyValue('--helm-radius')).toBe('5px')
  })

  it('adds and removes scan roots through main, and rescans after each', async () => {
    bridge.answer('app:info', () => APP_INFO)
    bridge.answer('settings:read', () => settings({ scanRoots: ['C:\\one'] }))
    bridge.answer('roots:add', () => ['C:\\one', 'C:\\my repos'])
    bridge.answer('roots:remove', () => ['C:\\my repos'])
    const { result } = renderHook(() => useLauncher())
    await vi.waitFor(() => expect(result.current.settings?.scanRoots).toEqual(['C:\\one']))

    act(() => result.current.addRoot())
    await vi.waitFor(() => expect(result.current.settings?.scanRoots).toEqual(['C:\\one', 'C:\\my repos']))
    expect(bridge.invoked('discovery:scan')).toHaveLength(1)

    act(() => result.current.removeRoot('C:\\one'))
    expect(bridge.invoked('roots:remove')).toEqual([{ path: 'C:\\one' }])
    await vi.waitFor(() => expect(result.current.settings?.scanRoots).toEqual(['C:\\my repos']))
    expect(bridge.invoked('discovery:scan')).toHaveLength(2)
  })

  it('clears a picked CLI by writing null through settings:write, and adopts main’s answer', async () => {
    bridge.answer('settings:write', (patch) => settings({ ...patch }))
    const { result } = renderHook(() => useLauncher())

    act(() => result.current.clearClaudePath())
    expect(bridge.invoked('settings:write')).toEqual([{ claudePath: null }])
    await vi.waitFor(() => expect(result.current.settings?.claudePath).toBeNull())
  })
})

describe('useSetup', () => {
  const status = (over: Partial<ClaudeStatus>): ClaudeStatus => ({
    path: 'C:\\bin\\claude.cmd',
    source: 'discovered',
    version: '2.1.999 (Claude Code)',
    semver: '2.1.999',
    tested: true,
    testedRange: { min: '2.1.0', max: '2.2.0' },
    configDir: 'C:\\home\\.claude',
    configDirExists: true,
    auth: 'authenticated',
    authSignal: '.claude.json records a completed sign-in',
    error: null,
    ...over
  })

  it('reads the CLI again whenever the chosen path changes, however it changed', async () => {
    let answer = status({ source: 'setting', path: 'D:\\picked\\claude.cmd' })
    bridge.answer('setup:status', () => answer)
    const picked: AppSettings = { ...DEFAULT_SETTINGS, claudePath: 'D:\\picked\\claude.cmd' }
    const { result, rerender } = renderHook(({ settings }) => useSetup(settings, () => undefined), {
      initialProps: { settings: picked }
    })
    await vi.waitFor(() => expect(result.current.status?.source).toBe('setting'))

    answer = status({ source: 'discovered' })
    rerender({ settings: { ...picked, claudePath: null } })
    await vi.waitFor(() => expect(result.current.status?.source).toBe('discovered'))
    expect(result.current.status?.path).toBe('C:\\bin\\claude.cmd')
    expect(bridge.invoked('setup:status')).toHaveLength(2)
  })

  it('locates the CLI through main’s picker and shows what main verified', async () => {
    const located = deferred<ClaudeStatus>()
    bridge.answer('setup:locateClaude', () => located.promise)
    const { result } = renderHook(() => useSetup(DEFAULT_SETTINGS, () => undefined))

    act(() => result.current.locateClaude())
    expect(result.current.checking).toBe(true)
    await act(async () => located.resolve(status({ source: 'setting', path: 'D:\\picked\\claude.cmd', version: '2.1.500' })))
    expect(result.current.checking).toBe(false)
    expect(result.current.status).toMatchObject({ source: 'setting', path: 'D:\\picked\\claude.cmd', version: '2.1.500' })
  })
})
