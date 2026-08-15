import type { ChangeEvent, JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type {
  ConfigSnapshotMeta,
  ContentDocument,
  ContentFile,
  ContentSource,
  RenderedMarkdown
} from '@helm/core'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import { formatAge, formatBytes, formatMoment } from '../lib/time'
// The rendered body and the frontmatter chips are shared with the config
// console, which opens the same markdown out of a `.claude` tree.
import { FrontmatterChips, MarkdownBody } from './MarkdownBody'
import {
  ArtifactIcon,
  EyeIcon,
  LinkIcon,
  PencilIcon,
  RestoreIcon,
  SaveIcon,
  WarnIcon
} from './icons'

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

  mode: ContentMode
  onModeChange: (mode: ContentMode) => void

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

  onSave: (content: string) => void
  onReload: () => void
  onRestore: (snapshot: ConfigSnapshotMeta) => void
  onReveal: (path: string) => void
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
 * One document, read or edited.
 *
 * Three surfaces behind one header, chosen by what the file is rather than by a
 * setting: markdown renders, HTML goes to a sandboxed frame, and everything
 * else is source. The header is the same in all three cases - name, path,
 * frontmatter - because that is the part a reader uses to know what they are
 * looking at, and it should not move when the body changes shape.
 */
export function ContentDocumentPane(props: ContentDocumentPaneProps): JSX.Element {
  const {
    file,
    document: loaded,
    preview,
    previewPending,
    mode,
    onModeChange,
    artifactUrl,
    artifactConsole,
    snapshots,
    saving,
    error,
    external,
    highlight,
    onSave,
    onReload,
    onRestore,
    onReveal,
    onDirtyChange,
    onDraftChange,
    onOpenPath,
    onOpenWikilink,
    onOpenExternal
  } = props

  const [draft, setDraft] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)

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
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (loaded === null) return
    if (seeded.current === basis) return
    seeded.current = basis
    setDraft(loaded.content.content)
    setShowHistory(false)
  }, [basis, loaded])

  const dirty = loaded !== null && draft !== loaded.content.content
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])
  useEffect(() => onDraftChange(draft), [draft, onDraftChange])

  const isMarkdown = file.kind === 'markdown'
  const isHtml = file.kind === 'html'
  const rendered = mode === 'edit' && preview !== null ? preview : (loaded?.rendered ?? null)
  const canSave = loaded !== null && dirty && !saving && external === null && !loaded.content.binary

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => setDraft(event.target.value)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header
        file={file}
        // While editing, the chips follow the *draft*: changing `type:` in the
        // frontmatter and watching the header keep the old value would be the
        // preview lying about the half of the document it is responsible for.
        rendered={rendered}
        mode={mode}
        onModeChange={onModeChange}
        onReveal={onReveal}
        editable={!loaded?.content.binary}
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
              className="rounded-well bg-warn px-2.5 py-1 text-[11px] font-medium text-bg transition hover:brightness-110"
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
        {mode === 'edit' && (
          <div
            className={cn(
              // `pl-5` so the editor's left edge lines up with the title above
              // it rather than sitting eight pixels inside it.
              'flex min-w-0 flex-col py-3 pl-5',
              isMarkdown ? 'w-1/2 shrink-0 border-r border-border pr-3' : 'flex-1 pr-5'
            )}
          >
            {loaded === null ? (
              <p className="text-[12px] text-fg-subtle">Reading&hellip;</p>
            ) : loaded.content.binary ? (
              <p className="rounded-raised border border-border bg-surface-sunken px-3 py-2 text-[12px] text-fg-muted">
                {formatBytes(loaded.content.size)} of binary content. Helm will not rewrite a file it
                cannot read as text.
              </p>
            ) : (
              <textarea
                ref={areaRef}
                data-content-editor
                value={draft}
                onChange={onChange}
                spellCheck={false}
                // Soft wrap, unlike the config editor's. That one edits JSON,
                // where a wrapped line hides the structure; this one edits
                // prose, where a paragraph is one very long line and a
                // horizontal scrollbar under it is unusable.
                wrap="soft"
                aria-label={`Edit ${file.relPath}`}
                className={cn(
                  'h-full w-full resize-none rounded-raised border border-border bg-surface-sunken p-3',
                  'font-mono text-[12px] leading-[1.55] text-fg select-text',
                  'focus:border-accent focus:outline-none'
                )}
              />
            )}
          </div>
        )}

        {(mode === 'read' || isMarkdown) &&
          (isHtml && mode === 'read' ? (
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
          ) : file.kind === 'binary' && mode === 'read' ? (
            <BinaryBody file={file} bytes={loaded?.content.size ?? file.size} onReveal={onReveal} />
          ) : isMarkdown ? (
            <MarkdownBody
              path={file.path}
              rendered={rendered}
              stale={mode === 'edit' && previewPending}
              // No contents column beside a split editor. The preview already
              // has half the pane; taking another 13rem out of it leaves a
              // measure narrow enough that every second line wraps.
              compact={mode === 'edit'}
              highlight={mode === 'read' ? highlight : null}
              onOpenPath={onOpenPath}
              onOpenExternal={onOpenExternal}
            />
          ) : (
            <SourceBody
              content={loaded?.content.content ?? ''}
              loading={loaded === null}
              binary={loaded?.content.binary ?? false}
              source={loaded?.source ?? null}
            />
          ))}
      </div>

      <footer className="shrink-0 border-t border-border">
        <div className="flex items-center gap-3 px-5 py-2.5">
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

          {mode === 'edit' && (
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
                  className="rounded-well border border-border-strong px-2.5 py-1 text-[11px] text-fg transition-colors hover:bg-hover"
                >
                  Revert
                </button>
              )}
              <button
                type="button"
                data-content-save
                onClick={() => onSave(draft)}
                disabled={!canSave}
                title={
                  external !== null ? 'The file changed on disk; decide above first' : 'Write this file'
                }
                className={cn(
                  'flex items-center gap-1.5 rounded-well border px-2.5 py-1 text-[11px] font-medium transition-colors',
                  canSave
                    ? 'border-accent text-accent-text hover:bg-accent-soft'
                    : 'cursor-default border-border text-fg-subtle opacity-60'
                )}
              >
                <SaveIcon width={12} height={12} />
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
// Header: identity and the frontmatter chip row
// ---------------------------------------------------------------------------

