import { describe, expect, it, vi } from 'vitest'
import type { QuitAnswer } from '../shared/ipc'
import { createQuitGate, nextQuitStep, quitEnds } from './quit'

/** Lets the question's answer reach the gate. */
const settle = (): Promise<void> => new Promise((done) => setImmediate(done))

/**
 * Helm's main window and quit, in Electron's order and wired as index.ts wires
 * them: `app.quit()` runs `before-quit`, which ends every session, and then
 * closes the window; the window's `close` handler asks the gate, and a held
 * close cancels the quit; a window that does close ends the app through
 * `window-all-closed`. `events` is what happened, in order.
 */
function helmWith(running: number, confirm: () => Promise<QuitAnswer> = () => new Promise(() => undefined)) {
  const events: string[] = []
  let sessions = running
  let windowOpen = true
  let quitting = false
  const asked = vi.fn(confirm)

  const gate = createQuitGate({ running: () => sessions, confirm: asked, quit: () => appQuit() })

  function appQuit(): void {
    if (quitting) return
    quitting = true
    events.push('before-quit')
    sessions = 0
    closeWindow()
  }

  function closeWindow(): void {
    if (!windowOpen) return
    if (!gate.allowClose(closeWindow)) {
      events.push('close held')
      quitting = false
      return
    }
    windowOpen = false
    events.push('closed')
    appQuit()
  }

  return {
    gate,
    events,
    asked,
    closeWindow,
    /** `app.quit()` called directly, as the E2E harness's close and a check do. */
    appQuit,
    sessions: () => sessions,
    windowOpen: () => windowOpen
  }
}

/** A question the test answers. */
function question(): { confirm: () => Promise<QuitAnswer>; answer: (choice: QuitAnswer) => void } {
  let answer: (choice: QuitAnswer) => void = () => undefined
  return {
    confirm: () =>
      new Promise<QuitAnswer>((resolve) => {
        answer = resolve
      }),
    answer: (choice) => answer(choice)
  }
}

describe('nextQuitStep', () => {
  it('goes ahead when nothing runs or the user has agreed, asks once, and waits while asking', () => {
    expect(nextQuitStep({ running: 0, agreed: false, asking: false })).toBe('proceed')
    expect(nextQuitStep({ running: 2, agreed: true, asking: false })).toBe('proceed')
    expect(nextQuitStep({ running: 2, agreed: false, asking: false })).toBe('ask')
    expect(nextQuitStep({ running: 2, agreed: false, asking: true })).toBe('wait')
  })
})

describe('quitEnds', () => {
  it('ends the sessions where the host’s setting ends them, unless the user kept them this once', () => {
    expect(quitEnds('end', true)).toBe(true)
    expect(quitEnds('keep', true)).toBe(false)
  })

  it('S13: an End answer never ends the sessions on a host whose setting keeps them', () => {
    expect(quitEnds('end', false)).toBe(false)
    expect(quitEnds('keep', false)).toBe(false)
  })

  it('does what the setting says when nobody was asked', () => {
    expect(quitEnds(null, true)).toBe(true)
    expect(quitEnds(null, false)).toBe(false)
  })
})

