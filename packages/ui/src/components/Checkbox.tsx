import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { CheckIcon } from './icons'

/**
 * The app's checkbox (DESIGN.md 4): a solid accent square with an `accent-fg`
 * check, a 1.5px `fg-subtle` outline when unchecked.
 *
 * Extracted because it existed twice, byte for byte, in `ProfileEditor` and
 * `SettingsPane` - and because two *other* places wanted a checkbox, did not
 * find one to import, and reached for a bare `<input type="checkbox">` tinted
 * with `accent-color`. Those two were the platform's control wearing the app's
 * colour: no outline of ours, a size of the platform's choosing, and - the way
 * this surfaced - no hover state available at all, since a native checkbox
 * exposes nothing to style.
 *
 * The check mark is a sibling rather than a background image so it inherits a
 * real token colour, and it is `pointer-events-none` so the click always lands
 * on the input underneath it.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  mark,
  disabled = false
}: {
  checked: boolean
  onChange: () => void
  /** The accessible name. Pass the visible text where this sits inside a
   * `<label>`; the two saying the same thing is not a conflict. */
  label: string
  /**
   * A bare `data-` attribute a driver reaches this control by, written as the
   * full attribute name. Spread rather than fixed, so a call site keeps the
   * hook it already had instead of every driver learning a new one.
   */
  mark?: string | undefined
  /** Shown but not changeable: a row that is listed for its reason, not its choice. */
  disabled?: boolean | undefined
}): JSX.Element {
  const marker = mark === undefined ? {} : { [mark]: '' }
  return (
    <span className="relative grid size-4 shrink-0 place-items-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-label={label}
        {...marker}
        className={cn(
          'peer size-4 cursor-pointer appearance-none rounded-raised border-[1.5px] border-fg-subtle',
          'transition-colors checked:border-accent checked:bg-accent hover:border-fg-muted',
          'disabled:cursor-default disabled:opacity-40 disabled:hover:border-fg-subtle'
        )}
      />
      <CheckIcon
        width={10}
        height={10}
        className="pointer-events-none absolute text-accent-fg opacity-0 peer-checked:opacity-100"
      />
    </span>
  )
}
