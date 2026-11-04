import { type BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { sessionLabel, type SessionRecord } from '@helm/core'
import type { QuitAnswer } from '../../shared/ipc'
import { emit } from '../ipc'
import type { Confirm, ConfirmRequest, QuitConfirm } from './session-host'

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
const pendingConfirms = new Map<number, (answer: QuitAnswer) => void>()

const settleAnswer = (id: number, answer: QuitAnswer): void => {
  pendingConfirms.get(id)?.(answer)
  pendingConfirms.delete(id)
}
// Anything but the three answers is a cancel: nothing ends on a word main does not know.
const takeQuitAnswer = (_e: unknown, { id, answer }: { id: number; answer: QuitAnswer }): void =>
  settleAnswer(id, answer === 'end' || answer === 'keep' ? answer : 'cancel')
let answersRegistered = false

/**
 * Listens for the window's answers to main's quit question, once per process:
 * called by `registerIpc`. The window's own `session:confirm` is the host's,
 * so main's question travels on `windowSessions:quitConfirm` and only its
 * answer is main's.
 */
export function registerConfirmAnswers(): void {
  if (answersRegistered) return
  answersRegistered = true
  ipcMain.on('windowSessions:quitConfirmed', takeQuitAnswer)
}

/** Where main's question goes. */
export type ConfirmChannel = 'windowSessions:quitConfirm'

type Ask = (request: ConfirmRequest) => Promise<QuitAnswer>

/**
 * Ask the renderer, so the question is a Helm island rather than a Win32 box.
 *
 * Falls back to `native` whenever there is no live window to ask - during
 * shutdown, before the first window, or after a renderer has gone. That path is
 * the reason this indirection is allowed to exist at all: main owns process
 * lifetime, and it must never be unable to ask its question.
 */
function rendererAsk(window: () => BrowserWindow | null, native: Ask, channel: ConfirmChannel): Ask {
  return async (request) => {
    const win = window()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return native(request)

    const id = nextConfirmId++
    const answered = await new Promise<QuitAnswer | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingConfirms.delete(id)
        resolve(null)
      }, CONFIRM_TIMEOUT_MS)
      pendingConfirms.set(id, (answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
      emit(win, channel, {
        id,
        kind: request.kind,
        message: request.message,
        detail: request.detail,
        confirmLabel: request.confirmLabel,
        ...(request.keepLabel === undefined ? {} : { keepLabel: request.keepLabel }),
        // What the tab says, not the `-n` name: this dialog is asking about the
        // sessions on screen, and a list naming them something else is a list
        // the user has to translate before answering.
        sessionNames: [...request.sessions.map(sessionLabel), ...(request.otherNames ?? [])]
      })
    })

    return answered ?? native(request)
  }
}

function nativeAsk(window: () => BrowserWindow | null): Ask {
  return async ({ message, detail, confirmLabel, keepLabel }) => {
    const win = window()
    const answers: QuitAnswer[] = keepLabel === undefined ? ['end', 'cancel'] : ['end', 'keep', 'cancel']
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: keepLabel === undefined ? [confirmLabel, 'Cancel'] : [confirmLabel, keepLabel, 'Cancel'],
      defaultId: 0,
      cancelId: answers.length - 1,
      message,
      detail
    }
    const { response } =
      win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
    return answers[response] ?? 'cancel'
  }
}

/**
 * How main asks before a session it closes itself ends. The window's own
 * close question is the host's (`session:confirm` on its connection), so main
 * has no window question of its own here and asks with the native box.
 */
export function sessionConfirm(window: () => BrowserWindow | null): Confirm {
  const ask = nativeAsk(window)
  return async (request) => (await ask(request)) === 'end'
}

/**
 * How Helm asks before it quits with sessions in the local host it would end:
 * in the window on `windowSessions:quitConfirm`, with the native box behind it,
 * and answered End and quit, Keep running and quit, or Cancel.
 */
export function quitConfirm(window: () => BrowserWindow | null): QuitConfirm {
  return rendererAsk(window, nativeAsk(window), 'windowSessions:quitConfirm')
}

/**
 * The OS notification for a session that ended where nobody could see it.
 * Clicking it brings the window forward on that session's tab. False when
 * this OS shows none.
 */
export function showExitNotification(window: () => BrowserWindow | null, record: SessionRecord): boolean {
  if (!Notification.isSupported()) return false
  const outcome = record.exitCode === 0 ? 'finished' : `exited with code ${String(record.exitCode ?? '?')}`
  const notification = new Notification({
    // The tab's label: this notification's job is to send someone back to a
    // tab, so it has to name the one they will be looking for.
    title: `${sessionLabel(record)} ${outcome}`,
    body: record.cwd
  })
  notification.on('click', () => {
    const target = window()
    if (!target || target.isDestroyed()) return
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
    emit(target, 'windowSessions:activate', { id: record.id })
  })
  notification.show()
  return true
}
