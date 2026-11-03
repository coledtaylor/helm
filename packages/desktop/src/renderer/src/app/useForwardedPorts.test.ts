import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserState, ForwardedPort } from '../../../shared/ipc'
import { bridge } from './bridge.testkit'
import { useBrowsers } from './useBrowsers'
import { useForwardedPorts } from './useForwardedPorts'

vi.mock('./bridge', () => import('./bridge.testkit'))

const forward = (local: number): ForwardedPort => ({ host: 'build-box', session: 7, port: 5173, local })

/** The page main made for `url`, as `browser:open` answers it. */
const page = (url: string): BrowserState => ({
  id: 1,
  url,
  title: 'Dev server',
  host: new URL(url).host,
  canGoBack: false,
  canGoForward: false,
  loading: false,
  problem: null,
  retryingUntil: null,
  zoomLevel: 0,
  errors: 0,
  devtoolsOpen: false,
  find: null,
  project: null,
  openedBy: null,
  openerRunning: false,
  sharedWith: null
})

/** The window's Browser tab and the forwarded ports, wired as App wires them. */
function renderWindow() {
  return renderHook(() => {
    const browsers = useBrowsers([])
    const ports = useForwardedPorts((request) => void browsers.open(request))
    return { browsers, ports }
  })
}

beforeEach(() => {
  bridge.reset()
  bridge.answer('browser:state', () => [])
  bridge.answer('browser:console', () => [])
  bridge.answer('forwards:read', () => [])
})

describe('useForwardedPorts', () => {
  it('S4: Open in browser on a remote session port forwards it and opens the forwarded address on this PC in the Browser tab', async () => {
    bridge.answer('forwards:open', () => forward(49152))
    bridge.answer('browser:open', ({ url }) => ({ state: page(url ?? ''), problem: null }))
    const { result } = renderWindow()

    act(() => result.current.ports.openRemotePort('build-box', 7, 'build-box:7', 5173))

    await waitFor(() => expect(bridge.invoked('browser:open')).toHaveLength(1))
    expect(bridge.invoked('forwards:open')).toEqual([{ host: 'build-box', session: 7, port: 5173 }])
    // Through `browser:open`, which holds the reach rule, as a typed address
    // is; a page of no project.
    expect(bridge.invoked('browser:open')).toEqual([{ url: 'http://localhost:49152/', project: null }])
    await waitFor(() =>
      expect(result.current.browsers.views.get(1)?.url).toBe('http://localhost:49152/')
    )
    expect(result.current.ports.portProblems.size).toBe(0)
  })

  it('S4: the port rows learn where each port is forwarded, at once and as it changes', async () => {
    bridge.answer('forwards:read', () => [forward(5173)])
    const { result } = renderWindow()
    await waitFor(() => expect(result.current.ports.forwards).toEqual([forward(5173)]))

    act(() => bridge.emit('forwards:changed', []))
    expect(result.current.ports.forwards).toEqual([])
  })

  it('S4: a forward main refuses opens no page and says why under the session, until Open in browser is pressed again', async () => {
    let refuse = true
    bridge.answer('forwards:open', () => {
      if (refuse) throw new Error('Port 5173 is not one session 7 listens on.')
      return forward(5173)
    })
    bridge.answer('browser:open', ({ url }) => ({ state: page(url ?? ''), problem: null }))
    const { result } = renderWindow()

    act(() => result.current.ports.openRemotePort('build-box', 7, 'build-box:7', 5173))
    await waitFor(() =>
      expect(result.current.ports.portProblems.get('build-box:7')).toBe('Port 5173 is not one session 7 listens on.')
    )
    expect(bridge.invoked('browser:open')).toEqual([])

    refuse = false
    act(() => result.current.ports.openRemotePort('build-box', 7, 'build-box:7', 5173))
    expect(result.current.ports.portProblems.has('build-box:7')).toBe(false)
    await waitFor(() => expect(bridge.invoked('browser:open')).toEqual([{ url: 'http://localhost:5173/', project: null }]))
  })
})
