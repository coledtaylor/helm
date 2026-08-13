import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
// Values, not just types - so this comes from `@helm/core/types`, which is the
// one entry point with no `node:` imports behind it. The package root reaches
// the filesystem through `launch/` and `store/`, and a value import of it from
// the renderer bundle fails at rollup.
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type EffortLevel,
  type PermissionMode,
  type Profile,
  type ProfileDraft,
  type Project
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { Checkbox } from './Checkbox'
import { CaretIcon, CloseIcon, HelmMarkIcon } from './icons'

export interface ProfileEditorProps {
  /** The profile being edited, or a draft to seed a new one. */
  initial: Profile | ProfileDraft
  /** Discovered projects, for the overlay and access pickers. */
  projects: Project[]
  /** Problems from the last save attempt. */
  problems?: readonly string[] | undefined
  saving?: boolean | undefined
  onSave: (draft: ProfileDraft) => void
  onCancel: () => void
  /** Deleting an existing profile. Absent on a new one, which has nothing to delete. */
  onDelete?: (() => void) | undefined
}

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const

/**
 * The profile form.
 *
 * Overlays and access are the two lists that matter and they are presented as
 * one table over the discovered projects, with a checkbox each. They are
 * genuinely different questions - composing a repo's skills is not granting its
 * files - and putting them in two separate pickers would mean picking the same
 * eight repos twice, so they share a row and differ by column.
 *
 * A repo ticked as an overlay is ticked for access too, because composing a
 * project's skills and then denying the session its files produces skills that
 * cannot do anything. Unticking access afterwards is allowed; it is just not
 * the default anyone wants.
 */
