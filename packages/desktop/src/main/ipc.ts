import { app, type BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { isAbsolute, relative } from 'node:path'
import {
  createHarness,
  readArchivedConversation,
  readHistoryProjects,
  readHistoryPrompts,
  readHistorySessions,
  suggestRoots
} from '@helm/core'
import type { ConfigService } from './config'
import type { ContentService } from './content'
import type { ArchiveService } from './archive'
import type { HistoryService } from './history'
import type { PullsService } from './pulls'
import type { UsageService } from './usage'
import { applyTitleBarOverlay } from './chrome'
import type { PtermHost } from './pterm'
import { readClaudeVersion, setClaudeOverride } from './claude-cli'
import { setGhOverride } from './gh-cli'
import { readClaudeStatus, verifyClaudeAt } from './setup'
import { checkForUpdate, RELEASES_PAGE } from './update'
import { appMode, dataDir, dbFile } from './paths'
import { activePty, windowsBuildNumber } from './pty'
import {
  exportProfile,
  importProfile,
  pinProfiles,
  profiles,
  removeProfile,
  saveProfile
} from './profiles'
import { cachedProjects, runScan, updateSettings, type Services } from './services'
import type { SessionHost } from './sessions'
import type {
  EventChannel,
  EventPayload,
  IpcRequests,
  RequestChannel,
  ResolvedTheme,
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

export function resolvedTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
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

export interface IpcContext {
  services: Services
  window: () => BrowserWindow | null
  /** Owns the hosted `claude` processes; see `sessions.ts`. */
  sessions: SessionHost
  /** Owns the project shells; see `pterm.ts`. */
  pterm: PtermHost
  /** Keeps the index over `~/.claude/history.jsonl` current; see `history.ts`. */
  history: HistoryService
  /** Keeps the conversations Claude Code deletes; see `archive.ts`. */
  archive: ArchiveService
  /** Mirrors Claude Code's cached plan-limit figures; see `usage.ts`. */
  usage: UsageService
  /** Sweeps the discovered repositories for open pull requests; see `pulls.ts`. */
  pulls: PullsService
  /** The one surface that writes to a `.claude` tree; see `config.ts`. */
  config: ConfigService
  /** Reads, renders and searches what Claude writes; see `content.ts`. */
  content: ContentService
  /** Called when the renderer reports it has mounted. */
  rendererReady: () => void
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

/**
 * Whether `path` is `root` or sits under it, compared case-insensitively
 * because two spellings of the same Windows directory are the same directory.
 */
function isWithin(root: string, path: string): boolean {
  const within = relative(root, path)
  return within === '' || (!within.startsWith('..') && !isAbsolute(within))
}

export function registerIpc(ctx: IpcContext): void {
  const { services } = ctx

  /** The CLI status, always read against the same config directory. */
  const claudeStatus = (picked?: string): ReturnType<typeof readClaudeStatus> =>
    readClaudeStatus({
      claudePath: picked ?? services.settings.claudePath,
      ...(ctx.claudeHome !== undefined ? { configDir: ctx.claudeHome } : {})
    })

  /** Adds paths that are not already roots, and tells the window. */
  const addRoots = (paths: string[]): string[] => {
    const merged = [...services.settings.scanRoots]
    for (const path of paths) {
      if (!merged.some((existing) => existing.toLowerCase() === path.toLowerCase())) {
        merged.push(path)
      }
    }
    if (merged.length === services.settings.scanRoots.length) return services.settings.scanRoots
    const next = updateSettings(services, { scanRoots: merged })
    emit(ctx.window(), 'settings:changed', next)
    return next.scanRoots
  }

  const requests: RequestHandlers = {
    'app:info': async () => ({
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
      claudeVersion: await readClaudeVersion(),
      windowsBuild: windowsBuildNumber() ?? null,
      releasesUrl: RELEASES_PAGE
    }),

    'settings:read': () => services.settings,

    'settings:write': (patch) => {
      const next = updateSettings(services, patch)
      emit(ctx.window(), 'settings:changed', next)
      // The session host reads the override, not the settings, so a picked CLI
      // written through this channel has to reach it too - otherwise sessions
      // launch from one path and `claude mcp add` from another.
      if (patch.claudePath !== undefined) setClaudeOverride(next.claudePath)
      // The pulls service resolves `gh` through the same module-level override,
      // and holds its own cached answer about which one it is - so a new path
      // has to reach both, and the poller has to be re-armed when the interval
      // moves or a change to it would not take effect until the next restart.
      if (patch.ghPath !== undefined) {
        setGhOverride(next.ghPath)
        ctx.pulls.rearm()
        void ctx.pulls.refresh()
      }
      if (patch.prPollMinutes !== undefined) ctx.pulls.rearm()
      // The snapshot is built in main, so the pane cannot hide or reveal a
      // repository on its own: `republish` repaints from the cache at once, and
      // the fetch behind it is for whatever was just un-ignored - a repository
      // Helm has been skipping has no rows, or has rows from before it was
      // ignored, and either way the sweep is what makes it current.
      if (patch.prIgnoredRepos !== undefined) {
        ctx.pulls.republish()
        void ctx.pulls.refresh()
      }
      if (patch.theme !== undefined) {
        nativeTheme.themeSource = patch.theme
        applyTitleBarOverlay(ctx.window(), resolvedTheme())
        emit(ctx.window(), 'theme:changed', {
          preference: next.theme,
          resolved: resolvedTheme()
        })
      }
      return next
    },

    'discovery:cached': () => cachedProjects(services),

    'discovery:scan': async (payload) => {
      emit(ctx.window(), 'scan:status', { running: true })
      try {
        const result = await runScan(services, { includeGit: payload?.includeGit ?? true })
        emit(ctx.window(), 'discovery:updated', result)
        return result
      } finally {
        emit(ctx.window(), 'scan:status', { running: false })
      }
    },

    'roots:suggest': () => suggestRoots(),

    'roots:add': async () => {
      const title = 'Add a folder to scan'
      if (ctx.chooseDirectory) {
        const picked = ctx.chooseDirectory(title)
        return picked === null ? services.settings.scanRoots : addRoots([picked])
      }
      const win = ctx.window()
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ['openDirectory', 'multiSelections']
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return services.settings.scanRoots
      return addRoots(result.filePaths)
    },

    'roots:accept': ({ path }) => addRoots([path]),

    'roots:remove': ({ path }) => {
      const merged = services.settings.scanRoots.filter(
        (existing) => existing.toLowerCase() !== path.toLowerCase()
      )
      const next = updateSettings(services, { scanRoots: merged })
      emit(ctx.window(), 'settings:changed', next)
      return next.scanRoots
    },

    'setup:status': () => claudeStatus(),

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
      if (picked === undefined) {
        return claudeStatus()
      }

      // Verified before it is saved. A setting that points at the wrong program
      // is a launch failure two screens later with nothing to connect it to.
      const check = await verifyClaudeAt(picked)
      if (!check.ok) {
        const status = await claudeStatus()
        return { ...status, error: check.problem }
      }
      const next = updateSettings(services, { claudePath: picked })
      setClaudeOverride(picked)
      emit(ctx.window(), 'settings:changed', next)
      return claudeStatus(picked)
    },

    'setup:complete': () => {
      const next = updateSettings(services, { firstRunCompletedAt: new Date().toISOString() })
      emit(ctx.window(), 'settings:changed', next)
      return next
    },

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

    'harness:create': async (request) => {
      const result = await createHarness({
        mode: request.mode,
        dir: request.dir,
        ...(request.name !== undefined ? { name: request.name } : {})
      })
      if (result.path === null) {
        return { ...result, roots: services.settings.scanRoots }
      }
      // A harness the launcher cannot see is not one the user created, so the
      // root goes in with it - unless a root already covers it, in which case
      // adding the harness itself would list it twice.
      const covered = services.settings.scanRoots.some((root) =>
        isWithin(root, result.path as string)
      )
      const roots = covered ? services.settings.scanRoots : addRoots([result.path])
      return { ...result, roots }
    },

    'update:check': () => checkForUpdate(),

    'theme:resolved': () => resolvedTheme(),

    'shell:showItem': ({ path }) => {
      shell.showItemInFolder(path)
    },

    // The renderer awaits this one, so a failure to spawn arrives as a rejected
    // promise with a sentence in it rather than a tab that never fills in.
    'session:start': (request) => ctx.sessions.start(request),
    'session:close': (request) => ctx.sessions.close(request),
    'session:list': () => ctx.sessions.list(),
    'session:rename': (request) => ctx.sessions.rename(request),

    'pterm:open': (request) => ctx.pterm.open(request),
    'pterm:close': ({ id }) => {
      ctx.pterm.close(id)
    },
    'pterm:shells': () => ctx.pterm.detected(),

    'profile:list': () => profiles(services),

    'profile:save': (request) => {
      const result = saveProfile(services, request)
      if (result.profile) emit(ctx.window(), 'profiles:changed', profiles(services))
      return result
    },

    'profile:delete': async ({ id }) => {
      const deleted = await removeProfile(services, ctx.window(), id)
      if (deleted) emit(ctx.window(), 'profiles:changed', profiles(services))
      return { deleted }
    },

    'profile:pin': ({ ids }) => {
      const next = pinProfiles(services, ids)
      emit(ctx.window(), 'profiles:changed', next)
      return next
    },

    'profile:export': ({ id }) => exportProfile(services, ctx.window(), id),

    'profile:import': async () => {
      const result = await importProfile(services, ctx.window())
      if (result.profile) emit(ctx.window(), 'profiles:changed', profiles(services))
      return result
    },

    'profile:launch': (request) => ctx.sessions.launchProfile(request),

    'history:summary': () => ctx.history.summary(),
    'history:sessions': (query) => readHistorySessions(services.store, query ?? {}),
    'history:prompts': ({ sessionId }) => readHistoryPrompts(services.store, sessionId),
    'history:projects': () => readHistoryProjects(services.store),
    'history:refresh': () => ctx.history.refresh(),
    // Awaited by the renderer for the same reason `session:start` is: the
    // reasons a resume cannot happen are sentences, and a tab is the wrong
    // place to learn them.
    'history:resume': (request) => ctx.sessions.resume(request),

    // Read-only, both of them, and there is deliberately no third channel here
    // that captures or deletes anything: what the archive holds is decided by a
    // pass in the main process, and the ceiling is an ordinary setting.
    'archive:conversation': ({ sessionId }) => readArchivedConversation(services.store, sessionId),
    'archive:stats': () => ctx.archive.stats(),

    'config:scopes': () => ctx.config.scopes(),
    'config:tree': ({ scopePath }) => ctx.config.tree(scopePath),
    'config:read': ({ path }) => ctx.config.read(path),
    // Every byte Helm writes into a `.claude` tree goes through this one
    // handler, which is what makes "no write without a snapshot" a property of
    // the app rather than of whoever remembered to take one.
    'config:write': (request) => ctx.config.write(request),
    'config:snapshots': ({ scopePath, path }) => ctx.config.snapshots(scopePath, path),
    'config:snapshot': ({ id }) => ctx.config.snapshot(id),
    'config:restore': ({ id, path }) => ctx.config.restore(id, path),
    'config:watch': ({ path }) => {
      ctx.config.watch(path)
    },

    'config:effective': (request) => ctx.config.effective(request),

    'config:mcpPreview': (request) => ctx.config.mcpPreview(request),
    'config:mcpAdd': (request) => ctx.config.mcpAdd(request),
    'config:mcpRemove': (request) => ctx.config.mcpRemove(request),
    'config:mcpApprove': (request) => ctx.config.mcpApprove(request),
    'config:mcpList': ({ cwd }) => ctx.config.mcpList(cwd),

    'config:doctor': () => ctx.config.doctor(),

    // The last reading rather than a fresh read: the service keeps itself
    // current, and a status bar that hit the disk every time it repainted
    // would be the one surface in the app that does.
    'usage:read': () => ctx.usage.snapshot(),

    // The cache, deliberately: this runs no `gh`, so the pane paints on the
    // first frame and whatever the fetch finds arrives as `pr:changed`.
    'pr:snapshot': () => ctx.pulls.snapshot(),
    'pr:refresh': (request) =>
      ctx.pulls.refresh(request?.repoPath !== undefined ? { repoPath: request.repoPath } : {}),
    // Cached unless asked otherwise, and the markdown comes back rendered - the
    // window has no pipeline of its own to run it through.
    'pr:detail': ({ repoPath, number, refresh }) =>
      ctx.pulls.detail({ repoPath, number, ...(refresh === true ? { refresh: true } : {}) }),

    /**
     * The two halves of a review launch, in the order they have to happen.
     *
     * `prepareReview` is where the decisions are: it reads the pull request out
     * of the cache, reads the template and the checkout mode out of settings,
     * runs `gh pr checkout` if that is what was asked for, and renders the
     * prompt. Only then does the session host spawn - so a checkout that was
     * refused is a rejection with a sentence in it rather than a tab that
     * opened onto the wrong revision.
     *
     * Awaited by the renderer for the same reason `session:start` is: the pane
     * has nowhere else to learn that there is no `gh`, or that the tree is
     * dirty, and a tab holding a terminal that never started is worse than no
     * tab.
     */
    'pr:review': async ({ repoPath, number, cols, rows }) => {
      const plan = await ctx.pulls.prepareReview({ repoPath, number })
      const session = await ctx.sessions.review(plan, { cols, rows })
      return {
        session,
        prompt: plan.prompt,
        checkedOut: plan.checkedOut,
        warnings: plan.warnings
      }
    },

    'content:scopes': () => ctx.content.scopes(),
    'content:tree': ({ scopePath, refresh }) => ctx.content.tree(scopePath, refresh ?? false),
    'content:dir': ({ scopePath, relPath }) => ctx.content.dir(scopePath, relPath),
    'content:document': ({ scopePath, path }) => ctx.content.document(scopePath, path),
    'content:render': ({ scopePath, path, source }) => ctx.content.render(scopePath, path, source),
    'content:search': ({ scopePath, query }) => ctx.content.search(scopePath, query),
    'content:write': (request) => ctx.content.write(request),
    'content:snapshots': ({ scopePath, path }) => ctx.content.snapshots(scopePath, path),
    'content:restore': ({ id, path }) => ctx.content.restore(id, path),
    'content:artifact': ({ scopePath, path }) => ctx.content.artifact(scopePath, path),
    'content:wikilink': ({ scopePath, target, from }) => ({
      path: ctx.content.wikilink(scopePath, target, from)
    }),

    // A link in a note is the user's, not Helm's, so it opens where they expect
    // links to open. The scheme check is the whole security of this handler:
    // `shell.openExternal` will happily hand a `file:` URL to the shell, which
    // on Windows is a way to run whatever it points at.
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
    }
  }

  const sends: SendHandlers = {
    'renderer:ready': () => ctx.rendererReady(),

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
    'session:focus': ({ id }) => ctx.sessions.setFocus(id),

    'pterm:input': ({ id, data }) => ctx.pterm.input(id, data),
    'pterm:resize': ({ id, cols, rows }) => ctx.pterm.resize(id, cols, rows),

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

  for (const [channel, handler] of Object.entries(sends) as Array<
    [string, (payload: unknown, event: Electron.IpcMainEvent) => void]
  >) {
    ipcMain.on(channel, (event, payload: unknown) => handler(payload, event))
  }

  nativeTheme.themeSource = services.settings.theme
  nativeTheme.on('updated', () => {
    // The overlay buttons are native chrome, so the theme swap has to be told
    // to them separately - they do not follow the renderer's class.
    applyTitleBarOverlay(ctx.window(), resolvedTheme())
    emit(ctx.window(), 'theme:changed', {
      preference: services.settings.theme,
      resolved: resolvedTheme()
    })
  })
}
