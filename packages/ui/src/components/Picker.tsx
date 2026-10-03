import type { JSX, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { CaretIcon } from './icons'

/**
 * A native select in the sunken well (DESIGN.md 4, "Select"), with a mark
 * beside its value. Native, so a driver can set it and the keyboard and
 * type-ahead are the platform's; its open list is drawn by `base-select`.
 */
export function Picker({
  id,
  icon,
  value,
  onChange,
  className,
  children
}: {
  id: string
  icon?: ReactNode
  value: string
  onChange: (value: string) => void
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <span className={cn('relative block', className)}>
      {icon !== undefined && (
        <span className="pointer-events-none absolute top-1/2 left-[9px] -translate-y-1/2">{icon}</span>
      )}
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-[28px] w-full appearance-none rounded-well border border-border bg-surface-sunken pr-7 text-[12.5px] text-fg',
          'transition-colors hover:border-border-strong focus:border-accent focus:outline-none',
          icon === undefined ? 'pl-[9px]' : 'pl-[29px]'
        )}
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
