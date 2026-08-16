import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import type {
  ConfigFile,
  ConfigScope,
  ConfigTree,
  TemplateChoice,
  TemplateDetail
} from '@helm/core'
import { cn } from '../lib/cn'
import { ROW_SELECTED } from '../lib/rows'
import { formatAge, formatBytes } from '../lib/time'
import { Checkbox } from './Checkbox'
import {
  CaretIcon,
  CloseIcon,
  FolderIcon,
  ImportIcon,
  PlusIcon,
  SparkIcon,
  TrashIcon
} from './icons'
import { Overlay } from './Overlay'

/**
 * Managing harness templates: everything about authoring one that Explorer
 * cannot do.
 *
 * **There is no file editor here, and that is the design.** A template is a
 * plain directory at a path this dialog states out loud, so the editor somebody
 * already has is a better editor than one built into a modal - "Show in
 * Explorer" is the whole of the editing story. What is left is the three things
 * a folder listing cannot tell you or cannot do:
 *
 * - **`.tpl` is a Helm invention.** Nobody looking at a folder guesses that
 *   `CLAUDE.md.tpl` is filled in and renamed on the way out, so the file list
 *   badges it, names the three variables in a help line, and offers the rename
 *   that opts a file in.
 * - **A skill you already wrote is somewhere Helm can see.** The import picker
 *   is `config:scopes` and `config:tree` with checkboxes on it - the same
 *   scopes the config console browses, `~/.claude` included, read only.
 * - **`template.yaml` is metadata, not a file to edit.** Two fields and a Save,
 *   because a text box full of YAML is a text box in which `label:` can be
 *   misspelled and the template silently drops out of the picker.
 *
 * Reachable from the New Harness dialog *and* from Settings. Templates are
 * app-level, and having to start creating a harness in order to tidy up the
 * templates would be the same mistake as putting "stop scanning this folder"
 * only in Settings - which is a bug this repository has already fixed once.
 */

export interface TemplateManagerProps {
  /** The picker's rows, `minimal` included - it is shown, and is not editable. */
  templates: readonly TemplateChoice[]
  /** Where they live, said out loud so the folder can be found without Helm. */
  templatesDir: string
  /** A template that could not be read. Not fatal to the rest of the list. */
  listProblems?: readonly string[] | undefined

  selected: string | null
  onSelect: (template: string | null) => void
  /** The chosen template's files and metadata. Null while it is being read. */
  detail: TemplateDetail | null

  /** Scopes the import picker may read from, straight from `config:scopes`. */
  scopes: readonly ConfigScope[]
  importScope: string | null
  onImportScopeChange: (scopePath: string | null) => void
  /** The chosen scope's tree. Null before the first answer for that scope. */
  importTree: ConfigTree | null

  busy?: boolean | undefined
  /** What the last action refused, as sentences. */
  problems?: readonly string[] | undefined
  /** What the last action did, as one sentence. Cleared by the next one. */
  notice?: string | null | undefined

  onCreate: (name: string) => void
  onSaveMetadata: (request: { name: string; label: string; description: string }) => void
  onDelete: (template: string) => void
  onReveal: (path: string) => void
  onMakeSubstitutable: (path: string) => void
  onImport: (paths: string[]) => void
  /** Opens the folder picker and then the same preview save-as-template uses. */
  onImportFolder: () => void
  onClose: () => void
}

