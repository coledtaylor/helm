import { type BrowserWindow, dialog } from 'electron'
import type { Profile } from '@helm/core'
import type {
  EventChannel,
  EventPayload,
  ExportProfileResult,
  ImportProfileResult,
  SaveProfileRequest,
  SaveProfileResult
} from '../shared/ipc'

/**
 * The shape of the profiles as main reaches them, and the dialogs around them.
 *
 * The profiles live in the local host (`host/profiles.ts`), and every reader
 * of profiles in main reads that `ProfileService`. The dialogs are Helm's: the
 * question before a delete, and the save and open pickers.
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
