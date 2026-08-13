import type { JSX } from 'react'
import type { ThemePreference } from '@helm/core'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import { MonitorIcon, MoonIcon, SunIcon } from './icons'

const OPTIONS: Array<{
  value: ThemePreference
  label: string
  Icon: typeof SunIcon
}> = [
  { value: 'system', label: 'Match the system theme', Icon: MonitorIcon },
  { value: 'light', label: 'Light theme', Icon: SunIcon },
  { value: 'dark', label: 'Dark theme', Icon: MoonIcon }
]

export interface ThemeToggleProps {
  value: ThemePreference
  onChange: (value: ThemePreference) => void
}

/** Three states, not two: `system` is a real setting, and a two-way switch
 * would silently pin the theme the first time someone touched it. */
export function ThemeToggle({ value, onChange }: ThemeToggleProps): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      // A segmented control (DESIGN.md): a sunken well whose selected segment
      // lifts to the raised surface with a hairline ring - tone, not shadow.
      className="flex items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
    >
      {OPTIONS.map(({ value: option, label, Icon }) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          aria-label={label}
          title={label}
          onClick={() => onChange(option)}
          className={cn(
            'grid size-6 place-items-center rounded-[5px] transition-colors',
            value === option
              ? SEGMENT_ON
              : 'text-fg-subtle hover:text-fg'
          )}
        >
          <Icon width={13} height={13} />
        </button>
      ))}
    </div>
  )
}
