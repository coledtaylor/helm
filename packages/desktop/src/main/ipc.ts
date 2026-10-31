import { app, type BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type WebContents } from 'electron'
import { FOREIGN_PAGE, type HelmPage, type PageLinks } from './host/page-link'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { pluginThemeOf, type AppSettings } from '@helm/core'
import type { BrowserHost } from './browser'
import type { BrowserMcpHost } from './browser-mcp'
import type { ConfigService } from './config'
import { localConfigConsole, type ConfigConsoleService } from './config-console'
import type { ContentService } from './content'
import type { FilesService } from './files'
import { localFilesReads, type FilesReads } from './files-reads'
import type { TemplateService } from './templates'
import type { RestoreService } from './restore'
import type { ArchiveService } from './archive'
import type { HistoryService } from './history'
import { localHistoryReads, type HistoryReads } from './history-reads'
import type { UsageService } from './usage'
import { applyWindowTheme } from './chrome'
import type { ThemeService } from './themes'
import type { PtermHost } from './pterm'
import { readClaudeVersion, setClaudeOverride } from './claude-cli'
import { readClaudeStatus } from './setup'
import { checkForUpdate, RELEASES_PAGE } from './update'
import { appMode, dataDir, dbFile } from './paths'
import type { PluginHost } from './plugins/host'
import type { HostPlugins } from './host/plugins'
import { activePty, windowsBuildNumber } from './pty'
import { createLocalProfiles, nativeProfileDialogs, type ProfileService } from './profiles'
import { updateSettings, type Services } from './services'
import { localWorkspace, type WorkspaceService } from './workspace'
import type { SessionHost } from './sessions'
import type { ActivityService } from './activity'
import type { ResourcesService } from './resources'
import type {
  EventChannel,
  EventPayload,
  IpcRequests,
  OwnAppInfo,
  RequestChannel,
  SendChannel,
  SendPayload
} from '../shared/ipc'

/**
 * The main-process half of the contract.
 *
 * `RequestHandlers` is `Record<RequestChannel, ...>`, so leaving a channel
 * unhandled does not compile. Nothing in this process may call `ipcMain.handle`
 * outside `registerIpc` - that is what keeps the surface enumerable.
 */

type RequestHandlers = {
  [K in RequestChannel]: (
    payload: IpcRequests[K]['request'],
    event: Electron.IpcMainInvokeEvent
  ) => IpcRequests[K]['response'] | Promise<IpcRequests[K]['response']>
}

type SendHandlers = {
  [K in SendChannel]: (payload: SendPayload<K>, event: Electron.IpcMainEvent) => void
}

/**
 * Repaints everything the theme reaches that is not the renderer's CSS - the
 * window's own background and the title-bar buttons - and tells the renderer.
 *
 * One function for every cause, because there are four and they must agree: a
 * settings write, Windows changing mode, a theme file saved, and the renderer
 * announcing it is listening. Each of them is "the answer to `state()` may
 * have moved", and nothing about which one it was changes what to paint.
 */
export function pushTheme(ctx: Pick<IpcContext, 'services' | 'themes' | 'window' | 'plugins'>): void {
  const state = ctx.themes.state(ctx.services.settings)
  applyWindowTheme(ctx.window(), state.applied)
  emit(ctx.window(), 'theme:changed', state)
  // Plugin pages follow too: the same colours, and the corner and density
  // settings their controls are drawn with.
  ctx.plugins.pushTheme(pluginThemeOf(state.applied, ctx.services.settings))
}

/** A web contents as the page relay sees it: its id, its two events, and when it navigates away or closes. */
export function helmPageOf(contents: WebContents): HelmPage {
  return {
    id: contents.id,
    send: (channel, payload) => {
      if (!contents.isDestroyed()) contents.send(channel, payload)
    },
    onGone: (listener) => {
      contents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) listener()
      })
      contents.once('destroyed', listener)
    }
  }
}

/** Typed `webContents.send`. The only way the main process pushes to a window. */
export function emit<K extends EventChannel>(
  win: BrowserWindow | null,
  channel: K,
  payload: EventPayload<K>
): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

/**
 * Where history, the transcript archive and usage are read this run: Helm's
 * own services over `helm.db`, or - when sessions run in the local host - the
 * host's, through `HistoryReads`, with none of Helm's own built.
 */
type HistoryWiring =
  | {
      /** Keeps the index over `~/.claude/history.jsonl` current; see `history.ts`. */
      history: HistoryService
      /** Keeps the conversations Claude Code deletes; see `archive.ts`. */
      archive: ArchiveService
      /** Mirrors Claude Code's cached plan-limit figures; see `usage.ts`. */
      usage: UsageService
      historyReads?: undefined
    }
  | {
      /**
       * With sessions in the local host, reads that refuse: the window reads
       * the host's over its own connection (`renderer/src/app/host/history.ts`).
       */
      historyReads: HistoryReads
      history?: undefined
      archive?: undefined
      usage?: undefined
    }

