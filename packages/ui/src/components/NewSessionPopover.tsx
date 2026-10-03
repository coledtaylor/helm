import type { FocusEvent, JSX, KeyboardEvent, RefObject } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  historyTitle,
  liveSessionsIn,
  type HistorySession,
  type LiveSession,
  type Profile,
  type Project
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { homePath, launchSentence, profileFor, profilesInOrder, rankProjects } from '../lib/launcher'
import { usePopup, type PopupAnchor } from '../lib/popup'
import { PROJECT_KIND_ICON } from '../lib/projectIcons'
import { formatAge } from '../lib/time'
import { HistoryIcon, LayersIcon } from './icons'
import { LaunchSentence, RunningHere } from './LaunchNotes'
import { Menu } from './Menu'
import type { LaunchChoice } from './NewSessionDialog'
import { Picker } from './Picker'

export interface NewSessionPopoverProps {
  /** Under the `+` it hangs from. */
  at: PopupAnchor
  /** The `+` itself: a press on it is its own toggle, not a press outside. */
  anchorRef: RefObject<HTMLElement | null>
  projects: readonly Project[]
  /** When each folder was last worked in, by lower-cased path. */
  recency: ReadonlyMap<string, number>
  /** Every live session on the machine, for the launch warning. */
  live: readonly LiveSession[]
  profiles: readonly Profile[]
  /** For writing paths from `~`. */
  home: string | null
  /** The folder it opens on: the one the pane is about, when it is about one. */
  initialPath: string | null
  /** Conversations that can be reopened, by lower-cased folder path. Absent means not read yet. */
  resumable: ReadonlyMap<string, readonly HistorySession[]>
  /** The folder chosen, so its conversations are read before Resume is pressed. */
  onShowing: (paths: readonly string[]) => void
  /** A launch is in flight. */
  busy: boolean
  /** Why the last launch failed. */
  error: string | null
  now: number
  onStart: (choice: LaunchChoice) => void
  onDismiss: () => void
}

/** Recent folders offered at the foot. */
const RECENT = 3

/** The caps label (DESIGN.md "Section labels"). */
const CAPS = 'text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase'

const BUTTON = 'h-[28px] rounded-well border text-[12.5px] transition-colors disabled:cursor-default disabled:opacity-50'

const key = (path: string): string => path.toLowerCase()

/** A select whose list is open: its keys are the list's, not the popover's. */
function isOpen(select: HTMLSelectElement): boolean {
  try {
    return select.matches(':open')
  } catch {
    // A DOM with no `:open` has no list of its own to be open.
    return false
  }
}

/**
 * A new session from a pane's `+`: the launcher as a popover anchored under the
 * button, where Ctrl+N's is a palette in the middle of the window.
 *
 * Built for the pointer, as the palette is for the keyboard. The folder and the
 * profile are selects rather than a field to type into, the folder opening on
 * the one the pane is about; the sentence under them says what Start will run
 * before it runs (DESIGN.md's launch disclosure); Resume lists the folder's
 * conversations that can be reopened; and the foot offers the folders worked in
 * last, one click each, with the profile each would start with.
 *
 * **The profile follows the folder until it is chosen**, as in the palette, and
 * the permission mode is the profile's. Choosing one is what Ctrl+N is for.
 */
