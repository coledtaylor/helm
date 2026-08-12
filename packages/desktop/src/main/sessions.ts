import { type BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { basename } from 'node:path'
import {
  buildResumeArgs,
  finishSession,
  launchRequestFromProfile,
  prepareLaunch,
  readHistorySession,
  readProfile,
  runningSessionNames,
  sanitizeSessionName,
  startSession,
  uniqueSessionName,
  type LaunchedReviewPlan,
  type LaunchPlan,
  type SessionRecord
} from '@helm/core'
import { resolveClaudeCommand } from './claude-cli'
import { emit } from './ipc'
import { shimRoot } from './paths'
import { killAllSessionsSync, killSession, spawnSession, type SessionHandle } from './pty'
import type { Services } from './services'
import type {
  CloseSessionRequest,
  CloseSessionResult,
  LaunchedProfile,
  LaunchProfileRequest,
  ResumedSession,
  ResumeSessionRequest,
  StartSessionRequest
} from '../shared/ipc'

/**
 * The lifecycle of a hosted `claude`, from argv to exit code.
 *
 * Helm supplies the argv, the cwd and the environment and then gets out of the
 * way (SPEC 4.4): nothing here reads the process's output. The only thing this
 * file does with the bytes is forward them to the pane that owns them.
 *
 * It owns two things the renderer cannot: what is actually alive - a tab is a
 * React value and a process is not - and the database row, so a session's exit
 * code and duration survive the window that was watching it.
 */

interface Hosted {
  record: SessionRecord
  handle: SessionHandle
  /**
   * The tab is gone but the process may not be yet. Kept rather than deleted so
   * that the exit still reaches the database: dropping the entry at close time
   * would leave the row claiming to be running until the next launch swept it
   * to `lost`, which is a lie about a session Helm ended on purpose.
   */
  closed: boolean
}

/**
 * Optional taps for the `--sessions-check` driver.
 *
 * The app passes none. They exist because the two things this milestone has to
 * prove that leave no trace anywhere else - what a hosted session printed, and
 * whether an exit was judged worth a notification - are decided here and then
 * forgotten. A driver that asserted on screenshots instead would be asserting
 * on the wrong thing.
 */
export interface SessionObserver {
  onOutput?: (id: number, chunk: string) => void
  /** Called only when a notification was actually shown. */
  onNotified?: (record: SessionRecord) => void
}

/** A question that must be answered before a live session is ended. */
export interface ConfirmRequest {
  kind: 'close-session' | 'quit'
  message: string
  detail: string
  /**
   * What the agreeing button says. Carried on the request rather than derived
   * by each implementation, so the Helm dialog and the native fallback cannot
   * word the same decision two different ways.
   */
  confirmLabel: string
  /** The sessions the answer decides the fate of. */
  sessions: SessionRecord[]
}

/**
 * How the user is asked. Injected rather than called directly so the driver can
 * answer it: a native modal has no automation surface, and a check that leaves
 * one open on screen also leaves it in the way of the app's own shutdown.
 */
export type Confirm = (request: ConfirmRequest) => Promise<boolean>

/**
 * How long main will wait for the renderer to answer before asking the old way.
 *
 * This is not a "the user is taking too long" timer - it is set well past any
 * real reading time, because the only thing it exists to catch is a renderer
 * that will never answer at all. `before-quit` holds the window open on this
 * promise, so without a ceiling a wedged renderer makes Helm unquittable, and
 * an ugly dialog beats an app that cannot be closed. If it does fire while a
 * Helm dialog is still on screen, the native box is what decides; the stale
 * answer arrives later and finds nothing waiting for it.
 */
const CONFIRM_TIMEOUT_MS = 120_000

let nextConfirmId = 1
const pendingConfirms = new Map<number, (agreed: boolean) => void>()

// Module scope, not per host: a second `createSessionHost` in the same process
// would otherwise stack a listener per call. Registered alongside the no-op in
// `ipc.ts`, which keeps the send contract exhaustive without stealing the event.
ipcMain.on('session:confirmed', (_e, { id, agreed }: { id: number; agreed: boolean }) => {
  pendingConfirms.get(id)?.(agreed)
  pendingConfirms.delete(id)
})

/**
 * Ask the renderer, so the question is a Helm island rather than a Win32 box.
 *
 * Falls back to `native` whenever there is no live window to ask - during
 * shutdown, before the first window, or after a renderer has gone. That path is
 * the reason this indirection is allowed to exist at all: main owns process
 * lifetime, and it must never be unable to ask its question.
 */
function rendererConfirm(window: () => BrowserWindow | null, native: Confirm): Confirm {
  return async (request) => {
    const win = window()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return native(request)

    const id = nextConfirmId++
    const answered = await new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingConfirms.delete(id)
        resolve(null)
      }, CONFIRM_TIMEOUT_MS)
      pendingConfirms.set(id, (agreed) => {
        clearTimeout(timer)
        resolve(agreed)
      })
      emit(win, 'session:confirm', {
        id,
        kind: request.kind,
        message: request.message,
        detail: request.detail,
        confirmLabel: request.confirmLabel,
        sessionNames: request.sessions.map((record) => record.name)
      })
    })

    return answered ?? native(request)
  }
}

