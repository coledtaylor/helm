import { useCallback, useEffect, useState } from 'react'
import type { Profile, ProfileDraft, SessionRecord } from '@helm/core'
import { helm } from './bridge'
import { estimateGrid } from './terminals'

/**
 * The renderer's view of saved profiles.
 *
 * The list is never mutated here. Every write goes to main and the answer comes
 * back as the whole list on `profiles:changed`, so a second window - or the
 * import dialog, which creates a profile from outside this component tree -
 * cannot leave the sidebar showing something that is not in the database.
 */

export interface ProfilesState {
  profiles: Profile[]
  /** Profiles whose session is being spawned right now. */
  launching: number[]
  /** Set when the last launch or import failed, until the next attempt. */
  error: string | null
  /** Set after a launch that composed something worth mentioning. */
  notice: string | null
  dismissError: () => void
  dismissNotice: () => void
  save: (draft: ProfileDraft, id?: number | null) => Promise<{ ok: boolean; problems: string[] }>
  remove: (id: number) => Promise<boolean>
  togglePin: (profile: Profile) => Promise<void>
  reorder: (ids: number[]) => Promise<void>
  exportProfile: (id: number) => Promise<void>
  importProfile: () => Promise<void>
  /** Spawns the profile and returns the session, or null on failure. */
  launch: (profile: Profile, paneSize: HTMLElement | null) => Promise<SessionRecord | null>
}

/** Electron prefixes a renderer-side rejection with the channel it came from. */
function readable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '')
}

export function useProfiles(): ProfilesState {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [launching, setLaunching] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const off = helm.on('profiles:changed', setProfiles)
    void helm.invoke('profile:list').then(setProfiles)
    return off
  }, [])

  /**
   * A notice is an acknowledgement, so it goes away on its own. An error is
   * not: it is the only account of a launch that did not happen, and clearing
   * it on a timer would leave an empty tab strip and no explanation.
   */
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => setNotice(null), 9000)
    return () => clearTimeout(timer)
  }, [notice])

  const save = useCallback(async (draft: ProfileDraft, id?: number | null) => {
    setError(null)
    try {
      const result = await helm.invoke('profile:save', { draft, ...(id == null ? {} : { id }) })
      return { ok: result.profile !== null, problems: result.problems }
    } catch (err: unknown) {
      return { ok: false, problems: [readable(err)] }
    }
  }, [])

  const remove = useCallback(async (id: number) => {
    const { deleted } = await helm.invoke('profile:delete', { id })
    return deleted
  }, [])

  const reorder = useCallback(async (ids: number[]) => {
    await helm.invoke('profile:pin', { ids })
  }, [])

  const togglePin = useCallback(
    async (profile: Profile) => {
      // Expressed as the whole pinned list rather than a per-profile flag,
      // which is the shape the store takes and the only one that can express
      // "pinned, in this order" without two calls that can disagree.
      const pinned = profiles.filter((p) => p.pinnedOrder !== null).map((p) => p.id)
      const next =
        profile.pinnedOrder === null
          ? [...pinned, profile.id]
          : pinned.filter((id) => id !== profile.id)
      await helm.invoke('profile:pin', { ids: next })
    },
    [profiles]
  )

  const exportProfile = useCallback(async (id: number) => {
    setError(null)
    setNotice(null)
    try {
      const { file } = await helm.invoke('profile:export', { id })
      if (file) setNotice(`Exported to ${file}`)
    } catch (err: unknown) {
      setError(readable(err))
    }
  }, [])

  const importProfile = useCallback(async () => {
    setError(null)
    setNotice(null)
    try {
      const result = await helm.invoke('profile:import')
      if (result.cancelled) return
      if (result.error !== undefined) {
        setError(result.error)
        return
      }
      setNotice(
        result.renamedTo === undefined
          ? `Imported “${result.profile?.name ?? ''}”.`
          : `Imported as “${result.renamedTo}” — that name was taken.`
      )
    } catch (err: unknown) {
      setError(readable(err))
    }
  }, [])

  const launch = useCallback(
    async (profile: Profile, paneSize: HTMLElement | null): Promise<SessionRecord | null> => {
      setError(null)
      setNotice(null)
      setLaunching((current) => [...current, profile.id])
      try {
        const { cols, rows } = estimateGrid(paneSize)
        const result = await helm.invoke('profile:launch', { profileId: profile.id, cols, rows })

        // What the composition actually turned into. Worth saying once, because
        // the alternative is a session that silently has fewer skills in it
        // than the profile claims and no way to tell from the terminal.
        //
        // The namespaces are named with their colons because that is how they
        // are typed at a `/` prompt - `<overlay>:think` - so the notice doubles
        // as the answer to "what do I call these now".
        const parts: string[] = []
        if (result.overlays.length > 0) {
          const names = result.overlays.map((name) => `${name}:`)
          const listed =
            names.length === 1
              ? names[0]
              : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
          parts.push(`Composed ${listed}`)
          if (result.composedInstructions) parts.push('with their CLAUDE.md instructions')
        }
        const summary = parts.join(' ')
        const warnings = result.warnings.join(' ')
        if (summary || warnings) setNotice([summary, warnings].filter(Boolean).join(' — '))

        return result.session
      } catch (err: unknown) {
        setError(readable(err))
        return null
      } finally {
        setLaunching((current) => current.filter((id) => id !== profile.id))
      }
    },
    []
  )

  return {
    profiles,
    launching,
    error,
    notice,
    dismissError: useCallback(() => setError(null), []),
    dismissNotice: useCallback(() => setNotice(null), []),
    save,
    remove,
    togglePin,
    reorder,
    exportProfile,
    importProfile,
    launch
  }
}
