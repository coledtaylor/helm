import type { JSX } from 'react'
import { useMemo } from 'react'
import type { ConfigLive, ConfigSettingLive, SettingHint } from '@helm/core'
// Values, so they come from `@helm/core/types` - the one entry point with no
// `node:` imports behind it (CLAUDE.md, hard rules).
import { SETTING_HINTS, settingHint, topLevelKey } from '@helm/core/types'
import { cn } from '../lib/cn'
import { Checkbox } from './Checkbox'
import { PlusIcon } from './icons'

/**
 * A `settings.json`, as the settings rather than as the JSON.
 *
 * Two surfaces over one text. **Reading** is the provenance list: every leaf
 * this file declares, the value it declares, and whether that is the value a
 * session would see - which is the question a settings file exists to answer
 * and the one a textarea cannot. **Editing** is a form built from
 * `settings-schema.ts`, so a boolean is a checkbox and an enumeration is a
 * select, and the two things that go wrong in a hand-edited settings file - a
 * typo'd key and a value of the wrong type - are unrepresentable for every key
 * the table knows.
 *
 * The form is a view over the *text*, not over a parsed copy of it: every edit
 * re-serialises the whole document and hands it back as the draft. So the raw
 * JSON escape hatch is never out of step with the form, one save path serves
 * both, and the JSON validator the save is gated on is the same one either way.
 *
 * The escape hatch is not a fallback for the impatient - it is required. Claude
 * Code owns this schema and adds keys between releases, so `settings-schema.ts`
 * is a table of hints and never a validator (see its own header). A form that
 * was the only way in would make a key Helm has not heard of uneditable.
 */

export interface ConfigSettingsPaneProps {
  /** The document as it stands, which is the editor's draft. */
  source: string
  live: ConfigLive | null
  editing: boolean
  onChange: (next: string) => void
  /** Opens the file that outranks a key here. */
  onOpenFile: (path: string) => void
  /** Switches to the raw JSON, for a value no field can hold. */
  onEditSource: () => void
}

interface Parsed {
  document: Record<string, unknown>
  ok: boolean
}

function parse(source: string): Parsed {
  const text = source.trim()
  if (text === '') return { document: {}, ok: true }
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { document: {}, ok: false }
    }
    return { document: value as Record<string, unknown>, ok: true }
  } catch {
    return { document: {}, ok: false }
  }
}

/** A leaf's value as one line. Objects and arrays are shown as they are typed. */
function preview(value: unknown): string {
  const json = JSON.stringify(value)
  return json ?? 'null'
}

