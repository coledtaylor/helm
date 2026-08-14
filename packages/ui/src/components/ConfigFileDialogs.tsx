import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigFile, ConfigScope } from '@helm/core'
// Values, not types, so they come from `@helm/core/types` - the one entry point
// with no `node:` imports behind it (CLAUDE.md, hard rules). The same argument
// as `validateJson` in the editor: a name the CLI could not address is refused
// as it is typed, so nothing is sent that main would have to write and undo.
import {
  checkConfigName,
  configUnit,
  planConfigFile,
  CREATABLE_KINDS,
  type CreatableKind
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { formatBytes } from '../lib/time'
import { CaretIcon, CloseIcon, PlusIcon, TrashIcon, WarnIcon } from './icons'

/**
 * New, Rename and Delete for one entry in a `.claude` tree.
 *
 * All three are modals for the same reason the harness dialog is: each asks a
 * question whose answer decides what appears on disk, and each has a preview
 * that has to be read before the button is pressed. The delete is an
 * `alertdialog` with Cancel focused and a danger-outlined accept, which is
 * DESIGN.md's rule for a destructive confirmation - and it says both what will
 * go and what can bring it back, because "restorable" is a fact the person
 * deciding needs and not a comment for whoever reads the code.
 *
 * The previews are computed from `planConfigFile` and `configUnit` - the same
 * functions the write path runs. A dialog that predicted the destination by its
 * own rule would eventually promise one path and produce another.
 */

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

const inputClass = cn(
  'h-[30px] w-full rounded-well border border-border bg-surface-sunken px-2.5 text-[12.5px]',
  'text-fg placeholder:text-fg-subtle select-text',
  'focus:border-accent focus:outline-none'
)

const labelClass = 'block text-[9.5px] font-semibold tracking-[.08em] text-fg-subtle uppercase'

const secondaryButton = cn(
  'rounded-well border border-border-strong px-3.5 py-1.5 text-[12px] text-fg',
  'transition-colors hover:bg-hover'
)

function primaryButton(ready: boolean): string {
  return cn(
    // Outlined in the accent, never solid-filled; disabled keeps the outline at
    // reduced opacity rather than swapping to a grey fill (DESIGN.md).
    'rounded-well border px-3.5 py-1.5 text-[12px] font-medium transition-colors',
    ready
      ? 'border-accent text-accent-text hover:bg-accent-soft'
      : 'cursor-default border-border text-fg-subtle opacity-60'
  )
}

function Backdrop({
  onCancel,
  children
}: {
  onCancel: () => void
  children: JSX.Element
}): JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      {children}
    </div>
  )
}

/** The modal island: 12px radius, stronger hairline, the one allowed shadow. */
const modalIsland = cn(
  'flex max-h-full w-full flex-col overflow-hidden rounded-xl',
  'border border-border-strong bg-surface shadow-panel'
)

