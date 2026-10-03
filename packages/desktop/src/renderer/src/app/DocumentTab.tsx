import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { EditorHighlight } from '@helm/core'
import { ContentDocumentPane, cn, EyeIcon, PencilIcon, CodeIcon } from '@helm/ui'
import { drafts } from './drafts'
import { useDocument } from './useDocument'

/**
 * How a note or an artifact is on screen in its file tab.
 *
 * Preview renders it - the note as a page, the artifact in its sandboxed
 * frame. Source is the plain file view every other file gets, with the lines
 * that changed since the last commit marked. Edit, for a note only, is the
 * editor beside a live preview, and the one place in the Files view anything
 * is written.
 */
export type DocumentMode = 'preview' | 'source' | 'edit'

/** A file that opens rendered rather than as source. */
export function documentKind(path: string): 'markdown' | 'html' | null {
  const lower = path.toLowerCase()
  if (/\.(md|markdown|mdx)$/.test(lower)) return 'markdown'
  if (/\.html?$/.test(lower)) return 'html'
  return null
}

export interface DocumentTabProps {
  /** The deepest folder Helm knows that holds the file - what it is saved and linked as part of. */
  scopePath: string
  path: string
  kind: 'markdown' | 'html'
  mode: DocumentMode
  /** The plain file view, for Source. Built by the caller, which owns its reads. */
  source: ReactNode
  /** The words a text search opened the file on, marked in the preview. */
  highlight: string | null
  /** Where its unsaved draft is kept between showings (`drafts`). */
  draftKey: string
  onDirtyChange: (dirty: boolean) => void
  onHighlight: (path: string, source: string) => Promise<EditorHighlight>
  onOpenPath: (path: string) => void
  onOpenExternal: (url: string) => void
}

export function DocumentTab({
  scopePath,
  path,
  kind,
  mode,
  source,
  highlight,
  draftKey,
  onDirtyChange,
  onHighlight,
  onOpenPath,
  onOpenExternal
}: DocumentTabProps): JSX.Element {
  const editing = mode === 'edit' && kind === 'markdown'
  // The draft as it stands, for whichever editor mounts next: the tab's own
  // edits are the truth from the moment it opens, and Source unmounts the
  // editor while the tab stays.
  const [kept, setKept] = useState(() => drafts.get(draftKey))
  const [startedWith] = useState(kept)
  const doc = useDocument({ scopePath, path, kind, editing, parked: startedWith })
  const { setDraft, setDirty } = doc

  const loaded = doc.document?.content ?? null
  // Worked out against the file every time rather than remembered, so a save -
  // which changes the file to match the draft, not the draft - clears it.
  const dirty = kept !== null && (loaded === null || kept.content !== loaded.content)
  // What a draft is typed against: a parked draft's own base while the file
  // has moved under it and nobody has reloaded, the file as read otherwise.
  const base = doc.external !== null && startedWith !== null ? startedWith.baseHash : (loaded?.hash ?? null)

  const changeDraft = useCallback(
    (draft: string) => {
      setDraft(draft)
      if (loaded === null || base === null) return
      setKept((current) =>
        draft === loaded.content ? null : current?.content === draft ? current : { content: draft, baseHash: base }
      )
    },
    [setDraft, loaded, base]
  )

  // Told outside the render that changed it, once per change.
  useEffect(() => drafts.set(draftKey, dirty ? kept : null), [draftKey, dirty, kept])
  useEffect(() => {
    setDirty(dirty)
    onDirtyChange(dirty)
  }, [dirty, setDirty, onDirtyChange])

  if (mode === 'source') return <>{source}</>

  const file = doc.document?.file ?? null
  if (file === null) {
    return (
      <p className={cn('px-5 py-4 text-[12px]', doc.error === null ? 'text-fg-subtle' : 'text-danger')} role="status">
        {doc.error ?? 'Reading…'}
      </p>
    )
  }

  return (
    <ContentDocumentPane
      file={file}
      document={doc.document}
      preview={doc.preview}
      previewPending={doc.previewPending}
      mode={editing ? 'edit' : 'read'}
      artifactUrl={doc.artifactUrl}
      artifactConsole={doc.artifactConsole}
      snapshots={doc.snapshots}
      saving={doc.saving}
      error={doc.error}
      external={doc.external}
      highlight={highlight}
      initialDraft={kept?.content ?? null}
      onHighlight={onHighlight}
      onSave={doc.save}
      onReload={doc.reload}
      onRestore={doc.restore}
      onDirtyChange={noop}
      onDraftChange={changeDraft}
      onOpenPath={(target) => onOpenPath(target)}
      onOpenWikilink={(target) => {
        void doc.resolveWikilink(target).then((resolved) => {
          if (resolved !== null) onOpenPath(resolved)
        })
      }}
      onOpenExternal={onOpenExternal}
    />
  )
}

/** Dirty is worked out here from the draft, so the pane's own report is not needed. */
const noop = (): void => undefined

/**
 * The crumb's switch between the three. HTML has no Edit: an artifact is
 * generated, and the editor that fits it is the one that generated it.
 */
export function DocumentModeSwitch({
  kind,
  mode,
  onChange
}: {
  kind: 'markdown' | 'html'
  mode: DocumentMode
  onChange: (mode: DocumentMode) => void
}): JSX.Element {
  const options: Array<{ id: DocumentMode; label: string; Icon: typeof EyeIcon }> = [
    { id: 'preview', label: 'Preview', Icon: EyeIcon },
    { id: 'source', label: 'Source', Icon: CodeIcon },
    ...(kind === 'markdown' ? [{ id: 'edit' as const, label: 'Edit', Icon: PencilIcon }] : [])
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Show as"
      data-document-mode={mode}
      className="ml-3 flex items-center gap-px rounded-well border border-border bg-surface-sunken p-px"
    >
      {options.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={mode === id}
          onClick={() => onChange(id)}
          className={cn(
            'flex h-[18px] items-center gap-1 rounded-raised px-1.5 text-[11px] transition-colors',
            mode === id ? 'bg-surface-raised text-fg ring-1 ring-border-strong hover:bg-active' : 'text-fg-subtle hover:text-fg'
          )}
        >
          <Icon width={10} height={10} />
          {label}
        </button>
      ))}
    </div>
  )
}