export function ConfigSettingsPane({
  source,
  live,
  editing,
  onChange,
  onOpenFile,
  onEditSource
}: ConfigSettingsPaneProps): JSX.Element {
  const parsed = useMemo(() => parse(source), [source])

  if (!parsed.ok) {
    return (
      <div className="p-5">
        <p className="rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          This file is not a JSON object, so there are no settings to show. The source view is
          below the fold of this pane - open it to fix the file.
        </p>
      </div>
    )
  }

  return editing ? (
    <SettingsForm document={parsed.document} onChange={onChange} onEditSource={onEditSource} />
  ) : (
    <SettingsReading document={parsed.document} live={live} onOpenFile={onOpenFile} />
  )
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every key, and what became of it.
 *
 * The rows come from the resolution when there is one, because that is the
 * only source that knows a key was outranked - and it is keyed by *leaf*
 * (`env.FOO`), which is how the layers actually merge. Where there is no
 * resolution the document's own top-level keys are listed instead, with the
 * schema's summary under each: less to say, but nothing invented.
 */
function SettingsReading({
  document,
  live,
  onOpenFile
}: {
  document: Record<string, unknown>
  live: ConfigLive | null
  onOpenFile: (path: string) => void
}): JSX.Element {
  const rows = live?.settings ?? []
  const keys = Object.keys(document)

  if (rows.length === 0 && keys.length === 0) {
    return (
      <p className="px-5 py-4 text-[12px] text-fg-subtle">
        This file declares nothing, so no session is changed by it.
      </p>
    )
  }

  return (
    <div className="px-5 py-4">
      <div
        data-config-settings={rows.length > 0 ? rows.length : keys.length}
        className="overflow-hidden rounded-raised border border-border"
      >
        {rows.length > 0
          ? rows.map((row) => (
              <SettingRow key={row.key} row={row} onOpenFile={onOpenFile} />
            ))
          : keys.map((key) => (
              <div
                key={key}
                className="border-b border-border bg-surface-raised px-3.5 py-2.5 last:border-b-0"
              >
                <p className="font-mono text-[11.5px] font-medium text-fg">{key}</p>
                <p className="mt-1 truncate font-mono text-[11px] text-fg-muted">
                  {preview(document[key])}
                </p>
                <p className="mt-0.5 text-[10px] text-fg-subtle">
                  {settingHint(topLevelKey(key))?.summary ??
                    'Not a key Helm has a note for. Claude Code may still use it.'}
                </p>
              </div>
            ))}
      </div>
    </div>
  )
}

function SettingRow({
  row,
  onOpenFile
}: {
  row: ConfigSettingLive
  onOpenFile: (path: string) => void
}): JSX.Element {
  const hint = settingHint(topLevelKey(row.key))
  return (
    <div
      data-setting={row.key}
      data-setting-wins={row.wins}
      className="border-b border-border bg-surface-raised px-3.5 py-2.5 last:border-b-0"
    >
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-medium text-fg">
          {row.key}
        </span>
        {/* The state chip's rule again, one density down: a hairline outline in
            the tone, never a fill. */}
        <span
          className={cn(
            'shrink-0 rounded-full border px-2 py-px text-[9px] tracking-[.06em] uppercase',
            row.wins ? 'border-success/40 text-success' : 'border-warn/40 text-warn'
          )}
        >
          {row.wins ? 'wins' : 'outranked'}
        </span>
      </div>
      <p className="mt-1 truncate font-mono text-[11px] text-fg-muted" title={row.value}>
        {row.value}
      </p>
      {row.outrankedBy === null ? (
        <p className="mt-0.5 text-[10px] text-fg-subtle">
          {`${row.layer} layer`}
          {hint ? ` · ${hint.summary}` : ' · nothing above it sets this'}
        </p>
      ) : (
        // The file that won, one click away. "Something overrides this" and
        // "here is the thing that overrides it" are different amounts of help.
        <button
          type="button"
          data-open-winner={row.key}
          onClick={() => row.outrankedBy && onOpenFile(row.outrankedBy.file)}
          title={row.outrankedBy.file}
          className="mt-0.5 block max-w-full truncate text-left text-[10px] text-warn transition-colors hover:text-accent-text"
        >
          {`the ${row.outrankedBy.layer} layer sets ${row.outrankedBy.value} instead`}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** The hint table's own idea of a starting value for a key being added. */
function blankFor(hint: SettingHint): unknown {
  switch (hint.type) {
    case 'boolean':
      return true
    case 'number':
      return 0
    case 'array':
      return []
    case 'object':
      return {}
    default:
      return hint.values?.[0] ?? ''
  }
}

function SettingsForm({
  document,
  onChange,
  onEditSource
}: {
  document: Record<string, unknown>
  onChange: (next: string) => void
  onEditSource: () => void
}): JSX.Element {
  const keys = Object.keys(document)
  // Two-space JSON with a trailing newline, which is what the CLI writes and
  // what every settings file in a `.claude` tree already looks like. Saving
  // through the form therefore normalises whitespace, and only ever on a save
  // somebody asked for.
  const commit = (next: Record<string, unknown>): void =>
    onChange(`${JSON.stringify(next, null, 2)}\n`)
  const set = (key: string, value: unknown): void => commit({ ...document, [key]: value })
  const remove = (key: string): void => {
    const next = { ...document }
    delete next[key]
    commit(next)
  }

  const unset = SETTING_HINTS.filter((hint) => !(hint.key in document))

  return (
    <div className="space-y-3 px-5 py-4">
      {keys.length === 0 && (
        <p className="text-[12px] text-fg-subtle">
          Nothing is set here yet. Add a key below, or open the source to write one Helm has no
          note for.
        </p>
      )}

      {keys.map((key) => (
        <Field
          key={key}
          name={key}
          value={document[key]}
          hint={settingHint(topLevelKey(key))}
          onSet={(value) => set(key, value)}
          onRemove={() => remove(key)}
          onEditSource={onEditSource}
        />
      ))}

      {unset.length > 0 && (
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="sr-only">Add a setting</span>
            <select
              data-add-setting
              aria-label="Add a setting"
              defaultValue=""
              onChange={(event) => {
                const hint = SETTING_HINTS.find((candidate) => candidate.key === event.target.value)
                if (!hint) return
                set(hint.key, blankFor(hint))
                event.target.value = ''
              }}
              className={cn(
                'h-7 w-full max-w-72 min-w-0 rounded-well border border-border bg-surface-sunken px-2',
                'text-[12px] text-fg transition-colors',
                'hover:border-border-strong focus:border-accent focus:outline-none'
              )}
            >
              <option value="">Add a setting…</option>
              {unset.map((hint) => (
                <option key={hint.key} value={hint.key}>
                  {hint.key}
                </option>
              ))}
            </select>
          </label>
          <PlusIcon width={12} height={12} className="shrink-0 text-fg-subtle" />
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-fg-subtle">
            Every key Claude Code documents. Anything else goes in the source.
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * One key.
 *
 * A value the schema cannot describe as a single field - `permissions`, `env`,
 * a list - is shown rather than flattened into a row of inputs. The claim a
 * form makes is that what is on screen is the whole value, and a form that
 * quietly edited the first element of `permissions.allow` would be breaking it.
 * Those get the source, which is the honest editor for them.
 */
function Field({
  name,
  value,
  hint,
  onSet,
  onRemove,
  onEditSource
}: {
  name: string
  value: unknown
  hint: SettingHint | null
  onSet: (value: unknown) => void
  onRemove: () => void
  onEditSource: () => void
}): JSX.Element {
  const structural = value !== null && typeof value === 'object'
  const input =
    'h-7 w-full rounded-well border border-border bg-surface-sunken px-2 text-[12px] text-fg transition-colors hover:border-border-strong focus:border-accent focus:outline-none'

  return (
    <div data-setting-field={name} className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <label className="block">
          <span className="block font-mono text-[11.5px] text-fg">{name}</span>
          {hint && <span className="mt-0.5 block text-[10.5px] text-fg-subtle">{hint.summary}</span>}

          <span className="mt-1.5 block">
            {typeof value === 'boolean' ? (
              <Checkbox
                checked={value}
                onChange={() => onSet(!value)}
                label={name}
                mark={`setting-${name}`}
              />
            ) : structural ? (
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate rounded-well border border-border bg-surface-sunken px-2 py-1 font-mono text-[11px] text-fg-muted">
                  {preview(value)}
                </span>
                <button
                  type="button"
                  data-edit-source={name}
                  onClick={onEditSource}
                  className="shrink-0 rounded-well border border-border-strong px-2 py-1 text-[11px] text-fg transition-colors hover:bg-hover"
                >
                  Edit as JSON
                </button>
              </span>
            ) : hint?.values ? (
              <select
                data-setting-input={name}
                aria-label={name}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => onSet(event.target.value)}
                className={cn(input, 'max-w-64')}
              >
                {!hint.values.includes(String(value)) && (
                  <option value={String(value)}>{String(value)}</option>
                )}
                {hint.values.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : typeof value === 'number' ? (
              <input
                data-setting-input={name}
                aria-label={name}
                type="number"
                value={value}
                onChange={(event) => onSet(Number(event.target.value))}
                className={cn(input, 'max-w-40')}
              />
            ) : (
              <input
                data-setting-input={name}
                aria-label={name}
                value={typeof value === 'string' ? value : preview(value)}
                spellCheck={false}
                onChange={(event) => onSet(event.target.value)}
                className={cn(input, 'max-w-full font-mono text-[11.5px]')}
              />
            )}
          </span>
        </label>
      </div>

      <button
        type="button"
        data-remove-setting={name}
        onClick={onRemove}
        title={`Remove ${name} from this file`}
        className="mt-0.5 shrink-0 rounded-well border border-border px-2 py-1 text-[10.5px] text-fg-subtle transition-colors hover:border-danger/45 hover:text-danger"
      >
        Remove
      </button>
    </div>
  )
}
