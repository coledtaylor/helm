import type { ChangeEvent, JSX, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConfigFile,
  ConfigFileContent,
  ConfigLive,
  ConfigRendered,
  ConfigSnapshotMeta,
  EffectiveView
} from '@helm/core'
// Values, not types, so they come from `@helm/core/types` - the one entry point
// with no `node:` imports behind it (CLAUDE.md, hard rules).
import {
  computeConfigLive,
  configFileNote,
  isRedactedConfigFile,
  isRenamable,
  renameRefusal,
  validateJson
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import { formatAge, formatBytes, formatMoment } from '../lib/time'
import { bundledWith, skillHolding } from './ConfigConsole'
import { LiveChip } from './ConfigLive'
import { BundledResources, ConfigOpaquePane, HookProvenance } from './ConfigProvenance'
import { ConfigSettingsPane } from './ConfigSettingsPane'
import { FrontmatterChips, MarkdownBody } from './MarkdownBody'
import {
  CheckIcon,
  EyeIcon,
  PencilIcon,
  RestoreIcon,
  SaveIcon,
  SparkIcon,
  TrashIcon,
  WarnIcon
} from './icons'

export type ConfigDetailMode = 'read' | 'edit' | 'source'

export interface ConfigEditorProps {
  file: ConfigFile
  /** The bytes as loaded. Null while the read is in flight. */
  loaded: ConfigFileContent | null
  /** The same bytes as markdown or as highlighted source. Null while rendering. */
  rendered: ConfigRendered | null
  /** The resolution the row's state was read from, for this file's own detail. */
  live: EffectiveView | null
  /** Every file in the scope, for the skill bundle either side of this one. */
  siblings: readonly ConfigFile[]
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
  /** Opens another file in this console - a bundled resource, a settings file. */
  onOpenPath: (path: string) => void
  /** Hands a link in a rendered document to the OS browser. */
  onOpenExternal: (url: string) => void
  /** Told the editor's current text so a parent can warn before switching away. */
  onDirtyChange: (dirty: boolean) => void
  /** Optional, because the two write controls arrived on their own branch and a
      caller that does not offer them simply does not render them. */
  onRename?: (() => void) | undefined
  onDelete?: (() => void) | undefined
}

const JSON_KINDS = new Set(['settings', 'settings-local', 'mcp'])
const MARKDOWN_KINDS = new Set(['skill', 'command', 'agent', 'claude-md', 'rule'])
const SETTINGS_KINDS = new Set(['settings', 'settings-local'])

/**
 * One configuration file, as the object it is.
 *
 * It used to be one textarea for everything, branching only on JSON versus
 * markdown. A `settings.json`, a `SKILL.md` and a hook script are three
 * different objects, and a monospace box is the one presentation that suits
 * none of them: it shows a settings file's syntax and hides which of its keys a
 * session would actually see, shows a skill's frontmatter as eight lines of
 * YAML, and shows a hook without the one fact that explains why it exists.
 *
 * So the pane branches on kind, and the bodies live in files of their own:
 * `ConfigSettingsPane`, `MarkdownBody` (the content viewer's own renderer),
 * `HookProvenance`. What stays here is the part every kind shares - identity,
 * the conflict banner, the draft, the save, the version list - because that is
 * the machinery the `.claude` write rule hangs off and it must not be per-kind.
 *
 * **Reading is the default and editing is a mode**, which is the reverse of
 * what this was. Most visits to a config file are visits to read it; and the
 * reading view is the one that can say things the file does not contain.
 *
 * The save button is disabled while the JSON is invalid, which is criterion 5:
 * malformed JSON is rejected *before* the write, not by the write. The main
 * process checks nothing about the syntax - it only checks that the bytes on
 * disk are still the ones this editor was based on.
 */
export function ConfigEditor({
  file,
  loaded,
  rendered,
  live: view,
  siblings,
  snapshots,
  saving,
  error,
  external,
  onSave,
  onReload,
  onRestore,
  onReveal,
  onOpenPath,
  onOpenExternal,
  onDirtyChange,
  onRename,
  onDelete
}: ConfigEditorProps): JSX.Element {
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState({ line: 1, column: 1 })
  const [showHistory, setShowHistory] = useState(false)
  const [mode, setMode] = useState<ConfigDetailMode>('read')
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
  const isSettings = SETTINGS_KINDS.has(file.kind)
  // Whether the CLI would still find this file under a different name. The
  // control is rendered either way; this decides whether it is enabled.
  const renamable = isRenamable(file.kind)
  // The kinds that are markdown by definition, and anything main rendered as
  // markdown anyway - which is how a `prompts.md` bundled beside a `SKILL.md`
  // reads as the document it is. Its *kind* is `other`, because to Claude Code
  // it is a resource rather than a skill; that is a fact about resolution and
  // not about how to show it.
  const isMarkdown = MARKDOWN_KINDS.has(file.kind) || rendered?.markdown != null
  const isHook = file.kind === 'hook'
  // Never read, so there is nothing to show and nothing was asked for. The same
  // predicate the reader uses, so the pane and the request cannot disagree.
  const redacted = isRedactedConfigFile(file.relPath)
  const binary = loaded?.binary === true

  const live: ConfigLive | null = useMemo(() => computeConfigLive(file, view), [file, view])
  const bundled = useMemo(() => bundledWith(file, siblings), [file, siblings])
  const holder = useMemo(() => skillHolding(file, siblings), [file, siblings])

  /**
   * A file with nothing to read: the credentials, and the CLI's own caches.
   *
   * `other` is only opaque when the resolution has nothing to say about it *and*
   * it is not text somebody wrote - a script a status line runs is in the same
   * kind and is very much worth opening.
   */
  const opaque =
    redacted ||
    binary ||
    (file.kind === 'other' &&
      live !== null &&
      live.state === 'inert' &&
      live.references.length === 0 &&
      configFileNote(file) !== null)

  const editable = !opaque && loaded !== null
  // Markdown edits as its source, so `Edit` and `Source` would be one button
  // twice. A settings file has three genuinely different surfaces.
  const modes: ConfigDetailMode[] = isSettings ? ['read', 'edit', 'source'] : ['read', 'edit']
  const effectiveMode: ConfigDetailMode = editable ? mode : 'read'
  const editingText = effectiveMode === 'source' || (effectiveMode === 'edit' && !isSettings)

  const problem = useMemo(() => (isJson ? validateJson(draft) : null), [isJson, draft])

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
    <div className="@container flex h-full min-h-0 flex-col">
      {/* ----------------------------------------------------------------- */}
      {/* Identity                                                           */}
      {/* ----------------------------------------------------------------- */}
      <header className="shrink-0 border-b border-border px-5 pt-3.5 pb-3">
        {/* Wraps rather than overflows, which is the pane header's own rule one
            level down: docked beside a session this column is about 300px, and
            a name, a chip and three segments do not fit on one line there. The
            title keeps a floor so it is the controls that take the second row
            and not the identity that disappears. */}
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-36 flex-1">
            <h2 className="truncate text-[14px] leading-tight font-medium tracking-tight text-fg">
              {file.name}
            </h2>
            <button
              type="button"
              onClick={() => onReveal(file.path)}
              title="Show in Explorer"
              className="mt-0.5 block max-w-full truncate text-left font-mono text-[10.5px] text-fg-subtle transition-colors hover:text-accent-text"
            >
              {file.relPath}
            </button>
          </div>

          {/* What the resolution says, in the two densities it is said in: the
              line on the row, and the chip. Both are absent when there is
              nothing to claim. */}
          {live?.note != null && (
            <p
              className="hidden min-w-0 shrink truncate pt-1 text-[10.5px] text-fg-subtle @[560px]:block"
              title={live.reason}
            >
              {live.note}
            </p>
          )}
          <span className="pt-0.5">
            <LiveChip live={live} />
          </span>

          {/* Rename and Delete. Shown disabled rather than hidden, with the
              reason in the title: "why can I not rename settings.json" is a
              real question, and a control that is simply absent answers it with
              nothing. They sit after the chip so the resolution stays the thing
              the eye reaches first. */}
          {(onRename || onDelete) && (
            <div className="flex shrink-0 items-center gap-1 pt-0.5">
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

          {editable && (
            <div
              role="group"
              aria-label="Mode"
              className="flex shrink-0 gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
            >
              {modes.map((option) => (
                <button
                  key={option}
                  type="button"
                  data-config-mode={option}
                  aria-pressed={effectiveMode === option}
                  onClick={() => setMode(option)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-[5px] px-2 py-0.5 text-[11px] transition-colors',
                    effectiveMode === option ? SEGMENT_ON : 'text-fg-muted hover:text-fg'
                  )}
                >
                  {option === 'read' ? (
                    <EyeIcon width={11} height={11} />
                  ) : option === 'edit' ? (
                    <PencilIcon width={11} height={11} />
                  ) : null}
                  {option === 'read' ? 'Read' : option === 'edit' ? 'Edit' : 'Source'}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* The frontmatter, as a header rather than as the first eight lines of
            the file. `description` is the field that decides whether a skill is
            ever selected, and it is the one nobody scrolls up to check. */}
        {isMarkdown && rendered?.markdown && rendered.markdown.frontmatter.fields.length > 0 && (
          <div className="mt-2.5">
            <FrontmatterChips fields={rendered.markdown.frontmatter.fields} />
          </div>
        )}

        {/* A resource opened on its own still says whose it is. */}
        {holder !== null && (
          <button
            type="button"
            data-bundled-holder={holder.relPath}
            onClick={() => onOpenPath(holder.path)}
            className="mt-2 flex items-center gap-1.5 text-[10.5px] text-fg-subtle transition-colors hover:text-accent-text"
          >
            <SparkIcon width={11} height={11} className="shrink-0" />
            bundled with the {holder.name} skill
          </button>
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
      {/* The body, which is what the file is                                */}
      {/* ----------------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1 flex-col">
        {opaque ? (
          <ConfigOpaquePane
            live={live}
            note={
              redacted
                ? configFileNote(file)
                : binary
                  ? `${formatBytes(loaded?.size ?? file.size)} of binary content. Helm will not rewrite a file it cannot read as text.`
                  : configFileNote(file)
            }
          />
        ) : loaded === null ? (
          <p className="px-5 py-4 text-[12px] text-fg-subtle">Reading&hellip;</p>
        ) : editingText ? (
          <div className="min-h-0 flex-1 px-5 py-3">
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
          </div>
        ) : isSettings ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <ConfigSettingsPane
              source={draft}
              live={live}
              editing={effectiveMode === 'edit'}
              onChange={setDraft}
              onOpenFile={onOpenPath}
              onEditSource={() => setMode('source')}
            />
          </div>
        ) : isMarkdown ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <MarkdownBody
              path={file.path}
              rendered={rendered?.markdown ?? null}
              surface="config"
              // No contents column: this pane is a column beside a list, and a
              // 13rem sidebar inside it leaves a measure that wraps every other
              // line. The document is a skill, not a manual.
              toc={false}
              compact
              // The header's own gutter, so the first heading starts under the
              // title rather than four pixels to the right of it.
              gutter="px-5"
              onOpenExternal={onOpenExternal}
            />
            <BundledResources files={bundled} selected={file.path} onSelect={(f) => onOpenPath(f.path)} />
          </div>
        ) : (
          <>
            {/* A program's provenance goes *above* its source: what runs it is
                the reason it is here, and it is written in another file. */}
            {(isHook || (live?.references.length ?? 0) > 0) && live !== null && (
              <HookProvenance live={live} onOpenFile={onOpenPath} />
            )}
            <SourceBody
              html={rendered?.code?.html ?? null}
              content={loaded.content}
              language={rendered?.code?.language ?? null}
            />
          </>
        )}
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Status and actions                                                 */}
      {/* ----------------------------------------------------------------- */}
      <footer className="shrink-0 border-t border-border">
        {problem !== null && editable && (
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
            {editingText ? (
              <>
                <span>
                  Ln {caret.line}, Col {caret.column}
                </span>
                <span aria-hidden>·</span>
                <span>{formatBytes(new TextEncoder().encode(draft).length)}</span>
              </>
            ) : (
              <>
                <span>{formatBytes(loaded?.size ?? file.size)}</span>
                <span aria-hidden>·</span>
                <span title={formatMoment(file.mtimeMs)}>updated {formatAge(file.mtimeMs)}</span>
              </>
            )}
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

          {/* Also while reading, when there is something unsaved: switching to
              the reading view with a draft in hand must not take the only
              control that can write it away. */}
          {(effectiveMode !== 'read' || dirty) && (
            <>
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
            </>
          )}
        </div>

        {showHistory && <History snapshots={snapshots} onRestore={onRestore} />}
      </footer>
    </div>
  )
}

/**
 * A program, coloured by the same grammars the content viewer's fences use.
 *
 * Shiki emits both themes at once as custom properties, so a theme toggle needs
 * no re-highlighting - and `markdown.css` already has the rules that pick a
 * side. Where there is no grammar the source still shows, in mono: a file that
 * would not highlight is not a file worth hiding.
 */
function SourceBody({
  html,
  content,
  language
}: {
  html: string | null
  content: string
  language: string | null
}): JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-5 py-4">
      {/* `markdown` for the class the shiki rules hang off, and *no* box of its
          own: `.markdown pre` already draws the sunken well with the hairline
          and the radius, and a second one around it is the same grey twice with
          a border between. The unhighlighted fallback draws its own, because
          then there is no `pre` from the pipeline to draw it. */}
      {html === null ? (
        <div data-config-source="plain" className="markdown markdown-source select-text">
          <pre className="rounded-raised border border-border bg-surface-sunken px-4 py-3 font-mono text-[12px] leading-[1.6] text-fg-muted">
            {content}
          </pre>
        </div>
      ) : (
        // The `pre` is injected as the *direct* child, because the measure cap
        // and the first/last-child margins are `>` rules: a wrapper div would
        // take them all and pass none of them on.
        <div
          data-config-source={language ?? 'plain'}
          className="markdown markdown-source select-text"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
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
