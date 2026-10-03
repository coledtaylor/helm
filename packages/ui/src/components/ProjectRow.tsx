import type { JSX } from 'react'
import type { Project } from '@helm/core'
import { cn } from '../lib/cn'
import { ROW_SELECTED, ROW_SELECTED_GROUP } from '../lib/rows'
import { SESSION_STATE_DOT, SESSION_STATE_LABEL, type SessionState } from '../lib/sessionstate'
import { CaretIcon, FolderIcon, HarnessIcon, PinIcon, RepoIcon, TerminalIcon } from './icons'

const KIND_ICON = {
  harness: HarnessIcon,
  repo: RepoIcon,
  folder: FolderIcon
} as const

/** The caret's column: 16px, so a row with nothing to expand keeps its icon in line. */
const CARET_PX = 16

export interface ProjectRowProps {
  project: Project
  selected: boolean
  onSelect: (project: Project) => void
  /** Pixels from the row's left edge to its caret - its depth in the tree. */
  indent: number
  /** Whether its sessions are showing. Null for a project with none to show. */
  expanded: boolean | null
  onToggle?: (() => void) | undefined
  /**
   * The most pressing state among its sessions, painted beside the name while
   * they are folded away - so a collapsed project still says one of them needs
   * you.
   */
  summary?: SessionState | null | undefined
  /** In the Pinned section rather than under its harness. */
  pinned?: boolean | undefined
  /** Omitted, the row carries no star at all. */
  onTogglePin?: ((project: Project) => void) | undefined
  /** The terminal button that starts a session here without opening the project's page. */
  onLaunch?: ((project: Project) => void) | undefined
  /** A session is starting here right now. */
  launching?: boolean | undefined
}

/**
 * One line: caret, kind, name, branch.
 *
 * It used to be two, the git chip under the name, because a single line had to
 * choose between truncating the name and dropping the branch. The tree is now
 * where sessions live as much as projects, and two lines per project doubled
 * the distance between a project and the sessions nested under it. The branch
 * keeps the line's right-hand end and gives way first; the rest of what git
 * says is on the project's page.
 *
 * The row's own action is the whole row: it opens the project's page. The caret
 * is a second, smaller target for folding its sessions away, and two controls
 * appear under the pointer - a terminal to start a session here directly, and the
 * star. They take the branch's place while they show rather than pushing
 * anything, so the name never moves under the pointer.
 *
 * `title` is deliberately on the main button and on nothing else in the tree:
 * the drivers reach the first project row with `aside nav button[title]`, and
 * the caret, the terminal button, the star and every session row carry `aria-label`
 * instead so that selector stays a project.
 */
