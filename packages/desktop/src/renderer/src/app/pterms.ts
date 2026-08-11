import {
  applyPrefs,
  createTerminal,
  describeTerminal,
  type TerminalHost,
  type TerminalReport
} from '../terminal'
import { helm } from './bridge'
import { onTerminalPrefs, terminalPrefs } from './termprefs'

/**
 * Project shells, owned outside React for the same reason session terminals
 * are (terminals.ts): a terminal is the state, not a rendering of it, and a
 * pane that hides while a session split is open must not take the scrollback
 * with it.
 *
 * Keyed by project path: one shell per project, created the first time its
 * pane mounts and killed when the project's tab closes.
 */

interface ShellPane {
  id: number
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
}

const panes = new Map<string, ShellPane>()

/** Output that arrived between `pterm:open` resolving and the sink attaching. */
const pending = new Map<number, string[]>()
const sinks = new Map<number, (data: string) => void>()

helm.on('pterm:data', ({ id, data }) => {
  const sink = sinks.get(id)
  if (sink) {
    sink(data)
    return
  }
  const buffered = pending.get(id)
  if (buffered) buffered.push(data)
  else pending.set(id, [data])
})

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
 * The shell for `path`, created on first call, re-parented on later ones.
 * Async because the pty has to exist before there is an id to wire.
 */
export async function mountShell(
  path: string,
  container: HTMLElement,
  opts: MountShellOptions
): Promise<MountedShell | null> {
  const existing = panes.get(path.toLowerCase())
  if (existing) {
    if (existing.element.parentElement !== container) {
      container.appendChild(existing.element)
      existing.host.refit()
    }
    return described(existing)
  }

  const opened = await helm.invoke('pterm:open', {
    path,
    cols: opts.cols,
    rows: opts.rows,
    ...(opts.shell != null && opts.shell !== '' ? { shell: opts.shell } : {})
  })
  // Two panes racing for one path (a fast tab close-and-reopen): the second
  // await lands after the first built the pane. Reattach rather than double up.
  const raced = panes.get(path.toLowerCase())
  if (raced) {
    if (raced.element.parentElement !== container) {
      container.appendChild(raced.element)
      raced.host.refit()
    }
    return described(raced)
  }
  if (!container.isConnected) return null

  const element = document.createElement('div')
  element.style.width = '100%'
  element.style.height = '100%'
  container.appendChild(element)

  const id = opened.id
  const host = createTerminal(
    element,
    {
      cols: opts.cols,
      rows: opts.rows,
      fit: true,
      ...(opts.windowsBuild !== null ? { windowsBuild: opts.windowsBuild } : {})
    },
    {
      onInput: (data) => helm.send('pterm:input', { id, data }),
      onResize: (cols, rows) => helm.send('pterm:resize', { id, cols, rows }),
      readClipboard: () => helm.invoke('clipboard:read'),
      writeClipboard: (text) => helm.invoke('clipboard:write', text)
    },
    terminalPrefs()
  )

  const sink = (data: string): void => {
    host.term.write(data)
  }
  sinks.set(id, sink)
  const buffered = pending.get(id)
  if (buffered) {
    pending.delete(id)
    for (const chunk of buffered) sink(chunk)
  }

  const detachExit = helm.on('pterm:exit', (payload) => {
    if (payload.id !== id) return
    host.term.options.cursorBlink = false
    host.term.options.disableStdin = true
    host.term.blur()
  })

  const pane: ShellPane = {
    id,
    shell: opened.shell,
    requested: opened.requested,
    problem: opened.problem,
    host,
    element,
    detachData: () => {
      sinks.delete(id)
      pending.delete(id)
    },
    detachExit
  }
  panes.set(path.toLowerCase(), pane)
  return described(pane)
}

export function getShell(path: string): TerminalHost | undefined {
  return panes.get(path.toLowerCase())?.host
}

/** Kills the shell for good. Called when the project's tab closes. */
export function disposeShell(path: string): Promise<void> {
  const pane = panes.get(path.toLowerCase())
  if (!pane) return Promise.resolve()
  panes.delete(path.toLowerCase())
  pane.detachData()
  pane.detachExit()
  pane.host.dispose()
  pane.element.remove()
  return helm.invoke('pterm:close', { id: pane.id })
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
  await disposeShell(path)
  return mountShell(path, container, opts)
}

/** See `describeTerminal`: a read-only tap for `pnpm settings-check`. */
export function describeShellTerminals(): Array<TerminalReport & { path: string; shell: string }> {
  return [...panes.entries()].map(([path, pane]) => ({
    ...describeTerminal(String(pane.id), pane.host),
    path,
    shell: pane.shell
  }))
}
