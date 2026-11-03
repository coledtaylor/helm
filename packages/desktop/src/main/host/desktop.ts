import { app, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { listProfiles, readPluginFolders, readPluginSettings } from '@helm/core'
import { parseSums, type FlotiOs, type RemoteHost, type SshConfigHosts } from '@helm/core/types'
import { createClientFolderRemoteAdder, type RemoteHostAdder } from './remote-add'
import { readSshConfigHosts } from './ssh-config'
import { findClaudeExecutable, setClaudeOverride } from '../claude-cli'
import { emit } from '../ipc'
import { appMode, dataDir, templatesDir } from '../paths'
import type { Confirm, QuitConfirm } from '../sessions'
import type { BrowserMcpHost } from '../browser-mcp'
import type { BackgroundHost } from '../plugins/background'
import type { ToolAnswer, ToolCallRequest } from '../plugins/tools'
import { nativeProfileDialogs } from '../profiles'
import { updateSettings, type Services } from '../services'
import { createBrowserToolRelay, type BrowserToolRelay } from './browser-tools'
import { createHostFiles, type HostFiles } from './files'
import {
  flotiBinary,
  openPageBridge,
  startLocalHost,
  type HostChild,
  type HostPlaces,
  type LocalHost,
  type SpawnOptions
} from './launcher'
import { createHostLink, type HostLink } from './link'
import { createOwnDataCopy, type OwnDataCopy } from './own-data'
import { createPageLinks, type PageLinks } from './page-link'
import { doctorHosts, recordDoctorHosts } from './doctor-hosts'
import type { PortForwards } from './forwards'
import { createRemoteHostLinks, type RemoteHostLinks } from './remote'
import { openRemotePageBridge, remoteClientFolder, startRemoteHost } from './remote-launcher'
import { createRemoteInstaller, spawnTransportRun, type RemoteInstaller } from './remote-install'
import { PROTOCOL_VERSION } from './protocol'
import { RELEASES_DOWNLOAD } from '../update'
import type { PluginBackgroundReport, RemoteHostStates } from '../../shared/ipc'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import { createBackgroundNeeds, createRemotePlugins, type RemotePlugins } from './remote-plugins'
import { createPluginToolRelay, type PluginToolRelay } from './plugin-tools'
import { createHostPlugins, type HostPlugins } from './plugins'
import { createHostProfiles, type HostProfiles } from './profiles'
import { createHostResources, type HostResources } from './resources'
import type { HostSettingsPatch } from './protocol'
import { createHostSessions, hostSettingsFor, type Emit, type HostSessions } from './sessions'
import { createHostWorkspace, type HostWorkspace } from './workspace'

/**
 * Everything the app needs to run its sessions and terminals in the local
 * host, put together from the parts in this folder with Electron's and Node's
 * own: where Helm's data is, how programs are started, and the window.
 */

export interface DesktopHost extends HostSessions {
  link: HostLink
  /** Answers the browser tool calls the host relays from its sessions. */
  browserRelay: BrowserToolRelay
  /** Offers the host Helm's plugin tool servers and answers the calls it relays to them. */
  pluginRelay: PluginToolRelay
  /** Helm's saved profiles, which live in the host while sessions run there. */
  profiles: HostProfiles
  /** Plugin folders, switches, settings, secrets and page files, which the host keeps while sessions run there. */
  plugins: HostPlugins
  /** Each remote host's plugins and tool relay, attached to its main link (`remote-plugins.ts`). */
  remotePlugins: RemotePlugins
  /** What the hidden window has reported of every host's background pages, each remote one naming its host. */
  pluginReports(): PluginBackgroundReport[]
  /**
   * Discovery, scan roots, harnesses, setup, templates and the host's half of
   * the settings, which the host keeps while sessions run there.
   */
  workspace: HostWorkspace
  /** The Files view, notes and artifacts, read and written in the host while sessions run there. */
  files: HostFiles
  /** What each hosted session is holding, from the host's processes-and-ports pass. */
  resources: HostResources
  /** What only Helm's own database holds, copied into the host once; its state is the window's notice. */
  ownData: OwnDataCopy
}

export interface DesktopHostDeps {
  services: Services
  window: () => BrowserWindow | null
  confirm: Confirm
  /** The quit question, with Keep running and quit beside End and quit. */
  confirmQuit: QuitConfirm
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
  templatesDir,
  execPath: process.execPath,
  appPath: app.getAppPath()
})