function nativeConfirm(window: () => BrowserWindow | null): Confirm {
  return async ({ message, detail, confirmLabel }) => {
    const win = window()
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: [confirmLabel, 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message,
      detail
    }
    const { response } =
      win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
    return response === 0
  }
}

export interface SessionHost {
  start: (req: StartSessionRequest) => SessionRecord
  /** Synthesises the profile's overlays, then spawns against them. */
  launchProfile: (req: LaunchProfileRequest) => LaunchedProfile
  /** Reopens a conversation from the history index in a new tab. */
  resume: (req: ResumeSessionRequest) => ResumedSession
  /**
   * Starts a session on a pull request, with a prompt composed by the caller.
   *
   * Takes the whole plan rather than a pull request number, because deciding
   * what the prompt says needs the cache, the settings and possibly a `gh pr
   * checkout` - all of which belong to `pulls.ts`. What this file owns is what
   * it owns for every other launch: turning a plan into argv and a process.
   */
  review: (plan: LaunchedReviewPlan, grid: { cols: number; rows: number }) => SessionRecord
  close: (req: CloseSessionRequest) => Promise<CloseSessionResult>
  /** Sessions this process is hosting, running or exited-but-not-yet-closed. */
  list: () => SessionRecord[]
  input: (id: number, data: string) => void
  resize: (id: number, cols: number, rows: number) => void
  /** The grid the pane last reported, which is what the pty is actually at. */
  grid: (id: number) => { cols: number; rows: number } | null
  /** OS process id, for asserting a session is really gone. */
  pid: (id: number) => number | null
  /** Which pane the user is looking at; decides whether an exit notifies. */
  setFocus: (id: number | null) => void
  runningCount: () => number
  /** Asks about every still-running session at once. True means go ahead. */
  confirmCloseAll: () => Promise<boolean>
  /** Synchronous teardown for app quit. */
  shutdown: () => void
}

export interface SessionHostDeps {
  services: Services
  window: () => BrowserWindow | null
  observer?: SessionObserver | undefined
  /** Defaults to asking the renderer, with the native box behind it. */
  confirm?: Confirm | undefined
}

