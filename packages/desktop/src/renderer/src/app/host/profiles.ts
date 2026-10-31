import type { Profile } from '@helm/core/types'
import type { HostConnection, HostSubscription } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import { profileFromHost } from '../../../../shared/host/records'
import type { HelmBridge } from '../../../../shared/ipc'
import type { HostReach } from './history'
import type { HostAdapter } from './router'

/**
 * Saved profiles while sessions run in the local host: they live in the host,
 * and the window lists, saves, pins, exports and imports them over its own
 * connection, in ipc.ts's shapes.
 *
 * On every connect it subscribes to the host's `profiles:changed` and hands
 * each list to the window, so whichever client wrote, every place that lists
 * profiles shows the change.
 *
 * The dialogs stay Helm's, on the user's own machine (`profileDialog:*`): it
 * asks before `profile:delete`, saves the document `profile:export` answers
 * where its save dialog says, and hands `profile:import` the file its open
 * dialog chose and read.
 *
 * A list asked for before the window reached the host waits for it, and with
 * no host it rejects with the sentence saying why, never an empty list
 * standing in for "could not look".
 */

export interface ProfilesAdapterDeps {
  link: HostReach
  /** The preload's bridge, for Helm's own dialogs. */
  own: Pick<HelmBridge, 'invoke'>
  log?: (line: string) => void
}

export function createProfilesAdapter({ link, own, log = () => undefined }: ProfilesAdapterDeps): HostAdapter {
  const listeners = new Set<(profiles: Profile[]) => void>()
  let subscription: HostSubscription | null = null

  const host = (): Promise<HostConnection> => link.connection()
  const take = (listed: readonly P.Profile[]): void => {
    const profiles = listed.map(profileFromHost)
    for (const listener of listeners) listener(profiles)
  }

  link.onConnected((connection) => {
    subscription?.unsubscribe()
    subscription = connection.subscribe('profiles:changed', {
      snapshot: take,
      event: take,
      error: (error) => log(`host: profiles:changed ended (${error.message})`)
    })
  })

  return {
    requests: {
      'profile:list': async () => (await (await host()).request('profile:list', null)).map(profileFromHost),

      'profile:save': async (request) => {
        const saved = await (await host()).request('profile:save', { id: request.id ?? null, draft: request.draft })
        return { profile: saved.profile === null ? null : profileFromHost(saved.profile), problems: saved.problems }
      },

      'profile:delete': async ({ id }) => {
        const connection = await host()
        const profile = (await connection.request('profile:list', null)).find((p) => p.id === id)
        if (profile === undefined) return { deleted: false }
        const { confirmed } = await own.invoke('profileDialog:confirmDelete', { name: profile.name })
        if (!confirmed) return { deleted: false }
        return { deleted: (await connection.request('profile:delete', { id })).deleted }
      },

      'profile:pin': async ({ ids }) => (await (await host()).request('profile:pin', { ids })).map(profileFromHost),

      'profile:export': async ({ id }) => {
        const document = await (await host()).request('profile:export', { id })
        return own.invoke('profileDialog:export', { fileName: document.fileName, yaml: document.yaml })
      },

      'profile:import': async () => {
        const chosen = await own.invoke('profileDialog:import')
        if (chosen.cancelled) return { profile: null, cancelled: true }
        if ('error' in chosen) return { profile: null, cancelled: false, error: chosen.error }
        const imported = await (await host()).request('profile:import', { fileName: chosen.fileName, yaml: chosen.yaml })
        return {
          profile: imported.profile === null ? null : profileFromHost(imported.profile),
          cancelled: false,
          ...(imported.error === null ? {} : { error: imported.error }),
          ...(imported.renamedTo === null ? {} : { renamedTo: imported.renamedTo })
        }
      }
    },
    events: {
      'profiles:changed': (listener) => {
        listeners.add(listener)
        void host().catch(() => undefined)
        return () => {
          listeners.delete(listener)
        }
      }
    }
  }
}
