import type { JSX } from 'react'
import { useState } from 'react'
import type { FolderTemplateKind, FolderTemplatePreview } from '@helm/core'
import { cn } from '../lib/cn'
import { formatBytes } from '../lib/time'
import { Checkbox } from './Checkbox'
import { CloseIcon, FolderIcon, SparkIcon } from './icons'
import { Overlay } from './Overlay'

/**
 * Freezing a folder into a template: a harness you have been living in, or a
 * tree somebody authored elsewhere.
 *
 * One dialog for both, because they are one operation - a folder, some of its
 * entries, and a name. What differs is where the folder came from and which
 * entries are ticked when it opens, and both of those are decided before this
 * paints.
 *
 * **Nothing is copied until it is shown**, which is the same discipline the New
 * Harness dialog's "What gets written" follows, pointed the other way. Three
 * things follow from it and each is load-bearing:
 *
 * - **The file count and the total size are stated before the button works.** A
 *   harness with repositories in it is gigabytes; the number is what stops that
 *   being a surprise, and it moves as entries are ticked rather than describing
 *   some other selection.
 * - **A refused entry is listed, not hidden.** `.git`, `node_modules` and
 *   `harness.yaml` are never copied, and a preview that silently omitted them
 *   would be a preview that is not the list of what is in the folder. They are
 *   shown with the reason, unticked and untickable.
 * - **Everything else is ticked and the user unticks.** Helm cannot know that
 *   `notes/` is a journal rather than a scaffold, so it asks rather than
 *   guesses. `repos/` is the one directory whose purpose is to hold this
 *   harness's things rather than the layout's, so it starts unticked - and it
 *   can be ticked, because an empty `repos/` in a template is reasonable.
 */

export interface SaveAsTemplateDialogProps {
  kind: FolderTemplateKind
  /** The folder being frozen. Empty in folder mode until one is chosen. */
  dir: string
  /** Offered in folder mode only; a harness's pane already chose the folder. */
  onChooseDir?: (() => void) | undefined
  /** What would be copied. Null while the walk is running. */
  preview: FolderTemplatePreview | null
  busy?: boolean | undefined
  problems?: readonly string[] | undefined
  onSave: (request: {
    name: string
    label: string
    description: string
    include: string[]
  }) => void
  onCancel: () => void
}

/**
 * The folder's own last segment, which is the right template name nearly
 * always and is one less thing to type.
 */
function leafOf(dir: string): string {
  return dir.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? ''
}

