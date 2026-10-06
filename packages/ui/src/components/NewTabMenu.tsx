import type { JSX } from 'react'
import { useMemo, useRef, useState } from 'react'
import type { Profile, Project } from '@helm/core/types'
import { folderName, homePath, profilesInOrder, rankProjects } from '../lib/launcher'
import type { PopupAnchor } from '../lib/popup'
import { PROJECT_KIND_ICON } from '../lib/projectIcons'
import { ConsoleIcon, GlobeIcon, LayersIcon, TerminalIcon } from './icons'
import { Menu, type MenuEntry } from './Menu'
import { NewSessionPopover, type NewSessionPopoverProps } from './NewSessionPopover'

export interface NewTabMenuProps extends Omit<NewSessionPopoverProps, 'at' | 'anchorRef'> {
  /** The `+` that was pressed. Everything here hangs from it. */
  anchor: HTMLElement
  /** One click on a profile starts it, in its own folder. */
  onProfile: (profile: Profile) => void
  /** A new, empty browser tab. */
  onBrowser: () => void
  /** A plain terminal in a folder - a shell, no `claude`. */
  onTerminal: (project: Project) => void
}

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

  if (stage === 'session') {
    return (
      <NewSessionPopover {...session} profiles={profiles} at={at} anchorRef={anchorRef} onDismiss={onDismiss} />
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
      hint: 'Ctrl N'
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

  return (
    <Menu
      label="New tab"
      at={at}
      anchorRef={anchorRef}
      entries={kinds}
      // Choosing a kind moves on to its step rather than closing: the menu
      // closes itself only for the one that has no step.
      stayOpen
      onSelect={(id) => {
        if (id === 'browser') {
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