export type IpcContext = IpcContextBase & HistoryWiring

interface IpcContextBase {
  services: Services
  window: () => BrowserWindow | null
  /** Each Helm page's own connection to the local host; see `host/page-link.ts`. */
  pageLinks: PageLinks
  /** Owns the hosted `claude` processes; see `sessions.ts`. */
  sessions: SessionHost
  /**
   * The saved profiles: Helm's own database, or the local host's when sessions
   * run there (`profiles.ts`). Helm's own when absent.
   */
  profiles?: ProfileService | undefined
  /** What a crash took, offered back once; see `restore.ts`. */
  restore: RestoreService
  /** What each of those is doing, from Claude Code's registry. */
  activity: ActivityService
  /** What each of those is holding: process tree and ports. */
  resources: ResourcesService
  /** Owns the project shells; see `pterm.ts`. */
  pterm: PtermHost
  /** Owns the browser pane's `WebContentsView`s; see `browser.ts`. */
  browsers: BrowserHost
  /**
   * Serves those views to the sessions Helm hosts; see `browser-mcp.ts`.
   *
   * Here only so `browserMcp` can take effect at once rather than at the next
   * restart. Nothing on any channel reaches it, and nothing ever should: a
   * renderer that could ask the endpoint for anything would be a page away from
   * a token.
   */
  browserMcp: BrowserMcpHost | null
  /** The one surface that writes to a `.claude` tree; see `config.ts`. */
  config: ConfigService
  /**
   * The config console as the window reaches it: the local host's when
   * sessions run there (`host/config.ts`), and `config` above otherwise.
   */
  configConsole?: ConfigConsoleService | undefined
  /** Reads, renders and searches what Claude writes; see `content.ts`. */
  content: ContentService
  /** The Files view's tree, file reads, Ctrl+P list and watches; see `files.ts`. */
  files: FilesService
  /**
   * What the Files view and the note viewer read, write and watch: the local
   * host's when sessions run there (`host/files.ts`), and `content` and
   * `files` above otherwise. Opening a file in an editor is `files`' either way.
   */
  filesReads?: FilesReads | undefined
  /** Authors what `template:list` reads back; see `templates.ts`. */
  templates: TemplateService
  /**
   * Discovery, scan roots, harnesses, setup, templates and the settings the
   * window reads: the local host's when sessions run there
   * (`host/workspace.ts`), and Helm's own (`localWorkspace`) otherwise.
   */
  workspace?: WorkspaceService | undefined
  /** Built-in and user themes, and the watch on the user's; see `themes.ts`. */
  themes: ThemeService
  /** Plugin folders, their pages' bridge calls, services and secrets; see `plugins/host.ts`. */
  plugins: PluginHost
  /**
   * The plugin registry, settings and secrets Settings acts on, while sessions
   * run in the local host, which keeps them (`host/plugins.ts`); absent
   * otherwise, when `plugins` keeps them. A page's bridge calls stay `plugins`'.
   */
  hostPlugins?: HostPlugins | undefined
  /** Called when the renderer reports it has mounted. */
  rendererReady: () => void
  /**
   * Called when the `claude` path, the terminal shell, the archive's ceiling,
   * either browser tools setting or the session tools setting changes, when
   * sessions run in the local host, which is told all of them. Absent
   * otherwise.
   */
  hostSettingsChanged?: (() => void) | undefined
  /**
   * Stands in for the native file and directory pickers.
   *
   * A native dialog has no automation surface, so the first-run driver - which
   * has to prove that "add a folder" and "locate claude" work end to end -
   * cannot click one. Same reasoning as the session host's `Confirm`: the
   * question is answered by the driver, and every other step still goes through
   * the real handler, the real settings write and the real rescan.
   *
   * Only `--packaging-firstrun` passes these. The app itself passes none and gets the
   * dialogs.
   */
  chooseDirectory?: ((title: string) => string | null) | undefined
  chooseFile?: ((title: string) => string | null) | undefined
  /**
   * A different `.claude` tree for the setup pane to report on. Only
   * `--packaging-firstrun` passes one - it is how "a machine with a fresh `~/.claude`"
   * is simulated without going anywhere near the user's real one.
   */
  claudeHome?: string | undefined
}

