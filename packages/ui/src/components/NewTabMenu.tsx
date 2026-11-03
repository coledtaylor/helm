import type { JSX } from 'react'
import { useMemo, useRef, useState } from 'react'
import type { Profile, Project } from '@helm/core/types'
import { folderName, homePath, profilesInOrder, rankProjects } from '../lib/launcher'
import { shortcutLabel } from '../lib/platform'
import type { PopupAnchor } from '../lib/popup'
import { PROJECT_KIND_ICON } from '../lib/projectIcons'
import { ConsoleIcon, GlobeIcon, LayersIcon, TerminalIcon } from './icons'
import { Menu, type MenuEntry } from './Menu'
import type { LauncherHost } from './NewSessionDialog'
import { NewSessionPopover, type NewSessionPopoverProps } from './NewSessionPopover'

export interface NewTabMenuProps extends Omit<NewSessionPopoverProps, 'at' | 'anchorRef' | 'hostName'> {
  /** The `+` that was pressed. Everything here hangs from it. */
  anchor: HTMLElement
  /** One click on a profile starts it, in its own folder. */
  onProfile: (profile: Profile) => void
  /** A new, empty browser tab. */
  onBrowser: () => void
  /** A plain terminal in a folder - a shell, no `claude`. */
  onTerminal: (project: Project) => void
  /**
   * The hosts a session, a profile or a terminal can open on, this PC first,
   * while more than one is connected. The menu names the one it opens on
   * (`host`) and offers the others; the folders and profiles it is given are
   * that host's. Absent, it names no host: there is only this PC.
   */
  hosts?: readonly LauncherHost[] | undefined
  /** The id of the host it opens on, one of `hosts`. */
  host?: string | undefined
  /** Another host was chosen: the caller gives that host's folders and profiles instead. */
  onHostChange?: ((host: string) => void) | undefined
}

/** A host entry's id in the first step's list; no kind's id starts so. */
const HOST_ENTRY = 'host:'

type Stage = 'kind' | 'session' | 'profile' | 'terminal'

/**
 * What a pane's `+` opens: first what kind of tab, then whatever that kind
 * needs - all of it hanging from the `+`, the way a browser's new-tab button
 * works, and all of it landing in the pane the `+` belongs to.
 *
 * - **Session** becomes the new-session popover (`NewSessionPopover`).
 * - **Profile session** becomes the list of profiles; one click starts one in
 *   its own folder, which is the launch the Profiles view's rows make.
 * - **Browser tab** opens straight away: an empty page, its address bar taking
 *   the caret.
 * - **Terminal** becomes the list of folders, the pane's own first and then the
 *   ones worked in last; one click opens a plain shell there.
 *
 * Each step replaces the one before rather than stacking beside it, so there is
 * one popup at a time and Escape always means "none of this".
 */
export function NewTabMenu({
  anchor,
  profiles,
  onProfile,
  onBrowser,
  onTerminal,
  onDismiss,
  hosts,
  host,
  onHostChange,
  ...session
}: NewTabMenuProps): JSX.Element {
  const [stage, setStage] = useState<Stage>('kind')
  // Measured once, when it opens. A strip that moves under it closes it anyway:
  // a resize is a dismissal.
  const [at] = useState<PopupAnchor>(() => ({ below: anchor.getBoundingClientRect() }))
  const anchorRef = useRef<HTMLElement | null>(anchor)
  const sorted = useMemo(() => profilesInOrder(profiles), [profiles])
  const { projects, recency, initialPath, home } = session
  const folders = useMemo(() => {
    const ranked = rankProjects(projects, '', recency).map((match) => match.project)
    const own = initialPath?.toLowerCase()
    const first = ranked.find((project) => project.path.toLowerCase() === own)
    return first === undefined ? ranked : [first, ...ranked.filter((project) => project !== first)]
  }, [projects, recency, initialPath])

  const choosing = hosts !== undefined && hosts.length > 1
  const on = choosing ? hosts.find((each) => each.id === host) : undefined

  if (stage === 'session') {
    return (
      <NewSessionPopover
        {...session}
        profiles={profiles}
        at={at}
        anchorRef={anchorRef}
        onDismiss={onDismiss}
        hostName={on?.remote === true ? on.name : undefined}
      />
    )
  }

  if (stage === 'profile') {
    return (
      <Menu
        label="Start a profile"
        at={at}
        anchorRef={anchorRef}
        entries={sorted.map(
          (profile): MenuEntry => ({
            kind: 'item',
            id: String(profile.id),
            label: profile.name,
            icon: <LayersIcon width={13} height={13} />,
            hint: folderName(profile.root)
          })
        )}
        onSelect={(id) => {
          const profile = sorted.find((candidate) => String(candidate.id) === id)
          if (profile !== undefined) onProfile(profile)
        }}
        onDismiss={onDismiss}
      />
    )
  }

  if (stage === 'terminal') {
    return (
      <Menu
        label="Open a terminal in"
        at={at}
        anchorRef={anchorRef}
        entries={folders.map((project): MenuEntry => {
          const Icon = PROJECT_KIND_ICON[project.kind]
          return {
            kind: 'item',
            id: project.path,
            label: project.name,
            icon: <Icon width={13} height={13} />,
            title: homePath(project.path, home)
          }
        })}
        onSelect={(path) => {
          const project = folders.find((candidate) => candidate.path === path)
          if (project !== undefined) onTerminal(project)
        }}
        onDismiss={onDismiss}
      />
    )
  }

  const kinds: MenuEntry[] = [
    {
      kind: 'item',
      id: 'session',
      label: 'Session',
      icon: <TerminalIcon width={13} height={13} />,
      hint: shortcutLabel('N', { separator: ' ' })
    },
    {
      kind: 'item',
      id: 'profile',
      label: 'Profile session',
      icon: <LayersIcon width={13} height={13} />,
      disabled: sorted.length === 0,
      title: sorted.length === 0 ? 'No profiles yet. Make one from Profiles on the rail.' : undefined
    },
    {
      kind: 'item',
      id: 'terminal',
      label: 'Terminal',
      icon: <ConsoleIcon width={13} height={13} />,
      disabled: folders.length === 0,
      title: folders.length === 0 ? 'No folders yet. Add one to scan from the sidebar.' : undefined
    },
    { kind: 'item', id: 'browser', label: 'Browser tab', icon: <GlobeIcon width={13} height={13} /> }
  ]
  // Which host a session, a profile or a terminal opens on, chosen here first
  // while there is more than one; the browser is this PC's whichever is ticked.
  const entries: MenuEntry[] = choosing
    ? [
        { kind: 'heading', id: 'hosts', label: 'Open on' },
        ...hosts.map(
          (each): MenuEntry => ({ kind: 'item', id: `${HOST_ENTRY}${each.id}`, label: each.name, checked: each.id === host })
        ),
        { kind: 'separator', id: 'kinds' },
        ...kinds
      ]
    : kinds

  return (
    <Menu
      label="New tab"
      at={at}
      anchorRef={anchorRef}
      entries={entries}
      // Choosing a kind moves on to its step rather than closing: the menu
      // closes itself only for the one that has no step.
      stayOpen
      onSelect={(id) => {
        if (id.startsWith(HOST_ENTRY)) {
          const chosen = id.slice(HOST_ENTRY.length)
          if (chosen !== host) onHostChange?.(chosen)
        } else if (id === 'browser') {
          onBrowser()
          onDismiss()
        } else {
          setStage(id === 'session' ? 'session' : id === 'terminal' ? 'terminal' : 'profile')
        }
      }}
      onDismiss={onDismiss}
    />
  )
}
