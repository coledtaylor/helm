import { app, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { listProfiles, readPluginFolders, readPluginSettings } from '@helm/core'
import { findClaudeExecutable, setClaudeOverride } from '../claude-cli'
import { emit } from '../ipc'
import { appMode, dataDir, templatesDir } from '../paths'
import type { Confirm } from '../sessions'
import type { BrowserMcpHost } from '../browser-mcp'
import type { BackgroundHost } from '../plugins/background'
import type { ToolAnswer, ToolCallRequest } from '../plugins/tools'
import { nativeProfileDialogs } from '../profiles'
import { updateSettings, type Services } from '../services'
import { createBrowserToolRelay, type BrowserToolRelay } from './browser-tools'
import { createHostConfig, type HostConfig } from './config'
import { createHostFiles, type HostFiles } from './files'
import { openPageBridge, startLocalHost, type HostChild, type HostPlaces, type LocalHost, type SpawnOptions } from './launcher'
import { createHostLink, type HostLink } from './link'
import { createPageLinks, type PageLinks } from './page-link'
import { createPluginToolRelay, type PluginToolRelay } from './plugin-tools'
import { createHostPlugins, type HostPlugins } from './plugins'
import { createHostProfiles, type HostProfiles } from './profiles'
import { createHostResources, type HostResources } from './resources'
import type { HostSettingsPatch } from './protocol'
import { createHostPtermHost } from './pterm'
import { createHostSessions, hostSettingsFor, type Emit, type HostSessions } from './sessions'
import { createTerminalStreams, type TerminalStreams } from './streams'
import { createHostWorkspace, type HostWorkspace } from './workspace'

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
  /** Plugin folders, switches, settings, secrets and page files, which the host keeps while sessions run there. */
  plugins: HostPlugins
  /** The config console, which reads and writes the agent's configuration in the host while sessions run there. */
  config: HostConfig
  /**
   * Discovery, scan roots, harnesses, setup, templates and the host's half of
   * the settings, which the host keeps while sessions run there.
   */
  workspace: HostWorkspace
  /** The Files view, notes and artifacts, read and written in the host while sessions run there. */
  files: HostFiles
  /** What each hosted session is holding, from the host's processes-and-ports pass. */
  resources: HostResources
}

export interface DesktopHostDeps {
  services: Services
  window: () => BrowserWindow | null
  confirm: Confirm
  onActivityChange: () => void
  /** Helm's browser tools, which answer the calls; null until they exist. */
  browserTools: () => BrowserMcpHost | null
  /** Hands a session's call to a plugin's tool to its background page, in the background host. */
  runPluginTool: (request: ToolCallRequest, signal: AbortSignal) => Promise<ToolAnswer>
  /** The hidden window plugins' background pages run in, which the host's list opens and closes. */
  pluginBackground: BackgroundHost
}

/** The checkout an unpackaged build runs from: `out/main` is three folders inside it. */
const repoRoot = (): string => resolve(__dirname, '..', '..', '..', '..')

/** Where this run's data is and where its `floti` is found. */
const places = (): HostPlaces => ({
  appMode,
  dataDir,
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  repoRoot: repoRoot(),
  templatesDir
})

const programs = {
  platform: process.platform,
  env: process.env,
  tmpdir,
  exists: existsSync,
  spawn: (command: string, args: string[], options: SpawnOptions): HostChild =>
    spawn(command, args, options)
}

/** One connection to this run's local host, through a bridge of its own; the host is started when none answers. */
export function connectLocalHost(log: (line: string) => void): Promise<LocalHost> {
  return startLocalHost(
    places(),
    {
      ...programs,
      appVersion: app.getVersion(),
      log,
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
    }
  )
}

/**
 * Each Helm page's own connection to the local host: with sessions in the
 * host, a bridge per page once main's own `link` has connected; without, an
 * answer saying so and nothing opened.
 */
