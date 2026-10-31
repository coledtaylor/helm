import { describe, expect, it } from 'vitest'
import type { Profile } from '@helm/core/types'
import { FakeConnection, fakeReach } from '../../../../../test/fake-connection'
import type * as P from '../../../../shared/host/protocol'
import type {
  HelmBridge,
  ProfileFileChosen,
  RequestChannel,
  RequestPayload,
  RequestResult
} from '../../../../shared/ipc'
import { createProfilesAdapter } from './profiles'
import type { HostAdapter } from './router'

const UNREACHABLE = 'No local host answered on its socket; turn off “Run sessions in the local host” in Settings.'

const profile = (id: number, name: string, patch: Partial<P.Profile> = {}): P.Profile => ({
  id,
  name,
  root: `/work dir/${name}`,
  overlays: ['/work dir/tools'],
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
  hosted?: P.Profile[]
  agree?: boolean
  /** Where Helm's save dialog says, or null when cancelled. */
  exportTo?: string | null
  chosen?: ProfileFileChosen
}

/** The host's profiles, and Helm's own dialogs on the user's machine. */
function world(options: Options = {}, connection: FakeConnection | null = new FakeConnection()) {
  const hosted = [...(options.hosted ?? [])]
  let nextId = 100
  connection
    ?.answer('profile:list', () => [...hosted])
    .answer('profile:save', ({ id, draft }) => {
      if (draft.root === '') return { profile: null, problems: ['A profile needs a folder to run in.'] }
      const saved = profile(id ?? nextId++, draft.name, { ...draft })
      hosted.push(saved)
      return { profile: saved, problems: [] }
    })
    .answer('profile:delete', ({ id }) => {
      const at = hosted.findIndex((p) => p.id === id)
      if (at >= 0) hosted.splice(at, 1)
      return { deleted: at >= 0 }
    })
    .answer('profile:pin', ({ ids }) => ids.map((id, order) => ({ ...hosted.find((p) => p.id === id)!, pinnedOrder: order })))
    .answer('profile:export', ({ id }) => ({ fileName: `${hosted.find((p) => p.id === id)!.name}.yaml`, yaml: 'name: x\n' }))
    .answer('profile:import', ({ fileName }) => ({
      profile: profile(200, 'imported'),
      error: null,
      renamedTo: fileName === 'taken.yaml' ? 'imported (2)' : null
    }))
  const asked: Array<{ channel: string; payload: unknown }> = []
  const own = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      asked.push({ channel, payload })
      switch (channel) {
        case 'profileDialog:confirmDelete':
          return Promise.resolve({ confirmed: options.agree ?? true })
        case 'profileDialog:export':
          return Promise.resolve({ file: options.exportTo === undefined ? '/out dir/x.yaml' : options.exportTo })
        case 'profileDialog:import':
          return Promise.resolve(options.chosen ?? { cancelled: true })
        default:
          return Promise.reject(new Error(`${channel} is not Helm's own`))
      }
    }
  } as unknown as Pick<HelmBridge, 'invoke'>
  const link = fakeReach(connection, UNREACHABLE)
  const adapter = createProfilesAdapter({ link, own })
  return { connection: connection ?? new FakeConnection(), link, adapter, asked, hosted }
}

function ask<K extends RequestChannel>(adapter: HostAdapter, channel: K, payload?: RequestPayload<K>): Promise<RequestResult<K>> {
  const route = adapter.requests?.[channel]
  if (route === undefined) throw new Error(`no route for ${channel}`)
  return route(payload as RequestPayload<K>)
}

describe('the window’s profiles over its own connection', () => {
  it('lists the host’s profiles, and hands the window each list the host pushes', async () => {
    const { adapter, connection, link } = world({ hosted: [profile(1, 'review')] })
    const lists: Profile[][] = []
    adapter.events?.['profiles:changed']?.((listed) => lists.push(listed))
    await expect(ask(adapter, 'profile:list')).resolves.toMatchObject([{ id: 1, name: 'review' }])
    await link.connect()
    connection.snapshot('profiles:changed', [profile(1, 'review')])
    connection.push('profiles:changed', [profile(1, 'review'), profile(2, 'ship')])
    expect(lists.map((list) => list.map((p) => p.name))).toEqual([['review'], ['review', 'ship']])
  })

  it('says why when the host cannot be reached, never an empty list as if there were none', async () => {
    await expect(ask(world({}, null).adapter, 'profile:list')).rejects.toThrow(UNREACHABLE)
  })

  it('saves, pins and launches nothing of its own: the host does each', async () => {
    const { adapter, connection } = world({ hosted: [profile(1, 'review')] })
    const saved = await ask(adapter, 'profile:save', {
      draft: { ...profile(0, 'ship'), root: '/work dir/ship' }
    } as RequestPayload<'profile:save'>)
    expect(saved.problems).toEqual([])
    expect(connection.payloads('profile:save')).toMatchObject([{ id: null }])
    await expect(ask(adapter, 'profile:pin', { ids: [1] })).resolves.toMatchObject([{ id: 1, pinnedOrder: 0 }])
  })

  it('deletes only after the user agrees in Helm’s dialog, and asks nothing about a profile that is gone', async () => {
    const refused = world({ hosted: [profile(1, 'review')], agree: false })
    await expect(ask(refused.adapter, 'profile:delete', { id: 1 })).resolves.toEqual({ deleted: false })
    expect(refused.connection.payloads('profile:delete')).toEqual([])
    expect(refused.asked).toEqual([{ channel: 'profileDialog:confirmDelete', payload: { name: 'review' } }])

    const agreed = world({ hosted: [profile(1, 'review')] })
    await expect(ask(agreed.adapter, 'profile:delete', { id: 1 })).resolves.toEqual({ deleted: true })
    await expect(ask(agreed.adapter, 'profile:delete', { id: 1 })).resolves.toEqual({ deleted: false })
    expect(agreed.asked).toHaveLength(1)
  })

  it('exports the host’s document through Helm’s save dialog', async () => {
    const { adapter, asked } = world({ hosted: [profile(1, 'review')] })
    await expect(ask(adapter, 'profile:export', { id: 1 })).resolves.toEqual({ file: '/out dir/x.yaml' })
    expect(asked).toEqual([{ channel: 'profileDialog:export', payload: { fileName: 'review.yaml', yaml: 'name: x\n' } }])
  })

  it('imports the file Helm’s open dialog read, sends nothing when cancelled, and names a file it could not read', async () => {
    const cancelled = world()
    await expect(ask(cancelled.adapter, 'profile:import')).resolves.toEqual({ profile: null, cancelled: true })
    expect(cancelled.connection.payloads('profile:import')).toEqual([])

    const unreadable = world({ chosen: { cancelled: false, error: 'gone.yaml: no such file' } })
    await expect(ask(unreadable.adapter, 'profile:import')).resolves.toEqual({
      profile: null,
      cancelled: false,
      error: 'gone.yaml: no such file'
    })

    const renamed = world({ chosen: { cancelled: false, fileName: 'taken.yaml', yaml: 'name: imported\n' } })
    await expect(ask(renamed.adapter, 'profile:import')).resolves.toMatchObject({
      profile: { id: 200, name: 'imported' },
      cancelled: false,
      renamedTo: 'imported (2)'
    })
    expect(renamed.connection.payloads('profile:import')).toEqual([{ fileName: 'taken.yaml', yaml: 'name: imported\n' }])
  })
})
