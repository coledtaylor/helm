import { app, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { listProfiles } from '@helm/core'
import { findClaudeExecutable } from '../claude-cli'
import { emit } from '../ipc'
import { appMode, dataDir } from '../paths'
import { showExitNotification, type Confirm } from '../sessions'
import type { BrowserMcpHost } from '../browser-mcp'
import type { PluginToolProvider } from '../plugins/tools'
import { nativeProfileDialogs } from '../profiles'
import { knownProject, updateSettings, type Services } from '../services'
import { createBrowserToolRelay, type BrowserToolRelay } from './browser-tools'
import { createHostConfig, type HostConfig } from './config'
import { createHostHistory, type HostHistory } from './history'
import { startLocalHost, type HostChild, type LocalHost } from './launcher'
import { createHostLink, type HostLink } from './link'
import { createPluginToolRelay, type PluginToolRelay } from './plugin-tools'
import { createHostProfiles, type HostProfiles } from './profiles'
import type { HostSettingsPatch } from './protocol'
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
  /** Answers the browser tool calls the host relays from its sessions. */
  browserRelay: BrowserToolRelay
  /** Offers the host Helm's plugin tool servers and answers the calls it relays to them. */
  pluginRelay: PluginToolRelay
  /** Helm's saved profiles, which live in the host while sessions run there. */
  profiles: HostProfiles
  /** Session history, the transcript archive and usage, which the host keeps while sessions run there. */
  history: HostHistory
  /** The config console, which reads and writes the agent's configuration in the host while sessions run there. */
  config: HostConfig
}

export interface DesktopHostDeps {
  services: Services
  window: () => BrowserWindow | null
  confirm: Confirm
  onActivityChange: () => void
  /** Helm's browser tools, which answer the calls; null until they exist. */
  browserTools: () => BrowserMcpHost | null
  /** Helm's plugins offering tools, and a way to call one. */
  plugins: PluginToolProvider
}

/** The checkout an unpackaged build runs from: `out/main` is three folders inside it. */
const repoRoot = (): string => resolve(__dirname, '..', '..', '..', '..')

/** One connection to this run's local host, through a bridge of its own; the host is started when none answers. */
export function connectLocalHost(log: (line: string) => void): Promise<LocalHost> {
  return startLocalHost(
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
  )
}

/**
 * A link to the local host for this run of Helm: its folders inside this run's
 * data directory (`hostEnvironment`), `floti` from where this build carries it,
 * and a host started when none answers.
 */
export function createLocalHostLink(settings: () => HostSettingsPatch, log: (line: string) => void): HostLink {
  return createHostLink({
    start: () => connectLocalHost(log),
    settings,
    log,
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
  })
}

export function createDesktopHost({
  services,
  window,
  confirm,
  onActivityChange,
  browserTools,
  plugins
}: DesktopHostDeps): DesktopHost {
  const log = (line: string): void => console.log(line)
  const link = createLocalHostLink(() => hostSettingsFor(services.settings, findClaudeExecutable()), log)
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
    knownProject: (cwd) => knownProject(services, cwd),
    onActivityChange,
    browserTools: () => services.settings.browserMcp,
    browserIdentityEnded: (key) => browserTools()?.forgetOpener(key),
    log
  })
  const browserRelay = createBrowserToolRelay({
    link,
    opener: (session) => hosted.sessions.browserOpener(session),
    run: (opener, tool, args) => browserTools()?.runBrowserTool(opener, tool, args) ?? null,
    log
  })
  const pluginRelay = createPluginToolRelay({
    link,
    servers: () => plugins.servers(),
    call: (request, signal) => plugins.call(request, signal),
    caller: (session) => hosted.pluginCaller(session),
    log
  })
  const profiles = createHostProfiles({
    link,
    dialogs: nativeProfileDialogs(window),
    emit: send,
    ownProfiles: () => listProfiles(services.store),
    copied: () => services.settings.profilesCopiedToHostAt !== null,
    markCopied: () => {
      updateSettings(services, { profilesCopiedToHostAt: new Date().toISOString() })
    },
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    log
  })
  const history = createHostHistory({ link, emit: send, log })
  const config = createHostConfig({
    link,
    emit: send,
    // Discovery runs in Helm's main process this run, so the sidebar's scan is Helm's own.
    scanned: () => services.lastScan?.projects ?? [],
    log
  })
  const pterm = createHostPtermHost({ link, streams, emit: send, log })
  return { ...hosted, link, streams, pterm, browserRelay, pluginRelay, profiles, history, config }
}