export function createLocalPageLinks(
  link: HostLink | null,
  isHelmPage: (id: number) => boolean,
  log: (line: string) => void
): PageLinks {
  return createPageLinks({
    inHost: link !== null,
    appVersion: app.getVersion(),
    isHelmPage,
    ready: () => (link === null ? Promise.reject(new Error('Sessions do not run in the local host.')) : link.connection()),
    openBridge: (data) => openPageBridge(places(), programs, data),
    log
  })
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
  runPluginTool,
  pluginBackground
}: DesktopHostDeps): DesktopHost {
  const log = (line: string): void => console.log(line)
  const link = createLocalHostLink(() => hostSettingsFor(services.settings, findClaudeExecutable()), log)
  const send: Emit = (channel, payload) => emit(window(), channel, payload)
  // The window hears discovery, the settings and profiles over its own
  // connection (`renderer/src/app/host`); main keeps the host's scan and
  // profiles for its own readers and copies Helm's into a new host.
  const toNoWindow: Emit = () => undefined
  const workspace = createHostWorkspace({
    link,
    emit: toNoWindow,
    own: () => services.settings,
    writeOwn: (patch) => updateSettings(services, patch),
    claudePicked: (path) => {
      updateSettings(services, { claudePath: path })
      setClaudeOverride(path)
    },
    log
  })
  // The window carries its own terminals, hears its sessions' exits and the
  // host's notifications, and asks its own questions over its own connection;
  // main keeps the running count its quit asks about, the browser tools'
  // identities and the plugins' sessions.
  const streams = createTerminalStreams({
    connection: () => link.current(),
    deliver: () => undefined,
    log
  })
  const hosted = createHostSessions({
    link,
    emit: toNoWindow,
    confirm,
    windowFocused: () => false,
    relist: true,
    layout: services.lost.layout,
    knownProject: (cwd) => workspace.knownProject(cwd),
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
  // The host's list says which plugins offer tools; their background pages answer.
  const pluginRelay: PluginToolRelay = createPluginToolRelay({
    link,
    servers: () => hostPlugins.toolServers(),
    call: (request, signal) => hostPlugins.callTool(request, signal),
    log
  })
  const profiles = createHostProfiles({
    link,
    dialogs: nativeProfileDialogs(window),
    emit: toNoWindow,
    ownProfiles: () => listProfiles(services.store),
    copied: () => services.settings.profilesCopiedToHostAt !== null,
    markCopied: () => {
      updateSettings(services, { profilesCopiedToHostAt: new Date().toISOString() })
    },
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    log
  })
  const hostPlugins: HostPlugins = createHostPlugins({
    link,
    // The window lays these over the host's list, which it reads itself.
    reportsChanged: (reports) => send('pluginBackground:changed', reports),
    runTool: runPluginTool,
    onToolsChanged: () => pluginRelay.offer(),
    background: pluginBackground,
    ownFolders: () => readPluginFolders(services.store),
    ownSettings: (plugin) => readPluginSettings(services.store, plugin),
    copied: () => services.settings.pluginsCopiedToHostAt !== null,
    markCopied: () => {
      updateSettings(services, { pluginsCopiedToHostAt: new Date().toISOString() })
    },
    log
  })
  const config = createHostConfig({
    link,
    emit: toNoWindow,
    // The sidebar's harnesses and projects are the host's scan.
    scanned: () => workspace.lastScan()?.projects ?? [],
    log
  })
  // Kept for the artifact frames main answers from the host's bytes.
  const files = createHostFiles({ link, emit: toNoWindow, log })
  // Kept for the session tools' detail; the window reads its own.
  const resources = createHostResources({ link, emit: toNoWindow, log })
  const pterm = createHostPtermHost({ link, streams, emit: toNoWindow, log })
  return {
    ...hosted,
    link,
    streams,
    pterm,
    browserRelay,
    pluginRelay,
    profiles,
    plugins: hostPlugins,
    config,
    workspace,
    files,
    resources
  }
}
