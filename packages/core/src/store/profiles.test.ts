import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProfileDraft } from '../types'
import { openStore, type Store } from './db'
import {
  createProfile,
  deleteProfile,
  findProfileByName,
  listProfiles,
  profileDraft,
  readProfile,
  setPinnedProfiles,
  updateProfile,
  uniqueProfileName
} from './profiles'

/** A folder the rows name. Nothing is made there: the rows are only data. */
const dir = join(tmpdir(), 'helm-profiles')
let store: Store

// The rows are about the store, not the file it lives in, so they live in
// memory.
beforeEach(() => {
  store = openStore({ file: ':memory:' })
})

afterEach(() => {
  store.close()
})

const draft = (overrides: Partial<ProfileDraft> = {}): ProfileDraft => ({
  name: 'Acme cloud sync',
  root: join(dir, 'harness'),
  overlays: [join(dir, 'harness', 'repos', 'acme')],
  access: [join(dir, 'harness', 'repos', 'other-repo')],
  model: 'opus',
  effort: 'high',
  permissionMode: 'auto',
  agent: null,
  mcp: ['clickup'],
  openingPrompt: '/recap',
  pinnedOrder: null,
  ...overrides
})

describe('profile CRUD', () => {
  it('stores and reads back every field', () => {
    const created = createProfile(store, draft())
    expect(created.id).toBeGreaterThan(0)
    expect(profileDraft(created)).toEqual(draft())
    expect(profileDraft(readProfile(store, created.id)!)).toEqual(draft())
  })

  it('keeps a profile that turns the session agents off, and a draft that leaves the choice out follows the setting', () => {
    const off = createProfile(store, draft({ name: 'No agents', sessionAgents: false }))
    expect(readProfile(store, off.id)?.sessionAgents).toBe(false)
    expect(profileDraft(off).sessionAgents).toBe(false)

    const silent = createProfile(store, draft({ name: 'Silent' }))
    expect(readProfile(store, silent.id)?.sessionAgents).toBeNull()
    expect(profileDraft(silent)).not.toHaveProperty('sessionAgents')

    // On is what following the setting already is, so it is stored as that.
    const on = createProfile(store, draft({ name: 'On', sessionAgents: true }))
    expect(readProfile(store, on.id)?.sessionAgents).toBeNull()
  })

  it('updates in place and stamps updated_at', () => {
    const created = createProfile(store, draft())
    const updated = updateProfile(store, created.id, draft({ model: 'sonnet', mcp: [] }))
    expect(updated?.model).toBe('sonnet')
    expect(updated?.mcp).toEqual([])
    expect(listProfiles(store)).toHaveLength(1)
  })

  it('returns null when updating a profile that has been deleted', () => {
    expect(updateProfile(store, 999, draft())).toBeNull()
  })

  it('deletes, and says whether there was anything to delete', () => {
    const created = createProfile(store, draft())
    expect(deleteProfile(store, created.id)).toBe(true)
    expect(deleteProfile(store, created.id)).toBe(false)
    expect(readProfile(store, created.id)).toBeNull()
  })

  it('rejects a duplicate name, which is what makes import ask for a new one', () => {
    createProfile(store, draft())
    expect(() => createProfile(store, draft())).toThrow()
  })

  it('finds by name case-insensitively, the way a person types it', () => {
    createProfile(store, draft())
    expect(findProfileByName(store, 'acme cloud sync')?.name).toBe('Acme cloud sync')
    expect(findProfileByName(store, 'nothing')).toBeNull()
  })

  it('suggests a free name for an import of something already here', () => {
    createProfile(store, draft())
    expect(uniqueProfileName(store, 'Acme cloud sync')).toBe('Acme cloud sync (2)')
    createProfile(store, draft({ name: 'Acme cloud sync (2)' }))
    expect(uniqueProfileName(store, 'Acme cloud sync')).toBe('Acme cloud sync (3)')
  })
})

describe('ordering', () => {
  it('puts pinned profiles first in their order, then the rest by name', () => {
    const a = createProfile(store, draft({ name: 'Alpha' }))
    const b = createProfile(store, draft({ name: 'Beta' }))
    const c = createProfile(store, draft({ name: 'Gamma' }))

    setPinnedProfiles(store, [c.id, a.id])
    expect(listProfiles(store).map((p) => p.name)).toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(readProfile(store, b.id)?.pinnedOrder).toBeNull()
  })

  it('unpins anything left out of the list', () => {
    const a = createProfile(store, draft({ name: 'Alpha' }))
    const b = createProfile(store, draft({ name: 'Beta' }))
    setPinnedProfiles(store, [a.id, b.id])
    setPinnedProfiles(store, [b.id])

    expect(readProfile(store, a.id)?.pinnedOrder).toBeNull()
    expect(listProfiles(store).map((p) => p.name)).toEqual(['Beta', 'Alpha'])
  })
})

