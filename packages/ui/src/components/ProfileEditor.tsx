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
import { CloseIcon } from './icons'

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
  onCancel
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
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-6"
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
          'flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl',
          'border border-border-strong bg-surface shadow-panel'
        )}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <span aria-hidden className="size-[11px] rounded-[3px] bg-accent" />
          <h2 className="text-[13px] font-medium tracking-tight text-fg">
            {'id' in initial ? 'Edit profile' : 'New profile'}
          </h2>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            title="Close"
            className="grid size-6 place-items-center rounded text-fg-subtle hover:bg-hover hover:text-fg"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
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

          <div className="grid gap-3 sm:grid-cols-2">
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
                className={cn(inputClass, 'font-mono text-[11px]')}
              />
            </Field>
          </div>

          <fieldset className="mt-4">
            <legend className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
              Composition
            </legend>
            <p className="mt-1 text-[11px] text-fg-muted">
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
              className={cn(inputClass, 'mt-2')}
            />

            <div className="mt-2 max-h-56 overflow-y-auto rounded-raised border border-border">
              <table className="w-full border-collapse text-[12px]">
                <thead className="sticky top-0 bg-surface-sunken">
                  <tr className="text-[10px] tracking-wide text-fg-subtle uppercase">
                    <th className="px-2 py-1.5 text-left font-medium">Project</th>
                    <th className="w-20 px-2 py-1.5 text-center font-medium">Compose</th>
                    <th className="w-20 px-2 py-1.5 text-center font-medium">Access</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-2 py-6 text-center text-[12px] text-fg-subtle">
                        No projects match.
                      </td>
                    </tr>
                  ) : (
                    visible.map((project) => (
                      <tr key={project.path} className="border-t border-border hover:bg-hover">
                        <td className="min-w-0 px-2 py-1.5">
                          <span className="block truncate text-fg">{project.name}</span>
                          <span className="block truncate font-mono text-[10px] text-fg-subtle">
                            {project.path}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={has(overlays, project.path)}
                            onChange={() => toggleOverlay(project.path)}
                            aria-label={`Compose ${project.name}`}
                            className="accent-accent"
                          />
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={has(access, project.path)}
                            onChange={() => toggleAccess(project.path)}
                            aria-label={`Grant access to ${project.name}`}
                            className="accent-accent"
                          />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </fieldset>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Model">
              <select
                value={model}
                aria-label="Model"
                onChange={(e) => setModel(e.target.value)}
                className={inputClass}
              >
                <option value="">Default</option>
                {MODELS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Effort">
              <select
                value={effort}
                aria-label="Effort"
                onChange={(e) => setEffort(e.target.value)}
                className={inputClass}
              >
                <option value="">Default</option>
                {EFFORT_LEVELS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Permission mode">
              <select
                value={permissionMode}
                aria-label="Permission mode"
                onChange={(e) => setPermissionMode(e.target.value)}
                className={inputClass}
              >
                <option value="">Default</option>
                {PERMISSION_MODES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
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
            <Field label="MCP servers" hint="Comma separated. Saved and exported; see M5.">
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
                className={inputClass}
              />
            </Field>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
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
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </footer>
      </div>
    </div>
  )
}

const inputClass = cn(
  'h-7 w-full rounded-well border border-border bg-surface-sunken px-2 text-[12px]',
  'text-fg placeholder:text-fg-subtle select-text',
  'focus:border-accent focus:outline-none'
)

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
      <span className="mb-1 block text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
        {label}
      </span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-[10px] text-fg-subtle">{hint}</span>}
    </label>
  )
}