export function ProjectRow({
  project,
  selected,
  onSelect,
  indent,
  expanded,
  onToggle,
  summary,
  pinned = false,
  onTogglePin,
  onLaunch,
  launching = false
}: ProjectRowProps): JSX.Element {
  const KindIcon = KIND_ICON[project.kind]
  const branch = project.git?.branch ?? null
  const hasActions = onLaunch !== undefined || onTogglePin !== undefined

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onSelect(project)}
        title={project.path}
        aria-current={selected ? 'true' : undefined}
        style={{ paddingLeft: indent + CARET_PX + 2 }}
        className={cn(
          'relative flex h-line w-full items-center gap-1.5 rounded-raised pr-2 text-left transition-colors',
          // `group-hover` rather than `hover`, so the tint follows the row and
          // not the button: the caret, the terminal button and the star sit outside it,
          // and a row that went flat while the pointer was on one of them
          // would read as several controls rather than one row.
          selected ? ROW_SELECTED_GROUP : 'group-hover:bg-hover'
        )}
      >
        {selected && (
          <span
            aria-hidden
            className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent"
          />
        )}
        <KindIcon
          width={13}
          height={13}
          className={cn(
            'shrink-0',
            selected ? 'text-accent' : 'text-fg-muted'
          )}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px] leading-[15px] text-fg',
            selected && 'font-medium'
          )}
        >
          {project.name}
        </span>
        {expanded === false && summary !== null && summary !== undefined && (
          <span
            aria-hidden
            data-project-summary={summary}
            className={cn('size-1.5 shrink-0 rounded-full', SESSION_STATE_DOT[summary])}
          />
        )}
        {(branch !== null || launching) && (
          <span
            className={cn(
              'max-w-[45%] min-w-0 shrink truncate font-mono text-[10.5px] leading-[15px] text-fg-subtle',
              hasActions && 'group-hover:invisible group-focus-within:invisible'
            )}
          >
            {launching ? 'starting…' : branch}
          </span>
        )}
      </button>

      {expanded !== null && onToggle !== undefined && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Fold' : 'Unfold'} the sessions in ${project.name}`}
          style={{ left: indent }}
          className="absolute top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-xs text-fg-subtle transition-colors hover:text-fg"
        >
          <CaretIcon
            width={10}
            height={10}
            className={cn('transition-transform', expanded && 'rotate-90')}
          />
        </button>
      )}

      {hasActions && (
        <div
          className={cn(
            'absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5',
            'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'
          )}
        >
          {onLaunch !== undefined && (
            <button
              type="button"
              data-launch-project={project.path}
              aria-label={`Start a session in ${project.name}`}
              disabled={launching}
              onClick={() => onLaunch(project)}
              className={cn(
                'grid size-5 place-items-center rounded-well bg-active text-fg transition-colors',
                'hover:bg-accent-soft hover:text-accent-text disabled:opacity-50'
              )}
            >
              <TerminalIcon width={12} height={12} />
            </button>
          )}
          {onTogglePin !== undefined && (
            <PinButton
              pinned={pinned}
              name={project.name}
              path={project.path}
              onToggle={() => onTogglePin(project)}
            />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A pinned path discovery no longer finds.
 *
 * Kept rather than dropped, and said out loud rather than painted as an
 * ordinary row. A pin is a deliberate act and an unplugged drive is not a
 * decision to un-pin, so the entry survives; but the tree must never offer a
 * launch that cannot happen, so this is **not a button**. The one thing still
 * worth doing to it - taking the pin off - is the star, shown outright because
 * it is the row's only control.
 *
 * "folder gone" is `SessionHistory`'s word for the same fact, deliberately: a
 * session whose project directory has vanished wears that badge, and a second
 * vocabulary for one condition is how two surfaces come to disagree about it.
 */
export function MissingProjectRow({
  path,
  indent,
  onTogglePin
}: {
  path: string
  indent: number
  onTogglePin?: ((path: string) => void) | undefined
}): JSX.Element {
  return (
    <div
      className="group relative flex h-line w-full items-center gap-1.5 rounded-raised pr-8"
      style={{ paddingLeft: indent + CARET_PX + 2 }}
      title={path}
    >
      <FolderIcon width={13} height={13} className="shrink-0 text-fg-subtle opacity-50" />
      <span className="min-w-0 truncate text-[12.5px] leading-[15px] text-fg-muted">
        {baseName(path)}
      </span>
      <span className="shrink-0 rounded-sm border border-border px-1 text-[9px] tracking-wide text-fg-subtle uppercase">
        folder gone
      </span>

      {onTogglePin && (
        <span className="absolute top-1/2 right-1 -translate-y-1/2">
          <PinButton
            pinned={true}
            name={baseName(path)}
            path={path}
            onToggle={() => onTogglePin(path)}
          />
        </span>
      )}
    </div>
  )
}

export interface SessionRowProps {
  /** `session:12` for one of Helm's, `pid:4068` for one somebody else started. */
  id: string
  label: string
  /** Null for a session outside Helm that has not said what it is doing. */
  state: SessionState | null
  /** The short word at the right: "needs you", "4m", "idle". */
  note: string
  /** Hover text - where it is running, and the CLI's own sentence if it is waiting. */
  hint: string
  /** Not one of Helm's: a `claude` started in a terminal, in this folder. */
  outside: boolean
  /** In front of the focused pane, in front of the other one, or neither. */
  shown: 'focused' | 'visible' | null
  indent: number
  onOpen: (id: string) => void
}

/**
 * A live session, under the project it is running in.
 *
 * The dot is the tab's dot - the same seven tones from `lib/sessionstate.ts` -
 * and the session in front of the focused pane wears the selected-row recipe
 * with its accent edge, so the tree and the pane agree about which session
 * you are looking at. The one in front of the *other* pane gets the hover
 * tone, the same split the two panes' tab strips make.
 *
 * A session Helm did not start is listed too, muted and saying so, because it
 * holds a working tree exactly as hard as one of Helm's does - the reason the
 * sessions pane is machine-wide. It has no tab, so it opens that pane instead.
 */
export function SessionRow({
  id,
  label,
  state,
  note,
  hint,
  outside,
  shown,
  indent,
  onOpen
}: SessionRowProps): JSX.Element {
  const waiting = state === 'waiting'
  return (
    // The hover text sits on a wrapper because this button is inside the
    // tree's `nav`: a `title` on it would make it one of the rows the drivers'
    // `aside nav button[title]` means as "a project".
    <div title={hint}>
      <button
        type="button"
        data-session-row={id}
        aria-current={shown === 'focused' ? 'true' : undefined}
        aria-label={`${label}, ${state === null ? 'state unknown' : SESSION_STATE_LABEL[state]}${outside ? ', outside Helm' : ''}`}
        onClick={() => onOpen(id)}
        style={{ paddingLeft: indent }}
        className={cn(
          'group/row relative flex h-line w-full items-center gap-2 rounded-raised pr-2 text-left transition-colors',
          shown === 'focused'
            ? ROW_SELECTED
            : shown === 'visible'
              ? 'bg-hover hover:bg-active'
              : 'hover:bg-hover'
        )}
      >
        {shown === 'focused' && (
          <span
            aria-hidden
            className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent"
          />
        )}
        <span
          aria-hidden
          data-session-dot={state ?? 'unknown'}
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            state === null ? 'border-[1.5px] border-fg-subtle' : SESSION_STATE_DOT[state],
            outside && 'opacity-70'
          )}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px] leading-[15px]',
            shown === 'focused' || waiting
              ? 'text-fg'
              : 'text-fg-muted group-hover/row:text-fg'
          )}
        >
          {label}
        </span>
        {note !== '' && (
          <span
            className={cn(
              'shrink-0 text-[11px] leading-[15px] tabular-nums',
              waiting
                ? 'text-warn'
                : state === 'failed'
                  ? 'text-danger'
                  : state === 'busy' && shown === 'focused'
                    ? 'text-accent-text'
                    : 'text-fg-subtle'
            )}
          >
            {note}
          </span>
        )}
      </button>
    </div>
  )
}

/**
 * The star, revealed by opacity and never by mounting it on a hover state.
 *
 * DESIGN.md states the rule this is the exception to: a row's own action stays
 * the row, and a control that changes *which list the row is in* is not the
 * row's action. Two things depend on the element being there the whole time:
 * keyboard focus can reach it (`focus-within` shows it), and nothing has to
 * guess its width.
 */
function PinButton({
  pinned,
  name,
  path,
  onToggle
}: {
  pinned: boolean
  name: string
  path: string
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      data-pin-project={path}
      aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
      onClick={onToggle}
      className={cn(
        'grid size-5 place-items-center rounded-well transition',
        pinned ? 'text-accent hover:bg-accent-soft' : 'text-fg-subtle hover:bg-active hover:text-fg'
      )}
    >
      <PinIcon width={12} height={12} />
    </button>
  )
}

/**
 * The last segment of a path, for a project no scan can name.
 *
 * Both separators, because a value typed into the setting by hand is still a
 * value this has to render; the whole path is on the row's `title` either way.
 */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}
