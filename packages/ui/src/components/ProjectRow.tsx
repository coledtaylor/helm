import type { JSX } from 'react'
import type { Project } from '@helm/core'
import { cn } from '../lib/cn'
import { PROJECT_KIND_ICON } from '../lib/projectIcons'
import { ROW_SELECTED, ROW_SELECTED_GROUP } from '../lib/rows'
import { commandTone, SESSION_STATE_DOT, SESSION_STATE_LABEL, type SessionState } from '../lib/sessionstate'
import { CaretIcon, CommandChildIcon, FolderIcon, PinIcon, TerminalIcon } from './icons'

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
  const KindIcon = PROJECT_KIND_ICON[project.kind]
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
  /** Present on a session another session started, drawn under it: where its guide runs. */
  guide?: SessionGuide | undefined
  /**
   * The name of the session that started this one, on a child drawn at the top
   * level because that session has ended. Said beside the name.
   */
  parentName?: string | undefined
  /**
   * Whether the sessions this one started are showing. Null for a session that
   * started none, which then has no caret.
   */
  expanded?: boolean | null | undefined
  onToggle?: (() => void) | undefined
  /**
   * The most pressing state among the sessions it started, painted beside the
   * name while they are folded away - so a folded parent still says one of its
   * children needs you.
   */
  summary?: SessionState | null | undefined
  /**
   * A command a session ran as a child (a test run, a build) rather than an
   * agent: its mark is a terminal glyph where a session has its state dot, since
   * a command has no conversation to be busy or waiting in.
   */
  command?: boolean | undefined
  /**
   * How many of the sessions it started are waiting for you, counted after its
   * name so a parent says who needs you before anyone opens it.
   */
  needs?: number | undefined
}

/**
 * The hairline that joins a child's row to the row above it: a vertical rule
 * down the parent's dot, and an elbow into the child's. One step is `FAMILY_STEP_PX`.
 */
export interface SessionGuide {
  /** The last of its parent's children: the rule stops at the elbow. */
  last: boolean
  /**
   * For each ancestor further out than its parent, outermost first: whether
   * that ancestor has more children below this branch, so its rule runs on
   * through this row.
   */
  through: readonly boolean[]
}

/** How far a child's dot sits in from its parent's: one step. */
export const FAMILY_STEP_PX = 16

/** The rule sits a little right of the parent's dot's left edge, as the design draws it. */
const GUIDE_OFFSET_PX = 11
/** The elbow reaches from the rule to just short of the child's dot. */
const ELBOW_PX = 7
/** The room a fold caret takes out of a rule that runs through its row. */
const CARET_GAP_PX = 7
/**
 * A fold caret's 16px target starts this far left of the dot's column, which
 * centres the design's 10px triangle 14px to 4px before it.
 */
const CARET_LEFT_PX = 17
/**
 * What the caret's column costs the dot beside it. The design lays the caret
 * out in the row, 14px back from the padding with a 10px box and the row's 7px
 * gap after it, so a parent's dot sits this far in from where the dot of a
 * session with nothing to fold keeps its own.
 */
