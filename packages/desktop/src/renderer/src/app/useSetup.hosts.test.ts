import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@helm/core/types'
import { bridge, remoteBridge } from './bridge.testkit'
import { useSetup } from './useSetup'
import { PATIENCE } from '../../../../../../test/patience'

vi.mock('./bridge', () => import('./bridge.testkit'))

const BOX = 'h1'

beforeEach(() => {
  bridge.reset()
  bridge.whenUnanswered('pending')
  const box = remoteBridge(BOX)
  box.reset()
  box.answer('roots:suggest', () => ['/home/you/work', '/srv'])
  box.answer('template:list', () => ({
    templates: [
      { id: 'minimal', label: 'Minimal', description: null, order: null, builtIn: true },
      { id: 'infra', label: 'Infra', description: null, order: 1, builtIn: false }
    ],
    dir: '/home/you/.config/helm/templates',
    problems: []
  }))
  box.answer('template:preview', ({ template }) => ({ template, entries: ['harness.yaml'], note: null, problems: [] }))
  box.answer('harness:create', ({ dir, name }) => ({ path: `${dir}/${name ?? ''}`, problems: [] }))
})

describe('useSetup on a host on another computer', () => {
  it('opens New harness on build-box with its suggested folder and templates, and creates it there only', async () => {
    const rootsChanged = vi.fn()
    const created = vi.fn()
    const { result } = renderHook(() => useSetup(DEFAULT_SETTINGS, rootsChanged, created))
    // Whatever this PC's own setup reads at mount is not this test's concern.
    bridge.clearRecords()
    const box = remoteBridge(BOX)

    act(() => result.current.openDialog('new', BOX))
    expect(result.current.dialogHost).toBe(BOX)
    await vi.waitFor(() => expect(result.current.dialogDir).toBe('/home/you/work'), { timeout: PATIENCE })
    await vi.waitFor(() => expect(result.current.templates.map((each) => each.id)).toEqual(['minimal', 'infra']), {
      timeout: PATIENCE
    })
    await vi.waitFor(() => expect(result.current.templatePreview?.entries).toEqual(['harness.yaml']), {
      timeout: PATIENCE
    })

    // The picker browses this PC: it is not asked for a path on build-box.
    act(() => result.current.chooseDialogDir())
    act(() => result.current.typeDialogDir('/srv/work'))
    act(() => result.current.createHarness({ mode: 'new', dir: '/srv/work', name: 'ops', template: 'infra' }))
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith('/srv/work/ops', BOX), { timeout: PATIENCE })

    expect(box.invoked('harness:create')).toEqual([{ mode: 'new', dir: '/srv/work', name: 'ops', template: 'infra' }])
    expect(rootsChanged).toHaveBeenCalledWith(BOX)
    // Nothing read from or written on this PC for it.
    expect(bridge.invocations).toEqual([])
  })
})