export function SaveAsTemplateDialog({
  kind,
  dir,
  onChooseDir,
  preview,
  busy = false,
  problems = [],
  onSave,
  onCancel
}: SaveAsTemplateDialogProps): JSX.Element {
  // Seeded once rather than synchronised: the caller keys this component on the
  // folder, so choosing a different one remounts it and every field below
  // starts again from that folder. A `setState` in an effect to keep them in
  // step is the cascading render `react-hooks/set-state-in-effect` is an error
  // about, and it would also fight a name the user had already typed.
  const [name, setName] = useState(() => leafOf(dir))
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  /**
   * Null means "whatever the preview ticked", which is the state this opens in
   * and the state it stays in until somebody ticks something.
   *
   * Derived rather than copied, because the defaults are the **engine's**:
   * which entries are instance data is a rule with a comment on it in one
   * place, and a second copy here is how the dialog and the writer come to
   * disagree about what a tick means.
   */
  const [ticked, setTicked] = useState<string[] | null>(null)

  const entries = preview?.entries ?? []
  const chosen = ticked ?? entries.filter((entry) => entry.included).map((entry) => entry.name)
  const selected = entries.filter((entry) => chosen.includes(entry.name))
  const fileCount = selected.reduce((sum, entry) => sum + entry.fileCount, 0)
  const totalBytes = selected.reduce((sum, entry) => sum + entry.bytes, 0)
  const truncated = selected.some((entry) => entry.truncated)
  const ready = name.trim() !== '' && dir !== '' && selected.length > 0 && !busy

  const toggle = (entryName: string): void =>
    setTicked(
      chosen.includes(entryName)
        ? chosen.filter((one) => one !== entryName)
        : [...chosen, entryName]
    )

  return (
    <Overlay
      aria-label={kind === 'harness' ? 'Save this harness as a template' : 'Import a folder as a template'}
      data-save-template={kind}
      className="max-w-[560px]"
      onDismiss={onCancel}
    >
      <header className="flex shrink-0 items-center gap-[9px] px-[22px] pt-[18px]">
        <SparkIcon width={13} height={13} className="shrink-0 text-accent" />
        <h2 className="text-[15px] font-medium tracking-tight text-fg">
          {kind === 'harness' ? 'Save as template' : 'Import a folder as a template'}
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
          {kind === 'harness'
            ? 'The layout is copied into a new template; this harness is not touched. Nothing here re-applies afterwards - a template makes a harness and the harness is then its own.'
            : 'The folder is copied into a new template; the folder is not touched.'}
        </p>

        <label className="mt-4 block">
          <span className={cn(LABEL, 'mb-1.5')}>{kind === 'harness' ? 'From' : 'The folder'}</span>
          <span className="flex gap-2">
            <input
              readOnly
              value={dir}
              // A path is long and this field is narrow, so the full one has to
              // be reachable without selecting the text - the same reason the
              // project pane's path button carries one.
              title={dir}
              data-save-template-dir
              aria-label="Folder"
              placeholder="Choose a folder…"
              className={cn(INPUT, 'min-w-0 flex-1 font-mono text-[11px] text-fg-muted')}
            />
            {onChooseDir !== undefined && (
              <button
                type="button"
                data-save-template-choose
                onClick={onChooseDir}
                className="h-[30px] shrink-0 rounded-well border border-border-strong px-2.5 text-[12px] text-fg transition-colors hover:bg-hover"
              >
                Choose…
              </button>
            )}
          </span>
        </label>

        <label className="mt-[14px] block">
          <span className={cn(LABEL, 'mb-1.5')}>Folder name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            spellCheck={false}
            data-save-template-name
            aria-label="Template folder name"
            placeholder="e.g. client-work"
            className={cn(INPUT, 'font-mono text-[11.5px]')}
          />
        </label>

        <label className="mt-[14px] block">
          <span className={cn(LABEL, 'mb-1.5')}>Label</span>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            data-save-template-label
            aria-label="Template label"
            placeholder="What the picker shows"
            className={INPUT}
          />
        </label>

        <label className="mt-[14px] block">
          <span className={cn(LABEL, 'mb-1.5')}>Description</span>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            data-save-template-description
            aria-label="Template description"
            placeholder="One sentence, under the label"
            className={INPUT}
          />
        </label>

        <div className="mt-4">
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className={LABEL}>What gets copied</span>
            <p data-save-template-total className="text-[10.5px] text-fg-muted tabular-nums">
              {preview === null
                ? 'reading…'
                : `${truncated ? 'more than ' : ''}${fileCount} ${fileCount === 1 ? 'file' : 'files'} · ${formatBytes(totalBytes)}`}
            </p>
          </div>

          <div className="rounded-raised border border-border bg-surface-sunken px-1.5 py-1.5">
            {preview === null ? (
              <p className="px-1.5 py-1 text-[11.5px] text-fg-subtle">Reading the folder…</p>
            ) : entries.length === 0 ? (
              <p className="px-1.5 py-1 text-[11.5px] text-fg-subtle">There is nothing in it.</p>
            ) : (
              <ul data-save-template-entries>
                {entries.map((entry) => {
                  const on = chosen.includes(entry.name)
                  const locked = entry.refused !== null || entry.link
                  return (
                    <li key={entry.name}>
                      <label
                        data-save-template-entry={entry.name}
                        data-save-template-entry-on={String(on && !locked)}
                        className={cn(
                          'flex items-center gap-2 rounded-[5px] px-1.5 py-1 transition-colors',
                          locked ? 'cursor-default' : 'cursor-pointer hover:bg-hover'
                        )}
                      >
                        {locked ? (
                          // A refused entry keeps its place in the list and
                          // loses its control: nothing is copied that was not
                          // shown, and nothing is offered that will not happen.
                          <span
                            aria-hidden
                            className="grid size-4 shrink-0 place-items-center rounded-[5px] border-[1.5px] border-border-strong"
                          />
                        ) : (
                          <Checkbox
                            checked={on}
                            onChange={() => toggle(entry.name)}
                            label={`Copy ${entry.name}`}
                            mark="data-save-template-check"
                          />
                        )}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate font-mono text-[11px]',
                            locked ? 'text-fg-subtle' : 'text-fg'
                          )}
                        >
                          {entry.name}
                          {entry.directory && '/'}
                        </span>
                        {locked ? (
                          <span className="shrink-0 truncate text-[10px] text-fg-subtle">
                            not copied - {entry.link ? 'a link' : entry.refused}
                          </span>
                        ) : (
                          <span className="shrink-0 font-mono text-[10px] text-fg-subtle tabular-nums">
                            {entry.truncated ? '50,000+' : entry.fileCount}
                            {entry.fileCount === 1 ? ' file' : ' files'} ·{' '}
                            {formatBytes(entry.bytes)}
                          </span>
                        )}
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {preview !== null && preview.note !== '' && (
            <p className="mt-2 text-[11px] leading-[1.55] text-fg-subtle">{preview.note}</p>
          )}
          {(preview?.problems ?? []).length > 0 && (
            <ul data-save-template-warnings className="mt-1.5 space-y-0.5 text-[10.5px] text-warn">
              {preview?.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>

        {problems.length > 0 && (
          <ul
            role="alert"
            data-save-template-problems
            className="mt-4 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </div>

      <footer className="mx-[22px] flex shrink-0 items-center gap-2 border-t border-border py-3.5">
        <FolderIcon width={12} height={12} className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-fg-subtle">
          Written into your templates folder.
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-well border border-border-strong px-3.5 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          data-save-template-confirm
          disabled={!ready}
          onClick={() =>
            onSave({ name: name.trim(), label, description, include: chosen })
          }
          className={cn(
            'rounded-well border px-3.5 py-1.5 text-[12px] font-medium transition-colors',
            ready
              ? 'border-accent text-accent-text hover:bg-accent-soft'
              : 'cursor-default border-border text-fg-subtle opacity-60'
          )}
        >
          {busy ? 'Copying…' : 'Create template'}
        </button>
      </footer>
    </Overlay>
  )
}

/** The sunken-well field, matching `ProfileEditor`'s `inputClass`. */
const INPUT = cn(
  'h-[30px] w-full rounded-well border border-border bg-surface-sunken px-2.5 text-[12.5px]',
  'text-fg placeholder:text-fg-subtle select-text',
  'transition-colors hover:border-border-strong focus:border-accent focus:outline-none'
)

const LABEL = 'block text-[9.5px] font-semibold tracking-[.08em] text-fg-subtle uppercase'
