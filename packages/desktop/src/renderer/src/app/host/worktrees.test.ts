import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeReach } from '../../../../../test/fake-connection'
import type * as P from '../../../../shared/host/protocol'
import type { RequestChannel, RequestPayload, RequestResult } from '../../../../shared/ipc'
import type { HostAdapter } from './router'
import { createWorktreesAdapter } from './worktrees'

const PROJECT = '/work dir/a repo'
const FOLDER = '/work dir/a repo/.floti/worktrees/ledger-store'
const UNREACHABLE = 'No local host answered on its socket.'

function ask<K extends RequestChannel>(adapter: HostAdapter, channel: K, payload: RequestPayload<K>): Promise<RequestResult<K>> {
  const route = adapter.requests?.[channel]
  if (route === undefined) throw new Error(`no route for ${channel}`)
  return route(payload)
}

const listing: P.AgentWorktrees = {
  worktrees: [
    {
      name: 'ledger-store',
      folder: FOLDER,
      branch: 'agent/ledger-store',
      child: { name: 'builder', parent: 'lead', running: true },
      uncommitted: true
    },
    { name: 'spare', folder: `${PROJECT}/.floti/worktrees/spare`, branch: null, child: null, uncommitted: null }
  ]
}

describe('the agent worktrees of a project over the window’s own connection', () => {
  it('lists the worktrees the host names, the child that worked in each and what git could not say, unchanged', async () => {
    const connection = new FakeConnection().answer('worktrees:list', () => listing)
    const adapter = createWorktreesAdapter(fakeReach(connection, UNREACHABLE))

    await expect(ask(adapter, 'worktrees:list', { project: PROJECT })).resolves.toEqual(listing.worktrees)
    expect(connection.payloads('worktrees:list')).toEqual([{ project: PROJECT }])
  })

  it('answers a project with none as an empty list', async () => {
    const connection = new FakeConnection().answer('worktrees:list', () => ({ worktrees: [] }))
    const adapter = createWorktreesAdapter(fakeReach(connection, UNREACHABLE))

    await expect(ask(adapter, 'worktrees:list', { project: PROJECT })).resolves.toEqual([])
  })

  it('removes one by its folder, and keeps the host’s refusal as the answer rather than throwing it', async () => {
    const refusal = 'The worktree ledger-store has uncommitted changes, so it was not removed. Commit or discard them first.'
    const connection = new FakeConnection().answer('worktrees:remove', ({ folder }) =>
      folder === FOLDER ? { removed: false, refusal } : { removed: true, refusal: null }
    )
    const adapter = createWorktreesAdapter(fakeReach(connection, UNREACHABLE))

    await expect(ask(adapter, 'worktrees:remove', { project: PROJECT, folder: FOLDER })).resolves.toEqual({
      removed: false,
      refusal
    })
    await expect(ask(adapter, 'worktrees:remove', { project: PROJECT, folder: `${FOLDER}-2` })).resolves.toEqual({
      removed: true,
      refusal: null
    })
    expect(connection.payloads('worktrees:remove')).toEqual([
      { project: PROJECT, folder: FOLDER },
      { project: PROJECT, folder: `${FOLDER}-2` }
    ])
  })

  it('says the link’s sentence when the host cannot be reached, never no worktrees or a removal', async () => {
    const adapter = createWorktreesAdapter(fakeReach(null, UNREACHABLE))

    await expect(ask(adapter, 'worktrees:list', { project: PROJECT })).rejects.toThrow(UNREACHABLE)
    await expect(ask(adapter, 'worktrees:remove', { project: PROJECT, folder: FOLDER })).rejects.toThrow(UNREACHABLE)
  })
})