export function NewSessionPopover({
  at,
  anchorRef,
  projects,
  recency,
  live,
  profiles,
  home,
  initialPath,
  resumable,
  onShowing,
  busy,
  error,
  now,
  onStart,
  onDismiss
}: NewSessionPopoverProps): JSX.Element {
  const ids = useId()
  const popupRef = useRef<HTMLDivElement>(null)
  const resumeRef = useRef<HTMLButtonElement>(null)
  const [chosenPath, setChosenPath] = useState<string | null>(null)
  const [chosenProfile, setChosenProfile] = useState<{ id: number | null } | null>(null)
  const [resumeAt, setResumeAt] = useState<PopupAnchor | null>(null)

  /** Focus goes back to the `+` when this closes without starting anything. */
  const dismiss = (): void => {
    const anchor = anchorRef.current
    if (anchor?.isConnected === true) anchor.focus({ preventScroll: true })
    onDismiss()
  }

  const place = usePopup({ ref: popupRef, at, anchorRef, holdOpen: resumeAt !== null, onDismiss: dismiss })

  const folders = useMemo(
    () => rankProjects(projects, '', recency).map((match) => match.project),
    [projects, recency]
  )
  const sortedProfiles = useMemo(() => profilesInOrder(profiles), [profiles])
  /** Two folders with one name are told apart by where they are. */
  const shared = useMemo(() => {
    const seen = new Map<string, number>()
    for (const project of projects) seen.set(key(project.name), (seen.get(key(project.name)) ?? 0) + 1)
    return seen
  }, [projects])

  const find = (path: string | null): Project | undefined =>
    path === null ? undefined : folders.find((project) => key(project.path) === key(path))
  const selected = find(chosenPath) ?? find(initialPath) ?? folders[0] ?? null
  const profile =
    chosenProfile === null
      ? selected === null
        ? null
        : profileFor(selected.path, profiles)
      : (profiles.find((candidate) => candidate.id === chosenProfile.id) ?? null)
  const mode = profile?.permissionMode ?? null
  const resumes = selected === null ? undefined : resumable.get(key(selected.path))
  const recent = folders.filter((project) => recency.has(key(project.path))).slice(0, RECENT)

  const selectedPath = selected?.path ?? null
  useEffect(() => {
    if (selectedPath !== null) onShowing([selectedPath])
  }, [selectedPath, onShowing])

  // Focus moves in once it is placed - a hidden element refuses it - and onto
  // the folder, which is the first thing anybody changes.
  const placed = place !== null
  useEffect(() => {
    if (placed) document.getElementById(`${ids}-folder`)?.focus({ preventScroll: true })
  }, [placed, ids])

  const start = (resume: HistorySession | null): void => {
    if (busy || selected === null) return
    onStart({ project: selected, profileId: profile?.id ?? null, permissionMode: mode, resume, beside: false })
  }

  const startRecent = (project: Project): void => {
    if (busy) return
    const its = profileFor(project.path, profiles)
    onStart({
      project,
      profileId: its?.id ?? null,
      permissionMode: its?.permissionMode ?? null,
      resume: null,
      beside: false
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // A list this opened has had the key already.
    if (event.defaultPrevented) return
    const target = event.target as HTMLElement
    const select = target.closest('select')
    if (select !== null && isOpen(select)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      dismiss()
      return
    }
    if (
      event.key === 'Enter' &&
      !event.altKey &&
      !event.shiftKey &&
      !event.ctrlKey &&
      target.tagName !== 'BUTTON'
    ) {
      event.preventDefault()
      start(null)
    }
  }

  // Focus leaving for somewhere else closes it, as a press elsewhere does. A
  // list it opened is portalled outside it and still counts as inside, and
  // the `+` is where `dismiss` itself sends the focus.
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget
    if (!(next instanceof Element)) return
    if (popupRef.current?.contains(next) || next.closest('[data-menu]') !== null) return
    if (anchorRef.current?.contains(next)) return
    onDismiss()
  }

  const sentence =
    selected === null
      ? null
      : launchSentence({ cwd: selected.path, home, profile, permissionMode: mode, resume: null })
  const KindIcon = selected === null ? null : PROJECT_KIND_ICON[selected.kind]

  return createPortal(
    <div
      ref={popupRef}
      role="dialog"
      aria-label="New session"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      data-new-session-popover
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        // Measured where it lands, then shown.
        visibility: place === null ? 'hidden' : undefined
      }}
      className="fixed z-50 w-[340px] rounded-well border border-border-strong bg-surface-raised p-3.5 text-fg outline-none"
    >
      <div className="mb-3 flex items-center">
        <span className="text-[13px] font-medium">New session</span>
        <span className="flex-1" />
        <span
          title="The launcher, from the keyboard"
          className="rounded-xs border border-border px-[5px] font-mono text-[10.5px] leading-4 text-fg-subtle"
        >
          Ctrl N
        </span>
      </div>

      {selected === null ? (
        <p className="mb-3 text-[12px] text-fg-muted">No folders yet. Add one to scan from the sidebar.</p>
      ) : (
        <>
          <label htmlFor={`${ids}-folder`} className={cn(CAPS, 'mb-[5px] block')}>
            Folder
          </label>
          <Picker
            id={`${ids}-folder`}
            icon={KindIcon === null ? undefined : <KindIcon width={13} height={13} className="text-fg-muted" />}
            value={selected.path}
            onChange={setChosenPath}
            className="mb-2.5"
          >
            {folders.map((project) => (
              <option key={project.path} value={project.path}>
                {(shared.get(key(project.name)) ?? 0) > 1
                  ? `${project.name} (${homePath(project.path, home)})`
                  : project.name}
              </option>
            ))}
          </Picker>

          <label htmlFor={`${ids}-profile`} className={cn(CAPS, 'mb-[5px] block')}>
            Profile
          </label>
          <Picker
            id={`${ids}-profile`}
            icon={<LayersIcon width={13} height={13} className="text-fg-muted" />}
            value={profile === null ? '' : String(profile.id)}
            onChange={(value) => setChosenProfile({ id: value === '' ? null : Number(value) })}
            className="mb-2.5"
          >
            <option value="">No profile</option>
            {sortedProfiles.map((candidate) => (
              <option key={candidate.id} value={String(candidate.id)}>
                {candidate.name}
              </option>
            ))}
          </Picker>

          <div className="mb-3 flex flex-col gap-2">
            {sentence !== null && <LaunchSentence parts={sentence} />}
            <RunningHere sessions={liveSessionsIn(live, selected.path)} />
            {error !== null && (
              <p role="alert" className="text-[11.5px] leading-[1.55] text-danger">
                {error}
              </p>
            )}
          </div>
        </>
      )}

      <div className="flex items-center gap-2">
        <button
          ref={resumeRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={resumeAt !== null}
          disabled={busy || resumes === undefined || resumes.length === 0}
          title={
            selected === null
              ? undefined
              : resumes === undefined
                ? `Reading the conversations in ${selected.name}…`
                : resumes.length === 0
                  ? `Nothing in ${selected.name} can be reopened`
                  : undefined
          }
          onClick={(event) =>
            setResumeAt(resumeAt === null ? { below: event.currentTarget.getBoundingClientRect() } : null)
          }
          className={cn(
            BUTTON,
            'border-border-strong px-3 text-fg hover:bg-hover disabled:hover:bg-transparent',
            resumeAt !== null && 'bg-hover'
          )}
        >
          Resume…
        </button>
        <span className="flex-1" />
        <button
          type="button"
          disabled={busy || selected === null}
          onClick={() => start(null)}
          className={cn(
            BUTTON,
            'border-accent px-3.5 font-medium text-accent-text hover:bg-accent-soft disabled:hover:bg-transparent'
          )}
        >
          {busy ? 'Starting…' : 'Start session'}
        </button>
      </div>

      {recent.length > 0 && (
        <>
          <div aria-hidden className="island-rule mt-3.5 mb-2.5" />
          <div id={`${ids}-recent`} className={cn(CAPS, 'mb-1')}>
            Recent
          </div>
          {/* Pulled out by its own padding, so the names line up under the
              label and the fill under the pointer reaches past them. */}
          <ul aria-labelledby={`${ids}-recent`} className="-mx-1.5">
            {recent.map((project) => {
              const its = profileFor(project.path, profiles)
              const sentenceText = launchSentence({
                cwd: project.path,
                home,
                profile: its,
                permissionMode: its?.permissionMode ?? null,
                resume: null
              })
                .map((part) => part.text)
                .join('')
              return (
                <li key={project.path}>
                  <button
                    type="button"
                    disabled={busy}
                    title={sentenceText}
                    onClick={() => startRecent(project)}
                    className="flex h-7 w-full items-center gap-2 rounded-raised px-1.5 text-left text-[12.5px] transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-50"
                  >
                    <span className="min-w-0 truncate text-fg">{project.name}</span>
                    {its !== null && (
                      <span className="min-w-0 truncate text-[11.5px] text-fg-subtle">{its.name}</span>
                    )}
                    <span className="flex-1" />
                    <span className="shrink-0 text-[11px] text-fg-subtle tabular-nums">
                      {formatAge(recency.get(key(project.path)) ?? now, now)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {resumeAt !== null && resumes !== undefined && (
        <Menu
          label="Resume a conversation"
          at={resumeAt}
          anchorRef={resumeRef}
          entries={resumes.map((session) => ({
            kind: 'item' as const,
            id: session.sessionId,
            label: historyTitle(session),
            icon: <HistoryIcon width={13} height={13} />,
            hint: formatAge(session.lastAt, now)
          }))}
          onSelect={(id) => {
            const session = resumes.find((candidate) => candidate.sessionId === id)
            if (session !== undefined) start(session)
          }}
          onDismiss={() => setResumeAt(null)}
        />
      )}
    </div>,
    document.body
  )
}