export function ProfileEditor({
  initial,
  projects,
  problems = [],
  saving = false,
  onSave,
  onCancel,
  onDelete
}: ProfileEditorProps): JSX.Element {
  const [name, setName] = useState(initial.name)
  const [root, setRoot] = useState(initial.root)
  const [overlays, setOverlays] = useState<string[]>(initial.overlays)
  const [access, setAccess] = useState<string[]>(initial.access)
  const [model, setModel] = useState(initial.model ?? '')
  const [effort, setEffort] = useState(initial.effort ?? '')
  const [permissionMode, setPermissionMode] = useState(initial.permissionMode ?? '')
  const [agent, setAgent] = useState(initial.agent ?? '')
  const [mcp, setMcp] = useState(initial.mcp.join(', '))
  const [openingPrompt, setOpeningPrompt] = useState(initial.openingPrompt ?? '')
  const [filter, setFilter] = useState('')

  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])

  // Escape closes. Captured on the window, because the focus may be inside any
  // of a dozen fields and each of them would otherwise need the handler.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const has = (list: string[], path: string): boolean =>
    list.some((entry) => entry.toLowerCase() === path.toLowerCase())

  const toggleOverlay = (path: string): void => {
    if (has(overlays, path)) {
      setOverlays((current) => current.filter((entry) => entry.toLowerCase() !== path.toLowerCase()))
      return
    }
    setOverlays((current) => [...current, path])
    setAccess((current) => (has(current, path) ? current : [...current, path]))
  }

  const toggleAccess = (path: string): void => {
    setAccess((current) =>
      has(current, path)
        ? current.filter((entry) => entry.toLowerCase() !== path.toLowerCase())
        : [...current, path]
    )
  }

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const matching =
      needle === ''
        ? projects
        : projects.filter(
            (project) =>
              project.name.toLowerCase().includes(needle) ||
              project.path.toLowerCase().includes(needle)
          )
    // Anything already chosen stays on screen regardless of the filter, so a
    // narrowed list cannot hide a selection the user is about to save.
    const chosen = projects.filter(
      (project) =>
        (has(overlays, project.path) || has(access, project.path)) &&
        !matching.some((m) => m.path === project.path)
    )
    return [...chosen, ...matching]
  }, [projects, filter, overlays, access])

  const submit = (): void => {
    onSave({
      name: name.trim(),
      root: root.trim(),
      overlays,
      access,
      model: model.trim() || null,
      effort: (effort as EffortLevel) || null,
      permissionMode: (permissionMode as PermissionMode) || null,
      agent: agent.trim() || null,
      mcp: mcp
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      openingPrompt: openingPrompt.trim() || null,
      pinnedOrder: 'pinnedOrder' in initial ? initial.pinnedOrder : null
    })
  }

  return (
    // `fixed`, not `absolute`: this is mounted inside the pane, and an absolute
    // backdrop would dim the pane while leaving the sidebar lit and clickable -
    // which is not what `aria-modal` promises.
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={'id' in initial ? `Edit ${initial.name}` : 'New profile'}
        className={cn(
          // A modal is the one surface that gets a shadow (DESIGN.md): a 12px
          // island lifted off a dimmed canvas, with the stronger hairline.
          'flex max-h-full w-full max-w-[620px] flex-col overflow-hidden rounded-xl',
          'border border-border-strong bg-surface shadow-panel'
        )}
      >
        <header className="flex shrink-0 items-center gap-[9px] px-[22px] pt-[18px]">
          <HelmMarkIcon width={13} height={13} className="shrink-0 text-accent" />
          <h2 className="text-[15px] font-medium tracking-tight text-fg">
            {'id' in initial ? 'Edit profile' : 'New profile'}
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

        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-4 pb-1">
          {problems.length > 0 && (
            <ul
              role="alert"
              className="mb-4 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
            >
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}

          <div className="grid gap-[14px] sm:grid-cols-2">
            <Field label="Name" hint="Shown in the launcher and used as the session name.">
              <input
                ref={nameRef}
                aria-label="Profile name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                className={inputClass}
              />
            </Field>
            <Field label="Root" hint="The working directory. Config resolves from here.">
              <input
                value={root}
                aria-label="Root directory"
                onChange={(e) => setRoot(e.target.value)}
                spellCheck={false}
                className={cn(inputClass, 'font-mono text-[11px] text-fg-muted')}
              />
            </Field>
          </div>

          <fieldset className="mt-4">
            <legend className={labelClass}>Composition</legend>
            <p className="mt-1.5 mb-2 text-[11px] leading-[1.55] text-fg-muted">
              <strong className="font-medium text-fg">Compose</strong> loads a project&rsquo;s
              skills, agents and commands under its own namespace.{' '}
              <strong className="font-medium text-fg">Access</strong> lets the session read and
              write its files.
            </p>

            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter projects"
              spellCheck={false}
              aria-label="Filter projects"
              className={cn(inputClass, 'h-[26px] text-[11.5px]')}
            />

            <div className="mt-2 overflow-hidden rounded-raised border border-border">
              <div className="flex items-center bg-surface-raised px-3 py-1.5">
                <span className={cn(labelClass, 'flex-1 text-[9px]')}>Project</span>
                <span className={cn(labelClass, 'w-[70px] text-center text-[9px]')}>Compose</span>
                <span className={cn(labelClass, 'w-[70px] text-center text-[9px]')}>Access</span>
              </div>
              <div className="max-h-56 overflow-y-auto">
                {visible.length === 0 ? (
                  <p className="border-t border-border px-3 py-6 text-center text-[12px] text-fg-subtle">
                    No projects match.
                  </p>
                ) : (
                  visible.map((project) => (
                    <div
                      key={project.path}
                      className="flex items-center border-t border-border px-3 py-[7px] transition-colors hover:bg-hover"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-[7px]">
                          <span className="min-w-0 truncate text-[12px] text-fg">
                            {project.name}
                          </span>
                          {project.kind === 'harness' && (
                            <span className="shrink-0 rounded-full bg-accent-soft px-[7px] py-px text-[8.5px] tracking-[.05em] text-accent-text uppercase">
                              harness root
                            </span>
                          )}
                        </span>
                        <span className="block truncate font-mono text-[9.5px] text-fg-subtle">
                          {project.path}
                        </span>
                      </span>
                      <span className="flex w-[70px] justify-center">
                        <Checkbox
                          checked={has(overlays, project.path)}
                          onChange={() => toggleOverlay(project.path)}
                          label={`Compose ${project.name}`}
                        />
                      </span>
                      <span className="flex w-[70px] justify-center">
                        <Checkbox
                          checked={has(access, project.path)}
                          onChange={() => toggleAccess(project.path)}
                          label={`Grant access to ${project.name}`}
                        />
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </fieldset>

          <div className="mt-4 grid gap-[14px] sm:grid-cols-2">
            <Field label="Model">
              <Select value={model} onChange={setModel} label="Model">
                <option value="">Default</option>
                {MODELS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Effort">
              <Select value={effort} onChange={setEffort} label="Effort">
                <option value="">Default</option>
                {EFFORT_LEVELS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Permission mode">
              <Select value={permissionMode} onChange={setPermissionMode} label="Permission mode">
                <option value="">Default</option>
                {PERMISSION_MODES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Agent" hint="Optional. Overrides the session's agent.">
              <input
                value={agent}
                aria-label="Agent"
                onChange={(e) => setAgent(e.target.value)}
                spellCheck={false}
                className={inputClass}
              />
            </Field>
            <Field label="MCP servers" hint="Comma separated. Saved and exported; see the config console.">
              <input
                value={mcp}
                aria-label="MCP servers"
                onChange={(e) => setMcp(e.target.value)}
                spellCheck={false}
                className={inputClass}
              />
            </Field>
            <Field label="Opening prompt" hint="Submitted as the first message, e.g. /recap.">
              <input
                value={openingPrompt}
                aria-label="Opening prompt"
                onChange={(e) => setOpeningPrompt(e.target.value)}
                spellCheck={false}
                placeholder="e.g. /recap"
                className={inputClass}
              />
            </Field>
          </div>
        </div>

        <footer className="mx-[22px] flex shrink-0 items-center gap-2 border-t border-border py-3.5">
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="rounded-well border border-border-strong px-3 py-1.5 text-[12px] text-warn transition-colors hover:bg-hover"
            >
              Delete profile
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            className="rounded-well border border-border-strong px-3.5 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className={cn(
              'rounded-well border border-accent px-3.5 py-1.5 text-[12px] font-medium text-accent-text transition-colors',
              saving ? 'cursor-default opacity-60' : 'hover:bg-accent-soft active:bg-active'
            )}
          >
            {saving ? 'Saving…' : 'id' in initial ? 'Save changes' : 'Save profile'}
          </button>
        </footer>
      </div>
    </div>
  )
}

const inputClass = cn(
  'h-[30px] w-full rounded-well border border-border bg-surface-sunken px-2.5 text-[12.5px]',
  'text-fg placeholder:text-fg-subtle select-text',
  'transition-colors hover:border-border-strong focus:border-accent focus:outline-none'
)

const labelClass =
  'block text-[9.5px] font-semibold tracking-[.08em] text-fg-subtle uppercase'

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <label className="block">
      <span className={cn(labelClass, 'mb-1.5')}>{label}</span>
      {children}
      {hint !== undefined && (
        <span className="mt-[5px] block text-[10px] text-fg-subtle">{hint}</span>
      )}
    </label>
  )
}

/**
 * A native `<select>` in the sunken-well shape, with the platform arrow
 * replaced by the system's own caret. Native and not a listbox of our own: the
 * drivers set it through `HTMLSelectElement.prototype.value`, and a div cannot
 * be set that way.
 */
function Select({
  value,
  onChange,
  label,
  children
}: {
  value: string
  onChange: (value: string) => void
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <span className="relative block">
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className={cn(inputClass, 'appearance-none pr-7')}
      >
        {children}
      </select>
      <CaretIcon
        width={9}
        height={9}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rotate-90 text-fg-subtle"
      />
    </span>
  )
}

/**
 * The one control the system allows a solid accent fill (DESIGN.md §4).
 *
 * A real `<input type="checkbox">` under an overlaid tick rather than a styled
 * button: it keeps the label association, the space key, and `el.checked` -
 * which is what profiles-check reads to prove composing a repo also granted it
 * access.
 */
