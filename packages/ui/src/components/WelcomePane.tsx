import type { JSX } from 'react'
import { cn } from '../lib/cn'

export interface WelcomePaneProps {
  roots: string[]
  projectCount: number
  onAddRoot: () => void
}

/** Shown when no project is selected. Names the roots being scanned so an empty
 * sidebar is diagnosable without opening settings. */
export function WelcomePane({
  roots,
  projectCount,
  onAddRoot
}: WelcomePaneProps): JSX.Element {
  return (
    <div className="grid h-full place-items-center px-8">
      <div className="max-w-md text-center">
        <h1 className="text-[17px] font-semibold tracking-tight text-fg">Helm</h1>
        <p className="mt-1.5 text-[13px] text-fg-muted">
          {projectCount > 0
            ? 'Pick a project on the left.'
            : 'Point Helm at a folder to get started.'}
        </p>

        {roots.length > 0 && (
          <div className="mt-6 text-left">
            <p className="mb-1.5 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
              Scanning
            </p>
            <ul className="rounded-lg border border-border bg-surface">
              {roots.map((root) => (
                <li
                  key={root}
                  className={cn(
                    'truncate border-b border-border px-3 py-2 font-mono text-[11px] text-fg-muted',
                    'last:border-b-0'
                  )}
                  title={root}
                >
                  {root}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          type="button"
          onClick={onAddRoot}
          className="mt-5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
        >
          Add a folder
        </button>
      </div>
    </div>
  )
}
