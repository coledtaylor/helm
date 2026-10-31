import { describe, expect, it } from 'vitest'
import { splitSettingsPatch } from './index'

describe('a window settings patch, split between the host and Helm', () => {
  it('keeps what quitting does on this device, never in the host', () => {
    const split = splitSettingsPatch({ quitSessions: { local: 'keep' }, scanRoots: ['/work'] })

    expect(split.own).toEqual({ quitSessions: { local: 'keep' } })
    expect(split.host).toEqual({ scanRoots: ['/work'] })
    expect(split.host).not.toHaveProperty('quitSessions')
  })

  it('keeps the tabs, panes and splits on this device, never in the host', () => {
    const paneLayout = {
      root: {
        axis: 'row' as const,
        children: [
          { panes: [{ kind: 'session' as const, id: 7 }], activeId: 'session:7' },
          { panes: [{ kind: 'history' as const }], activeId: 'history' }
        ],
        sizes: [0.3, 0.7]
      },
      focused: 1
    }
    const split = splitSettingsPatch({ paneLayout })

    expect(split.own).toEqual({ paneLayout })
    expect(split.host).toEqual({})
  })
})
