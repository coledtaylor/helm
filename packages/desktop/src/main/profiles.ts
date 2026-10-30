import { type BrowserWindow, dialog } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  createProfile,
  deleteProfile,
  listProfiles,
  profileDraft,
  profileFromYaml,
  profileToYaml,
  readProfile,
  setPinnedProfiles,
  uniqueProfileName,
  updateProfile,
  validateProfile,
  type Profile
} from '@helm/core'
import type { Services } from './services'
import type {
  EventChannel,
  EventPayload,
  ExportProfileResult,
  ImportProfileResult,
  SaveProfileRequest,
  SaveProfileResult
} from '../shared/ipc'

/**
 * Profile CRUD, and the dialogs around it.
 *
 * Where the profiles live is decided once, when Helm starts: in Helm's own
 * database, or - with "Run sessions in the local host" on - in the host
 * (`host/profiles.ts`). Either is a `ProfileService`, and every reader of
 * profiles in main reads the one chosen. The dialogs are Helm's either way:
 * the question before a delete, and the save and open pickers.
 *
 * The store does the persisting and `@helm/core` does the serialising; what is
 * here is what needs a window, plus the rules about what happens when an
 * imported name is already taken.
 */

export interface ProfileService {
  /** The profiles as they are now. */
  list(): Promise<Profile[]>
  /** The same, as last known, for readers that cannot wait: the config console's and Files view's folders. */
  current(): Profile[]
  save(req: SaveProfileRequest): Promise<SaveProfileResult>
  /** Asks first; false when the user declined or the profile is gone. */
  remove(id: number): Promise<boolean>
  pin(ids: number[]): Promise<Profile[]>
  /** Asks where, then writes the profile there. */
  exportProfile(id: number): Promise<ExportProfileResult>
  /** Asks which file, then adds the profile it describes. */
  importProfile(): Promise<ImportProfileResult>
}

/** The questions a profile write asks in Helm's window, wherever the profiles live. */
export interface ProfileDialogs {
  /** Whether the user agrees to delete the profile named `name`. */
  confirmDelete(name: string): Promise<boolean>
  /** Where to export to, starting from `suggested`; null when cancelled. */
  chooseExportFile(suggested: string): Promise<string | null>
  /** Which file to import; null when cancelled. */
  chooseImportFile(): Promise<string | null>
}

export type EmitToWindow = <K extends EventChannel>(channel: K, payload: EventPayload<K>) => void

const PROFILE_FILE_FILTERS = [
  { name: 'Helm profile', extensions: ['yaml', 'yml'] },
  { name: 'All files', extensions: ['*'] }
]

/**
 * The native dialogs, on `window` when it is there.
 *
 * Deleting asks first. A profile is a small thing - a name and some flags -
 * but it is also the one the user assembled by hand in a form, there is no
 * undo, and the affordance that triggers this is a 12-pixel icon in a strip
 * that appears on hover, two icons along from the one that edits. The message
 * offers the export, because that is the answer to "I wanted to keep that".
 */