/** Where a plugin page's calls and the window's answers for them go. */
export interface PluginPageRoutes {
  call: PluginHost['call']
  cancel: PluginHost['cancel']
  command: (plugin: string, id: string) => void | Promise<void>
  answer: PluginHost['answer']
  session: PluginHost['session']
}

/**
 * A plugin page's calls go to whatever keeps the plugins: the local host's
 * plugins while sessions run there (`host/plugins.ts`), Helm's own registry
 * otherwise, which answers every one itself and asks the host nothing.
 */
export function pluginPages(ctx: Pick<IpcContext, 'plugins' | 'hostPlugins'>): PluginPageRoutes {
  const host = ctx.hostPlugins
  if (host !== undefined) {
    return {
      call: (request, sender) => host.call(request, sender),
      cancel: (callId, sender) => host.cancel(callId, sender),
      command: (plugin, id) => host.command(plugin, id),
      answer: (requestId) => host.answer(requestId),
      session: (answer, sender) => host.session(answer, sender)
    }
  }
  const own = ctx.plugins
  return {
    call: (request, sender) => own.call(request, sender),
    cancel: (callId, sender) => own.cancel(callId, sender),
    command: (plugin, id) => own.command(plugin, id),
    answer: (requestId) => own.answer(requestId),
    session: (answer, sender) => own.session(answer, sender)
  }
}

