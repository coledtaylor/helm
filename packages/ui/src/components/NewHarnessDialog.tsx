import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon, HelmMarkIcon } from './icons'

export interface NewHarnessDialogProps {
  /**
   * Which of the two the dialog opens on. Both are reachable from inside it -
   * they are the same decision seen from two directions ("I want a workspace"
   * versus "I already have one"), and someone who picks the wrong one should
   * not have to close the dialog to say so.
   *
   * 'new' scaffolds a directory that does not exist yet. 'convert' writes a
   * manifest into one that already holds repositories.
   */
  mode: 'new' | 'convert'
  /** For 'new', the folder it will be created inside; for 'convert', the folder itself. */
  dir: string
  onChooseDir: () => void
  problems?: readonly string[] | undefined
  busy?: boolean | undefined
  onCreate: (request: { mode: 'new' | 'convert'; dir: string; name: string }) => void
  onCancel: () => void
}

/**
 * Creating a harness, which is a smaller thing than the word suggests: a
 * directory with a `harness.yaml` in it. The dialog says exactly what will be
 * written, because "scaffold" is a word that usually means a dozen files with
 * opinions in them and here it means three entries with none.
 */
export function NewHarnessDialog({
  mode: initialMode,
  dir,
  onChooseDir,
  problems = [],
  busy = false,
  onCreate,
  onCancel
}: NewHarnessDialogProps): JSX.Element {
  const [mode, setMode] = useState(initialMode)
  const [name, setName] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === 'new') nameRef.current?.focus()
  }, [mode])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const trimmed = name.trim()
  const ready = dir !== '' && (mode === 'convert' || trimmed !== '')
  // Joined with whichever separator the chosen path already uses, so the
  // preview is the path the main process will build rather than a POSIX
  // rendering of a Windows one.
  const separator = dir.includes('\\') ? '\\' : '/'
  const target =
    mode === 'convert' || dir === ''
      ? dir
      : `${dir.replace(/[\\/]+$/, '')}${separator}${trimmed}`

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'new' ? 'Create a harness' : 'Turn a folder into a harness'}
        data-harness-dialog={mode}
        className={cn(
          // The modal island: 12px radius, stronger hairline, and the one
          // shadow the system allows (DESIGN.md).
          'flex max-h-full w-full max-w-[520px] flex-col overflow-hidden rounded-xl',
          'border border-border-strong bg-surface shadow-panel'
        )}
      >
        <header className="flex shrink-0 items-center gap-[9px] px-[22px] pt-[18px]">
          <HelmMarkIcon width={13} height={13} className="shrink-0 text-accent" />
          <h2 className="text-[15px] font-medium tracking-tight text-fg">
            {mode === 'new' ? 'New harness' : 'Turn a folder into a harness'}
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
            A harness is a working root with its own config, repos and sessions. Projects and Config
            always resolve inside one.
          </p>

          <div
            role="radiogroup"
            aria-label="What to create"
            className="mt-4 flex gap-1 rounded-well border border-border bg-surface-sunken p-0.5"
          >
            {(['new', 'convert'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={mode === candidate}
                data-harness-mode={candidate}
                onClick={() => setMode(candidate)}
                className={cn(
                  'flex-1 rounded-[5px] px-2.5 py-1 text-[12px] transition-colors',
                  mode === candidate
                    ? 'bg-surface-raised text-fg ring-1 ring-border-strong'
                    : 'text-fg-muted hover:text-fg'
                )}
              >
                {candidate === 'new' ? 'A new folder' : 'A folder I already have'}
              </button>
            ))}
          </div>

          {problems.length > 0 && (
            <ul
              role="alert"
              data-harness-problems
              className="mt-4 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
            >
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}

          {mode === 'new' && (
            <label className="mt-4 block">
              <span className={cn(labelClass, 'mb-1.5')}>Name</span>
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                data-harness-name
                aria-label="Harness name"
                placeholder="e.g. client-work"
                className={inputClass}
              />
            </label>
          )}

          <label className="mt-[14px] block">
            <span className={cn(labelClass, 'mb-1.5')}>
              {mode === 'new' ? 'Create it inside' : 'The folder'}
            </span>
            <span className="flex gap-2">
              <input
                readOnly
                value={dir}
                aria-label={mode === 'new' ? 'Parent folder' : 'Folder'}
                data-harness-dir
                placeholder="Choose a folder…"
                className={cn(inputClass, 'min-w-0 flex-1 font-mono text-[11px] text-fg-muted')}
              />
              <button
                type="button"
                data-harness-choose
                onClick={onChooseDir}
                className="h-[30px] shrink-0 rounded-well border border-border-strong px-2.5 text-[12px] text-fg transition-colors hover:bg-hover"
              >
                Choose…
              </button>
            </span>
            <span className="mt-[5px] block text-[10px] text-fg-subtle">
              {mode === 'new'
                ? 'The harness is created as a folder of this name inside it.'
                : 'Nothing is moved or renamed.'}
            </span>
          </label>

          <div className="mt-4">
            <span className={cn(labelClass, 'mb-1.5')}>What gets written</span>
            <div className="rounded-raised border border-border bg-surface-sunken px-3 py-2.5">
              <p
                className="truncate font-mono text-[11px] text-fg-muted"
                title={target}
                data-harness-target
              >
                {target === '' ? '…' : target}
              </p>
              <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-fg-subtle">
                <li>harness.yaml</li>
                {mode === 'new' && <li>repos/</li>}
                <li>.claude/</li>
              </ul>
              <p className="mt-2 text-[11px] leading-[1.55] text-fg-subtle">
                {mode === 'new'
                  ? 'Nothing else. No starter skills, notes or rules - what belongs in a harness is yours to decide.'
                  : 'The manifest records repos: "." so the repositories already in this folder stay visible.'}
              </p>
            </div>
          </div>
        </div>

        <footer className="mx-[22px] flex shrink-0 items-center justify-end gap-2 border-t border-border py-3.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-well border border-border-strong px-3.5 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            data-harness-create
            disabled={!ready || busy}
            onClick={() => onCreate({ mode, dir, name: trimmed })}
            className={cn(
              'rounded-well border px-3.5 py-1.5 text-[12px] font-medium transition-colors',
              ready && !busy
                ? 'border-accent text-accent-text hover:bg-accent-soft'
                : 'cursor-default border-border text-fg-subtle opacity-60'
            )}
          >
            {busy ? 'Creating…' : mode === 'new' ? 'Create harness' : 'Convert'}
          </button>
        </footer>
      </div>
    </div>
  )
}

const inputClass = cn(
  'h-[30px] w-full rounded-well border border-border bg-surface-sunken px-2.5 text-[12.5px]',
  'text-fg placeholder:text-fg-subtle select-text',
  'focus:border-accent focus:outline-none'
)

const labelClass = 'block text-[9.5px] font-semibold tracking-[.08em] text-fg-subtle uppercase'
