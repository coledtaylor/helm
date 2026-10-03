import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ConfigSnapshotMeta, ContentDocument, ContentFile, EditorHighlight, RenderedMarkdown } from '@helm/core'
import { cn } from '../lib/cn'
import { CodeEditor, type EditorStatus } from './CodeEditor'
import { ConsolePanel } from './ConsolePanel'
import { formatAge, formatBytes, formatMoment } from '../lib/time'
// The rendered body and the frontmatter chips are shared with the config
// console, which opens the same markdown out of a `.claude` tree.
import { FrontmatterChips, MarkdownBody } from './MarkdownBody'
import { ArtifactIcon, LinkIcon, RestoreIcon, SaveIcon, WarnIcon, WrapIcon } from './icons'

export type ContentMode = 'read' | 'edit'

/** One line an artifact wrote to its console, as the main process saw it. */
export interface ArtifactConsoleEntry {
  level: string
  message: string
  source: string
  line: number
}

export interface ContentDocumentPaneProps {
  file: ContentFile
  /** The file as loaded, with its rendered form. Null while the read is in flight. */
  document: ContentDocument | null
  /** The draft's rendered form, for the split preview. Null when not editing. */
  preview: RenderedMarkdown | null
  previewPending: boolean

  /** Read renders; edit is the editor beside a live preview, for a note only. */
  mode: ContentMode

  /** The URL a sandboxed frame may load, for an HTML artifact. */
  artifactUrl: string | null
  /**
   * What the artifact logged. Collected in the main process, not here: the
   * frame has an opaque origin, so this window cannot reach its console - only
   * the process hosting both of them can.
   */
  artifactConsole: ArtifactConsoleEntry[]

  snapshots: ConfigSnapshotMeta[]
  saving: boolean
  error: string | null
  external: { hash: string; content: string; exists: boolean } | null

  /** The search term the file was opened from, highlighted in the reading view. */
  highlight: string | null

  /**
   * The draft to start the editor on instead of the file - what this tab held
   * when it last went behind another. Read once, on the first load.
   */
  initialDraft?: string | null | undefined

  /**
   * Tokenises the draft for the editor's underlay, over IPC. Must be stable
   * across renders - it is an effect dependency one layer down.
   */
  onHighlight?: ((path: string, source: string) => Promise<EditorHighlight>) | null

  onSave: (content: string) => void
  onReload: () => void
  onRestore: (snapshot: ConfigSnapshotMeta) => void
  onDirtyChange: (dirty: boolean) => void
  onDraftChange: (draft: string) => void
  /** A `[[wikilink]]` that resolved. */
  onOpenPath: (path: string, heading: string | null) => void
  /**
   * A `[[wikilink]]` clicked *inside* a sandboxed artifact, which arrives as a
   * name rather than a path - the frame is deliberately told no paths, so the
   * host resolves it.
   */
  onOpenWikilink: (target: string, heading: string | null) => void
  /** An `https://` link in a note. */
  onOpenExternal: (url: string) => void
}

/**
 * A note or an HTML artifact, opened from the Files view: a note rendered, or
 * edited beside a live preview; an artifact in a frame that can reach nothing.
 *
 * Its file tab says the rest. The path is on the crumb above it, and the
 * crumb's Preview / Source / Edit switch is what decides between this pane and
 * the plain file view - so there is no title block here, only what belongs to
 * the document itself: its frontmatter, its unwritten links, and the save.
 */
