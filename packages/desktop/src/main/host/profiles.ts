import { basename } from 'node:path'
import { profileDraft, type Profile } from '@helm/core'
import type { EmitToWindow, ProfileDialogs, ProfileService } from '../profiles'
import type { HostConnection, HostSubscription } from './client'
import type { HostLink } from './link'
import type * as P from './protocol'
import { profileFromHost } from './records'

/**
 * Helm's saved profiles when sessions run in the local host: they live in the
 * host, which composes a launch from them, and this is the `ProfileService`
 * the window and main's other readers use.
 *
 * On every connect it subscribes to the host's `profiles:changed`, keeps the
 * list it carries and hands it to the window, so whichever client wrote, every
 * place that lists profiles shows the change. The dialogs stay Helm's: it asks
 * before `profile:delete`, saves the document `profile:export` answers where
 * its save dialog says, and hands `profile:import` the file its open dialog
 * chose.
 *
 * The first time Helm ever connects to a host, it copies its own saved
 * profiles into it, in their pin order, skipping a name the host already has.
 * A profile the host refuses is logged with the host's problems and stays only
 * in Helm's database. That it ran is recorded, so a profile deleted in the
 * host later is not copied back, and Helm's own database is never written by
 * it: with the setting off again, Helm's profiles are as they were.
 */

export interface HostProfilesDeps {
  link: HostLink
  dialogs: ProfileDialogs
  emit: EmitToWindow
  /** Helm's own saved profiles, in their pin order: what the first connect copies. */
  ownProfiles: () => Profile[]
  /** Whether Helm's profiles have been copied into a host before. */
  copied: () => boolean
  /** Records that they have, so no later start copies them again. */
  markCopied: () => void
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, text: string) => Promise<void>
  log: (line: string) => void
}

export interface HostProfiles extends ProfileService {
  shutdown(): void
}

export function createHostProfiles(deps: HostProfilesDeps): HostProfiles {
  const { link } = deps
  let known: Profile[] = []
  let subscription: HostSubscription | null = null

  const host = (): Promise<HostConnection> => link.connection()

  const take = (listed: readonly P.Profile[]): Profile[] => {
    known = listed.map(profileFromHost)
    deps.emit('profiles:changed', known)
    return known
  }

  /** Helm's own profiles into a host that has never been given them. */
  const copyOwnProfiles = async (connection: HostConnection): Promise<void> => {
    if (deps.copied()) return
    const taken = new Set((await connection.request('profile:list', null)).map((p) => p.name.toLowerCase()))
    for (const profile of deps.ownProfiles()) {
      if (taken.has(profile.name.toLowerCase())) continue
      const saved = await connection.request('profile:save', { id: null, draft: profileDraft(profile) })
      if (saved.profile === null) {
        deps.log(`host: the profile “${profile.name}” was not copied into the local host (${saved.problems.join(' ')})`)
        continue
      }
      taken.add(saved.profile.name.toLowerCase())
    }
    deps.markCopied()
  }

  link.onConnected(async (connection) => {
    subscription?.unsubscribe()
    subscription = connection.subscribe('profiles:changed', {
      snapshot: (listed) => take(listed),
      event: (listed) => take(listed),
      error: (error) => deps.log(`host: profiles:changed ended (${error.message})`)
    })
    try {
      await copyOwnProfiles(connection)
    } catch (error) {
      // Not recorded as done, so the next start tries again; a name copied
      // this time is skipped then.
      deps.log(`host: Helm's profiles were not copied into the local host (${(error as Error).message})`)
    }
  })

  return {
    // Through the connection, which joins the first connect while it is in
    // flight: a list asked for before Helm reached the host is the host's,
    // and with no host it rejects with the sentence saying why, never an
    // empty list standing in for "could not look".
    async list() {
      known = (await (await host()).request('profile:list', null)).map(profileFromHost)
      return known
    },

    // The last list the host sent, for main's readers that cannot wait (the
    // config and content scopes); empty until the first connect.
    current: () => known,

    async save(req) {
      const saved = await (await host()).request('profile:save', { id: req.id ?? null, draft: req.draft })
      return { profile: saved.profile === null ? null : profileFromHost(saved.profile), problems: saved.problems }
    },

    async remove(id) {
      const connection = await host()
      const profile = (await connection.request('profile:list', null)).find((p) => p.id === id)
      if (profile === undefined) return false
      if (!(await deps.dialogs.confirmDelete(profile.name))) return false
      return (await connection.request('profile:delete', { id })).deleted
    },

    async pin(ids) {
      return (await (await host()).request('profile:pin', { ids })).map(profileFromHost)
    },

    async exportProfile(id) {
      const document = await (await host()).request('profile:export', { id })
      const file = await deps.dialogs.chooseExportFile(document.fileName)
      if (file === null) return { file: null }
      await deps.writeFile(file, document.yaml)
      return { file }
    },

    async importProfile() {
      const file = await deps.dialogs.chooseImportFile()
      if (file === null) return { profile: null, cancelled: true }
      let yaml: string
      try {
        yaml = await deps.readFile(file)
      } catch (error) {
        return { profile: null, cancelled: false, error: `${basename(file)}: ${(error as Error).message}` }
      }
      const imported = await (await host()).request('profile:import', { fileName: basename(file), yaml })
      return {
        profile: imported.profile === null ? null : profileFromHost(imported.profile),
        cancelled: false,
        ...(imported.error === null ? {} : { error: imported.error }),
        ...(imported.renamedTo === null ? {} : { renamedTo: imported.renamedTo })
      }
    },

    shutdown() {
      subscription?.unsubscribe()
      subscription = null
    }
  }
}
