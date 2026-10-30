import { describe, expect, it } from 'vitest'
import { profileDraft, type Profile } from '@helm/core'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import { HostRequestError } from './client'
import type * as P from './protocol'
import { createHostProfiles } from './profiles'

const profile = (id: number, name: string, patch: Partial<P.Profile> = {}): P.Profile => ({
  id,
  name,
  root: `/work/${name}`,
  overlays: ['/work/tools'],
  access: [],
  model: 'sonnet',
  effort: null,
  permissionMode: null,
  agent: null,
  mcp: [],
  openingPrompt: '/recap',
  pinnedOrder: null,
  createdAt: '2026-10-29T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  ...patch
})

interface Options {
  /** Helm's own profiles, in their pin order. */
  own?: Profile[]
  /** Whether Helm's profiles were copied into a host before. */
  copied?: boolean
  /** The host's profiles to begin with. */
  hosted?: P.Profile[]
  agree?: boolean
  exportTo?: string | null
  importFrom?: string | null
  files?: Record<string, string>
}

/** The host side: a store of profiles answering profile:list and profile:save as the host does. */
function world(options: Options = {}) {
  const connection = new FakeConnection()
  const hosted = [...(options.hosted ?? [])]
  let nextId = 100
  connection.answer('profile:list', () => [...hosted])
  connection.answer('profile:save', ({ id, draft }) => {
    if (draft.root === '') return { profile: null, problems: ['A profile needs a folder to run in.'] }
    const saved = profile(id ?? nextId++, draft.name, { ...draft })
    hosted.push(saved)
    return { profile: saved, problems: [] }
  })
  const link = fakeLink(connection)
  const emitted: Profile[][] = []
  const logged: string[] = []
  const asked: string[] = []
  const written: Array<{ path: string; text: string }> = []
  const marks: number[] = []
  let copied = options.copied ?? false
  const profiles = createHostProfiles({
    link,
    dialogs: {
      confirmDelete: (name) => {
        asked.push(name)
        return Promise.resolve(options.agree ?? true)
      },
      chooseExportFile: (suggested) => {
        asked.push(suggested)
        return Promise.resolve(options.exportTo === undefined ? `/out/${suggested}` : options.exportTo)
      },
      chooseImportFile: () => Promise.resolve(options.importFrom ?? null)
    },
    emit: (channel, payload) => {
      if (channel === 'profiles:changed') emitted.push(payload as Profile[])
    },
    ownProfiles: () => options.own ?? [],
    copied: () => copied,
    markCopied: () => {
      copied = true
      marks.push(marks.length + 1)
    },
    readFile: (path) => {
      const text = options.files?.[path]
      return text === undefined ? Promise.reject(new Error('no such file')) : Promise.resolve(text)
    },
    writeFile: (path, text) => {
      written.push({ path, text })
      return Promise.resolve()
    },
    log: (line) => logged.push(line)
  })
  return { connection, hosted, link, profiles, emitted, logged, asked, written, marks }
}

/** A profile of Helm's own, as its database lists it. */
const own = (id: number, name: string, pinnedOrder: number | null, patch: Partial<Profile> = {}): Profile => ({
  ...profile(id, name, { pinnedOrder }),
  ...patch
})

