import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { EditorHighlight, FileChangeState, FileView as FileViewData } from '@helm/core'
import { changedLineSet, describeFileChanges } from '@helm/core/types'
import { cn } from '../lib/cn'
import { languageName } from '../lib/languages'
import { formatBytes } from '../lib/time'
import { CodeEditor, type EditorLineMarks, type EditorStatus } from './CodeEditor'
import { CheckIcon, CodeIcon, CopyIcon, DocIcon, FolderIcon, WarnIcon, WrapIcon } from './icons'

/**
 * A file, read beside the session changing it.
 *
 * Read-only on purpose: this is the place to watch a file change, and VS Code
 * is one click away to change it. The code sits on the pane itself - no well
 * inside the island - with the lines that differ from the last commit marked
 * in the accent, and a status line along the bottom saying where the caret is
 * and what the file is.
 *
 * Three pieces, exported separately because they live in three places: the
 * body is the pane's contents, the crumb is the row under the tab strip, and
 * the actions sit at the end of the strip itself.
 */

export interface FileViewProps {
  /** The file as last read, or null while the first read is in flight. */
  view: FileViewData | null
  /** The read itself failed - the folder is not one Helm knows, or main threw. */
  error: string | null
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
  /** Tokenises for the editor's underlay. Must be stable across renders. */
  onHighlight: ((path: string, source: string) => Promise<EditorHighlight>) | null
  onCaretChange?: ((caret: { line: number; column: number }) => void) | undefined
  onReveal: (path: string) => void
  /** Null where VS Code is not installed. */
  onOpenInEditor: (() => void) | null
}

/** Marks from how the file stands against the last commit; none for a file wholly new. */
function marksOf(changes: FileChangeState | undefined): EditorLineMarks | null {
  if (changes?.kind !== 'tracked') return null
  if (changes.lines.changedCount === 0 && changes.lines.removedCount === 0) return null
  return { changed: changedLineSet(changes.lines), removedAfter: new Set(changes.lines.removedAfter) }
}

export function FileView({
  view,
  error,
  wrap,
  onWrapChange,
  onHighlight,
  onCaretChange,
  onReveal,
  onOpenInEditor
}: FileViewProps): JSX.Element {
  const [caret, setCaret] = useState({ line: 1, column: 1 })
  const [status, setStatus] = useState<EditorStatus | null>(null)
  // Recomputed only when the changes do, so the editor's gutter is not handed a
  // fresh object on every caret move.
  const changes = view?.changes
  const marks = useMemo(() => marksOf(changes), [changes])

  useEffect(() => {
    onCaretChange?.(caret)
  }, [caret, onCaretChange])

  if (error !== null) {
    return (
      <Notice icon={<WarnIcon width={18} height={18} className="text-danger" />} title="This file could not be read">
        {error}
      </Notice>
    )
  }
  if (view === null) {
    return <p className="px-5 py-4 text-[12px] text-fg-subtle">Reading&hellip;</p>
  }
  if (view.error !== null) {
    return (
      <Notice icon={<WarnIcon width={18} height={18} className="text-warn" />} title="Helm will not show this">
        {view.error}
      </Notice>
    )
  }

  const handOff = (
    <div className="mt-4 flex items-center justify-center gap-2">
      {onOpenInEditor !== null && view.exists && (
        <HandOff onClick={onOpenInEditor}>
          <CodeIcon width={13} height={13} />
          Open in VS Code
        </HandOff>
      )}
      <HandOff onClick={() => onReveal(view.path)}>
        <FolderIcon width={13} height={13} />
        Reveal in Explorer
      </HandOff>
    </div>
  )

  if (!view.exists) {
    return (
      <Notice icon={<DocIcon width={18} height={18} className="text-fg-subtle" />} title="This file is not there any more">
        It was deleted or renamed since this tab opened. If it comes back, it shows here again.
        {handOff}
      </Notice>
    )
  }
  if (view.binary) {
    return (
      <Notice icon={<DocIcon width={18} height={18} className="text-fg-subtle" />} title="Not a text file">
        {formatBytes(view.size)} of binary content. Open it in the program it belongs to.
        {handOff}
      </Notice>
    )
  }
  if (view.tooLarge) {
    return (
      <Notice icon={<DocIcon width={18} height={18} className="text-fg-subtle" />} title="Too large to read here">
        {formatBytes(view.size)} - past what this view reads without freezing the window.
        {handOff}
      </Notice>
    )
  }

  return (
    <div data-file-view-pane={view.relPath} className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 pt-1">
        <CodeEditor
          surface="file"
          path={view.path}
          value={view.content}
          onChange={noEdit}
          readOnly
          bare
          marks={marks}
          wrap={wrap}
          onHighlight={onHighlight}
          onCaretChange={setCaret}
          onStatusChange={setStatus}
          ariaLabel={`Contents of ${view.relPath}`}
        />
      </div>
      <footer className="flex h-6 shrink-0 items-center gap-3.5 border-t border-border px-3 text-[11px] text-fg-subtle tabular-nums">
        <span data-file-caret>
          Ln {caret.line}, Col {caret.column}
        </span>
        <span>{languageName(status?.language ?? 'plaintext')}</span>
        {view.eol !== null && <span title="How this file ends its lines">{view.eol === 'mixed' ? 'Mixed line endings' : view.eol}</span>}
        <span className="flex-1" />
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => onWrapChange(!wrap)}
          title={wrap ? 'Long lines wrap - click to scroll them instead' : 'Long lines scroll - click to wrap them'}
          className={cn(
            'flex h-5 items-center gap-1 rounded-xs px-1 transition-colors hover:bg-hover hover:text-fg',
            wrap && 'text-accent-text'
          )}
        >
          <WrapIcon width={11} height={11} />
          Wrap
        </button>
        <span title="Read here, edit in VS Code">Read only</span>
      </footer>
    </div>
  )
}

