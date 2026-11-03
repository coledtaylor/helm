import {
  applyPrefs,
  createTerminal,
  describeTerminal,
  type TerminalHost,
  type TerminalReport
} from '../terminal'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import { bridgeFor } from './bridge'
import { onTerminalPrefs, terminalPrefs } from './termprefs'

/**
 * Project shells, owned outside React for the same reason session terminals
 * are (terminals.ts): a terminal is the state, not a rendering of it, and a
 * pane that hides while a session split is open must not take the scrollback
 * with it.
 *
 * Keyed by project path: one shell per project, created the first time its
 * pane mounts and killed when the project's tab closes. A terminal tab's shell
 * is keyed by the tab instead (`terminalShellKey`) and opened `separate`, so
 * two of them on one folder are two shells.
 *
 * Each shell runs on a host: this PC's by default, or a host on another
 * computer for its folders there, opened, typed into and closed through that
 * host's own bridge (`bridgeFor`). Two hosts' shells never share a registry
 * key or a stream: a pty id is each host's own.
 */

/** The registry key of a terminal tab's shell. No folder path looks like it. */
export const terminalShellKey = (id: number): string => `terminal:${String(id)}`

interface ShellPane {
  id: number
  /** The host it runs on: `LOCAL_HOST_KEY`, or a host on another computer by id. */
  on: string
  /** The executable actually running, as the main process reported it. */
  shell: string
  /** What was asked for, when that is not what runs. Null when they agree. */
  requested: string | null
  /** Why the requested shell is not the one running. */
  problem: string | null
  host: TerminalHost
  element: HTMLDivElement
  detachData: () => void
  detachExit: () => void
  /** Whether the shell went with the host it ran in, rather than exiting. */
  lost: boolean
}

const panes = new Map<string, ShellPane>()

/**
 * A shell's place in the registry. This PC's paths fold case, as Windows
 * does; a host on another computer's sit behind its id, case kept.
 */
const registryKey = (key: string, host: string): string =>
  host === LOCAL_HOST_KEY ? key.toLowerCase() : `host:${encodeURIComponent(host)}/${key}`

/** One pty's stream: its id is its host's own. */
const streamKey = (host: string, id: number): string => `${host}\u0000${String(id)}`

/** Told whenever a shell is lost, or one is opened or closed in its place. */
const shellListeners = new Set<() => void>()
const shellsChanged = (): void => {
  for (const listener of shellListeners) listener()
}

/** Calls `listener` whenever a shell is lost, opened or closed; returns the unsubscribe. */
export function onShellsChange(listener: () => void): () => void {
  shellListeners.add(listener)
  return () => {
    shellListeners.delete(listener)
  }
}

/**
 * Whether the shell under `key` went with the host it ran in. Its screen
 * stays, with input off, until a new shell is opened in its place
 * (`reopenShell`) or its tab closes.
 */
export function shellLost(key: string, host: string = LOCAL_HOST_KEY): boolean {
  return panes.get(registryKey(key, host))?.lost === true
}

/** Output that arrived between `pterm:open` resolving and the sink attaching. */
const pending = new Map<string, string[]>()
const sinks = new Map<string, (data: string) => void>()

/** The hosts whose shells' output is heard: this PC's from the start, any other from its first shell. */
const heard = new Set<string>()
function hear(host: string): void {
  if (heard.has(host)) return
  heard.add(host)
  bridgeFor(host).on('pterm:data', ({ id, data }) => {
    const at = streamKey(host, id)
    const sink = sinks.get(at)
    if (sink) {
      sink(data)
      return
    }
    const buffered = pending.get(at)
    if (buffered) buffered.push(data)
    else pending.set(at, [data])
  })
}
hear(LOCAL_HOST_KEY)

/** Live font and cursor changes reach an open shell exactly as they reach a
 * session pane; see the same subscription in terminals.ts. */
onTerminalPrefs((prefs) => {
  for (const pane of panes.values()) applyPrefs(pane.host, prefs)
})

export interface MountShellOptions {
  windowsBuild: number | null
  cols: number
  rows: number
  /**
   * Open this pane under a specific executable rather than the default shell.
   * Absent means "whatever `terminalShell` says", which is what every pane does
   * until someone picks otherwise in its header.
   */
  shell?: string | null
  /**
   * The registry key, for a shell that is not the project's own: a terminal
   * tab's (`terminalShellKey`). Absent means the path, and the project shell.
   */
  key?: string
  /** The host the folder is on; this PC's when absent. */
  host?: string
}

/** What a mounted shell turned out to be, for the pane header to caption. */
export interface MountedShell {
  host: TerminalHost
  shell: string
  requested: string | null
  problem: string | null
}

const described = (pane: ShellPane): MountedShell => ({
  host: pane.host,
  shell: pane.shell,
  requested: pane.requested,
  problem: pane.problem
})

/**
 * Park `element` in `container` as its **only** child, refitting if it moved.
 *
 * The word "only" is the whole of this function. A shell outlives every pane
 * that shows it and gets re-parented from one box to the next, which the old
 * `appendChild` did correctly - but a box can also be handed a *different*
 * project, and then appending stacked the new project's terminal underneath the
 * one already there. What that looked like was not two terminals: the island
 * clips, so the pane painted the shell it was given first - a prompt sitting in
 * some previously-visited directory, under a header naming the project on
 * screen - with the rest spilling out of the bottom edge. Every project visited
 * added one.
 *
 * So the eviction is keyed on the container, not on the path. A box holds one
 * shell; whichever shell arrives is it, and the displaced element is left
 * parentless rather than destroyed - its process is still running and its pane
 * re-parents it back the next time that project is shown.
 */
