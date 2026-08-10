import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon, HarnessIcon } from './icons'

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
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-6"
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
          'flex w-full max-w-lg flex-col overflow-hidden rounded-xl',
          'border border-border-strong bg-surface shadow-panel'
        )}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <HarnessIcon width={14} height={14} className="text-accent" />
          <h2 className="text-[13px] font-medium tracking-tight text-fg">
            {mode === 'new' ? 'Create a harness' : 'Turn a folder into a harness'}
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

        <div className="px-4 py-4">
          <div
            role="radiogroup"
            aria-label="What to create"
            className="mb-4 flex gap-1 rounded-well border border-border bg-surface-sunken p-0.5"
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
              className="mb-4 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
            >
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}

          <label className="block text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
            {mode === 'new' ? 'Create it inside' : 'The folder'}
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              readOnly
              value={dir}
              aria-label={mode === 'new' ? 'Parent folder' : 'Folder'}
              data-harness-dir
              placeholder="Choose a folder…"
              className={cn(
                'h-8 min-w-0 flex-1 rounded-well border border-border bg-surface-sunken px-2',
                'font-mono text-[11px] text-fg-muted select-text'
              )}
            />
            <button
              type="button"
              data-harness-choose
              onClick={onChooseDir}
              className="shrink-0 rounded-well border border-border-strong px-2.5 text-[12px] text-fg transition-colors hover:bg-hover"
            >
              Choose…
            </button>
          </div>

          {mode === 'new' && (
            <>
              <label
                htmlFor="harness-name"
                className="mt-4 block text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase"
              >
                Name
              </label>
              <input
                id="harness-name"
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                data-harness-name
                placeholder="work"
                className={cn(
                  'mt-1.5 h-8 w-full rounded-well border border-border bg-surface-sunken px-2',
                  'text-[12px] text-fg select-text placeholder:text-fg-subtle',
                  'focus:border-accent focus:outline-none'
                )}
              />
            </>
          )}

          <div className="mt-4 rounded-raised border border-border bg-surface-sunken px-3 py-2.5">
            <p className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
              What gets written
            </p>
            <p
              className="mt-1 truncate font-mono text-[11px] text-fg-muted"
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
            <p className="mt-2 text-[11px] text-fg-subtle">
              {mode === 'new'
                ? 'Nothing else. No starter skills, notes or rules - what belongs in a harness is yours to decide.'
                : 'Nothing is moved or renamed. The manifest records repos: "." so the repositories already in this folder stay visible.'}
            </p>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-well border border-border-strong px-3 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
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
            {busy ? 'Creating…' : mode === 'new' ? 'Create' : 'Convert'}
          </button>
        </footer>
      </div>
    </div>
  )
}