function Header({
  file,
  rendered,
  mode,
  onModeChange,
  onReveal,
  editable
}: {
  file: ContentFile
  rendered: RenderedMarkdown | null
  mode: ContentMode
  onModeChange: (mode: ContentMode) => void
  onReveal: (path: string) => void
  editable: boolean
}): JSX.Element {
  const chips = rendered?.frontmatter.fields ?? []
  const broken = rendered?.counts.brokenWikilinks ?? 0

  return (
    <header className="shrink-0 border-b border-border px-5 pt-4 pb-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] leading-tight font-medium tracking-tight text-fg">
            {file.title}
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

        {editable && (
          <div
            role="group"
            aria-label="Mode"
            className="flex shrink-0 gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
          >
            {(
              [
                { id: 'read' as const, label: 'Read', Icon: EyeIcon },
                { id: 'edit' as const, label: 'Edit', Icon: PencilIcon }
              ]
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                data-content-mode={option.id}
                aria-pressed={mode === option.id}
                onClick={() => onModeChange(option.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-[5px] px-2.5 py-0.5 text-[11px] transition-colors',
                  mode === option.id
                    ? SEGMENT_ON
                    : 'text-fg-muted hover:text-fg'
                )}
              >
                <option.Icon width={11} height={11} />
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* `type`, `date` and `tags` are this vault's own convention and are what
          a note is filed under; showing them as YAML would be showing the
          storage format of the one thing the reader wanted rendered. */}
      {chips.length > 0 && (
        <div className="mt-3">
          <FrontmatterChips fields={chips} />
        </div>
      )}

      {rendered?.frontmatter.error != null && (
        <p className="mt-2 text-[11px] text-danger">
          The frontmatter block is not valid YAML: {rendered.frontmatter.error}
        </p>
      )}
    </header>
  )
}

/**
 * A file as source: data, text, and the scripts an agent writes into `tools/`.
 *
 * Highlighted where main could - the same shiki pass a fenced code block gets,
 * carrying both themes as custom properties so a theme toggle recolours it
 * without a re-highlight. `source-view` rather than `markdown` on the wrapper,
 * with the code rules shared between them in `markdown.css`: it is the same
 * `<pre class="shiki">` and it should look identical, but it is not a document
 * and the rest of the markdown rules have no business applying to it.
 *
 * Plain text is the fallback and it is a real one, not an error state - a file
 * past the highlighting ceiling, or in a language nobody packaged a grammar
 * for, is still a file somebody wanted to read.
 *
 * **This wrapper does not scroll - the block inside it does.** Both branches
 * below are pinned to the wrapper's height and own both of their scrollbars, so
 * a long file is read inside a bounded well rather than by scrolling the well
 * itself past the bottom of the window. See the `.source-view` rules in
 * `markdown.css` for the measurements that argument came from; the plain-text
 * branch carries the same thing as utilities because it is a `pre` this file
 * writes rather than one shiki hands over.
 */
function SourceBody({
  content,
  loading,
  binary,
  source
}: {
  content: string
  loading: boolean
  binary: boolean
  source: ContentSource | null
}): JSX.Element {
  return (
    <div data-content-source className="min-w-0 flex-1 overflow-hidden p-3">
      {loading ? (
        <p className="text-[12px] text-fg-subtle">Reading&hellip;</p>
      ) : binary ? (
        <p className="rounded-raised border border-border bg-surface-sunken px-3 py-2 text-[12px] text-fg-muted">
          Helm could not read this file as text.
        </p>
      ) : source !== null && source.html !== '' ? (
        <div
          className="source-view"
          data-content-language={source.language}
          data-content-highlighted={source.highlighted}
          // The same argument as the markdown body's: this string was produced
          // by shiki in the main process from bytes on disk, and the renderer
          // injects it rather than evaluating anything in it.
          dangerouslySetInnerHTML={{ __html: source.html }}
        />
      ) : (
        <pre
          data-content-language="plaintext"
          className="h-full overflow-auto overscroll-contain rounded-raised border border-border bg-surface-sunken p-3 font-mono text-[12px] leading-[1.55] text-fg select-text"
        >
          {content}
        </pre>
      )}
    </div>
  )
}

/**
 * A file Helm will not open, which is still a file worth being told about.
 *
 * The list stopped hiding these, so this is where that decision has to land:
 * a row that led nowhere would move the silent omission from the list into the
 * document pane rather than ending it. Explorer is the honest next step.
 */
function BinaryBody({
  file,
  bytes,
  onReveal
}: {
  file: ContentFile
  bytes: number
  onReveal: (path: string) => void
}): JSX.Element {
  return (
    <div className="grid min-w-0 flex-1 place-items-center p-8">
      <div className="max-w-sm text-center">
        <ArtifactIcon width={20} height={20} className="mx-auto text-fg-subtle" />
        <p className="mt-3 text-[13px] text-fg-muted">
          <span className="font-mono text-[12px]">{file.ext === '' ? file.slug : `.${file.ext}`}</span>{' '}
          is not a kind Helm reads.
        </p>
        <p className="mt-1 text-[12px] text-fg-subtle">
          {formatBytes(bytes)} on disk. It is listed because it is there.
        </p>
        <button
          type="button"
          data-content-reveal
          onClick={() => onReveal(file.path)}
          className={cn(
            'mt-4 rounded-well border border-border-strong px-2.5 py-1 text-[11px] text-fg',
            'transition-colors hover:bg-hover'
          )}
        >
          Show in Explorer
        </button>
      </div>
    </div>
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

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-sunken px-4 py-1.5">
        <ArtifactIcon width={12} height={12} className="shrink-0 text-fg-subtle" />
        <span className="text-[11px] text-fg-subtle">
          Sandboxed frame · no Node, no network, opaque origin
        </span>
        <span className="flex-1" />
        <span
          data-artifact-console={errors.length}
          className={cn('text-[11px] tabular-nums', errors.length > 0 ? 'text-danger' : 'text-fg-subtle')}
          title={
            errors.length === 0
              ? 'The artifact logged no errors or warnings'
              : errors.map((entry) => `${entry.level}: ${entry.message}`).join('\n')
          }
        >
          {errors.length === 0 ? 'console clean' : `${errors.length} console errors`}
        </span>
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