function park(container: HTMLElement, pane: ShellPane): MountedShell {
  const moved = pane.element.parentElement !== container
  if (moved || container.childElementCount > 1) container.replaceChildren(pane.element)
  if (moved) pane.host.refit()
  return described(pane)
}

/**
 * The shell for `path`, created on first call, re-parented on later ones.
 * Async because the pty has to exist before there is an id to wire.
 */
export async function mountShell(
  path: string,
  container: HTMLElement,
  opts: MountShellOptions
): Promise<MountedShell | null> {
  const on = opts.host ?? LOCAL_HOST_KEY
  const bridge = bridgeFor(on)
  const key = registryKey(opts.key ?? path, on)
  const existing = panes.get(key)
  if (existing) return park(container, existing)

  hear(on)
  const opened = await bridge.invoke('pterm:open', {
    path,
    cols: opts.cols,
    rows: opts.rows,
    ...(opts.shell != null && opts.shell !== '' ? { shell: opts.shell } : {}),
    ...(opts.key === undefined ? {} : { separate: true })
  })
  // The pane that asked may be gone by now - a tab closed, or a project
  // switched away from while the pty was opening. Parking into a box React has
  // already dropped would take the shell out of whatever box is on screen.
  if (!container.isConnected) return null
  // Two panes racing for one path (a fast tab close-and-reopen): the second
  // await lands after the first built the pane. Reattach rather than double up.
  const raced = panes.get(key)
  if (raced) return park(container, raced)

  const element = document.createElement('div')
  element.style.width = '100%'
  element.style.height = '100%'
  container.replaceChildren(element)

  const id = opened.id
  const stream = streamKey(on, id)
  const host = createTerminal(
    element,
    {
      cols: opts.cols,
      rows: opts.rows,
      fit: true,
      ...(opts.windowsBuild !== null ? { windowsBuild: opts.windowsBuild } : {})
    },
    {
      onInput: (data) => bridge.send('pterm:input', { id, data }),
      onResize: (cols, rows) => bridge.send('pterm:resize', { id, cols, rows }),
      // The clipboard and the browser are this PC's whichever host the shell runs on.
      readClipboard: () => bridgeFor(LOCAL_HOST_KEY).invoke('clipboard:read'),
      writeClipboard: async (text) => (await bridgeFor(LOCAL_HOST_KEY).invoke('clipboard:write', text)).outcome,
      openLink: (url) => void bridgeFor(LOCAL_HOST_KEY).invoke('shell:openExternal', { url })
    },
    terminalPrefs()
  )

  const sink = (data: string): void => {
    host.term.write(data)
  }
  sinks.set(stream, sink)
  const buffered = pending.get(stream)
  if (buffered) {
    pending.delete(stream)
    for (const chunk of buffered) sink(chunk)
  }

  const detachExit = bridge.on('pterm:exit', (payload) => {
    if (payload.id !== id) return
    host.term.options.cursorBlink = false
    host.term.options.disableStdin = true
    host.term.blur()
    if (payload.lost === true) {
      pane.lost = true
      shellsChanged()
    }
  })

  const pane: ShellPane = {
    id,
    on,
    shell: opened.shell,
    requested: opened.requested,
    problem: opened.problem,
    host,
    element,
    detachData: () => {
      sinks.delete(stream)
      pending.delete(stream)
    },
    detachExit,
    lost: false
  }
  panes.set(key, pane)
  shellsChanged()
  return described(pane)
}

/** A project shell by its path, or a terminal tab's by `terminalShellKey`, on `host` (this PC's by default). */
export function getShell(key: string, host: string = LOCAL_HOST_KEY): TerminalHost | undefined {
  return panes.get(registryKey(key, host))?.host
}

/** Kills the shell for good, on the host it runs on. Called when its project's tab, or its own, closes. */
export function disposeShell(key: string, host: string = LOCAL_HOST_KEY): Promise<void> {
  const at = registryKey(key, host)
  const pane = panes.get(at)
  if (!pane) return Promise.resolve()
  panes.delete(at)
  pane.detachData()
  pane.detachExit()
  pane.host.dispose()
  pane.element.remove()
  shellsChanged()
  return bridgeFor(pane.on).invoke('pterm:close', { id: pane.id })
}

/**
 * Swap one pane's shell for another executable.
 *
 * A shell cannot change what it is running, so this is a kill and a respawn -
 * and the close is awaited rather than fired off, because the main process
 * keys shells by project path and would otherwise hand the reopen the record it
 * is about to drop.
 */
export async function reopenShell(
  path: string,
  container: HTMLElement,
  opts: MountShellOptions
): Promise<MountedShell | null> {
  await disposeShell(opts.key ?? path, opts.host)
  return mountShell(path, container, opts)
}

/** See `describeTerminal`: a read-only tap for the real-window drivers. */
export function describeShellTerminals(): Array<TerminalReport & { path: string; shell: string }> {
  return [...panes.entries()].map(([path, pane]) => ({
    ...describeTerminal(String(pane.id), pane.host),
    path,
    shell: pane.shell
  }))
}