export function registerIpc(ctx: IpcContext): void {
  const { services } = ctx
  const profileService =
    ctx.profiles ??
    createLocalProfiles(services, nativeProfileDialogs(ctx.window), (channel, payload) =>
      emit(ctx.window(), channel, payload)
    )
  const historyReads: HistoryReads =
    ctx.historyReads !== undefined ? ctx.historyReads : localHistoryReads(services.store, ctx)

  const configConsole: ConfigConsoleService = ctx.configConsole ?? localConfigConsole(ctx.config)
  const filesReads: FilesReads = ctx.filesReads ?? localFilesReads(ctx.content, ctx.files)

  /** The CLI status, always read against the same config directory. */
  const claudeStatus = (picked?: string): ReturnType<typeof readClaudeStatus> =>
    readClaudeStatus({
      claudePath: picked ?? services.settings.claudePath,
      ...(ctx.claudeHome !== undefined ? { configDir: ctx.claudeHome } : {})
    })

  const workspace: WorkspaceService =
    ctx.workspace ??
    localWorkspace({
      services,
      emit: (channel, payload) => emit(ctx.window(), channel, payload),
      claudeStatus,
      templates: ctx.templates
    })

  const profileDialogs = nativeProfileDialogs(ctx.window)

  /** What this build says of itself, wherever sessions run. */
  const ownAppInfo = (): OwnAppInfo => ({
    version: app.getVersion(),
    mode: appMode,
    dataDir,
    dbFile,
    migrations: [...services.store.migrations.applied, ...services.store.migrations.alreadyApplied],
    versions: {
      electron: process.versions['electron'] ?? 'unknown',
      chrome: process.versions['chrome'] ?? 'unknown',
      node: process.versions['node'] ?? 'unknown'
    },
    windowsBuild: windowsBuildNumber() ?? null,
    home: homedir(),
    releasesUrl: RELEASES_PAGE
  })

  /**
   * What follows any write to Helm's settings, from either half: the session
   * host reads the override, not the settings, so a picked CLI written here has
   * to reach it too - otherwise sessions launch from one path and
   * `claude mcp add` from another.
   */
  const settingsWritten = (patch: Partial<AppSettings>, next: AppSettings): void => {
    if (patch.claudePath !== undefined) setClaudeOverride(next.claudePath)
    // Sessions in the local host run the `claude` and open the shell the
    // host was told, and get the browser and session tools and the browser's
    // reach as it was told, and the host holds its archive to the ceiling it
    // was told, so it is told again at once when any of those changes.
    if (
      patch.claudePath !== undefined ||
      patch.terminalShell !== undefined ||
      patch.transcriptArchiveMaxBytes !== undefined ||
      patch.browserMcp !== undefined ||
      patch.browserMcpLocalOnly !== undefined ||
      patch.sessionMcp !== undefined
    ) {
      ctx.hostSettingsChanged?.()
    }
    /*
     * The endpoint follows its own tick, immediately.
     *
     * `browserMcpLocalOnly` is deliberately **not** here: it is read through
     * a function at every tool call, so it takes effect on the next one
     * without anything being told. This one is different because it owns a
     * socket - and an off switch for a listener that only takes effect at the
     * next restart is an off switch somebody would reasonably believe had
     * already worked.
     *
     * Sessions already running keep their tokens until it stops, and stopping
     * revokes them: a session that had the tools loses them mid-task, which
     * is the honest consequence of turning them off and is what the sentence
     * in the pane says.
     *
     * **Several families, one socket**, so the question is whether *anything*
     * is still on rather than whether this one is - a plugin offering tools
     * counts too, which is why the endpoint decides (`sync`). Unticking one
     * family with another still on takes that family's route away - the
     * endpoint reads the settings per request - and leaves the listener up
     * for the rest, which is what makes them independent capabilities rather
     * than one with several switches.
     */
    if (
      (patch.browserMcp !== undefined || patch.sessionMcp !== undefined) &&
      ctx.browserMcp !== null
    ) {
      void ctx.browserMcp.sync()
    }
    if (patch.theme !== undefined) nativeTheme.themeSource = patch.theme
    if (
      patch.theme !== undefined ||
      patch.themeDark !== undefined ||
      patch.themeLight !== undefined ||
      patch.accentColor !== undefined
    ) {
      pushTheme(ctx)
    } else if (patch.cornerRadius !== undefined || patch.density !== undefined) {
      // Shape is not part of the window's theme, but it is part of a plugin's.
      ctx.plugins.pushTheme(pluginThemeOf(ctx.themes.state(next).applied, next))
    }
  }

  const pages = pluginPages(ctx)

  const requests: RequestHandlers = {
    // Only a Helm page's own frame: never a frame inside it, which is where
    // an artifact or a plugin page would be.
    'hostLink:open': (_payload, event) => {
      if (event.senderFrame !== event.sender.mainFrame) return Promise.reject(new Error(FOREIGN_PAGE))
      return ctx.pageLinks.open(helmPageOf(event.sender))
    },

    'app:info': async () => ({ ...ownAppInfo(), claudeVersion: await readClaudeVersion() }),

    'ownApp:info': () => ownAppInfo(),

    'settings:read': () => workspace.settings(),

    'settings:write': async (patch) => {
      const next = await workspace.writeSettings(patch)
      emit(ctx.window(), 'settings:changed', next)
      settingsWritten(patch, next)
      return next
    },

    // With sessions in the local host, the window keeps the host's half of
    // the settings over its own connection and Helm's half here.
    'ownSettings:read': () => services.settings,

    'ownSettings:write': (patch) => {
      const next = updateSettings(services, patch)
      emit(ctx.window(), 'ownSettings:changed', next)
      settingsWritten(patch, next)
      return next
    },

    'profileDialog:confirmDelete': async ({ name }) => ({ confirmed: await profileDialogs.confirmDelete(name) }),

    'profileDialog:export': async ({ fileName, yaml }) => {
      const file = await profileDialogs.chooseExportFile(fileName)
      if (file === null) return { file: null }
      await writeFile(file, yaml, 'utf8')
      return { file }
    },

    'profileDialog:import': async () => {
      const file = await profileDialogs.chooseImportFile()
      if (file === null) return { cancelled: true }
      try {
        return { cancelled: false, fileName: basename(file), yaml: await readFile(file, 'utf8') }
      } catch (error) {
        return { cancelled: false, error: `${basename(file)}: ${(error as Error).message}` }
      }
    },

    'discovery:cached': () => workspace.cached(),

    'discovery:scan': (payload) => workspace.scan(payload?.includeGit ?? true),

    'roots:suggest': () => workspace.suggestRoots(),

    // The picker is the window's own; the folders chosen go wherever the roots
    // are kept.
    'roots:add': async () => {
      const title = 'Add a folder to scan'
      if (ctx.chooseDirectory) {
        const picked = ctx.chooseDirectory(title)
        return picked === null ? (await workspace.settings()).scanRoots : workspace.acceptRoots([picked])
      }
      const win = ctx.window()
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ['openDirectory', 'multiSelections']
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return (await workspace.settings()).scanRoots
      return workspace.acceptRoots(result.filePaths)
    },

    'roots:accept': ({ path }) => workspace.acceptRoots([path]),

    'roots:remove': ({ path }) => workspace.removeRoot(path),

    'setup:status': () => workspace.setupStatus(),

    // The picker is the window's own; the executable chosen is checked, and
    // kept, wherever sessions run.
    'setup:locateClaude': async () => {
      const title = 'Locate the claude executable'
      let picked: string | undefined
      if (ctx.chooseFile) {
        picked = ctx.chooseFile(title) ?? undefined
      } else {
        const win = ctx.window()
        const options: Electron.OpenDialogOptions = {
          title,
          properties: ['openFile'],
          filters:
            process.platform === 'win32'
              ? [
                  { name: 'Programs', extensions: ['exe', 'cmd', 'bat'] },
                  { name: 'All files', extensions: ['*'] }
                ]
              : [{ name: 'All files', extensions: ['*'] }]
        }
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options)
        picked = result.canceled ? undefined : result.filePaths[0]
      }
      return picked === undefined ? workspace.setupStatus() : workspace.locateClaude(picked)
    },

    'setup:complete': () => workspace.completeSetup(),

    'path:chooseDirectory': async ({ title }) => {
      if (ctx.chooseDirectory) return { path: ctx.chooseDirectory(title ?? 'Choose a folder') }
      const win = ctx.window()
      const options: Electron.OpenDialogOptions = {
        title: title ?? 'Choose a folder',
        properties: ['openDirectory', 'createDirectory']
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    },

    'path:chooseFile': async ({ title }) => {
      const heading = title ?? 'Choose a program'
      if (ctx.chooseFile) return { path: ctx.chooseFile(heading) }
      const win = ctx.window()
      const options: Electron.OpenDialogOptions = {
        title: heading,
        properties: ['openFile'],
        filters:
          process.platform === 'win32'
            ? [
                { name: 'Programs', extensions: ['exe', 'cmd', 'bat'] },
                { name: 'All files', extensions: ['*'] }
              ]
            : [{ name: 'All files', extensions: ['*'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    },

    'harness:create': (request) => workspace.createHarness(request),

    'template:list': () => workspace.templates.list(),

    'template:preview': (request) => workspace.templates.preview(request),

    // Authoring. Every one of these writes inside the templates directory and
    // nowhere else; `template:import` is the only one that reads outside it,
    // and reading is all it does - see `assertTemplateWritable`.
    'template:detail': ({ template }) => workspace.templates.detail(template),
    'template:create': (request) => workspace.templates.create(request),
    'template:rename': (request) => workspace.templates.rename(request),
    'template:delete': ({ template }) => workspace.templates.remove(template),
    'template:metadata': (request) => workspace.templates.metadata(request),
    'template:substitute': (request) => workspace.templates.substitute(request),
    'template:import': (request) => workspace.templates.importFiles(request),
    'template:folderPreview': (request) => workspace.templates.folderPreview(request),
    'template:fromFolder': (request) => workspace.templates.fromFolder(request),

    'update:check': () => checkForUpdate(),

    'theme:resolved': () => ctx.themes.state(services.settings).resolved,
    'theme:current': () => ctx.themes.state(services.settings),
    'themes:list': () => ctx.themes.listing(),
    'themes:openFolder': async () => {
      ctx.themes.ensureDir()
      // `openPath` resolves to an error *string* rather than rejecting, and a
      // folder that would not open is worth a sentence rather than nothing.
      const problem = await shell.openPath(ctx.themes.dir)
      if (problem !== '') throw new Error(problem)
    },
    // Not revealed here: the pane asks `shell:showItem` for that, so a check
    // can make a copy without a file manager opening on somebody's desktop.
    'themes:duplicate': ({ id }) => ({ file: ctx.themes.duplicate(id) }),

    'shell:showItem': ({ path }) => {
      shell.showItemInFolder(path)
    },

    // The renderer awaits this one, so a failure to spawn arrives as a rejected
    // promise with a sentence in it rather than a tab that never fills in.
    'session:start': (request) => ctx.sessions.start(request),
    'session:launch': (request) => ctx.sessions.launch(request),
    'session:restorable': () => ctx.restore.offer(),
    'session:restore': (request) => ctx.restore.restore(request),
    'session:close': (request) => ctx.sessions.close(request),
    'session:list': async () => {
      await ctx.sessions.settled()
      return ctx.sessions.list()
    },
    // A read of what main already holds, not a fresh pass: the poller is what
    // decides when the registry is re-read, and a channel that forced a read
    // would let a renderer set the poll rate.
    'session:activity': () => ctx.activity.states(),
    'sessions:overview': () => ctx.activity.overview(),
    // Whatever the last pass produced. Never a fresh enumeration: the pass runs
    // only while something is watching, and a channel that forced one would let
    // a renderer spawn a powershell.exe per invoke. With sessions in the local
    // host, the host's last set once Helm has reached it, or a rejection
    // saying it could not be.
    'sessions:resources': () => ctx.resources.snapshots(),
    'session:rename': (request) => ctx.sessions.rename(request),

    'pterm:open': (request) => ctx.pterm.open(request),
    'pterm:close': ({ id }) => {
      ctx.pterm.close(id)
    },
    'pterm:shells': () => ctx.pterm.detected(),

    // Each write tells the window itself, from wherever the profiles live.
    'profile:list': () => profileService.list(),
    'profile:save': (request) => profileService.save(request),
    'profile:delete': async ({ id }) => ({ deleted: await profileService.remove(id) }),
    'profile:pin': ({ ids }) => profileService.pin(ids),
    'profile:export': ({ id }) => profileService.exportProfile(id),
    'profile:import': () => profileService.importProfile(),

    'profile:launch': (request) => ctx.sessions.launchProfile(request),

    'history:summary': () => historyReads.summary(),
    'history:sessions': (query) => historyReads.sessions(query ?? {}),
    'history:prompts': ({ sessionId }) => historyReads.prompts(sessionId),
    'history:projects': () => historyReads.projects(),
    'history:refresh': () => historyReads.refresh(),
    // The one write in this family. It touches `history_names` and nothing the
    // index owns, so no pass is forced and no other window has to be told: the
    // renderer adopts the row it gets back.
    'history:rename': ({ sessionId, name }) => historyReads.rename(sessionId, name),
    // Awaited by the renderer for the same reason `session:start` is: the
    // reasons a resume cannot happen are sentences, and a tab is the wrong
    // place to learn them.
    'history:resume': (request) => ctx.sessions.resume(request),

    // Read-only, both of them, and there is deliberately no third channel here
    // that captures or deletes anything: what the archive holds is decided by a
    // pass in the main process or the local host, and the ceiling is an
    // ordinary setting.
    'archive:conversation': ({ sessionId }) => historyReads.conversation(sessionId),
    'archive:stats': () => historyReads.archiveStats(),

    // A free function rather than a method on either service: one editor, one
    // highlighter, and nothing about a draft in a box belongs to a scope.
    'editor:highlight': ({ path, source }) => filesReads.highlight(path, source),

    'config:scopes': () => configConsole.scopes(),
    'config:tree': ({ scopePath }) => configConsole.tree(scopePath),
    'config:read': ({ path }) => configConsole.read(path),
    'config:render': ({ path, source }) => configConsole.render(path, source),
    // Every byte Helm writes into a `.claude` tree goes through this one
    // handler, which is what makes "no write without a snapshot" a property of
    // the app rather than of whoever remembered to take one.
    'config:write': (request) => configConsole.write(request),
    'config:snapshots': ({ scopePath, path }) => configConsole.snapshots(scopePath, path),
    'config:snapshot': ({ id }) => configConsole.snapshot(id),
    'config:restore': ({ id, path }) => configConsole.restore(id, path),
    'config:watch': ({ path }) => configConsole.watch(path),

    // The other three things a directory supports. They reach the same
    // snapshot-first path `config:write` does; what is new here is the
    // question, not a second route to the disk.
    'config:create': (request) => configConsole.create(request),
    'config:rename': (request) => configConsole.rename(request),
    'config:delete': (request) => configConsole.remove(request),

    'config:effective': (request) => configConsole.effective(request),

    'config:mcpPreview': (request) => configConsole.mcpPreview(request),
    'config:mcpAdd': (request) => configConsole.mcpAdd(request),
    'config:mcpRemove': (request) => configConsole.mcpRemove(request),
    'config:mcpApprove': (request) => configConsole.mcpApprove(request),
    'config:mcpList': ({ cwd }) => configConsole.mcpList(cwd),

    'config:doctor': () => configConsole.doctor(),

    'usage:read': () => historyReads.usage(),

    'content:scopes': () => filesReads.scopes(),
    'content:document': ({ scopePath, path }) => filesReads.document(scopePath, path),
    'content:render': ({ scopePath, path, source }) => filesReads.render(scopePath, path, source),
    'content:search': ({ scopePath, query }) => filesReads.search(scopePath, query),
    'content:write': (request) => filesReads.write(request),
    'content:snapshots': ({ scopePath, path }) => filesReads.snapshots(scopePath, path),
    'content:restore': ({ id, path }) => filesReads.restore(id, path),
    'content:artifact': ({ scopePath, path }) => filesReads.artifact(scopePath, path),
    'files:dir': ({ root, relPath }) => filesReads.dir(root, relPath),
    'files:status': ({ root }) => filesReads.status(root),
    'files:read': ({ root, path }) => filesReads.read(root, path),
    'files:list': ({ root }) => filesReads.list(root),
    'files:watch': ({ roots }) => filesReads.watch(roots),
    'files:editor': () => ({ name: ctx.files.editor() }),
    'files:openInEditor': ({ path, line }) => ctx.files.openInEditor(path, line),

    'content:wikilink': async ({ scopePath, target, from }) => ({
      path: await filesReads.wikilink(scopePath, target, from)
    }),

    // A link in a note or a terminal is the user's, not Helm's, so it opens
    // where they expect links to open. The scheme check is the whole security
    // of this handler: `shell.openExternal` will happily hand a `file:` URL to
    // the shell, which on Windows is a way to run whatever it points at.
    'shell:openExternal': async ({ url }) => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { opened: false }
      }
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return { opened: false }
      await shell.openExternal(parsed.toString())
      return { opened: true }
    },

    'clipboard:read': () => clipboard.readText(),
    'clipboard:write': (text) => {
      clipboard.writeText(text)
    },

    /*
     * Plugins. Every decision - what a manifest allows, whose secret may go
     * where, what a page may open - is in `main/plugins/`; these delegate.
     */
    'plugins:list': () => ctx.hostPlugins?.list() ?? ctx.plugins.list(),
    'plugins:add': async () => {
      const title = 'Add a plugin folder'
      let path: string | null
      if (ctx.chooseDirectory) path = ctx.chooseDirectory(title)
      else {
        const win = ctx.window()
        const options: Electron.OpenDialogOptions = { title, properties: ['openDirectory'] }
        const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
        path = result.canceled ? null : (result.filePaths[0] ?? null)
      }
      if (path === null) return { path: null, error: null, plugins: await (ctx.hostPlugins?.list() ?? ctx.plugins.list()) }
      return ctx.hostPlugins?.add(path) ?? ctx.plugins.add(path)
    },
    'plugins:remove': ({ path, deleteSecrets }) =>
      ctx.hostPlugins?.remove(path, deleteSecrets) ?? ctx.plugins.remove(path, deleteSecrets),
    'plugins:setEnabled': ({ path, enabled }) =>
      ctx.hostPlugins?.setEnabled(path, enabled) ?? ctx.plugins.setEnabled(path, enabled),
    'plugins:setTools': ({ path, enabled }) => ctx.hostPlugins?.setTools(path, enabled) ?? ctx.plugins.setTools(path, enabled),
    'plugins:reload': ({ path }) => ctx.hostPlugins?.reload(path) ?? ctx.plugins.reload(path),
    'plugins:setSetting': ({ plugin, key, value }) =>
      ctx.hostPlugins?.setSetting(plugin, key, value) ?? ctx.plugins.setSetting(plugin, key, value),
    // The sender is part of the call's name, so two Helm pages relaying calls
    // cannot cancel each other's.
    'plugins:call': (request, event) => pages.call(request, event.sender.id),
    'plugins:session': (answer, event) => pages.session(answer, event.sender.id),
    'plugins:command': ({ plugin, id }) => pages.command(plugin, id),
    'plugins:metrics': () => ctx.hostPlugins?.metrics() ?? ctx.plugins.metrics(),
    'plugins:log': ({ path }) => ctx.hostPlugins?.log(path) ?? ctx.plugins.log(path),
    'plugins:ownSecrets': ({ path }) => ctx.hostPlugins?.ownSecrets(path) ?? ctx.plugins.ownSecrets(path),
    'secrets:list': () => ctx.hostPlugins?.secrets.list() ?? ctx.plugins.secrets.list(),
    'secrets:save': (input) => ctx.hostPlugins?.secrets.save(input) ?? ctx.plugins.secrets.save(input),
    'secrets:remove': ({ key }) => ctx.hostPlugins?.secrets.remove(key) ?? ctx.plugins.secrets.remove(key),

    /*
     * The browser pane. Every handler is a one-line delegation on purpose:
     * every decision behind them - what a typed address means, whether the
     * reach posture allows it, what hiding is - lives in `main/browser.ts` and
     * `@helm/core`, so there is exactly one place either could be got wrong.
     */
    'browser:open': (request) => ctx.browsers.open(request),
    'browser:navigate': ({ id, input }) => ctx.browsers.navigate(id, input),
    'browser:back': ({ id }) => ctx.browsers.back(id),
    'browser:forward': ({ id }) => ctx.browsers.forward(id),
    'browser:reload': ({ id, hard }) => ctx.browsers.reload(id, hard === true),
    'browser:close': ({ id }) => ctx.browsers.close(id),
    'browser:state': ({ id }) => ctx.browsers.states(id),
    'browser:eval': ({ id, source }) => ctx.browsers.evaluate(id, source),
    'browser:devtools': ({ id }) => ctx.browsers.devtools(id),
    'browser:find': ({ id, query, forward }) => ctx.browsers.find(id, query, forward !== false),
    'browser:stopFind': ({ id }) => ctx.browsers.stopFind(id),
    'browser:zoom': ({ id, level }) => ctx.browsers.zoom(id, level),
    'browser:clearStorage': ({ id }) => ctx.browsers.clearStorage(id),
    'browser:console': ({ id }) => ctx.browsers.entries(id),
    'browser:snapshot': ({ id }) => ctx.browsers.snapshot(id),
    'browser:shareTargets': () => ctx.browsers.shareTargets(),
    'browser:share': ({ id, session }) => ctx.browsers.share(id, session)
  }

  const sends: SendHandlers = {
    'renderer:ready': () => ctx.rendererReady(),

    // Bytes pass unread; the relay drops any not from the page that opened the connection.
    'hostLink:send': ({ connection, bytes }, event) => ctx.pageLinks.send(event.sender.id, connection, bytes),
    'hostLink:close': ({ connection }, event) => ctx.pageLinks.close(event.sender.id, connection),

    'pty:input': (data) => {
      activePty()?.pty.write(data)
    },

    'pty:resize': ({ cols, rows }) => {
      try {
        activePty()?.pty.resize(cols, rows)
      } catch {
        // The pty may have exited between the resize event and this call.
      }
    },

    'session:input': ({ id, data }) => ctx.sessions.input(id, data),
    'session:resize': ({ id, cols, rows }) => ctx.sessions.resize(id, cols, rows),
    'session:focus': ({ ids }) => ctx.sessions.setFocus(ids),
    'sessions:watch': ({ watching }) => ctx.resources.watch(watching),

    'pterm:input': ({ id, data }) => ctx.pterm.input(id, data),
    'pterm:resize': ({ id, cols, rows }) => ctx.pterm.resize(id, cols, rows),

    'browser:bounds': (payload) => ctx.browsers.bounds(payload),

    'plugins:cancel': ({ callId }, event) => pages.cancel(callId, event.sender.id),
    'plugins:answer': ({ requestId }) => pages.answer(requestId),
    'plugins:backgroundState': ({ plugin, revision, state, error }) =>
      ctx.hostPlugins !== undefined
        ? ctx.hostPlugins.backgroundState(plugin, revision, state, error)
        : ctx.plugins.backgroundState(plugin, revision, state, error),
    'plugins:toolResult': (outcome, event) => ctx.plugins.toolResult(outcome, event.sender.id),

    // Consumed by one-shot `ipcMain.once` listeners in the spike drivers, which
    // register alongside these. A no-op here keeps the contract exhaustive
    // without stealing the event.
    'term:created': () => undefined,
    'term:resized': () => undefined,
    'probe:res': () => undefined,
    // Same shape: the real listener is the one `sessions.ts` registers at
    // module scope, which is the side holding the promise this answers.
    'session:confirmed': () => undefined
  }

  // The maps above are where the types are checked. Registration itself is
  // uniform, so the payload is `unknown` here by construction - Electron cannot
  // know which channel it is dispatching.
  for (const [channel, handler] of Object.entries(requests) as Array<
    [string, (payload: unknown, event: Electron.IpcMainInvokeEvent) => unknown]
  >) {
    ipcMain.handle(channel, (event, payload: unknown) => handler(payload, event))
  }

  /*
   * A send that throws must not take the process with it.
   *
   * The asymmetry with `handle` above is the whole reason this exists: a
   * request that throws rejects its own promise and reaches the renderer as a
   * failed invoke, while a send has no reply to fail into - so an exception out
   * of one of these handlers is an **uncaught exception in the main process**,
   * and Electron answers that with its own error dialog over the app.
   *
   * That is not hypothetical. `browser:bounds` is sent on every
   * `ResizeObserver` tick of an open browser pane, and a view whose page had
   * closed itself made it throw every time: the dialog came back as fast as it
   * could be dismissed, which is what the bug report described. The fault
   * itself is fixed where it was, in `browser.ts`; this is here because the
   * next one should degrade rather than pop a dialog, and because a fire-and-
   * forget channel is exactly where a fault is least likely to be noticed
   * otherwise. Logged rather than swallowed, so it is still findable.
   */
  for (const [channel, handler] of Object.entries(sends) as Array<
    [string, (payload: unknown, event: Electron.IpcMainEvent) => void]
  >) {
    ipcMain.on(channel, (event, payload: unknown) => {
      try {
        handler(payload, event)
      } catch (err) {
        console.error(`ipc send ${channel} threw:`, err)
      }
    })
  }

  nativeTheme.themeSource = services.settings.theme
  // Windows changing mode only matters to `system`, but `updated` also fires
  // for high-contrast and inverted-colour changes, and re-resolving is cheap.
  nativeTheme.on('updated', () => pushTheme(ctx))
  ctx.themes.onChange(() => {
    emit(ctx.window(), 'themes:changed', ctx.themes.listing())
    // The edited file may be the theme on screen; if it is not, this paints
    // the same values again, which is nothing.
    pushTheme(ctx)
  })
}
