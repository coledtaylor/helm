import { createTerminal, type TerminalHost } from '../terminal'
import { helm } from './bridge'

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

export interface MountShellOptions {
  windowsBuild: number | null
  cols: number
  rows: number
}

/**
 * The shell for `path`, created on first call, re-parented on later ones.
 * Async because the pty has to exist before there is an id to wire.
 */
export async function mountShell(
  path: string,
  container: HTMLElement,
  opts: MountShellOptions
): Promise<TerminalHost | null> {
  const existing = panes.get(path.toLowerCase())
  if (existing) {
    if (existing.element.parentElement !== container) {
      container.appendChild(existing.element)
      existing.host.refit()
    }
    return existing.host
  }

  const { id } = await helm.invoke('pterm:open', { path, cols: opts.cols, rows: opts.rows })
  // Two panes racing for one path (a fast tab close-and-reopen): the second
  // await lands after the first built the pane. Reattach rather than double up.
  const raced = panes.get(path.toLowerCase())
  if (raced) {
    if (raced.element.parentElement !== container) {
      container.appendChild(raced.element)
      raced.host.refit()
    }
    return raced.host
  }
  if (!container.isConnected) return null

  const element = document.createElement('div')
  element.style.width = '100%'
  element.style.height = '100%'
  container.appendChild(element)

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
    }
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

  panes.set(path.toLowerCase(), {
    id,
    host,
    element,
    detachData: () => {
      sinks.delete(id)
      pending.delete(id)
    },
    detachExit
  })
  return host
}

export function getShell(path: string): TerminalHost | undefined {
  return panes.get(path.toLowerCase())?.host
}

/** Kills the shell for good. Called when the project's tab closes. */
export function disposeShell(path: string): void {
  const pane = panes.get(path.toLowerCase())
  if (!pane) return
  panes.delete(path.toLowerCase())
  pane.detachData()
  pane.detachExit()
  pane.host.dispose()
  pane.element.remove()
  void helm.invoke('pterm:close', { id: pane.id })
}