const CARET_DOT_SHIFT_PX = 3

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
 *
 * A session another session started is drawn under that one, a step in, whatever
 * folder it runs in, joined to it by a hairline guide. A session that started
 * others has a triangle caret before its dot to fold them away, as a project
 * has for its sessions; the most pressing state among them shows beside its
 * name while they are folded, and a count says how many are waiting for you. A
 * command a session ran as a child wears a terminal glyph where a session has
 * its dot. A child whose parent has ended stands on its own and says whose it was.
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
  onOpen,
  guide,
  parentName,
  expanded = null,
  onToggle,
  summary,
  command = false,
  needs = 0
}: SessionRowProps): JSX.Element {
  const waiting = state === 'waiting'
  const folds = expanded !== null && onToggle !== undefined
  const guideLeft = indent - GUIDE_OFFSET_PX
  const rule = 'absolute border-l border-border-strong'
  // A row with a caret has the caret's column before its mark.
  const lead = folds ? { marginLeft: CARET_DOT_SHIFT_PX } : undefined
  return (
    // The hover text sits on a wrapper because this button is inside the
    // tree's `nav`: a `title` on it would make it one of the rows the drivers'
    // `aside nav button[title]` means as "a project". The wrapper is also what
    // the caret is placed against, so the row's own button holds nothing but
    // the row.
    <div title={hint} className="relative">
      <button
        type="button"
        data-session-row={id}
        aria-current={shown === 'focused' ? 'true' : undefined}
        aria-label={`${label}, ${state === null ? 'state unknown' : SESSION_STATE_LABEL[state]}${outside ? ', outside Helm' : ''}${parentName === undefined ? '' : `, started by ${parentName}`}${needs === 0 ? '' : `, ${String(needs)} of its sessions waiting for you`}`}
        onClick={() => onOpen(id)}
        style={{ paddingLeft: indent }}
        className={cn(
          'group/row relative flex h-line w-full items-center gap-[7px] rounded-raised pr-2 text-left transition-colors',
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
        {guide !== undefined && (
          <>
            {/* The rules of the ancestors further out, which run on through
                this row while they have children below it. */}
            {guide.through.map(
              (runs, at) =>
                runs && (
                  <span
                    key={`through-${String(at)}`}
                    aria-hidden
                    data-session-guide="through"
                    className={cn(rule, 'inset-y-0')}
                    style={{ left: guideLeft - FAMILY_STEP_PX * (guide.through.length - at) }}
                  />
                )
            )}
            {/* The parent's own rule: the whole row while more children follow,
                down to the elbow for the last. A row with a caret of its own
                leaves the caret's room clear, as the elbow's place. */}
            <span
              aria-hidden
              data-session-guide={guide.last ? 'last' : 'more'}
              className={cn(rule, 'top-0')}
              style={{
                left: guideLeft,
                height: folds ? `calc(50% - ${String(CARET_GAP_PX)}px)` : guide.last ? '50%' : '100%'
              }}
            />
            {folds && !guide.last && (
              <span
                aria-hidden
                data-session-guide="more"
                className={cn(rule, 'bottom-0')}
                style={{ left: guideLeft, top: `calc(50% + ${String(CARET_GAP_PX)}px)` }}
              />
            )}
            {!folds && (
              <span
                aria-hidden
                data-session-guide="elbow"
                className="absolute top-1/2 border-t border-border-strong"
                style={{ left: guideLeft, width: ELBOW_PX }}
              />
            )}
          </>
        )}
        {command ? (
          <span
            aria-hidden
            data-session-command={state ?? 'unknown'}
            style={lead}
            className={cn(
              'grid size-3 shrink-0 place-items-center',
              commandTone(state),
              outside && 'opacity-70'
            )}
          >
            <CommandChildIcon />
          </span>
        ) : (
          <span
            aria-hidden
            data-session-dot={state ?? 'unknown'}
            style={lead}
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              state === null ? 'border-[1.5px] border-fg-subtle' : SESSION_STATE_DOT[state],
              outside && 'opacity-70'
            )}
          />
        )}
        <span
          className={cn(
            'min-w-0 truncate text-[12.5px] leading-[15px]',
            shown === 'focused' || waiting
              ? 'text-fg'
              : 'text-fg-muted group-hover/row:text-fg'
          )}
        >
          {label}
          {parentName !== undefined && (
            <span data-session-parent={parentName} className="text-fg-subtle">
              {` · from ${parentName}`}
            </span>
          )}
        </span>
        {expanded === false && summary !== null && summary !== undefined && (
          <span
            aria-hidden
            data-family-summary={summary}
            className={cn('size-1.5 shrink-0 rounded-full', SESSION_STATE_DOT[summary])}
          />
        )}
        {needs > 0 && (
          <span
            aria-hidden
            data-session-needs={needs}
            className="grid h-4 min-w-4 shrink-0 place-items-center rounded-full border border-warn/45 px-1 text-[10px] leading-[14px] font-medium text-warn tabular-nums"
          >
            {needs}
          </span>
        )}
        {note !== '' && (
          <span
            className={cn(
              'ml-auto shrink-0 text-[11px] leading-[15px] tabular-nums',
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

      {folds && (
        <button
          type="button"
          data-session-fold={id}
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Fold' : 'Unfold'} the sessions started by ${label}`}
          style={{ left: indent - CARET_LEFT_PX }}
          className="absolute top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-xs text-[9px] leading-none text-fg-subtle transition-colors hover:text-fg"
        >
          {/* The design's glyphs: a triangle down while the children show, right while they are folded away. */}
          <span aria-hidden>{expanded ? '▾' : '▸'}</span>
        </button>
      )}
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