const programs = {
  platform: process.platform,
  env: process.env,
  tmpdir,
  exists: existsSync,
  spawn: (command: string, args: string[], options: SpawnOptions): HostChild =>
    spawn(command, args, options)
}

/**
 * One connection to this run's local host, through a bridge of its own; the
 * host is started when none answers, unless `startHost` is false.
 */
export function connectLocalHost(log: (line: string) => void, startHost = true): Promise<LocalHost> {
  return startLocalHost(
    places(),
    {
      ...programs,
      appVersion: app.getVersion(),
      deviceName: hostname(),
      log,
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
    },
    { startHost }
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
  log: (line: string) => void,
  nextConnection?: () => number
): PageLinks {
  return createPageLinks({
    ...(nextConnection !== undefined ? { nextConnection } : {}),
    inHost: link !== null,
    appVersion: app.getVersion(),
    deviceName: hostname(),
    isHelmPage,
    ready: () =>
      link === null ? Promise.reject(new Error('Sessions do not run in the local host.')) : link.connection(),
    howEnded: () => ({
      planned: link?.endedOnPurpose() ?? false,
      restarts: link?.restartsHost() ?? false
    }),
    openBridge: (data) => openPageBridge(places(), programs, data),
    log
  })
}

/**
 * Helm's links to the hosts on other computers in its `hosts` setting, each
 * through `floti bridge` and that host's own transport, with its own client
 * folder in this run's data directory. Each connection names this device
 * with the computer's name, and the first one to a host pins its key.
 */
export function createDesktopRemoteHosts(options: {
  isHelmPage: (id: number) => boolean
  nextConnection: () => number
  changed: (states: RemoteHostStates) => void
  /** Each host's plugins and tool relay, on its main link. */
  plugins: RemotePlugins
  /** The ports of each host's sessions forwarded to this PC, which close with their sessions. */
  forwards: PortForwards
  log: (line: string) => void
}): RemoteHostLinks {
  const folderOf = (id: string): string => remoteClientFolder(places(), process.platform, id)
  return createRemoteHostLinks({
    start: (host) =>
      startRemoteHost(
        places(),
        { ...programs, appVersion: app.getVersion(), log: options.log },
        {
          folder: folderOf(host.id),
          transport: host.transport,
          floti: host.floti,
          deviceName: hostname()
        }
      ),
    openBridge: (host, data) =>
      openRemotePageBridge(
        places(),
        programs,
        { folder: folderOf(host.id), transport: host.transport, floti: host.floti },
        data
      ),
    // Its device key and the host key it pinned: nothing else is kept there.
    forget: (host) => rm(folderOf(host.id), { recursive: true, force: true }),
    changed: options.changed,
    linked: (host, link) => {
      const plugins = options.plugins.attach(host.id, link)
      const forwards = options.forwards.attach(host.id, link)
      return {
        stop() {
          forwards.stop()
          plugins.stop()
        }
      }
    },
    // What `floti doctor` checks besides this PC's host, recorded where it looks.
    hostsChanged: (hosts) => {
      recordDoctorHosts(places(), programs, doctorHosts(hosts, folderOf)).catch((error: unknown) => {
        options.log(`host: floti doctor was not told this device's hosts (${(error as Error).message})`)
      })
    },
    isHelmPage: options.isHelmPage,
    appVersion: app.getVersion(),
    deviceName: hostname(),
    nextConnection: options.nextConnection,
    log: options.log,
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
  })
}

/**
 * Adding a host on another computer by connecting to it (`remote-add.ts`):
 * its first connection is main's, in the host's own client folder, the same
 * one its link uses after, so the key it pins is the one the link holds the
 * host to. A host not added has that folder removed.
 */
export function createDesktopRemoteAdder(options: {
  hosts: () => readonly RemoteHost[]
  log: (line: string) => void
}): RemoteHostAdder {
  return createClientFolderRemoteAdder({
    places: places(),
    launcher: { ...programs, appVersion: app.getVersion(), log: options.log },
    deviceName: hostname(),
    hosts: options.hosts,
    log: options.log
  })
}

/** The Host names of this PC's `~/.ssh/config`, read from the user's own home folder. */
export function readDesktopSshHosts(): Promise<SshConfigHosts> {
  return readSshConfigHosts(join(homedir(), '.ssh'), homedir())
}

/** A file's SHA-256, read as a stream. */
function sha256OfFile(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .once('error', fail)
      .on('data', (chunk) => hash.update(chunk))
      .once('end', () => done(hash.digest('hex')))
  })
}