export function TemplateManager({
  templates,
  templatesDir,
  listProblems = [],
  selected,
  onSelect,
  detail,
  scopes,
  importScope,
  onImportScopeChange,
  importTree,
  busy = false,
  problems = [],
  notice = null,
  onCreate,
  onSaveMetadata,
  onDelete,
  onReveal,
  onMakeSubstitutable,
  onImport,
  onImportFolder,
  onClose
}: TemplateManagerProps): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const authored = templates.filter((choice) => !choice.builtIn)
  const chosen = authored.find((choice) => choice.id === selected) ?? null

  return (
    <Overlay
      aria-label="Manage templates"
      data-template-manager
      className="max-w-[880px]"
      onDismiss={onClose}
    >
      <header className="flex shrink-0 items-center gap-[9px] px-[22px] pt-[18px]">
        <SparkIcon width={13} height={13} className="shrink-0 text-accent" />
        <h2 className="text-[15px] font-medium tracking-tight text-fg">Templates</h2>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <CloseIcon width={12} height={12} />
        </button>
      </header>

      <p className="shrink-0 px-[22px] pt-2 text-[11px] leading-[1.55] text-fg-muted">
        A template is a folder. Creating a harness from it copies the folder in, and that is the
        whole mechanism - so editing one is a job for your own editor.
      </p>
      <button
        type="button"
        data-template-dir
        onClick={() => onReveal(templatesDir)}
        title={`Show ${templatesDir} in Explorer`}
        className="mx-[22px] mt-1 shrink-0 truncate text-left font-mono text-[10.5px] text-fg-subtle transition-colors hover:text-accent-text"
      >
        {templatesDir}
      </button>

      <div className="mt-3 flex min-h-0 flex-1 gap-3 px-[22px] pb-1">
        {/* Left: the list. A sunken well holding rows, per DESIGN.md's island
            anatomy - the detail beside it is the raised surface. */}
        <div className="flex w-[268px] shrink-0 flex-col gap-2">
          <div
            data-template-list
            className="min-h-0 flex-1 overflow-y-auto rounded-well border border-border bg-surface-sunken p-1"
          >
            {authored.length === 0 && !creating && (
              <p className="px-2 py-3 text-[11.5px] leading-[1.55] text-fg-subtle">
                No templates yet. Every new harness gets the built-in Minimal scaffold until there
                is one.
              </p>
            )}
            {authored.map((choice) => (
              <TemplateRow
                key={choice.id}
                choice={choice}
                on={choice.id === selected}
                onClick={() => onSelect(choice.id)}
                // Only the row it is actually about. `detail` lags the
                // selection by one fetch, and a row wearing the previous
                // template's file count would be a number that is simply wrong.
                {...(detail !== null && detail.id === choice.id ? { detail } : {})}
              />
            ))}
          </div>

          {creating ? (
            <form
              className="rounded-well border border-border bg-surface-sunken p-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (newName.trim() === '') return
                onCreate(newName.trim())
                setNewName('')
                setCreating(false)
              }}
            >
              <span className={cn(LABEL, 'mb-1.5 block')}>Folder name</span>
              <input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                spellCheck={false}
                data-template-new-name
                aria-label="New template folder name"
                placeholder="e.g. client-work"
                className={INPUT}
              />
              <div className="mt-2 flex justify-end gap-2">
                <SmallButton
                  onClick={() => {
                    setCreating(false)
                    setNewName('')
                  }}
                >
                  Cancel
                </SmallButton>
                <SmallButton primary submit data-template-new-confirm disabled={busy}>
                  Create
                </SmallButton>
              </div>
            </form>
          ) : (
            <div className="flex shrink-0 gap-2">
              <SmallButton
                data-template-new
                onClick={() => setCreating(true)}
                icon={<PlusIcon width={11} height={11} />}
              >
                New
              </SmallButton>
              <SmallButton
                data-template-import-folder
                onClick={onImportFolder}
                icon={<ImportIcon width={12} height={12} />}
              >
                Import folder…
              </SmallButton>
            </div>
          )}
        </div>

        {/* Right: the chosen template. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {chosen === null ? (
            <p className="px-1 py-2 text-[12px] text-fg-subtle">
              Pick a template to rename it, describe it, or copy skills into it.
            </p>
          ) : (
            <TemplateDetailPane
              // Remounted per template: the form below holds three fields that
              // belong to *this* one, and carrying them across a row change is
              // how somebody saves one template's label onto another.
              key={chosen.id}
              choice={chosen}
              detail={detail}
              scopes={scopes}
              importScope={importScope}
              onImportScopeChange={onImportScopeChange}
              importTree={importTree}
              busy={busy}
              onSaveMetadata={onSaveMetadata}
              onDelete={onDelete}
              onReveal={onReveal}
              onMakeSubstitutable={onMakeSubstitutable}
              onImport={onImport}
            />
          )}
        </div>
      </div>

      {(problems.length > 0 || listProblems.length > 0 || notice !== null) && (
        <div className="mx-[22px] mt-2 shrink-0 space-y-1.5">
          {notice !== null && (
            <p
              data-template-notice
              className="rounded-raised border border-border bg-surface-sunken px-3 py-1.5 text-[11.5px] text-fg-muted"
            >
              {notice}
            </p>
          )}
          {problems.length > 0 && (
            <ul
              role="alert"
              data-template-problems
              className="rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[11.5px] leading-[1.5] text-danger"
            >
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          {listProblems.length > 0 && (
            <ul data-template-list-problems className="space-y-0.5 text-[10.5px] text-warn">
              {listProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <footer className="mx-[22px] flex shrink-0 items-center justify-end gap-2 border-t border-border py-3.5">
        <button
          type="button"
          data-template-close
          onClick={onClose}
          className="rounded-well border border-border-strong px-3.5 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
        >
          Done
        </button>
      </footer>
    </Overlay>
  )
}

/** One row of the list: what the picker shows, plus what the folder weighs. */
function TemplateRow({
  choice,
  on,
  detail,
  onClick
}: {
  choice: TemplateChoice
  on: boolean
  /** Only for the selected row - the others have not been read. */
  detail?: TemplateDetail | undefined
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      data-template-row={choice.id}
      aria-current={on}
      onClick={onClick}
      className={cn(
        'relative block w-full rounded-[5px] px-2.5 py-1.5 text-left transition-colors',
        on ? ROW_SELECTED : 'hover:bg-hover'
      )}
    >
      {on && (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent"
        />
      )}
      <span data-template-row-label className="block truncate text-[12px] leading-[15px] text-fg">
        {choice.label}
      </span>
      <span className="mt-px block truncate font-mono text-[10px] text-fg-subtle">{choice.id}</span>
      {choice.description !== null && (
        <span className="mt-0.5 block text-[11px] leading-[1.45] text-fg-muted">
          {choice.description}
        </span>
      )}
      {detail !== undefined && (
        <span data-template-row-meta className="mt-1 block text-[10px] text-fg-subtle">
          {detail.fileCount} {detail.fileCount === 1 ? 'file' : 'files'}
          {detail.totalBytes > 0 && ` · ${formatBytes(detail.totalBytes)}`}
          {detail.modifiedAtMs > 0 && ` · ${formatAge(detail.modifiedAtMs)}`}
        </span>
      )}
    </button>
  )
}

/** The metadata form, the file list, and the import picker. */
function TemplateDetailPane({
  choice,
  detail,
  scopes,
  importScope,
  onImportScopeChange,
  importTree,
  busy,
  onSaveMetadata,
  onDelete,
  onReveal,
  onMakeSubstitutable,
  onImport
}: {
  choice: TemplateChoice
  detail: TemplateDetail | null
  scopes: readonly ConfigScope[]
  importScope: string | null
  onImportScopeChange: (scopePath: string | null) => void
  importTree: ConfigTree | null
  busy: boolean
  onSaveMetadata: (request: { name: string; label: string; description: string }) => void
  onDelete: (template: string) => void
  onReveal: (path: string) => void
  onMakeSubstitutable: (path: string) => void
  onImport: (paths: string[]) => void
}): JSX.Element {
  // Seeded once. The caller keys this pane on the template's id, so switching
  // rows remounts it with that template's values rather than carrying the last
  // one's half-typed label across - and a `setState` in an effect to keep them
  // in step is the cascading render this repo lints as an error.
  const [name, setName] = useState(choice.id)
  const [label, setLabel] = useState(choice.label)
  const [description, setDescription] = useState(choice.description ?? '')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const loaded = detail !== null && detail.id === choice.id

  return (
    <div className="space-y-2.5">
      <section className="rounded-raised border border-border bg-surface-raised px-4 py-3.5">
        <h3 className={cn(LABEL, 'mb-2.5')}>Details</h3>
        <div className="space-y-2.5">
          <Field
            label="Folder name"
            hint="The folder this template is, and what a harness records as its provenance."
          >
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              spellCheck={false}
              data-template-name
              aria-label="Template folder name"
              className={cn(INPUT, 'font-mono text-[11.5px]')}
            />
          </Field>
          <Field label="Label" hint="What the New Harness picker shows.">
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              data-template-label
              aria-label="Template label"
              className={INPUT}
            />
          </Field>
          <Field label="Description" hint="One sentence, under the label in the picker.">
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              data-template-description
              aria-label="Template description"
              className={INPUT}
            />
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SmallButton
            primary
            data-template-save
            disabled={busy}
            onClick={() => onSaveMetadata({ name: name.trim(), label, description })}
          >
            Save
          </SmallButton>
          <SmallButton
            data-template-reveal
            onClick={() => onReveal(detail?.dir ?? choice.id)}
            icon={<FolderIcon width={12} height={12} />}
          >
            Show in Explorer
          </SmallButton>
          <span className="flex-1" />
          {confirmingDelete ? (
            <span className="flex items-center gap-2">
              <span className="text-[11px] text-danger">Delete {choice.id} and everything in it?</span>
              <SmallButton onClick={() => setConfirmingDelete(false)}>Keep it</SmallButton>
              <SmallButton
                danger
                data-template-delete-confirm
                disabled={busy}
                onClick={() => onDelete(choice.id)}
              >
                Delete
              </SmallButton>
            </span>
          ) : (
            <SmallButton
              data-template-delete
              onClick={() => setConfirmingDelete(true)}
              icon={<TrashIcon width={12} height={12} />}
            >
              Delete
            </SmallButton>
          )}
        </div>
      </section>

      <FileList
        detail={loaded ? detail : null}
        busy={busy}
        onMakeSubstitutable={onMakeSubstitutable}
      />

      <ImportPicker
        // Remounted per scope, which is what drops the ticks belonging to the
        // last one - they are paths, and a path from another scope is not a
        // selection in this one.
        key={importScope ?? ''}
        scopes={scopes}
        scopePath={importScope}
        onScopeChange={onImportScopeChange}
        tree={importTree}
        busy={busy}
        onImport={onImport}
      />
    </div>
  )
}

/**
 * The template's files, with what each one becomes.
 *
 * The `target` column is the whole point of listing them here rather than
 * sending the user to Explorer: a folder listing shows `CLAUDE.md.tpl` and
 * `dot-claude/`, and neither of those is what arrives in the harness. The
 * badge, the arrow and the help line under the list are three ways of saying
 * the same convention, because it is the one thing about this format nobody
 * can infer.
 */
function FileList({
  detail,
  busy,
  onMakeSubstitutable
}: {
  detail: TemplateDetail | null
  busy: boolean
  onMakeSubstitutable: (path: string) => void
}): JSX.Element {
  return (
    <section className="rounded-raised border border-border bg-surface-raised px-4 py-3.5">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h3 className={LABEL}>Files</h3>
        {/* The label already says "files", so the caption is the *numbers* -
            and an empty template has nothing to count, which the sentence below
            says better than "0 files" beside a heading reading FILES. */}
        {detail !== null && detail.fileCount > 0 && (
          <p className="text-[10.5px] text-fg-muted">
            {detail.fileCount}
            {detail.totalBytes > 0 && ` · ${formatBytes(detail.totalBytes)}`}
          </p>
        )}
      </div>

      {detail === null ? (
        <p className="text-[11.5px] text-fg-subtle">Reading…</p>
      ) : detail.files.length === 0 ? (
        <p className="text-[11.5px] leading-[1.55] text-fg-subtle">
          Nothing in it yet. Copy a skill in below, or open the folder and write one.
        </p>
      ) : (
        <ul data-template-files className="-mx-1 space-y-px">
          {detail.files.map((file) => (
            <li
              key={file.relPath}
              data-template-file={file.relPath}
              data-template-file-tpl={String(file.substituted)}
              className="group flex items-center gap-2 rounded-[5px] px-1.5 py-1 transition-colors hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg" title={file.relPath}>
                {file.relPath}
              </span>
              {file.substituted && (
                <span
                  data-template-file-badge
                  title="Filled in with the variables below, and written without the .tpl"
                  className="shrink-0 rounded-full border border-accent/45 px-1.5 py-px font-mono text-[9px] text-accent-text"
                >
                  tpl
                </span>
              )}
              {file.link && (
                <span className="shrink-0 rounded-full border border-warn/40 px-1.5 py-px text-[9px] text-warn">
                  link · not written
                </span>
              )}
              {file.target !== '' && file.target !== file.relPath && (
                <span className="shrink-0 truncate font-mono text-[10px] text-fg-subtle">
                  → {file.target}
                </span>
              )}
              <span className="w-14 shrink-0 text-right font-mono text-[10px] text-fg-subtle tabular-nums">
                {formatBytes(file.size)}
              </span>
              {!file.substituted && !file.link && (
                <button
                  type="button"
                  data-template-substitutable={file.relPath}
                  disabled={busy}
                  onClick={() => onMakeSubstitutable(file.relPath)}
                  title={`Rename to ${file.relPath}.tpl, so its variables are filled in`}
                  className={cn(
                    'shrink-0 rounded border border-border-strong px-1.5 py-px text-[10px] text-fg-muted',
                    'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
                    'hover:bg-hover hover:text-fg'
                  )}
                >
                  Make substitutable
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* The three variables, named where the badge is. There are no others, and
          no conditionals or loops - a template language is a thing that grows,
          and the moment it can branch it needs a debugger. */}
      <p data-template-variables className="mt-2.5 text-[11px] leading-[1.6] text-fg-subtle">
        A file named <code className="font-mono text-[10.5px] text-fg-muted">x.tpl</code> is written
        as <code className="font-mono text-[10.5px] text-fg-muted">x</code> with{' '}
        <code className="font-mono text-[10.5px] text-accent-text">{'{{NAME}}'}</code>,{' '}
        <code className="font-mono text-[10.5px] text-accent-text">{'{{CREATED_AT}}'}</code> and{' '}
        <code className="font-mono text-[10.5px] text-accent-text">{'{{TEMPLATE}}'}</code> filled
        in. Every other file is copied byte for byte, so a workflow full of{' '}
        <code className="font-mono text-[10.5px] text-fg-muted">{'${{ … }}'}</code> arrives as you
        wrote it.
      </p>
    </section>
  )
}

/**
 * Copying a skill, command, agent, `CLAUDE.md` or `settings.json` in.
 *
 * The sources are `config:scopes` - every `.claude` tree the config console can
 * see, the user's own `~/.claude` included, because importing a skill you wrote
 * for yourself is the obvious case and reading is all Helm does there anyway.
 * `ClaudeInventory` could not feed this: it is counts and carries no names.
 *
 * What lands is a **plain copy**. A template travels - mailed, cloned,
 * unzipped - so there is no link back to where it came from, and the row says
 * so rather than leaving it to be discovered on somebody else's machine.
 */
function ImportPicker({
  scopes,
  scopePath,
  onScopeChange,
  tree,
  busy,
  onImport
}: {
  scopes: readonly ConfigScope[]
  scopePath: string | null
  onScopeChange: (scopePath: string | null) => void
  tree: ConfigTree | null
  busy: boolean
  onImport: (paths: string[]) => void
}): JSX.Element {
  const [ticked, setTicked] = useState<string[]>([])

  const importable = (tree?.files ?? []).filter((file) => IMPORTABLE.has(file.kind))
  const toggle = (path: string): void =>
    setTicked((current) =>
      current.includes(path) ? current.filter((one) => one !== path) : [...current, path]
    )

  return (
    <section
      data-template-import
      className="rounded-raised border border-border bg-surface-raised px-4 py-3.5"
    >
      <h3 className={cn(LABEL, 'mb-2.5')}>Copy in from a .claude tree</h3>

      {/* The platform arrow is replaced by the system's own caret, matching the
          `Select` in `ProfileEditor` and `SettingsPane`. Still a native
          `<select>` for the reason those give: a driver sets it through
          `HTMLSelectElement.prototype.value`, and a listbox of our own cannot
          be set that way. */}
      <span className="relative block">
        <select
          value={scopePath ?? ''}
          data-template-import-scope
          aria-label="Where to copy from"
          onChange={(event) => onScopeChange(event.target.value === '' ? null : event.target.value)}
          className={cn(INPUT, 'cursor-pointer appearance-none pr-7')}
        >
          <option value="">Choose a scope…</option>
          {scopes.map((scope) => (
            <option key={scope.path} value={scope.path}>
              {scope.kind === 'user'
                ? `${scope.label} · ~/.claude`
                : `${scope.label} · ${scope.path}`}
            </option>
          ))}
        </select>
        <CaretIcon
          width={9}
          height={9}
          className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rotate-90 text-fg-subtle"
        />
      </span>

      {scopePath !== null && (
        <>
          {tree === null ? (
            <p className="mt-2 text-[11.5px] text-fg-subtle">Reading…</p>
          ) : importable.length === 0 ? (
            <p className="mt-2 text-[11.5px] text-fg-subtle">
              Nothing here to copy - that scope has no skills, commands, agents or settings.
            </p>
          ) : (
            <ul
              data-template-import-files
              className="mt-2 max-h-[188px] overflow-y-auto rounded-well border border-border bg-surface-sunken p-1"
            >
              {importable.map((file) => (
                <li key={file.path}>
                  <label
                    // The scope-relative path rather than the absolute one: a
                    // driver reaches this by selector, and an absolute Windows
                    // path in one is a string full of backslashes that CSS
                    // reads as escapes.
                    data-template-import-file={file.relPath}
                    data-template-import-on={String(ticked.includes(file.path))}
                    className="flex cursor-pointer items-center gap-2 rounded-[5px] px-1.5 py-1 transition-colors hover:bg-hover"
                    title={file.path}
                  >
                    <Checkbox
                      checked={ticked.includes(file.path)}
                      onChange={() => toggle(file.path)}
                      label={`Copy ${file.name}`}
                    />
                    <span className="shrink-0 rounded-full border border-border-strong px-1.5 py-px text-[9px] text-fg-subtle">
                      {KIND_LABEL[file.kind] ?? file.kind}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg">{file.name}</span>
                    <span className="shrink-0 truncate font-mono text-[10px] text-fg-subtle">
                      {file.relPath}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2.5 flex items-center gap-2">
            <SmallButton
              primary
              data-template-import-confirm
              disabled={busy || ticked.length === 0}
              onClick={() => {
                onImport(ticked)
                setTicked([])
              }}
            >
              {ticked.length === 0 ? 'Copy in' : `Copy ${ticked.length} in`}
            </SmallButton>
            <p className="text-[10.5px] leading-[1.5] text-fg-subtle">
              Copied as plain files, with no link back - a skill&rsquo;s whole folder travels with
              it.
            </p>
          </div>
        </>
      )}
    </section>
  )
}

/**
 * The kinds worth copying into a template.
 *
 * `other` is left out - a file the console could not classify is a resource
 * bundled beside something, and it arrives with the skill that bundles it
 * rather than being picked on its own. `settings-local` is left out too: it is
 * a decision about *this machine*, which is the one thing a travelling template
 * must not carry.
 */
const IMPORTABLE = new Set<ConfigFile['kind']>([
  'skill',
  'command',
  'agent',
  'hook',
  'rule',
  'claude-md',
  'settings',
  'mcp'
])

const KIND_LABEL: Partial<Record<ConfigFile['kind'], string>> = {
  skill: 'skill',
  command: 'command',
  agent: 'agent',
  hook: 'hook',
  rule: 'rule',
  'claude-md': 'CLAUDE.md',
  settings: 'settings',
  mcp: 'mcp'
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint: string
  children: ReactNode
}): JSX.Element {
  return (
    <label className="block">
      <span className={cn(LABEL, 'mb-1 block')}>{label}</span>
      {children}
      <span className="mt-[3px] block text-[10px] leading-[1.45] text-fg-subtle">{hint}</span>
    </label>
  )
}

function SmallButton({
  children,
  onClick,
  icon,
  primary = false,
  danger = false,
  disabled = false,
  submit = false,
  ...marks
}: {
  children: ReactNode
  onClick?: (() => void) | undefined
  icon?: ReactNode | undefined
  primary?: boolean | undefined
  danger?: boolean | undefined
  disabled?: boolean | undefined
  submit?: boolean | undefined
} & Record<string, unknown>): JSX.Element {
  return (
    <button
      type={submit ? 'submit' : 'button'}
      {...(onClick === undefined ? {} : { onClick })}
      disabled={disabled}
      {...marks}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-well border px-2.5 py-1 text-[11.5px] transition-colors',
        // The accent outlines, never fills (DESIGN.md "no solid accent fills") -
        // the tint arrives on hover.
        primary
          ? 'border-accent text-accent-text hover:bg-accent-soft'
          : danger
            ? 'border-danger/45 text-danger hover:bg-danger/10'
            : 'border-border-strong text-fg hover:bg-hover',
        disabled && 'cursor-default opacity-55 hover:bg-transparent'
      )}
    >
      {icon !== undefined && <span className={primary ? '' : 'text-accent'}>{icon}</span>}
      {children}
    </button>
  )
}

/**
 * The sunken-well field, matching `ProfileEditor`'s `inputClass`.
 *
 * `transition-colors hover:border-border-strong` is not decoration: the scope
 * picker below is a `<select>`, which is a *control*, and `affordance-check`
 * AFF-4 requires every control to change appearance under the pointer. Without
 * it this was the one dead hover in the app - flagged the first time the
 * manager was walked, which is what the two `VIEWS` rows are for.
 */
const INPUT = cn(
  'h-[28px] w-full rounded-well border border-border bg-surface-sunken px-2.5 text-[12px]',
  'text-fg placeholder:text-fg-subtle select-text',
  'transition-colors hover:border-border-strong focus:border-accent focus:outline-none'
)

const LABEL = 'text-[9.5px] font-semibold tracking-[.08em] text-fg-subtle uppercase'