export function createSessionHost({
  services,
  window,
  observer,
  confirm = rendererConfirm(window, nativeConfirm(window))
}: SessionHostDeps): SessionHost {
  const hosted = new Map<number, Hosted>()
  const grids = new Map<number, { cols: number; rows: number }>()
  let focused: number | null = null

  const isRunning = (h: Hosted): boolean => h.record.status === 'running'
  /** Still alive *and* still in a tab. */
  const running = (): Hosted[] => [...hosted.values()].filter((h) => isRunning(h) && !h.closed)

  function onExit(id: number, exitCode: number): void {
    // The row is the source of truth for the duration - it measures against the
    // clock that wrote `started_at`. `finishSession` returns null if this exit
    // was already recorded, in which case there is nothing to announce.
    const record = finishSession(services.store, id, { exitCode })
    const entry = hosted.get(id)
    if (!record || !entry || entry.closed) {
      // Already recorded, or nobody is watching: there is no pane to tell.
      hosted.delete(id)
      return
    }

    entry.record = record
    emit(window(), 'session:exit', record)
    notifyIfUnwatched(record)
  }

  function notifyIfUnwatched(record: SessionRecord): void {
    const win = window()
    // "Non-focused" is two conditions, not one: a session in a background tab
    // of a focused window is just as unwatched as one in a minimised window.
    const watched = win !== null && !win.isDestroyed() && win.isFocused() && focused === record.id
    if (watched || !Notification.isSupported()) return

    const outcome =
      record.exitCode === 0 ? 'finished' : `exited with code ${String(record.exitCode ?? '?')}`
    const notification = new Notification({
      title: `${record.name} ${outcome}`,
      body: record.cwd
    })
    notification.on('click', () => {
      const target = window()
      if (!target || target.isDestroyed()) return
      if (target.isMinimized()) target.restore()
      target.show()
      target.focus()
      emit(target, 'session:activate', { id: record.id })
    })
    notification.show()
    observer?.onNotified?.(record)
  }

  /**
   * The one path a session is spawned by, whether it came from a project row or
   * from a profile. Both produce a `LaunchPlan` first - the only difference
   * between them is how many flags ended up in it.
   */
  function spawn(
    plan: LaunchPlan,
    grid: { cols: number; rows: number },
    origin: { projectPath?: string | null | undefined; profileId?: number | null | undefined }
  ): SessionRecord {
    const command = resolveClaudeCommand()
    if (!command) {
      throw new Error(
        'Claude Code CLI not found. Install it (or put `claude` on PATH) and restart Helm.'
      )
    }

    const argv = [...command.prefixArgs, ...plan.argv]

    // The row goes in before the spawn so that a session which dies in its
    // first second is still a session that happened, with a reason.
    const record = startSession(services.store, {
      name: plan.name,
      cwd: plan.cwd,
      projectPath: origin.projectPath ?? null,
      profileId: origin.profileId ?? null,
      argv
    })

    let handle: SessionHandle
    try {
      handle = spawnSession({
        id: String(record.id),
        file: command.file,
        args: argv,
        cols: Math.max(grid.cols, 1),
        rows: Math.max(grid.rows, 1),
        cwd: plan.cwd,
        onData: (data) => {
          emit(window(), 'session:data', { id: record.id, data })
          observer?.onOutput?.(record.id, data)
        },
        onExit: (exitCode) => onExit(record.id, exitCode)
      })
    } catch (err) {
      finishSession(services.store, record.id, { exitCode: null })
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`Could not start a session in ${plan.cwd}: ${detail}`, { cause: err })
    }

    hosted.set(record.id, { record, handle, closed: false })
    return record
  }

  return {
    start(req) {
      const base = req.name?.trim() || basename(req.cwd) || 'session'
      const plan = prepareLaunch({
        root: req.cwd,
        name: uniqueSessionName(base, runningSessionNames(services.store)),
        shimRoot
      })
      return spawn(plan, req, { projectPath: req.projectPath })
    },

    launchProfile(req) {
      const profile = readProfile(services.store, req.profileId)
      if (!profile) throw new Error('That profile no longer exists.')

      // Named after the profile, uniqued against what is running: three
      // sessions from one profile is the normal case, and `/resume` shows only
      // the name.
      const name = uniqueSessionName(profile.name, runningSessionNames(services.store))
      const plan = prepareLaunch(launchRequestFromProfile(profile, shimRoot, name))

      // The overlay work happens before the row exists, so a profile pointing
      // at a repo that has been deleted fails here rather than as a session
      // that starts and quietly composes nothing.
      const session = spawn(plan, req, { profileId: profile.id })

      return {
        session,
        profile,
        overlays: plan.overlays.map((shim) => shim.name),
        composedInstructions: plan.memoryFile !== null,
        warnings: plan.warnings
      }
    },

    /**
     * Reopening a conversation `history.jsonl` remembers.
     *
     * Both preconditions are checked here rather than trusted from the
     * renderer. The launcher already refuses to offer a session it knows is
     * reaped, but "knows" is an index that was current a moment ago, and the
     * failure it is guarding against - `claude` printing "No conversation
     * found" into a fresh tab and exiting - is exactly the broken terminal the
     * milestone is about. A sentence the pane can show is better than a tab
     * that dies in front of the user.
     */
    resume(req) {
      const history = readHistorySession(services.store, req.sessionId)
      if (!history) {
        throw new Error('That session is not in the history index any more.')
      }
      if (!history.projectExists) {
        throw new Error(
          `${history.project} is no longer on disk. Claude Code resolves a session id against the working directory, so this conversation cannot be reopened from anywhere else.`
        )
      }
      if (history.transcriptFile === null) {
        throw new Error(
          'Claude Code has removed this conversation’s transcript, so there is nothing left to resume. Its prompts are still in the history.'
        )
      }

      // Helm's own label for the tab, not the session's name - `-n` is not
      // passed, so nothing here reaches the CLI. The opening prompt is what
      // makes a conversation recognisable in a strip of tabs.
      const label = uniqueSessionName(
        sanitizeSessionName(history.firstPrompt) || history.projectName,
        runningSessionNames(services.store)
      )

      const session = spawn(
        {
          cwd: history.project,
          name: label,
          argv: buildResumeArgs(history.sessionId),
          overlays: [],
          memoryFile: null,
          warnings: []
        },
        req,
        { projectPath: history.project }
      )

      return { session, history }
    },

    /**
     * A review is an ordinary session that happens to open with a prompt.
     *
     * Which is the whole design. There is no review mode, no second kind of
     * pty and nothing watching what comes back: `prepareLaunch` puts the prompt
     * where the CLI expects a bare positional (`core/launch/plan.ts` -
     * `buildLaunchArgs`, last), the shared `spawn` starts it, and from that
     * moment it is a tab like any other, which the user can talk to, interrupt
     * or close. Helm never parses a line of it - see SPEC 4.4 and the hard rule
     * in CLAUDE.md.
     *
     * `projectPath` is the repository, so the session appears against the
     * project it reviewed rather than as an orphan.
     */
    review(plan, grid) {
      const repo = plan.slug.split('/')[1] ?? basename(plan.repoPath)
      const launch = prepareLaunch({
        root: plan.repoPath,
        // Named for what it is, and uniqued like every other launch: reviewing
        // two pull requests at once is the normal case.
        name: uniqueSessionName(
          `PR #${String(plan.number)} review - ${repo}`,
          runningSessionNames(services.store)
        ),
        shimRoot,
        openingPrompt: plan.prompt,
        // Null for either of these passes no flag at all, which is what keeps a
        // Helm nobody has configured launching exactly what `claude` would.
        model: plan.model,
        effort: plan.effort
      })
      return spawn(launch, grid, { projectPath: plan.repoPath })
    },

    async close(req) {
      const entry = hosted.get(req.id)
      if (!entry) return { closed: true }

      if (isRunning(entry) && req.force !== true) {
        const agreed = await confirm({
          kind: 'close-session',
          message: `“${entry.record.name}” is still running.`,
          detail: `Closing the tab ends the Claude Code session in ${entry.record.cwd}.`,
          confirmLabel: 'End session',
          sessions: [entry.record]
        })
        if (!agreed) return { closed: false }
        // Re-read: the answer took as long as a person took to give it, and the
        // session may have ended on its own in the meantime.
        if (!hosted.has(req.id)) return { closed: true }
      }

      entry.closed = true
      if (isRunning(entry)) killSession(String(req.id))
      else hosted.delete(req.id)
      if (focused === req.id) focused = null
      return { closed: true }
    },

    list: () => [...hosted.values()].filter((h) => !h.closed).map((h) => h.record),

    input(id, data) {
      hosted.get(id)?.handle.write(data)
    },

    resize(id, cols, rows) {
      const entry = hosted.get(id)
      if (!entry) return
      grids.set(id, { cols, rows })
      entry.handle.resize(cols, rows)
    },

    grid: (id) => grids.get(id) ?? null,

    pid: (id) => hosted.get(id)?.handle.pid ?? null,

    setFocus(id) {
      focused = id
    },

    runningCount: () => running().length,

    async confirmCloseAll() {
      const live = running()
      if (live.length === 0) return true

      return confirm({
        kind: 'quit',
        message:
          live.length === 1
            ? `“${live[0]?.record.name ?? ''}” is still running.`
            : `${String(live.length)} Claude Code sessions are still running.`,
        detail: 'Quitting Helm ends them.',
        confirmLabel: live.length > 1 ? `End ${String(live.length)} sessions` : 'End session',
        sessions: live.map((entry) => entry.record)
      })
    },

    shutdown() {
      // Rows first: once the processes are gone their `onExit` handlers may not
      // get a turn on the event loop before the process image is replaced, and
      // a row left claiming to be running would be reconciled to `lost` at the
      // next launch - which is the wrong answer for a session Helm ended on
      // purpose.
      for (const entry of hosted.values()) {
        if (isRunning(entry)) {
          finishSession(services.store, entry.record.id, { exitCode: entry.handle.exitCode() })
        }
      }
      killAllSessionsSync()
      hosted.clear()
    }
  }
}