export function nativeProfileDialogs(window: () => BrowserWindow | null): ProfileDialogs {
  const shown = (): BrowserWindow | null => {
    const win = window()
    return win && !win.isDestroyed() ? win : null
  }
  return {
    async confirmDelete(name) {
      const options: Electron.MessageBoxOptions = {
        type: 'question',
        buttons: ['Delete profile', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Delete “${name}”?`,
        detail:
          'This cannot be undone. Sessions already launched from it keep running, and ' +
          'exporting it first writes a YAML file you can import back.'
      }
      const win = shown()
      const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
      return response === 0
    },

    async chooseExportFile(suggested) {
      const options: Electron.SaveDialogOptions = {
        title: 'Export profile',
        defaultPath: suggested,
        filters: PROFILE_FILE_FILTERS
      }
      const win = shown()
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      return result.canceled || !result.filePath ? null : result.filePath
    },

    async chooseImportFile() {
      const options: Electron.OpenDialogOptions = {
        title: 'Import profile',
        properties: ['openFile'],
        filters: PROFILE_FILE_FILTERS
      }
      const win = shown()
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      const file = result.filePaths[0]
      return result.canceled || file === undefined ? null : file
    }
  }
}

export function profiles(services: Services): Profile[] {
  return listProfiles(services.store)
}

/**
 * Validation before the write, so a bad draft is a list of problems beside the
 * fields rather than an exception the renderer has to turn back into English.
 */
export function saveProfile(services: Services, req: SaveProfileRequest): SaveProfileResult {
  const problems = validateProfile(req.draft)
  if (problems.length > 0) return { profile: null, problems }

  const draft = { ...req.draft, name: req.draft.name.trim() }

  // The name is unique-indexed, which is what makes it addressable in a
  // launcher list. A collision is the user's to resolve, and the message names
  // the profile they collided with.
  const clash = listProfiles(services.store).find(
    (existing) =>
      existing.name.toLowerCase() === draft.name.toLowerCase() && existing.id !== req.id
  )
  if (clash) return { profile: null, problems: [`A profile named “${clash.name}” already exists.`] }

  const profile =
    req.id === undefined || req.id === null
      ? createProfile(services.store, draft)
      : updateProfile(services.store, req.id, draft)

  return profile
    ? { profile, problems: [] }
    : { profile: null, problems: ['That profile no longer exists.'] }
}

export async function removeProfile(services: Services, dialogs: ProfileDialogs, id: number): Promise<boolean> {
  const profile = readProfile(services.store, id)
  if (!profile) return false
  if (!(await dialogs.confirmDelete(profile.name))) return false
  return deleteProfile(services.store, id)
}

export function pinProfiles(services: Services, ids: number[]): Profile[] {
  setPinnedProfiles(services.store, ids)
  return listProfiles(services.store)
}

/** A filename a person would recognise in a folder of them. */
function suggestedFileName(profile: Profile): string {
  const slug =
    profile.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'profile'
  return `${slug}.helm-profile.yaml`
}

export async function exportProfile(
  services: Services,
  dialogs: ProfileDialogs,
  id: number
): Promise<ExportProfileResult> {
  const profile = readProfile(services.store, id)
  if (!profile) throw new Error('That profile no longer exists.')

  const file = await dialogs.chooseExportFile(suggestedFileName(profile))
  if (file === null) return { file: null }

  await writeFile(file, profileToYaml(profileDraft(profile)), 'utf8')
  return { file }
}

export async function importProfile(services: Services, dialogs: ProfileDialogs): Promise<ImportProfileResult> {
  const file = await dialogs.chooseImportFile()
  if (file === null) return { profile: null, cancelled: true }

  let draft
  try {
    draft = profileFromYaml(await readFile(file, 'utf8'))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { profile: null, cancelled: false, error: `${basename(file)}: ${detail}` }
  }

  // Renamed rather than refused or overwritten: importing the same harness's
  // profiles twice is a normal thing to do, and neither losing the import nor
  // silently replacing what is here is what was meant by it.
  const name = uniqueProfileName(services.store, draft.name)
  const profile = createProfile(services.store, { ...draft, name })

  return {
    profile,
    cancelled: false,
    ...(name === draft.name ? {} : { renamedTo: name })
  }
}

/** Profiles in Helm's own database, telling the window after every write that changed something. */
export function createLocalProfiles(services: Services, dialogs: ProfileDialogs, emit: EmitToWindow): ProfileService {
  const changed = (): void => emit('profiles:changed', profiles(services))
  return {
    list: () => Promise.resolve(profiles(services)),
    current: () => profiles(services),
    save(req) {
      const result = saveProfile(services, req)
      if (result.profile) changed()
      return Promise.resolve(result)
    },
    async remove(id) {
      const deleted = await removeProfile(services, dialogs, id)
      if (deleted) changed()
      return deleted
    },
    pin(ids) {
      const next = pinProfiles(services, ids)
      emit('profiles:changed', next)
      return Promise.resolve(next)
    },
    exportProfile: (id) => exportProfile(services, dialogs, id),
    async importProfile() {
      const result = await importProfile(services, dialogs)
      if (result.profile) changed()
      return result
    }
  }
}
