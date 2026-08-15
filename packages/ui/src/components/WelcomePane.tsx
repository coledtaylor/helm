import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { HelmMarkIcon } from './icons'

export interface WelcomePaneProps {
  roots: string[]
  projectCount: number
  onAddRoot: () => void
  /** Scaffold a harness. The same action first run offers, still reachable. */
  onCreateHarness?: (() => void) | undefined
}

/** Shown when no project is selected. Names the roots being scanned so an empty
 * sidebar is diagnosable without opening settings. */
export function WelcomePane({
  roots,
  projectCount,
  onAddRoot,
  onCreateHarness
}: WelcomePaneProps): JSX.Element {
  return (
    <div
      data-welcome-pane
      className="grid h-full place-items-center rounded-island border border-border bg-surface px-8"
    >
      <div className="max-w-md text-center">
        {/* The mark at watermark scale, standing in for the wordmark that used
            to head this pane - the same argument the title bar's comment makes,
            with more force here: "Helm" set above a Helm wheel says the name
            twice to someone already looking at the app.

            Hairline weight, because this is the empty state of the workspace
            column and the one thing on it that must read is the sentence saying
            what to do next. A watermark that wins that contest has become a
            splash screen.

            The alpha is on the **element**, not in the colour, and that is the
            part to leave alone. `HelmMarkIcon` is eight spokes, eight knobs, a
            rim and a hub painted as separate shapes, so a semi-transparent
            `currentColor` composites each one over the last: measured at
            `text-border-strong`, a spoke came out at R=59 as intended, the rim
            at 87 where two shapes cross, and the hub - where all eight spokes
            converge under the knob - at **188**, three times the value asked
            for, and near-black on white the other way. The mark had a hot bead
            in the middle of it. CSS `opacity` renders the subtree to a buffer
            first and composites it once, so the wheel is flat at any size.

            Which leaves the colour opaque, and `fg-subtle` is the one token
            carrying the same value in both modes (#75798C, theme.css) - so a
            single opacity lands on the same composite either side. Measured off
            the design shot at 35%: rgb(58 60 77) on the dark island against
            border-strong's own rgb(59 60 74), and rgb(207 208 215) on the light
            one against its rgb(208 209 212). The hairline the rest of the app
            draws its edges with, arrived at without the stacking.

            Vector, so it is the taskbar icon's own drawing at 192px rather than
            a bitmap resampled to it (see `HelmMarkIcon`) - the one size where a
            192px .ico entry does not exist and a resampled 256 would be the
            softest thing on the pane. */}
        <HelmMarkIcon
          width={192}
          height={192}
          role="img"
          aria-label="Helm"
          aria-hidden={false}
          className="mx-auto text-fg-subtle opacity-35"
        />
        <p className="mt-8 text-[13px] text-fg-muted">
          {projectCount > 0
            ? 'Pick a project on the left.'
            : 'Point Helm at a folder to get started.'}
        </p>

        {roots.length > 0 && (
          <div className="mt-6 text-left">
            <p className="mb-1.5 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
              Scanning
            </p>
            <ul className="rounded-raised border border-border bg-surface-raised">
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

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={onAddRoot}
            className="rounded-well border border-border-strong px-3 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
          >
            Add a folder
          </button>
          {onCreateHarness && (
            <button
              type="button"
              data-welcome-create-harness
              onClick={onCreateHarness}
              className="rounded-well border border-border-strong px-3 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
            >
              Create a harness
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
