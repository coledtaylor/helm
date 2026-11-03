import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import type { Profile, ProfileDraft, Project, SessionRecord } from '@helm/core/types'
import { ProfileEditor, ProfileList, type ProfilePrediction } from '@helm/ui'
import { bridgeFor } from './bridge'
import { useProfiles } from './useProfiles'

export interface HostProfilesProps {
  /** A host on another computer, by id, and its name. */
  host: string
  name: string
  connected: boolean
  /** That host's projects and harnesses, as its scan found them. */
  projects: readonly Project[]
  harnesses: readonly { name: string; path: string }[]
  /** A draft with nothing chosen, rooted at `root`. */
  blank: (root: string, name: string) => ProfileDraft
  /** A session one of its profiles started there, for the window to give a tab. */
  onLaunched: (record: SessionRecord) => void
  /** The pane a launched session is sized for. */
  paneSize: () => HTMLElement | null
}

/**
 * The profiles kept on a host on another computer, under its name in the
 * Profiles sidebar. Every read and write - listing, saving, deleting, pinning,
 * ordering, launching and the editor's agent and MCP pickers - goes through
 * that host's own bridge (`bridgeFor`), so none of them lands on this PC.
 */
export function HostProfiles({
  host,
  name,
  connected,
  projects,
  harnesses,
  blank,
  onLaunched,
  paneSize
}: HostProfilesProps): JSX.Element {
  const state = useProfiles(host)
  const [editing, setEditing] = useState<Profile | ProfileDraft | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const launch = useCallback(
    async (profile: Profile) => {
      const record = await state.launch(profile, paneSize())
      if (record) onLaunched(record)
    },
    [state, paneSize, onLaunched]
  )

  const predict = useCallback(async (root: string, overlays: string[]): Promise<ProfilePrediction> => {
    const view = await bridgeFor(host).invoke('config:effective', { cwd: root, overlays })
    return { agents: view.agents, mcpServers: view.mcpServers }
  }, [host])

  const save = useCallback(
    async (draft: ProfileDraft) => {
      setSaving(true)
      try {
        const id = editing !== null && 'id' in editing ? editing.id : null
        const { profile, problems: found } = await state.save(draft, id)
        setProblems(found)
        if (profile === null) return
        setEditing(null)
        if (id === null) void launch(profile)
      } finally {
        setSaving(false)
      }
    },
    [editing, state, launch]
  )

  return (
    <>
      <ProfileList
        profiles={state.profiles}
        harnesses={harnesses}
        launchingIds={state.launching}
        onLaunch={(profile) => void launch(profile)}
        onEdit={(profile) => {
          setProblems([])
          setEditing(profile)
        }}
        onDelete={(profile) => void state.remove(profile.id)}
        onExport={(profile) => void state.exportProfile(profile.id)}
        onTogglePin={(profile) => void state.togglePin(profile)}
        onReorder={(ids) => void state.reorder(ids)}
        host={{
          id: host,
          name,
          remote: true,
          connected,
          onNew: () => {
            setProblems([])
            setEditing(blank(projects[0]?.path ?? '', ''))
          }
        }}
      />
      {editing !== null && (
        <ProfileEditor
          initial={editing}
          projects={[...projects]}
          predict={predict}
          problems={problems}
          saving={saving}
          onSave={(draft) => void save(draft)}
          onCancel={() => setEditing(null)}
          {...('id' in editing
            ? {
                onDelete: () => {
                  void state.remove(editing.id)
                  setEditing(null)
                }
              }
            : {})}
        />
      )}
    </>
  )
}