/** The editor is read-only, so there is nothing to do with a change. */
const noEdit = (): void => undefined

function Notice({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }): JSX.Element {
  return (
    <div role="status" className="flex h-full items-start justify-center px-6 pt-20">
      <div className="max-w-[440px] text-center">
        <div className="flex justify-center">{icon}</div>
        <p className="mt-2 text-[13px] font-medium text-fg">{title}</p>
        <div className="mt-1 text-[12px] leading-relaxed text-fg-muted">{children}</div>
      </div>
    </div>
  )
}

function HandOff({ onClick, children }: { onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded-well border border-border-strong px-2.5 text-[12px] text-fg transition-colors hover:bg-hover"
    >
      {children}
    </button>
  )
}

/**
 * The row under a file's tab: where it is in its project, and how it stands
 * against the last commit.
 *
 * The file's own name is the one thing here that must survive a narrow pane,
 * so the folders above it give way first and the sentence about git drops to
 * its short form - below 520px of crumb, measured on the crumb itself, since a
 * pane beside a session is a fraction of the window.
 */
export function FileCrumb({
  relPath,
  changes
}: {
  relPath: string
  changes: FileChangeState | null
}): JSX.Element {
  const parts = relPath.split('/')
  const said = changes === null ? null : describeFileChanges(changes)
  return (
    <div
      data-pane-crumb
      data-file-crumb
      className="@container flex h-[26px] shrink-0 items-center border-b border-border px-3 text-[11px] text-fg-subtle"
    >
      <div className="flex w-full min-w-0 items-center gap-3">
        <span className="flex min-w-0 items-center gap-1 font-mono" title={relPath}>
          {parts.slice(0, -1).map((part, index) => (
            <span key={`${String(index)}:${part}`} className="flex min-w-0 shrink items-center gap-1">
              <span className="min-w-0 truncate">{part}</span>
              <span aria-hidden className="shrink-0">
                ›
              </span>
            </span>
          ))}
          <span className="shrink-0 text-fg-muted">{parts.at(-1)}</span>
        </span>
        <span className="flex-1" />
        {said !== null && (
          <span
            data-file-changes={changes?.kind}
            title={changes?.kind === 'unknown' ? `${said.text}: ${changes.reason}` : said.text}
            className={cn(
              'flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap',
              said.marked ? 'text-accent-text' : 'text-fg-subtle'
            )}
          >
            {said.marked && <span aria-hidden className="h-[11px] w-[2px] shrink-0 rounded-[1px] bg-accent" />}
            <span className="hidden @[520px]:inline">{said.text}</span>
            <span className="@[520px]:hidden">{said.short}</span>
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The hand-offs, at the end of a file tab's strip: VS Code, Explorer and the
 * path. VS Code is named because it is the editor the file goes to; the other
 * two are glyphs every Windows user reads without a word.
 */
export function FileActions({
  path,
  onOpenInEditor,
  onReveal,
  onCopyPath
}: {
  path: string
  /** Null where VS Code is not installed; the button says so rather than vanishing. */
  onOpenInEditor: (() => void) | null
  onReveal: (path: string) => void
  onCopyPath: (path: string) => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="mr-1 flex items-center gap-0.5" data-file-actions>
      <button
        type="button"
        onClick={onOpenInEditor ?? undefined}
        disabled={onOpenInEditor === null}
        title={onOpenInEditor === null ? 'VS Code is not installed on this machine' : 'Open this file in VS Code, at the line the caret is on'}
        className={cn(
          'flex h-[26px] items-center gap-1.5 rounded-well border border-border-strong px-2 text-[12px] text-fg transition-colors',
          'hover:bg-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent'
        )}
      >
        <CodeIcon width={13} height={13} />
        Open in VS Code
      </button>
      <IconAction label="Reveal in Explorer" onClick={() => onReveal(path)}>
        <FolderIcon width={14} height={14} />
      </IconAction>
      <IconAction
        label={copied ? 'Path copied' : 'Copy path'}
        onClick={() => {
          onCopyPath(path)
          setCopied(true)
        }}
      >
        {copied ? <CheckIcon width={14} height={14} className="text-success" /> : <CopyIcon width={14} height={14} />}
      </IconAction>
    </div>
  )
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-[26px] place-items-center rounded-well text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
    >
      {children}
    </button>
  )
}
