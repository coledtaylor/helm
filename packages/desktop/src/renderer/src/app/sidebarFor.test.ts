import { describe, expect, it } from 'vitest'
import type { PaneRef } from '@helm/core/types'
import { sidebarFor } from './sidebarFor'

describe('sidebarFor', () => {
  it('brings the list each tab was opened from, and nothing for a tab that holds its own', () => {
    const cases: ReadonlyArray<[PaneRef, ReturnType<typeof sidebarFor>]> = [
      [{ kind: 'session', id: 1 }, 'sessions'],
      [{ kind: 'terminal', id: 1, path: 'C:\\p' }, 'sessions'],
      [{ kind: 'project', path: 'C:\\p' }, 'sessions'],
      [{ kind: 'sessions' }, 'sessions'],
      [{ kind: 'restore' }, 'sessions'],
      [{ kind: 'file', root: 'C:\\p', path: 'C:\\p\\a.ts' }, 'files'],
      [{ kind: 'settings' }, 'settings'],
      [{ kind: 'history' }, null],
      [{ kind: 'config' }, null],
      [{ kind: 'browser' }, null]
    ]
    for (const [ref, view] of cases) expect([ref.kind, sidebarFor(ref)]).toEqual([ref.kind, view])
  })
})