function Problem({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p
      role="alert"
      data-config-dialog-problem
      className="mt-3 flex items-start gap-2 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-[1.55] text-danger"
    >
      <WarnIcon width={12} height={12} className="mt-[3px] shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  )
}

// ---------------------------------------------------------------------------
// New
// ---------------------------------------------------------------------------

export interface ConfigNewDialogProps {
  scope: ConfigScope
  /** The tree as it stands, so a collision is shown as it is typed. */
  files: readonly ConfigFile[]
  busy: boolean
  /** Set when main refused something this dialog thought was fine. */
  error: string | null
  onCreate: (kind: CreatableKind, name: string) => void
  onCancel: () => void
}

export function ConfigNewDialog({
  scope,
  files,
  busy,
  error,
  onCreate,
  onCancel
}: ConfigNewDialogProps): JSX.Element {
  const [kind, setKind] = useState<CreatableKind>('skill')
  const [name, setName] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const userScope = scope.kind === 'user'

  const spec = CREATABLE_KINDS.find((candidate) => candidate.kind === kind) ?? CREATABLE_KINDS[0]

  useEffect(() => {
    if (spec?.named === true) nameRef.current?.focus()
  }, [spec?.named])

  const planned = useMemo(
    () => planConfigFile({ kind, name, userScope }),
    [kind, name, userScope]
  )

  /**
   * A collision, found against the tree already on screen.
   *
   * The renderer's copy is a courtesy - main checks the disk, which is the
   * authority and which can hold a file this scope was listed before. But a
   * refusal that arrives only after the request looks like a bug in the app,
   * where one that appears under the field as it is typed is the app agreeing
   * that the name is taken.
   */
  const collision = useMemo(() => {
    const plan = planned.plan
    if (plan === null) return null
    const relPath = plan.relPath.toLowerCase()
    if (files.some((file) => file.relPath.toLowerCase() === relPath)) {
      return `${plan.relPath} is already there.`
    }
    if (plan.dirRelPath !== null) {
      const prefix = `${plan.dirRelPath.toLowerCase()}/`
      if (files.some((file) => file.relPath.toLowerCase().startsWith(prefix))) {
        return `${scope.label} already has a skill called ${plan.address}.`
      }
    }
    return null
  }, [planned, files, scope.label])

  const named = spec?.named === true
  const typed = name.trim() !== ''
  // Nothing is said about a name nobody has typed yet - a field that opens
  // scolding you for leaving it blank is a field that is wrong on arrival.
  const problem = error ?? collision ?? (named && !typed ? null : planned.error)
  const ready = planned.ok && collision === null && !busy && (!named || typed)

  const submit = (): void => {
    if (ready) onCreate(kind, name.trim())
  }

  return (
    <Backdrop onCancel={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`New in ${scope.label}`}
        data-config-new-dialog
        className={cn(modalIsland, 'max-w-[520px]')}
      >
        <header className="flex shrink-0 items-center gap-[9px] px-[22px] pt-[18px]">
          <PlusIcon width={13} height={13} className="shrink-0 text-accent" />
          <h2 className="min-w-0 truncate text-[15px] font-medium tracking-tight text-fg">
            New in {scope.label}
          </h2>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            title="Close"
            className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <CloseIcon width={12} height={12} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-2 pb-1">
          <p className="text-[11px] leading-[1.55] text-fg-muted">
            Written into this scope&rsquo;s <span className="font-mono">.claude</span> tree, with a
            snapshot taken first - so anything created here can be un-created from its history.
          </p>

          <label className="mt-4 block">
            <span className={cn(labelClass, 'mb-1.5')}>What</span>
            <span className="relative block">
              <select
                data-config-new-kind
                value={kind}
                onChange={(event) => setKind(event.target.value as CreatableKind)}
                aria-label="What to create"
                // A real fill, never transparent: the dropped-open list is an OS
                // window that reads this control's own background (DESIGN.md).
                className={cn(inputClass, 'appearance-none pr-7')}
              >
                <optgroup label="Things you name">
                  {CREATABLE_KINDS.filter((candidate) => candidate.named).map((candidate) => (
                    <option key={candidate.kind} value={candidate.kind}>
                      {candidate.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="One per scope">
                  {CREATABLE_KINDS.filter((candidate) => !candidate.named).map((candidate) => {
                    const present = files.some((file) => file.kind === candidate.kind)
                    const barred = candidate.projectOnly && userScope
                    return (
                      <option
                        key={candidate.kind}
                        value={candidate.kind}
                        disabled={present || barred}
                      >
                        {candidate.label}
                        {present ? ' (already there)' : barred ? ' (projects only)' : ''}
                      </option>
                    )
                  })}
                </optgroup>
              </select>
              <CaretDown />
            </span>
            <span className="mt-[5px] block text-[10px] leading-[1.5] text-fg-subtle">
              {spec?.hint}
            </span>
          </label>

          {named && (
            <label className="mt-[14px] block">
              <span className={cn(labelClass, 'mb-1.5')}>Name</span>
              <input
                ref={nameRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit()
                }}
                spellCheck={false}
                data-config-new-name
                aria-label="Name"
                placeholder={kind === 'skill' ? 'e.g. brew-coffee' : 'e.g. spec:plan'}
                className={cn(inputClass, 'font-mono text-[12px]')}
              />
              <span className="mt-[5px] block text-[10px] leading-[1.5] text-fg-subtle">
                {kind === 'skill'
                  ? 'Lowercase words joined by hyphens. The folder gets this name and so does the frontmatter.'
                  : 'Lowercase words joined by hyphens; a colon or a slash starts a namespace.'}
              </span>
            </label>
          )}

          {problem !== null && problem !== '' && <Problem>{problem}</Problem>}

          <div className="mt-4">
            <span className={cn(labelClass, 'mb-1.5')}>What gets written</span>
            <div className="rounded-raised border border-border bg-surface-sunken px-3 py-2.5">
              <p className="truncate font-mono text-[11px] text-fg-muted" data-config-new-target>
                {planned.plan?.relPath ?? '…'}
              </p>
              {planned.plan !== null && (
                <>
                  <p className="mt-1.5 text-[11px] leading-[1.55] text-fg-subtle">
                    Claude Code addresses it as{' '}
                    <span className="font-mono text-fg-muted">{planned.plan.address}</span>.
                  </p>
                  <pre className="mt-2 max-h-32 overflow-auto font-mono text-[10.5px] leading-[1.5] text-fg-subtle">
                    {planned.plan.content.trimEnd()}
                  </pre>
                </>
              )}
            </div>
          </div>
        </div>

        <footer className="mx-[22px] flex shrink-0 items-center justify-end gap-2 border-t border-border py-3.5">
          <button type="button" onClick={onCancel} className={secondaryButton}>
            Cancel
          </button>
          <button
            type="button"
            data-config-new-create
            disabled={!ready}
            onClick={submit}
            className={primaryButton(ready)}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </footer>
      </div>
    </Backdrop>
  )
}

/**
 * The app's own caret over a native select.
 *
 * The platform arrow is always replaced (DESIGN.md): Chromium draws a heavy
 * chevron in its own colour that reads as a control borrowed from another
 * program. `CaretIcon` rotated 90 degrees is the shape the rest of the app uses.
 */
function CaretDown(): JSX.Element {
  return (
    <CaretIcon
      width={8}
      height={8}
      className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rotate-90 text-fg-subtle"
    />
  )
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export interface ConfigRenameDialogProps {
  scope: ConfigScope
  file: ConfigFile
  files: readonly ConfigFile[]
  busy: boolean
  error: string | null
  onRename: (name: string) => void
  onCancel: () => void
}

/**
 * Where a rename would put it, by the same rules the write path uses.
 *
 * A skill keeps its parent and changes its last directory, so a nested
 * `skills/vendor/thing` stays under `vendor`. A command, agent or rule *is* its
 * path, so the new name is the new path and the emptied namespace goes.
 */
function renamePreview(
  file: ConfigFile,
  name: string,
  userScope: boolean
): { relPath: string | null; address: string | null; error: string | null } {
  if (file.kind === 'skill') {
    const checked = checkConfigName('skill', name)
    if (!checked.ok) return { relPath: null, address: null, error: checked.error }
    const leaf = checked.segments[0] ?? ''
    const dir = file.relPath.slice(0, file.relPath.lastIndexOf('/'))
    const parent = dir.slice(0, dir.lastIndexOf('/'))
    const tail = file.relPath.slice(dir.length + 1)
    return { relPath: `${parent}/${leaf}/${tail}`, address: leaf, error: null }
  }
  const planned = planConfigFile({ kind: file.kind as CreatableKind, name, userScope })
  return {
    relPath: planned.plan?.relPath ?? null,
    address: planned.plan?.address ?? null,
    error: planned.error
  }
}

export function ConfigRenameDialog({
  scope,
  file,
  files,
  busy,
  error,
  onRename,
  onCancel
}: ConfigRenameDialogProps): JSX.Element {
  const [name, setName] = useState(file.name)
  const nameRef = useRef<HTMLInputElement>(null)
  const userScope = scope.kind === 'user'

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  const unit = useMemo(() => configUnit(files, file), [files, file])
  const preview = useMemo(() => renamePreview(file, name, userScope), [file, name, userScope])

  const unchanged = name.trim() === file.name
  const collision = useMemo(() => {
    if (preview.relPath === null || unchanged) return null
    const relPath = preview.relPath.toLowerCase()
    const moving = new Set(unit.map((member) => member.relPath.toLowerCase()))
    if (files.some((other) => other.relPath.toLowerCase() === relPath && !moving.has(relPath))) {
      return `${preview.relPath} is already there.`
    }
    return null
  }, [preview.relPath, unchanged, files, unit])

  const problem = error ?? collision ?? (unchanged ? null : preview.error)
  const ready = preview.relPath !== null && collision === null && !unchanged && !busy

  const submit = (): void => {
    if (ready) onRename(name.trim())
  }

  return (
    <Backdrop onCancel={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Rename ${file.name}`}
        data-config-rename-dialog
        className={cn(modalIsland, 'max-w-[520px]')}
      >
        <header className="flex shrink-0 items-center gap-[9px] px-[22px] pt-[18px]">
          <h2 className="min-w-0 truncate text-[15px] font-medium tracking-tight text-fg">
            Rename {file.name}
          </h2>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            title="Close"
            className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <CloseIcon width={12} height={12} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-2 pb-1">
          <p className="text-[11px] leading-[1.55] text-fg-muted">
            {file.kind === 'skill'
              ? unit.length > 1
                ? `The whole folder moves - the SKILL.md and the ${String(unit.length - 1)} file${unit.length === 2 ? '' : 's'} beside it.`
                : 'A skill is its folder, so the folder is what moves.'
              : 'A command, agent or rule is addressed by its path, so the name is the path.'}{' '}
            Every file is snapshotted on the way, at both ends.
          </p>

          <label className="mt-4 block">
            <span className={cn(labelClass, 'mb-1.5')}>New name</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
              spellCheck={false}
              data-config-rename-name
              aria-label="New name"
              className={cn(inputClass, 'font-mono text-[12px]')}
            />
          </label>

          {problem !== null && problem !== '' && <Problem>{problem}</Problem>}

          <div className="mt-4">
            <span className={cn(labelClass, 'mb-1.5')}>Where it goes</span>
            <div className="rounded-raised border border-border bg-surface-sunken px-3 py-2.5">
              <p className="truncate font-mono text-[11px] text-fg-subtle" title={file.relPath}>
                {file.relPath}
              </p>
              <p
                className="mt-1 truncate font-mono text-[11px] text-fg-muted"
                data-config-rename-target
                title={preview.relPath ?? ''}
              >
                {preview.relPath === null ? '…' : `→ ${preview.relPath}`}
              </p>
              {preview.address !== null && !unchanged && (
                <p className="mt-1.5 text-[11px] leading-[1.55] text-fg-subtle">
                  Addressed as{' '}
                  <span className="font-mono text-fg-muted">{preview.address}</span> afterwards.
                </p>
              )}
            </div>
          </div>
        </div>

        <footer className="mx-[22px] flex shrink-0 items-center justify-end gap-2 border-t border-border py-3.5">
          <button type="button" onClick={onCancel} className={secondaryButton}>
            Cancel
          </button>
          <button
            type="button"
            data-config-rename-apply
            disabled={!ready}
            onClick={submit}
            className={primaryButton(ready)}
          >
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </footer>
      </div>
    </Backdrop>
  )
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface ConfigDeleteDialogProps {
  file: ConfigFile
  files: readonly ConfigFile[]
  busy: boolean
  error: string | null
  onDelete: () => void
  onCancel: () => void
}

/**
 * The destructive confirmation.
 *
 * DESIGN.md's rule verbatim: `alertdialog`, Cancel focused and taking its ring
 * on plain `:focus` because script placed it there, and an accepting button
 * that carries `border-danger/50 text-danger` with a `bg-danger/10` hover
 * rather than a fill.
 *
 * It names every file rather than summarising, and it says what brings them
 * back - that sentence is the whole reason a delete is allowed to be one click
 * behind a confirmation instead of two.
 */
export function ConfigDeleteDialog({
  file,
  files,
  busy,
  error,
  onDelete,
  onCancel
}: ConfigDeleteDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const unit = useMemo(() => configUnit(files, file), [files, file])
  const bytes = unit.reduce((total, member) => total + member.size, 0)

  return (
    <Backdrop onCancel={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={`Delete ${file.name}`}
        data-config-delete-dialog
        className={cn(modalIsland, 'max-w-[440px]')}
      >
        <div className="px-[22px] pt-[18px]">
          <header className="flex items-start gap-[9px]">
            <TrashIcon width={13} height={13} className="mt-[3px] shrink-0 text-danger" />
            <h2 className="min-w-0 text-[15px] leading-[1.35] font-medium tracking-tight text-fg">
              Delete {file.name}?
            </h2>
          </header>

          <p className="mt-2 text-[12px] leading-[1.55] text-fg-muted">
            {unit.length === 1
              ? 'This file comes off the disk.'
              : `A skill is its folder, so all ${String(unit.length)} files in it come off the disk.`}{' '}
            Helm records every one of them first, and{' '}
            <strong className="font-medium text-fg">Undo puts them back</strong> - the same version
            history the editor restores from.
          </p>

          <ul
            data-config-delete-files
            className="mt-3 max-h-40 space-y-0.5 overflow-y-auto rounded-raised border border-border bg-surface-raised px-3 py-2"
          >
            {unit.map((member) => (
              <li
                key={member.path}
                className="flex items-baseline gap-2 font-mono text-[11px] text-fg-muted"
                title={member.path}
              >
                <span className="min-w-0 flex-1 truncate">{member.relPath}</span>
                <span className="shrink-0 tabular-nums text-fg-subtle">
                  {formatBytes(member.size)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] tabular-nums text-fg-subtle">
            {formatBytes(bytes)} in total.
          </p>

          {error !== null && error !== '' && <Problem>{error}</Problem>}
        </div>

        <footer className="mx-[22px] mt-4 flex shrink-0 items-center justify-end gap-2 border-t border-border py-3.5">
          <button
            ref={cancelRef}
            type="button"
            data-config-delete-cancel
            onClick={onCancel}
            className={cn(
              secondaryButton,
              // `:focus`, not `:focus-visible`. Focus is placed here by script,
              // Chromium does not count that as visible, and the one button
              // Enter would press must not look like the one it would not.
              'focus:border-accent focus:outline-none'
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            data-config-delete-confirm
            disabled={busy}
            onClick={onDelete}
            className={cn(
              // Carried by the text and the hover wash, never by a fill - the
              // same rule the accent follows (DESIGN.md).
              'rounded-well border border-danger/50 px-3.5 py-1.5 text-[12px] font-medium',
              'text-danger transition-colors hover:bg-danger/10',
              busy && 'cursor-default opacity-60'
            )}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </footer>
      </div>
    </Backdrop>
  )
}

// ---------------------------------------------------------------------------
// The undo strip
// ---------------------------------------------------------------------------

export interface ConfigDeletedNoticeProps {
  /** What was removed, as it was addressed. */
  label: string
  fileCount: number
  busy: boolean
  onUndo: () => void
  onDismiss: () => void
}

/**
 * What a delete leaves behind on screen.
 *
 * The rows are in the per-file history and stay there, but the file is no
 * longer in the tree - so the editor that would list its versions has nothing
 * to open. This strip is that history, at the one moment somebody wants it, and
 * `Undo` is `config:restore` over the rows the delete returned. It survives
 * picking another file, because noticing a mistake usually takes a second look
 * at what is still there.
 */
export function ConfigDeletedNotice({
  label,
  fileCount,
  busy,
  onUndo,
  onDismiss
}: ConfigDeletedNoticeProps): JSX.Element {
  return (
    <div
      data-config-deleted-notice
      role="status"
      className={cn(
        'flex shrink-0 items-center gap-3 rounded-island border border-border bg-surface px-3 py-2'
      )}
    >
      <TrashIcon width={13} height={13} className="shrink-0 text-fg-subtle" />
      <p className="min-w-0 flex-1 truncate text-[12px] text-fg-muted">
        Deleted <span className="text-fg">{label}</span>
        <span className="text-fg-subtle">
          {' '}
          &middot; {fileCount} {fileCount === 1 ? 'file' : 'files'} kept in its history
        </span>
      </p>
      <button
        type="button"
        data-config-undo-delete
        disabled={busy}
        onClick={onUndo}
        className={cn(
          'shrink-0 rounded-well border px-2.5 py-1 text-[11px] font-medium transition-colors',
          busy
            ? 'cursor-default border-border text-fg-subtle opacity-60'
            : 'border-accent text-accent-text hover:bg-accent-soft'
        )}
      >
        {busy ? 'Restoring…' : 'Undo'}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        <CloseIcon width={11} height={11} />
      </button>
    </div>
  )
}
