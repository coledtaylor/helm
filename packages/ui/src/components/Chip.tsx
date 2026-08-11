import type { JSX, ReactNode } from 'react'
import { cn } from '../lib/cn'

export type ChipTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'

const TONE: Record<ChipTone, string> = {
  neutral: 'text-fg-subtle',
  accent: 'text-accent',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger'
}

export interface ChipProps {
  icon?: ReactNode | undefined
  children: ReactNode
  tone?: ChipTone | undefined
  title?: string | undefined
  /** Let the label ellipsise instead of pushing the row wider. */
  truncate?: boolean | undefined
  /**
   * The sidebar's line box: 10.5px on a 13px lead. The 15px default is sized
   * for 11px text, and a two-line list row pays for those 2px on every row.
   */
  dense?: boolean | undefined
  className?: string | undefined
}

/**
 * A small count or status marker. Deliberately borderless: a project row can
 * carry five of these and outlined pills at that density read as noise.
 *
 * Two details that only show up at 11px. The icon is `shrink-0`, because a flex
 * item with an intrinsic width still compresses to nothing once its row
 * overflows - the symptom is a branch chip that silently loses its icon on
 * exactly the long branch names. And the line box is 15px rather than
 * `leading-none`, which crops the descenders off `g`, `p` and `y`.
 */
export function Chip({
  icon,
  children,
  tone = 'neutral',
  title,
  truncate = false,
  dense = false,
  className
}: ChipProps): JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 tabular-nums',
        dense ? 'text-[10.5px] leading-[13px]' : 'text-[11px] leading-[15px]',
        truncate ? 'min-w-0' : 'shrink-0 whitespace-nowrap',
        TONE[tone],
        className
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {truncate ? <span className="min-w-0 truncate">{children}</span> : children}
    </span>
  )
}
