import { app, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { readHistorySession } from '@helm/core'
import { findClaudeExecutable } from '../claude-cli'
import { emit } from '../ipc'
import { appMode, dataDir } from '../paths'
import { showExitNotification, type Confirm } from '../sessions'
import type { Services } from '../services'
import { startLocalHost, type HostChild } from './launcher'
import { createHostLink, type HostLink } from './link'
import { createHostPtermHost } from './pterm'
import { createHostSessions, hostSettingsFor, type Emit, type HostSessions } from './sessions'
import { createTerminalStreams, type TerminalStreams } from './streams'

/**
 * Everything the app needs to run its sessions and terminals in the local
 * host, put together from the parts in this folder with Electron's and Node's
 * own: where Helm's data is, how programs are started, and the window.
 */

export interface DesktopHost extends HostSessions {
  link: HostLink
  streams: TerminalStreams
  pterm: ReturnType<typeof createHostPtermHost>
}

export interface DesktopHostDeps {
  services: Services
  window: () => BrowserWindow | null
  confirm: Confirm
  onActivityChange: () => void
}

/** The checkout an unpackaged build runs from: `out/main` is three folders inside it. */
const repoRoot = (): string => resolve(__dirname, '..', '..', '..', '..')

export function createDesktopHost({ services, window, confirm, onActivityChange }: DesktopHostDeps): DesktopHost {
  const log = (line: string): void => console.log(line)
  const link = createHostLink({
    start: () =>
      startLocalHost(
        {
          appMode,
          dataDir,
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          repoRoot: repoRoot()
        },
        {
          platform: process.platform,
          env: process.env,
          tmpdir,
          exists: existsSync,
          spawn: (command, args, options): HostChild => spawn(command, args, options),
          appVersion: app.getVersion(),
          log,
          setTimeout: (run, ms) => setTimeout(run, ms),
          clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
        }
      ),
    settings: () => hostSettingsFor(services.settings, findClaudeExecutable()),
    log,
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
  })
  const send: Emit = (channel, payload) => emit(window(), channel, payload)
  const streams = createTerminalStreams({
    connection: () => link.current(),
    deliver: (channel, id, data) => send(channel, { id, data }),
    log
  })
  const hosted = createHostSessions({
    link,
    streams,
    emit: send,
    confirm,
    notify: (record) => {
      showExitNotification(window, record)
    },
    windowFocused: () => {
      const win = window()
      return win !== null && !win.isDestroyed() && win.isFocused()
    },
    layout: services.lost.layout,
    history: (sessionId) => readHistorySession(services.store, sessionId),
    onActivityChange,
    log
  })
  const pterm = createHostPtermHost({ link, streams, emit: send, log })
  return { ...hosted, link, streams, pterm }
}