describe('the quit gate', () => {
  it('Quit with sessions running asks first, and a cancel ends nothing and leaves Helm open', async () => {
    const { confirm, answer } = question()
    const helm = helmWith(2, confirm)

    helm.gate.requestQuit()
    expect(helm.asked).toHaveBeenCalledTimes(1)
    expect(helm.events).toEqual([])

    answer('cancel')
    await settle()
    expect(helm.events).toEqual([])
    expect(helm.sessions()).toBe(2)
    expect(helm.windowOpen()).toBe(true)
  })

  it('Quit with sessions running quits once on a yes, and the window closes without asking again', async () => {
    const { confirm, answer } = question()
    const helm = helmWith(2, confirm)

    helm.gate.requestQuit()
    answer('end')
    await settle()

    expect(helm.events).toEqual(['before-quit', 'closed'])
    expect(helm.asked).toHaveBeenCalledTimes(1)
    expect(helm.sessions()).toBe(0)
  })

  it('Quit with nothing running quits at once, without asking', () => {
    const helm = helmWith(0)

    helm.gate.requestQuit()

    expect(helm.events).toEqual(['before-quit', 'closed'])
    expect(helm.asked).not.toHaveBeenCalled()
  })

  it('Quit pressed again while the question is on screen does not ask a second time', async () => {
    const { confirm, answer } = question()
    const helm = helmWith(1, confirm)

    helm.gate.requestQuit()
    helm.gate.requestQuit()
    expect(helm.asked).toHaveBeenCalledTimes(1)

    answer('end')
    await settle()
    expect(helm.events).toEqual(['before-quit', 'closed'])
  })

  it('closing the window with sessions running asks once, and on a yes closes and quits without asking again', async () => {
    const { confirm, answer } = question()
    const helm = helmWith(1, confirm)

    helm.closeWindow()
    expect(helm.events).toEqual(['close held'])
    expect(helm.sessions()).toBe(1)

    answer('end')
    await settle()
    expect(helm.events).toEqual(['close held', 'closed', 'before-quit'])
    expect(helm.asked).toHaveBeenCalledTimes(1)
  })

  it('closing the window and answering no keeps the window and its sessions', async () => {
    const { confirm, answer } = question()
    const helm = helmWith(1, confirm)

    helm.closeWindow()
    answer('cancel')
    await settle()

    expect(helm.events).toEqual(['close held'])
    expect(helm.windowOpen()).toBe(true)
    expect(helm.sessions()).toBe(1)
  })

  it('closing the window while the menu’s question is on screen waits for that answer', async () => {
    const { confirm, answer } = question()
    const helm = helmWith(1, confirm)

    helm.gate.requestQuit()
    helm.closeWindow()
    expect(helm.asked).toHaveBeenCalledTimes(1)
    expect(helm.events).toEqual(['close held'])

    answer('end')
    await settle()
    expect(helm.events).toEqual(['close held', 'before-quit', 'closed'])
    expect(helm.asked).toHaveBeenCalledTimes(1)
  })

  it('a quit code starts with app.quit() is not held: before-quit has ended the sessions when the window closes', () => {
    const helm = helmWith(2)

    helm.appQuit()

    expect(helm.events).toEqual(['before-quit', 'closed'])
    expect(helm.asked).not.toHaveBeenCalled()
  })

  it('an updater’s quit-and-install, which closes the window and then quits, asks once', async () => {
    const { confirm, answer } = question()
    const helm = helmWith(1, confirm)

    // Electron's `autoUpdater.quitAndInstall` closes every window first and
    // calls `app.quit()` once they have closed.
    helm.closeWindow()
    answer('end')
    await settle()
    helm.appQuit()

    expect(helm.events).toEqual(['close held', 'closed', 'before-quit'])
    expect(helm.asked).toHaveBeenCalledTimes(1)
  })

  it('Keep running and quit quits once, and the window closes without asking again', async () => {
    const { confirm, answer } = question()
    const helm = helmWith(2, confirm)

    helm.gate.requestQuit()
    answer('keep')
    await settle()

    expect(helm.events).toEqual(['before-quit', 'closed'])
    expect(helm.asked).toHaveBeenCalledTimes(1)
    expect(helm.gate.answer()).toBe('keep')
  })

  it('remembers End and quit for before-quit, and nothing while nobody was asked', async () => {
    const { confirm, answer } = question()
    const helm = helmWith(1, confirm)
    expect(helm.gate.answer()).toBeNull()

    helm.gate.requestQuit()
    expect(helm.gate.answer()).toBeNull()
    answer('end')
    await settle()

    expect(helm.gate.answer()).toBe('end')
  })

  it('Cancel leaves no answer behind, so the next Quit asks again', async () => {
    const { confirm, answer } = question()
    const helm = helmWith(1, confirm)

    helm.gate.requestQuit()
    answer('cancel')
    await settle()
    expect(helm.gate.answer()).toBeNull()

    helm.gate.requestQuit()
    expect(helm.asked).toHaveBeenCalledTimes(2)
  })

  it('a question that cannot be asked is a no, and the next Quit asks again', async () => {
    const helm = helmWith(1, () => Promise.reject(new Error('no window to ask')))

    helm.gate.requestQuit()
    await settle()
    expect(helm.events).toEqual([])
    expect(helm.sessions()).toBe(1)

    helm.gate.requestQuit()
    expect(helm.asked).toHaveBeenCalledTimes(2)
  })
})