describe('profiles in the local host', () => {
  it('lists the host’s profiles, keeps them current from profiles:changed, and hands each list to the window', async () => {
    const w = world({ copied: true, hosted: [profile(1, 'api')] })
    expect(await w.profiles.list()).toEqual([expect.objectContaining({ id: 1, name: 'api', root: '/work/api' })])

    w.connection.snapshot('profiles:changed', [profile(1, 'api')])
    w.connection.push('profiles:changed', [profile(1, 'api'), profile(2, 'web')])

    expect(w.profiles.current().map((p) => p.name)).toEqual(['api', 'web'])
    expect(w.emitted.map((list) => list.map((p) => p.name))).toEqual([['api'], ['api', 'web']])
  })

  it('answers a list asked for before the first connect has finished with the host’s profiles, not an empty one', async () => {
    const w = world({ copied: true, hosted: [profile(1, 'api'), profile(2, 'web')] })
    expect(w.link.current()).toBeNull()
    expect((await w.profiles.list()).map((p) => p.name)).toEqual(['api', 'web'])
    expect(w.profiles.current().map((p) => p.name)).toEqual(['api', 'web'])
  })

  it('says why when the host cannot be reached, rather than listing no profiles as if there were none', async () => {
    const sentence = 'Helm could not find the local host program at /nowhere/floti; turn it off.'
    const profiles = createHostProfiles({
      link: fakeLink(null, sentence),
      dialogs: {
        confirmDelete: () => Promise.resolve(false),
        chooseExportFile: () => Promise.resolve(null),
        chooseImportFile: () => Promise.resolve(null)
      },
      emit: () => undefined,
      ownProfiles: () => [],
      copied: () => true,
      markCopied: () => undefined,
      readFile: () => Promise.reject(new Error('unused')),
      writeFile: () => Promise.resolve(),
      log: () => undefined
    })
    await expect(profiles.list()).rejects.toThrow(sentence)
  })

  it('saves a draft through the host and passes its problems back unchanged', async () => {
    const w = world({ copied: true })
    const draft = profileDraft(own(0, 'hub', null))
    const saved = await w.profiles.save({ draft })
    const refused = await w.profiles.save({ id: 4, draft: { ...draft, name: 'bad', root: '' } })

    expect(w.connection.payloads('profile:save')).toEqual([
      expect.objectContaining({ id: null, draft: expect.objectContaining({ name: 'hub', root: '/work/hub' }) }),
      expect.objectContaining({ id: 4, draft: expect.objectContaining({ name: 'bad' }) })
    ])
    expect(saved).toEqual({ profile: expect.objectContaining({ id: 100, name: 'hub' }), problems: [] })
    expect(refused).toEqual({ profile: null, problems: ['A profile needs a folder to run in.'] })
  })

  it('deletes only after the user agrees in Helm’s dialog, and asks nothing about a profile that is gone', async () => {
    const declined = world({ copied: true, hosted: [profile(1, 'api')], agree: false })
    expect(await declined.profiles.remove(1)).toBe(false)
    expect(declined.asked).toEqual(['api'])
    expect(declined.connection.payloads('profile:delete')).toEqual([])

    const agreed = world({ copied: true, hosted: [profile(1, 'api')] })
    agreed.connection.answer('profile:delete', () => ({ deleted: true }))
    expect(await agreed.profiles.remove(1)).toBe(true)
    expect(await agreed.profiles.remove(9)).toBe(false)
    expect(agreed.asked).toEqual(['api'])
    expect(agreed.connection.payloads('profile:delete')).toEqual([{ id: 1 }])
  })

  it('pins through the host', async () => {
    const w = world({ copied: true })
    w.connection.answer('profile:pin', () => [profile(2, 'web', { pinnedOrder: 0 }), profile(1, 'api')])
    expect((await w.profiles.pin([2])).map((p) => [p.name, p.pinnedOrder])).toEqual([
      ['web', 0],
      ['api', null]
    ])
    expect(w.connection.payloads('profile:pin')).toEqual([{ ids: [2] }])
  })

  it('exports the host’s document where Helm’s save dialog says, and writes nothing when it is cancelled', async () => {
    const w = world({ copied: true })
    w.connection.answer('profile:export', () => ({ fileName: 'api.helm-profile.yaml', yaml: 'name: api\n' }))
    expect(await w.profiles.exportProfile(1)).toEqual({ file: '/out/api.helm-profile.yaml' })
    expect(w.written).toEqual([{ path: '/out/api.helm-profile.yaml', text: 'name: api\n' }])

    const cancelled = world({ copied: true, exportTo: null })
    cancelled.connection.answer('profile:export', () => ({ fileName: 'api.helm-profile.yaml', yaml: 'name: api\n' }))
    expect(await cancelled.profiles.exportProfile(1)).toEqual({ file: null })
    expect(cancelled.written).toEqual([])
  })

  it('a profile gone before its export says the host’s sentence', async () => {
    const w = world({ copied: true })
    w.connection.answer('profile:export', () => {
      throw new HostRequestError('profile:export', 'failed', 'That profile no longer exists.')
    })
    await expect(w.profiles.exportProfile(1)).rejects.toThrow('That profile no longer exists.')
  })

  it('imports the file Helm’s open dialog chose, by its name and text, and says what the host renamed it to', async () => {
    const w = world({ copied: true, importFrom: '/in/api.helm-profile.yaml', files: { '/in/api.helm-profile.yaml': 'name: api\n' } })
    w.connection.answer('profile:import', () => ({ profile: profile(5, 'api (2)'), error: null, renamedTo: 'api (2)' }))
    expect(await w.profiles.importProfile()).toEqual({
      profile: expect.objectContaining({ id: 5, name: 'api (2)' }),
      cancelled: false,
      renamedTo: 'api (2)'
    })
    expect(w.connection.payloads('profile:import')).toEqual([{ fileName: 'api.helm-profile.yaml', yaml: 'name: api\n' }])

    w.connection.answer('profile:import', () => ({ profile: null, error: 'api.helm-profile.yaml: not a profile', renamedTo: null }))
    expect(await w.profiles.importProfile()).toEqual({
      profile: null,
      cancelled: false,
      error: 'api.helm-profile.yaml: not a profile'
    })
  })

  it('sends nothing when the import is cancelled, and names a file it could not read', async () => {
    const cancelled = world({ copied: true })
    expect(await cancelled.profiles.importProfile()).toEqual({ profile: null, cancelled: true })
    expect(cancelled.connection.payloads('profile:import')).toEqual([])

    const unreadable = world({ copied: true, importFrom: '/in/gone.yaml' })
    expect(await unreadable.profiles.importProfile()).toEqual({
      profile: null,
      cancelled: false,
      error: 'gone.yaml: no such file'
    })
    expect(unreadable.connection.payloads('profile:import')).toEqual([])
  })

  describe('Helm’s own profiles, copied in on the first connect', () => {
    it('copies each in its pin order, skipping a name the host has, logging one it refuses, and records that it ran', async () => {
      const w = world({
        hosted: [profile(1, 'API')],
        own: [
          own(7, 'web', 0, { overlays: ['/work/tools'], permissionMode: 'plan' }),
          own(8, 'api', 1),
          own(9, 'broken', null, { root: '' }),
          own(10, 'notes', null)
        ]
      })
      await w.link.connect()

      expect(w.connection.payloads('profile:save')).toEqual([
        {
          id: null,
          draft: {
            name: 'web',
            root: '/work/web',
            overlays: ['/work/tools'],
            access: [],
            model: 'sonnet',
            effort: null,
            permissionMode: 'plan',
            agent: null,
            mcp: [],
            openingPrompt: '/recap',
            pinnedOrder: 0
          }
        },
        expect.objectContaining({ id: null, draft: expect.objectContaining({ name: 'broken' }) }),
        expect.objectContaining({ id: null, draft: expect.objectContaining({ name: 'notes', pinnedOrder: null }) })
      ])
      expect(w.hosted.map((p) => p.name)).toEqual(['API', 'web', 'notes'])
      expect(w.logged).toEqual([
        'host: the profile “broken” was not copied into the local host (A profile needs a folder to run in.)'
      ])
      expect(w.marks).toEqual([1])
      expect(w.connection.subscriptions.has('profiles:changed')).toBe(true)
    })

    it('copies nothing on a later start, so a profile deleted in the host stays deleted', async () => {
      const w = world({ copied: true, own: [own(7, 'web', 0)] })
      await w.link.connect()
      expect(w.connection.payloads('profile:save')).toEqual([])
      expect(w.marks).toEqual([])
    })

    it('is not recorded as done when the host stops answering partway, so the next start finishes it', async () => {
      const w = world({ own: [own(7, 'web', 0), own(8, 'api', 1)] })
      w.connection.answer('profile:save', () => {
        throw new HostRequestError('profile:save', 'unavailable', 'The connection to the local host was closed.')
      })
      await w.link.connect()
      expect(w.marks).toEqual([])
      expect(w.logged).toEqual([
        "host: Helm's profiles were not copied into the local host (The connection to the local host was closed.)"
      ])
    })
  })
})
