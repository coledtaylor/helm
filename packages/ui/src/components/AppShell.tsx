import type { JSX, ReactNode } from 'react'

export interface AppShellProps {
  sidebar: ReactNode
  tabBar: ReactNode
  children: ReactNode
  statusBar: ReactNode
  /**
   * A strip above the tabs for a fact about the machine that the whole window
   * is qualified by - the CLI version guard is the only one so far. Above the
   * tabs rather than over the pane, because a hosted TUI owns the pane and a
   * banner floating on top of it covers the composer.
   */
  banner?: ReactNode | undefined
}

/**
 * The window frame: sidebar on the left, tabs above the pane, status strip
 * along the bottom. Nothing here knows what a tab contains - M2 swaps the pane
 * for a terminal without touching this file.
 *
 * `min-h-0` on the scrolling column is load-bearing: a flex child defaults to
 * `min-height: auto`, so a tall pane grows the row instead of scrolling inside
 * it, and the status bar walks off the bottom of the window.
 */
export function AppShell({
  sidebar,
  tabBar,
  children,
  statusBar,
  banner
}: AppShellProps): JSX.Element {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
      <div className="flex min-h-0 flex-1">
        {sidebar}
        <main className="flex min-w-0 min-h-0 flex-1 flex-col">
          {banner}
          {tabBar}
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </main>
      </div>
      {statusBar}
    </div>
  )
}
