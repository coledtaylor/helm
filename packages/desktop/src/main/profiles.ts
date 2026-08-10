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
  ExportProfileResult,
  ImportProfileResult,
  SaveProfileRequest,
  SaveProfileResult
} from '../shared/ipc'

/**
 * Profile CRUD, and the two file dialogs around it.
 *
 * The store does the persisting and `@helm/core` does the serialising; what is
 * here is only what needs a window - the native save and open pickers - plus
 * the rules about what happens when an imported name is already taken.
 */

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

/**
 * Deleting asks first.
 *
 * A profile is a small thing - a name and some flags - but it is also the one
 * the user assembled by hand in a form, there is no undo, and the affordance
 * that triggers this is a 12-pixel icon in a strip that appears on hover, two
 * icons along from the one that edits. The message offers the export, because
 * that is the answer to "I wanted to keep that".
 */
export async function removeProfile(
  services: Services,
  win: BrowserWindow | null,
  id: number
): Promise<boolean> {
  const profile = readProfile(services.store, id)
  if (!profile) return false

  const options: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Delete profile', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Delete “${profile.name}”?`,
    detail:
      'This cannot be undone. Sessions already launched from it keep running, and ' +
      'exporting it first writes a YAML file you can import back.'
  }
  const { response } =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
  if (response !== 0) return false

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
  win: BrowserWindow | null,
  id: number
): Promise<ExportProfileResult> {
  const profile = readProfile(services.store, id)
  if (!profile) throw new Error('That profile no longer exists.')

  const options: Electron.SaveDialogOptions = {
    title: 'Export profile',
    defaultPath: suggestedFileName(profile),
    filters: [
      { name: 'Helm profile', extensions: ['yaml', 'yml'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const result =
    win && !win.isDestroyed()
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { file: null }

  await writeFile(result.filePath, profileToYaml(profileDraft(profile)), 'utf8')
  return { file: result.filePath }
}

export async function importProfile(
  services: Services,
  win: BrowserWindow | null
): Promise<ImportProfileResult> {
  const options: Electron.OpenDialogOptions = {
    title: 'Import profile',
    properties: ['openFile'],
    filters: [
      { name: 'Helm profile', extensions: ['yaml', 'yml'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const result =
    win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)

  const file = result.filePaths[0]
  if (result.canceled || file === undefined) return { profile: null, cancelled: true }

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
