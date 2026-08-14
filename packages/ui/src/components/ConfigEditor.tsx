import type { ChangeEvent, JSX, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConfigFile,
  ConfigFileContent,
  ConfigSnapshotMeta
} from '@helm/core'
// Values, not types, so they come from `@helm/core/types` - the one entry point
// with no `node:` imports behind it (CLAUDE.md, hard rules).
import {
  isRenamable,
  parseFrontmatter,
  renameRefusal,
  settingHint,
  topLevelKey,
  validateJson
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { formatAge, formatBytes, formatMoment } from '../lib/time'
import { CheckIcon, PencilIcon, RestoreIcon, SaveIcon, TrashIcon, WarnIcon } from './icons'

export interface ConfigEditorProps {
  file: ConfigFile
  /** The bytes as loaded. Null while the read is in flight. */
  loaded: ConfigFileContent | null
  /** Versions of this file, newest first. */
  snapshots: ConfigSnapshotMeta[]
  saving: boolean
  /** Set after a save that was refused, or a read that failed. */
  error: string | null
  /**
   * The file changed on disk while it was open here. Carries the bytes now on
   * disk, so "reload" is a real choice rather than a hope.
   */
  external: { hash: string; content: string; exists: boolean } | null
  onSave: (content: string) => void
  onReload: () => void
  onRestore: (snapshot: ConfigSnapshotMeta) => void
  onReveal: (path: string) => void
  /** Told the editor's current text so a parent can warn before switching away. */
  onDirtyChange: (dirty: boolean) => void

  /**
   * Renaming and deleting this entry. Both open a dialog rather than acting -
   * a rename has a destination to show and a delete has a list to name.
   *
   * They live here, on the pane that is already about *this* file, rather than
   * on its row: a row carries no buttons, and the row's own click is what opens
   * the thing they act on (DESIGN.md, list rows).
   */
  onRename?: (() => void) | undefined
  onDelete?: (() => void) | undefined
}

const JSON_KINDS = new Set(['settings', 'settings-local', 'mcp'])
const MARKDOWN_KINDS = new Set(['skill', 'command', 'agent', 'claude-md', 'rule'])

/**
 * One configuration file, edited in place.
 *
 * Deliberately a textarea rather than a code editor. The files here are a
 * hundred lines of markdown or thirty of JSON, and the two things that actually
 * prevent mistakes in them are not syntax colouring: knowing what the
 * frontmatter says without scrolling, and being told exactly where the JSON
 * broke. Both are here. A CodeMirror would be a megabyte of bundle for a
 * gutter.
 *
 * The save button is disabled while the JSON is invalid, which is criterion 5:
 * malformed JSON is rejected *before* the write, not by the write. The main
 * process checks nothing about the syntax - it only checks that the bytes on
 * disk are still the ones this editor was based on.
 */
export function ConfigEditor({
  file,
  loaded,
  snapshots,
  saving,
  error,
  external,
  onSave,
  onReload,
  onRestore,
  onReveal,
  onDirtyChange,
  onRename,
  onDelete
}: ConfigEditorProps): JSX.Element {
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState({ line: 1, column: 1 })
  const [showHistory, setShowHistory] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  // Re-seeded whenever a different file, or a different version of it, arrives.
  // Keyed on the hash rather than the path so that a reload after an external
  // change replaces the text, and a re-render for any other reason does not.
  const basis = `${file.path}\u0000${loaded?.hash ?? ''}`
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (loaded === null || seeded.current === basis) return
    seeded.current = basis
    setDraft(loaded.content)
    setShowHistory(false)
  }, [basis, loaded])

  const dirty = loaded !== null && draft !== loaded.content
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const isJson = JSON_KINDS.has(file.kind)
  const isMarkdown = MARKDOWN_KINDS.has(file.kind)
  // Shown disabled rather than hidden, with the reason in its title: "why can I
  // not rename settings.json" is a real question, and a control that is simply
  // absent answers it with nothing.
  const renamable = isRenamable(file.kind)

  const problem = useMemo(() => (isJson ? validateJson(draft) : null), [isJson, draft])
  const frontmatter = useMemo(
    () => (isMarkdown ? parseFrontmatter(draft) : null),
    [isMarkdown, draft]
  )
  /** Top-level keys the settings editor can annotate. */
  const keys = useMemo(() => {
    if (!isJson || problem !== null) return []
    try {
      const parsed: unknown = JSON.parse(draft === '' ? '{}' : draft)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
      return Object.keys(parsed as Record<string, unknown>)
    } catch {
      return []
    }
  }, [isJson, draft, problem])

  const updateCaret = (): void => {
    const area = areaRef.current
    if (!area) return
    const upTo = area.value.slice(0, area.selectionStart)
    const lastBreak = upTo.lastIndexOf('\n')
    setCaret({ line: upTo.split('\n').length, column: upTo.length - lastBreak })
  }

  /** Puts the caret on the character the parser objected to. */
  const goToProblem = (): void => {
    const area = areaRef.current
    if (!area || !problem) return
    area.focus()
    area.setSelectionRange(problem.offset, Math.min(problem.offset + 1, area.value.length))
    updateCaret()
  }

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setDraft(event.target.value)
    updateCaret()
  }

  const blocked = problem !== null
  const canSave = loaded !== null && dirty && !blocked && !saving && external === null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ----------------------------------------------------------------- */}
      {/* Identity                                                           */}
      {/* ----------------------------------------------------------------- */}
      <header className="shrink-0 border-b border-border px-5 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] leading-tight font-medium tracking-tight text-fg">
              {file.name}
            </h2>
            <button
              type="button"
              onClick={() => onReveal(file.path)}
              title="Show in Explorer"
              className="mt-0.5 block max-w-full truncate text-left font-mono text-[11px] text-fg-subtle transition-colors hover:text-accent-text"
            >
              {file.relPath}
            </button>
          </div>
          {/* Rename and Delete, then the kind pill. The two controls sit before
              it so the pill stays the last thing on the line, where it was. */}
          {(onRename || onDelete) && (
            <div className="flex shrink-0 items-center gap-1">
              {onRename && (
                <button
                  type="button"
                  data-rename-config
                  onClick={onRename}
                  disabled={!renamable}
                  title={renamable ? `Rename ${file.name}` : (renameRefusal(file.kind) ?? '')}
                  aria-label={`Rename ${file.name}`}
                  className={cn(
                    'grid size-6 place-items-center rounded transition-colors',
                    renamable
                      ? 'text-fg-subtle hover:bg-hover hover:text-fg'
                      : 'cursor-default text-fg-subtle opacity-40'
                  )}
                >
                  <PencilIcon width={12} height={12} />
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  data-delete-config
                  onClick={onDelete}
                  title={`Delete ${file.name}`}
                  aria-label={`Delete ${file.name}`}
                  className="grid size-6 place-items-center rounded text-fg-subtle transition-colors hover:bg-danger/10 hover:text-danger"
                >
                  <TrashIcon width={12} height={12} />
                </button>
              )}
            </div>
          )}
          <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-[10px] tracking-[.05em] text-accent-text uppercase">
            {file.kind === 'settings-local' ? 'settings.local' : file.kind}
          </span>
        </div>

        {/* The frontmatter, as a header rather than as the first eight lines of
            the file. `description` is the field that decides whether a skill is
            ever selected, and it is the one nobody scrolls up to check. */}
        {frontmatter && frontmatter.fields.length > 0 && (
          <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {frontmatter.fields.map((field) => (
              <div key={field.key} className="flex min-w-0 items-baseline gap-1.5">
                <dt className="shrink-0 text-[10px] tracking-wide text-fg-subtle uppercase">
                  {field.key}
                </dt>
                <dd className="min-w-0 truncate text-[11px] text-fg-muted" title={field.value}>
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {isJson && keys.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {keys.map((key) => {
              const hint = settingHint(topLevelKey(key))
              return (
                <span
                  key={key}
                  title={hint?.summary ?? 'Not a key Helm has a note for. Claude Code may still use it.'}
                  className={cn(
                    'rounded-sm border px-1.5 py-px font-mono text-[10px]',
                    hint
                      ? 'border-border bg-surface-sunken text-fg-muted'
                      : 'border-dashed border-border text-fg-subtle'
                  )}
                >
                  {key}
                </span>
              )
            })}
          </div>
        )}
      </header>

      {/* ----------------------------------------------------------------- */}
      {/* Banners                                                            */}
      {/* ----------------------------------------------------------------- */}
      {external !== null && (
        <div
          role="alert"
          data-external-change
          className="shrink-0 border-b border-warn/30 bg-warn/10 px-5 py-2.5"
        >
          <p className="flex items-center gap-2 text-[12px] font-medium text-warn">
            <WarnIcon width={13} height={13} className="shrink-0" />
            {external.exists
              ? 'This file changed on disk after you opened it'
              : 'This file was removed from disk after you opened it'}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
            Saving is blocked until you decide.{' '}
            {dirty
              ? 'Reloading discards what you have typed here; the version on disk is the one Claude Code would read.'
              : 'Reload to pick up what changed.'}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-reload-external
              onClick={onReload}
              className="rounded-well bg-warn px-2.5 py-1 text-[11px] font-medium text-bg transition hover:brightness-110"
            >
              Reload from disk
            </button>
            <button
              type="button"
              data-overwrite-external
              onClick={() => onSave(draft)}
              disabled={blocked}
              className={cn(
                'rounded-well border border-border-strong px-2.5 py-1 text-[11px] text-fg transition-colors',
                blocked ? 'cursor-default opacity-50' : 'hover:bg-hover'
              )}
            >
              Keep mine and overwrite
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p
          role="alert"
          data-editor-error
          className="shrink-0 border-b border-danger/30 bg-danger/10 px-5 py-2 text-[11px] text-danger"
        >
          {error}
        </p>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* The text                                                           */}
      {/* ----------------------------------------------------------------- */}
      <div className="min-h-0 flex-1 px-5 py-3">
        {loaded === null ? (
          <p className="text-[12px] text-fg-subtle">Reading&hellip;</p>
        ) : loaded.binary ? (
          <p className="rounded-raised border border-border bg-surface-sunken px-3 py-2 text-[12px] text-fg-muted">
            {formatBytes(loaded.size)} of binary content. Helm will not rewrite a file it cannot
            read as text.
          </p>
        ) : (
          <textarea
            ref={areaRef}
            data-config-editor
            value={draft}
            onChange={onChange}
            onKeyUp={updateCaret}
            onClick={updateCaret}
            spellCheck={false}
            wrap="off"
            aria-label={`Edit ${file.relPath}`}
            className={cn(
              'h-full w-full resize-none rounded-raised border bg-surface-sunken p-3',
              'font-mono text-[12px] leading-[1.55] text-fg select-text',
              'focus:outline-none',
              problem !== null ? 'border-danger/50' : 'border-border focus:border-accent'
            )}
          />
        )}
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Status and actions                                                 */}
      {/* ----------------------------------------------------------------- */}
      <footer className="shrink-0 border-t border-border">
        {problem !== null && (
          <button
            type="button"
            data-json-error
            onClick={goToProblem}
            className="flex w-full items-baseline gap-2 border-b border-danger/20 bg-danger/10 px-5 py-1.5 text-left"
          >
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-danger">
              {problem.line}:{problem.column}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-danger">
              {problem.message}
            </span>
            <span className="shrink-0 text-[10px] text-danger/70">Go to it</span>
          </button>
        )}

        <div className="flex items-center gap-3 px-5 py-2.5">
          <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-fg-subtle">
            <span>
              Ln {caret.line}, Col {caret.column}
            </span>
            <span aria-hidden>·</span>
            <span>{formatBytes(new TextEncoder().encode(draft).length)}</span>
          </span>

          {snapshots.length > 0 && (
            <button
              type="button"
              data-toggle-history
              aria-expanded={showHistory}
              onClick={() => setShowHistory((open) => !open)}
              className="text-[11px] text-fg-subtle transition-colors hover:text-accent-text"
            >
              {snapshots.length} {snapshots.length === 1 ? 'version' : 'versions'}
            </button>
          )}

          <span className="flex-1" />

          <span
            data-dirty={dirty}
            className={cn('text-[11px]', dirty ? 'text-warn' : 'text-fg-subtle')}
          >
            {saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}
          </span>

          {dirty && (
            <button
              type="button"
              onClick={() => loaded && setDraft(loaded.content)}
              className="rounded-well border border-border-strong px-2.5 py-1 text-[11px] text-fg transition-colors hover:bg-hover"
            >
              Revert
            </button>
          )}
          <button
            type="button"
            data-save-config
            onClick={() => onSave(draft)}
            disabled={!canSave}
            title={
              blocked
                ? 'The JSON is not valid, so it cannot be written'
                : external !== null
                  ? 'The file changed on disk; decide above first'
                  : 'Write this file'
            }
            className={cn(
              // Outlined accent, never filled (DESIGN.md); disabled keeps the
              // outline at half strength rather than swapping to a grey fill.
              'flex items-center gap-1.5 rounded-well border px-2.5 py-1 text-[11px] font-medium transition-colors',
              canSave
                ? 'border-accent text-accent-text hover:bg-accent-soft'
                : 'cursor-default border-border text-fg-subtle opacity-60'
            )}
          >
            <SaveIcon width={12} height={12} />
            Save
          </button>
        </div>

        {showHistory && (
          <History snapshots={snapshots} onRestore={onRestore} />
        )}
      </footer>
    </div>
  )
}

/**
 * Every version Helm has taken of this file.
 *
 * Sized and hashed rather than diffed: the point of the list is to find the one
 * you want back, and a timestamp plus a byte count does that for a settings
 * file with four versions. The hash is shown because the criterion this exists
 * for is that a restore returns the *exact* prior bytes, and a truncated hash
 * is how a person checks that claim without leaving the app.
 */
function History({
  snapshots,
  onRestore
}: {
  snapshots: ConfigSnapshotMeta[]
  onRestore: (snapshot: ConfigSnapshotMeta) => void
}): JSX.Element {
  return (
    <ol
      data-snapshot-list
      className="max-h-48 overflow-y-auto border-t border-border bg-surface-sunken"
    >
      {snapshots.map((snapshot) => (
        <li
          key={snapshot.id}
          className="flex items-center gap-3 border-b border-border px-5 py-1.5 last:border-b-0"
        >
          <span
            className="w-12 shrink-0 text-[10px] tabular-nums text-fg-subtle"
            title={formatMoment(Date.parse(snapshot.createdAt))}
          >
            {formatAge(Date.parse(snapshot.createdAt))}
          </span>
          <span className="w-14 shrink-0 text-[10px] tracking-wide text-fg-subtle uppercase">
            {snapshot.reason}
          </span>
          <span className="w-16 shrink-0 text-[10px] tabular-nums text-fg-muted">
            {snapshot.reason === 'create' ? 'absent' : formatBytes(snapshot.bytes)}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-subtle">
            {snapshot.contentHash.slice(0, 12)}
          </span>
          <button
            type="button"
            data-restore={snapshot.id}
            onClick={() => onRestore(snapshot)}
            title="Put these bytes back, snapshotting what is there now"
            className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <RestoreIcon width={10} height={10} />
            Restore
          </button>
        </li>
      ))}
    </ol>
  )
}

/** Shared by the panes that report the result of a write. */
export function Result({
  ok,
  children
}: {
  ok: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-raised border px-3 py-2 text-[11px]',
        ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'
      )}
    >
      {ok ? (
        <CheckIcon width={13} height={13} className="mt-px shrink-0" />
      ) : (
        <WarnIcon width={13} height={13} className="mt-px shrink-0" />
      )}
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  )
}