export function ContentDocumentPane(props: ContentDocumentPaneProps): JSX.Element {
  const {
    file,
    document: loaded,
    preview,
    previewPending,
    mode,
    artifactUrl,
    artifactConsole,
    snapshots,
    saving,
    error,
    external,
    highlight,
    initialDraft = null,
    onHighlight = null,
    onSave,
    onReload,
    onRestore,
    onDirtyChange,
    onDraftChange,
    onOpenPath,
    onOpenWikilink,
    onOpenExternal
  } = props

  // Seeded at once when the file is already here, so the first render reports
  // the draft it will keep rather than an empty one a frame before it.
  const [draft, setDraft] = useState(() => (loaded === null ? '' : (initialDraft ?? loaded.content.content)))
  const [showHistory, setShowHistory] = useState(false)
  const [status, setStatus] = useState<EditorStatus | null>(null)
  // On, because a note is prose and a paragraph is one very long line - a
  // horizontal scrollbar under one is unusable. The toggle is there for the
  // table that reads better unwrapped.
  const [wrap, setWrap] = useState(true)

  // Re-seeded whenever a different file, or a different version of it, arrives.
  // Keyed on the hash rather than the path so a reload after an external change
  // replaces the text and a re-render for any other reason does not - the same
  // rule the config editor follows, and for the same reason.
  // The delimiter is NUL because it is the one byte that cannot appear in a
  // path, so no filename can forge a basis by containing the separator.
  // Written as an escape and never as a raw byte: a literal 0x00 in the
  // source makes git classify this whole file as binary, so every diff of it
  // reports "Bin n -> m bytes" and a three-way merge refuses outright. And
  // \u0000 rather than \0, which is an octal escape the moment a digit
  // follows it.
  const basis = `${file.path}\u0000${loaded?.content.hash ?? ''}`
  const seeded = useRef<string | null>(loaded === null ? null : basis)
  useEffect(() => {
    if (loaded === null) return
    if (seeded.current === basis) return
    // A draft left behind is the first thing seeded and only that: a reload
    // after it is somebody choosing the file over the draft.
    const first = seeded.current === null
    seeded.current = basis
    setDraft(first && initialDraft !== null ? initialDraft : loaded.content.content)
    setShowHistory(false)
  }, [basis, loaded, initialDraft])

  const dirty = loaded !== null && draft !== loaded.content.content
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])
  useEffect(() => onDraftChange(draft), [draft, onDraftChange])

  const isMarkdown = file.kind === 'markdown'
  const editing = mode === 'edit' && isMarkdown && loaded !== null && !loaded.content.binary
  const rendered = editing && preview !== null ? preview : (loaded?.rendered ?? null)
  const canSave = loaded !== null && dirty && !saving && external === null && !loaded.content.binary

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header
        // While editing, the chips follow the *draft*: changing `type:` in the
        // frontmatter and watching the header keep the old value would be the
        // preview lying about the half of the document it is responsible for.
        rendered={rendered}
        editing={editing}
        wrap={wrap}
        onWrapChange={setWrap}
      />

      {external !== null && (
        <div
          role="alert"
          data-content-external
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
              ? 'Reloading discards what you have typed here.'
              : 'Reload to pick up what changed.'}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-content-reload
              onClick={onReload}
              className="rounded-well border border-warn/60 px-2.5 py-1 text-[11px] font-medium text-warn transition-colors hover:bg-warn/10"
            >
              Reload from disk
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p
          role="alert"
          data-content-error
          className="shrink-0 border-b border-danger/30 bg-danger/10 px-5 py-2 text-[11px] text-danger"
        >
          {error}
        </p>
      )}

      {loaded?.error != null && (
        <p
          role="alert"
          data-content-render-error
          className="shrink-0 border-b border-danger/30 bg-danger/10 px-5 py-2 text-[11px] text-danger"
        >
          This file could not be rendered: {loaded.error}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        {editing && (
          // `pl-5` so the editor's left edge lines up with the rendered text
          // beside it rather than sitting eight pixels inside it.
          <div className="flex w-1/2 min-w-0 shrink-0 flex-col border-r border-border py-3 pr-3 pl-5">
            <CodeEditor
              surface="content"
              path={file.path}
              value={draft}
              onChange={setDraft}
              onHighlight={onHighlight}
              wrap={wrap}
              onStatusChange={setStatus}
              ariaLabel={`Edit ${file.relPath}`}
            />
          </div>
        )}

        {file.kind === 'html' ? (
          // Keyed on the URL so a different artifact gets a fresh frame and a
          // fresh "has it painted yet" - the alternative is resetting that
          // state from an effect, which is a cascading render for a value a
          // remount already gives correctly.
          <ArtifactFrame
            key={artifactUrl}
            url={artifactUrl}
            file={file}
            entries={artifactConsole}
            onOpenWikilink={onOpenWikilink}
          />
        ) : (
          <MarkdownBody
            path={file.path}
            rendered={rendered}
            stale={editing && previewPending}
            // No contents column beside a split editor. The preview already
            // has half the pane; taking another 13rem out of it leaves a
            // measure narrow enough that every second line wraps.
            compact={editing}
            highlight={editing ? null : highlight}
            onOpenPath={onOpenPath}
            onOpenExternal={onOpenExternal}
          />
        )}
      </div>

      <footer className="shrink-0 border-t border-border">
        <div className="flex h-6 items-center gap-3 px-3">
          <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-fg-subtle">
            <span>{formatBytes(loaded?.content.size ?? file.size)}</span>
            {loaded?.rendered && (
              <>
                <span aria-hidden>·</span>
                <span data-content-words={loaded.rendered.words}>
                  {loaded.rendered.words.toLocaleString()} words
                </span>
                <span aria-hidden>·</span>
                <span data-content-render-ms={loaded.rendered.tookMs}>
                  rendered in {loaded.rendered.tookMs} ms
                </span>
              </>
            )}
            {/* Why the editor has no colour in it. The same ceiling the
                reading view degrades at, so pressing Edit does not change the
                answer - and a grey editor with nothing said about it reads as
                a highlighter that broke. */}
            {editing && status?.tooLarge === true && (
              <>
                <span aria-hidden>·</span>
                <span
                  data-editor-degraded
                  title="Past the size ceiling the editor drops the highlighted underlay entirely rather than getting slow, so the line-number gutter and match painting are off with it. Typing, find and go to line all still work."
                >
                  plain text: too large to highlight
                </span>
              </>
            )}
          </span>

          {snapshots.length > 0 && (
            <button
              type="button"
              data-content-history
              aria-expanded={showHistory}
              onClick={() => setShowHistory((open) => !open)}
              className="text-[11px] text-fg-subtle transition-colors hover:text-accent-text"
            >
              {snapshots.length} {snapshots.length === 1 ? 'version' : 'versions'}
            </button>
          )}

          <span className="flex-1" />

          {editing && (
            <>
              <span
                data-content-dirty={dirty}
                className={cn('text-[11px]', dirty ? 'text-warn' : 'text-fg-subtle')}
              >
                {saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}
              </span>
              {dirty && (
                <button
                  type="button"
                  onClick={() => loaded && setDraft(loaded.content.content)}
                  className="flex h-5 items-center rounded-xs px-1.5 text-[11px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  Revert
                </button>
              )}
              <button
                type="button"
                data-content-save
                onClick={() => onSave(draft)}
                disabled={!canSave}
                title={external !== null ? 'The file changed on disk; decide above first' : 'Write this file'}
                className={cn(
                  'flex h-5 items-center gap-1 rounded-xs px-1.5 text-[11px] transition-colors',
                  canSave ? 'text-accent-text hover:bg-accent-soft' : 'cursor-default text-fg-subtle opacity-60'
                )}
              >
                <SaveIcon width={11} height={11} />
                Save
              </button>
            </>
          )}
        </div>

        {showHistory && <History snapshots={snapshots} onRestore={onRestore} />}
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header: the frontmatter chip row
// ---------------------------------------------------------------------------

/**
 * What the document says about itself - its frontmatter as chips, and the
 * wikilinks with no note behind them - and the wrap toggle while it is being
 * edited. Nothing at all when there is none of that: a README with no
 * frontmatter starts on its first heading.
 */
function Header({
  rendered,
  editing,
  wrap,
  onWrapChange
}: {
  rendered: RenderedMarkdown | null
  editing: boolean
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
}): JSX.Element | null {
  const chips = rendered?.frontmatter.fields ?? []
  const broken = rendered?.counts.brokenWikilinks ?? 0
  const yamlError = rendered?.frontmatter.error ?? null
  if (chips.length === 0 && broken === 0 && yamlError === null && !editing) return null

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-5 py-2">
      {/* `type`, `date` and `tags` are this vault's own convention and are what
          a note is filed under; showing them as YAML would be showing the
          storage format of the one thing the reader wanted rendered. */}
      {chips.length > 0 && (
        <div className="min-w-0">
          <FrontmatterChips fields={chips} />
        </div>
      )}
      {yamlError !== null && (
        <p className="text-[11px] text-danger">The frontmatter block is not valid YAML: {yamlError}</p>
      )}
      <span className="flex-1" />
      {broken > 0 && (
        <span
          data-broken-links={broken}
          title="Wikilinks with no note behind them yet. In this vault that marks a note worth writing, not a mistake."
          className="flex shrink-0 items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[10px] text-warn"
        >
          <LinkIcon width={10} height={10} />
          {broken} unwritten
        </span>
      )}
      {editing && (
        // A lone toggle rather than an On/Off pair: wrapping is one thing
        // that is either happening or not.
        <button
          type="button"
          data-content-wrap
          aria-pressed={wrap}
          onClick={() => onWrapChange(!wrap)}
          title={
            wrap
              ? 'Long lines wrap. Click to let them run off to the right.'
              : 'Long lines run off to the right. Click to wrap them.'
          }
          className={cn(
            'flex h-6 shrink-0 items-center gap-1.5 rounded-well border px-2 text-[11px] transition-colors',
            wrap
              ? 'border-accent/50 text-accent-text hover:bg-accent-soft'
              : 'border-border-strong text-fg-muted hover:bg-hover hover:text-fg'
          )}
        >
          <WrapIcon width={11} height={11} />
          Wrap
        </button>
      )}
    </header>
  )
}

// ---------------------------------------------------------------------------
// The artifact frame
// ---------------------------------------------------------------------------

/**
 * An HTML artifact, in a frame that can reach nothing.
 *
 * Four independent things make that true, and the frame is only as safe as the
 * weakest of them, which is why none of them is left implicit:
 *
 *   - `sandbox="allow-scripts"` and *not* `allow-same-origin`. The document
 *     gets an opaque origin, so it cannot read this window, its storage, or
 *     anything Helm has. Scripts are allowed because a generated report is
 *     usually a chart.
 *   - The source is a `helm-content://` URL bound to a token the main process
 *     minted for this file. The frame cannot name a path; it can only ask for
 *     something under the directory that token pinned.
 *   - The response carries a Content Security Policy with `default-src 'none'`
 *     and no `http:` or `https:` in any directive, so remote content is not
 *     blocked by policy at the app level - it has nowhere to be requested from.
 *   - Node is not in the renderer at all (`nodeIntegration: false`,
 *     `sandbox: true` on the window), and subframes do not get it back.
 *
 * The console is captured rather than assumed quiet: "no console errors" is an
 * acceptance criterion, and a criterion nothing observes is a wish.
 */
function ArtifactFrame({
  url,
  file,
  entries,
  onOpenWikilink
}: {
  url: string | null
  file: ContentFile
  entries: ArtifactConsoleEntry[]
  onOpenWikilink: (target: string, heading: string | null) => void
}): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)

  /**
   * A `[[wikilink]]` clicked inside the frame.
   *
   * `postMessage` is the only channel there is: the frame has an opaque origin,
   * so nothing in this window can read into it and nothing in it can reach out
   * except this. The origin on the event is the string `"null"` for exactly
   * that reason, which makes it useless as a check - so the check is on the
   * **source window** instead, and it is the whole of the trust here. What
   * comes through is a name, not a path, and the main process resolves it
   * against the vault's own index: a hostile artifact posting nonsense gets a
   * file that does not exist, and posting a real name opens a note the reader
   * could have clicked in the list beside it.
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (frameRef.current === null || event.source !== frameRef.current.contentWindow) return
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null) return
      const message = data as { helm?: unknown; target?: unknown; heading?: unknown }
      if (message.helm !== 'wikilink' || typeof message.target !== 'string') return
      onOpenWikilink(
        message.target,
        typeof message.heading === 'string' ? message.heading : null
      )
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onOpenWikilink])

  const errors = entries.filter((entry) => entry.level === 'error' || entry.level === 'warning')
  const [consoleOpen, setConsoleOpen] = useState(false)

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-sunken px-4 py-1.5">
        <ArtifactIcon width={12} height={12} className="shrink-0 text-fg-subtle" />
        <span className="text-[11px] text-fg-subtle">
          Sandboxed frame · no Node, no network, opaque origin
        </span>
        <span className="flex-1" />
        {/*
          The count that used to be a dead tooltip.
          `attachArtifactConsole` has been streaming these since artifacts
          landed and `useContent` has been keeping them; the only way to read
          any of it was a `title` attribute, which is a list you cannot scroll,
          filter or copy out of. It is the panel's toggle now, and the panel is
          the same component the browser pane uses.

          `data-artifact-console` stays exactly where it was, because a
          driver locates the count by it.
        */}
        <button
          type="button"
          data-artifact-console={errors.length}
          onClick={() => setConsoleOpen((current) => !current)}
          aria-expanded={consoleOpen}
          title={consoleOpen ? "Hide what the artifact logged" : "Show what the artifact logged"}
          className={cn(
            'rounded-well px-1.5 py-0.5 text-[11px] tabular-nums transition-colors hover:bg-hover',
            errors.length > 0 ? 'text-danger' : 'text-fg-subtle hover:text-fg'
          )}
        >
          {errors.length === 0
            ? 'console clean'
            : `${String(errors.length)} console error${errors.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {url === null ? (
        <p className="p-8 text-center text-[12px] text-fg-subtle">Opening&hellip;</p>
      ) : (
        <iframe
          ref={frameRef}
          data-artifact-frame
          data-artifact-path={file.path}
          src={url}
          title={file.title}
          // Scripts, and nothing else. No `allow-same-origin`, which is what
          // keeps the origin opaque; no `allow-top-navigation`, no forms, no
          // popups, no pointer lock, no downloads.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          className={cn(
            'min-h-0 w-full flex-1 border-0 bg-white transition-opacity',
            loaded ? 'opacity-100' : 'opacity-0'
          )}
        />
      )}

      {/*
        The same panel the browser pane uses, **read-only**.

        `onEvaluate` is absent and that is the design rather than an omission:
        the frame's origin is opaque and `postMessage` is deliberately the only
        channel into it (see the wikilink handler above). Helm cannot execute in
        there and should not gain the ability to, so the half of the panel that
        would need that is simply not passed.
      */}
      <ConsolePanel
        name="artifact"
        entries={entries}
        open={consoleOpen}
        onToggle={() => setConsoleOpen((current) => !current)}
        note="Read-only. The frame has an opaque origin, so Helm can watch what it logs and cannot run anything inside it."
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

/** Every version Helm has taken of this file - the same list the config
 * console's editor shows, over the same table, because it is the same snapshot
 * mechanism. */
function History({
  snapshots,
  onRestore
}: {
  snapshots: ConfigSnapshotMeta[]
  onRestore: (snapshot: ConfigSnapshotMeta) => void
}): JSX.Element {
  return (
    <ol
      data-content-snapshots={snapshots.length}
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
            data-content-restore={snapshot.id}
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