/**
 * Installing and updating floti on the hosts this device adds, through each
 * one's own transport (`remote-install.ts`): this build's own floti, the
 * release's SHA-256 list a release build carries beside it
 * (`floti-SHA256SUMS`, absent from a development build), and the install
 * scripts it carries (`install/`, or the checkout's `scripts/install`).
 */
export function createDesktopRemoteInstaller(log: (line: string) => void): RemoteInstaller {
  const at = places()
  const join = (...parts: string[]): string => resolve(...parts)
  const scripts = at.packaged ? join(at.resourcesPath, 'install') : join(at.repoRoot, 'scripts', 'install')
  return createRemoteInstaller({
    run: spawnTransportRun(spawn, process.env),
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    protocol: PROTOCOL_VERSION,
    ownBuild: async () => {
      const path = flotiBinary(at, programs)
      return existsSync(path) ? { path, sha256: await sha256OfFile(path) } : null
    },
    sums: async () => {
      if (!at.packaged) return null
      try {
        return parseSums(await readFile(join(at.resourcesPath, 'floti-SHA256SUMS'), 'utf8'))
      } catch {
        return null
      }
    },
    script: (os: FlotiOs) => readFile(join(scripts, os === 'windows' ? 'install.ps1' : 'install.sh'), 'utf8'),
    releaseBase: (version) => `${RELEASES_DOWNLOAD}/v${version}`,
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
    start: ({ startHost }) => connectLocalHost(log, startHost),
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
  confirmQuit,
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
  const hosted = createHostSessions({
    link,
    emit: toNoWindow,
    confirm,
    confirmQuit,
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
  // One hidden window for every host's background pages: open while any needs it.
  const backgroundNeeds = createBackgroundNeeds(pluginBackground)
  const pluginReports = (): PluginBackgroundReport[] => [...hostPlugins.reports(), ...remotePlugins.reports()]
  // The window lays these over each host's list, which it reads itself.
  const reportsChanged = (): void => send('pluginBackground:changed', pluginReports())
  const hostPlugins: HostPlugins = createHostPlugins({
    link,
    reportsChanged,
    runTool: runPluginTool,
    onToolsChanged: () => pluginRelay.offer(),
    background: backgroundNeeds.forHost(LOCAL_HOST_KEY),
    copyOwn: {
      folders: () => readPluginFolders(services.store),
      settings: (plugin) => readPluginSettings(services.store, plugin),
      copied: () => services.settings.pluginsCopiedToHostAt !== null,
      markCopied: () => {
        updateSettings(services, { pluginsCopiedToHostAt: new Date().toISOString() })
      }
    },
    log
  })
  const remotePlugins = createRemotePlugins({
    runTool: runPluginTool,
    background: backgroundNeeds,
    reportsChanged,
    log
  })
  // Kept for the artifact frames main answers from the host's bytes.
  const files = createHostFiles({ link, emit: toNoWindow, log })
  // Kept for the session tools' detail; the window reads its own.
  const resources = createHostResources({ link, emit: toNoWindow, log })
  // Read from helm.db and sent; the host records that it finished.
  const ownData = createOwnDataCopy({ link, store: services.store, log })
  ownData.onChange((state) => send('ownData:changed', state))
  return {
    ...hosted,
    link,
    browserRelay,
    pluginRelay,
    profiles,
    plugins: hostPlugins,
    remotePlugins,
    pluginReports,
    workspace,
    files,
    resources,
    ownData
  }
}
