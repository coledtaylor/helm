import type { JSX, ReactNode } from 'react'
import { TitleBar } from './TitleBar'

export interface AppShellProps {
  /** The destinations down the left edge. */
  rail: ReactNode
  /** The sidebar island, or nothing while it is hidden. */
  sidebar?: ReactNode | undefined
  children: ReactNode
  statusBar: ReactNode
  /**
   * A strip above the panes for a fact about the machine that the whole window
   * is qualified by - the CLI version guard is the only one so far. Above the
   * panes rather than over one, because a hosted TUI owns its pane and a banner
   * floating on top of it covers the composer.
   */
  banner?: ReactNode | undefined
}

/**
 * The window frame: the title strip, the rail, the sidebar, the panes, and the
 * status strip along the bottom. Nothing here knows what a pane contains.
 *
 * Islands on a canvas (DESIGN.md): the frame paints the canvas and keeps the
 * gutters between the sidebar island, the panes and the window's right edge -
 * `gap-gutter`, which is the pane-gap setting. The rail sits on the canvas
 * with no island of its own, and two pixels from the sidebar rather than a
 * gutter away, so the two read as one control. The panes draw their own island
 * chrome; this component owns only the water between them.
 *
 * `min-h-0` on the scrolling column is load-bearing: a flex child defaults to
 * `min-height: auto`, so a tall pane grows the row instead of scrolling inside
 * it, and the status bar walks off the bottom of the window.
 */
export function AppShell({ rail, sidebar, children, statusBar, banner }: AppShellProps): JSX.Element {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
      <TitleBar />
      <div className="flex min-h-0 flex-1 pr-gutter">
        {rail}
        <div className="flex min-h-0 min-w-0 flex-1 gap-gutter pl-0.5">
          {sidebar}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-gutter">
            {banner}
            <div className="min-h-0 flex-1">{children}</div>
          </main>
        </div>
      </div>
      {statusBar}
    </div>
  )
}
