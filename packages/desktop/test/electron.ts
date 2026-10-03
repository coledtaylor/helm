import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A stand-in for the `electron` module, for main-process integration tests:
 *
 *   vi.mock('electron', async () => (await import('../../test/electron')).electronFake())
 *
 * It covers what the main process's modules touch when they load and what the
 * services under test call. Windows, dialogs and notifications do nothing,
 * and the network is refused, so a test that reaches one by accident fails
 * loudly rather than reaching the real thing.
 */
export function electronFake(): Record<string, unknown> {
  const appRoot = join(tmpdir(), 'helm-electron-fake')
  const noop = (): void => undefined
  return {
    app: {
      isPackaged: false,
      getPath: (name: string) => {
        const dir = join(appRoot, name)
        mkdirSync(dir, { recursive: true })
        return dir
      },
      setPath: noop,
      getVersion: () => '0.0.0-test',
      getName: () => 'Helm',
      on: noop,
      once: noop,
      quit: noop
    },
    ipcMain: { handle: noop, on: noop, removeHandler: noop, removeAllListeners: noop },
    dialog: {
      showMessageBox: () => Promise.resolve({ response: 0, checkboxChecked: false }),
      showMessageBoxSync: () => 0,
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] })
    },
    Notification: class {
      static isSupported(): boolean {
        return false
      }
      on = noop
      show = noop
      close = noop
    },
    nativeTheme: { shouldUseDarkColors: true, themeSource: 'system', on: noop },
    shell: {
      openExternal: () => Promise.resolve(),
      openPath: () => Promise.resolve(''),
      showItemInFolder: noop
    },
    clipboard: { writeText: noop, readText: () => '' },
    net: {
      request: () => {
        throw new Error('electronFake: no network in tests')
      },
      fetch: () => Promise.reject(new Error('electronFake: no network in tests'))
    },
    protocol: { handle: noop, registerSchemesAsPrivileged: noop },
    BrowserWindow: class {
      static getAllWindows(): unknown[] {
        return []
      }
    }
  }
}
