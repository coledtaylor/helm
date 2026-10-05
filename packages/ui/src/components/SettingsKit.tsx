import type { JSX, ReactNode } from 'react'
import { createContext, useContext, useId, useState } from 'react'
import { cn } from '../lib/cn'
import { CaretIcon, CheckIcon, WarnIcon } from './icons'

/**
 * The parts every Settings page is drawn with: the page itself, its groups,
 * its rows and their controls.
 *
 * Out of `SettingsPane` so a page drawn somewhere else - a plugin's, the
 * plugins list, the secrets - is the same page rather than a likeness of it.
 */

/**
 * A Settings page: its title, the line under it, and its groups, on the
 * pane's own surface at a reading width.
 */
export function SettingsPage({
  title,
  hint,
  sole,
  aside,
  children,
  ...rest
}: {
  title: string
  hint?: ReactNode | undefined
  /** The page is one group: that group draws no heading of its own. */
  sole: boolean
  /** Beside the title, at its right: a page's own actions. */
  aside?: ReactNode | undefined
  children: ReactNode
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <div data-settings-pane {...rest} className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-7 py-7">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-medium tracking-tight text-fg">{title}</h1>
            {hint !== undefined && <p className="mt-1 text-[12px] leading-[1.5] text-fg-muted">{hint}</p>}
          </div>
          {aside !== undefined && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
        </div>
        <SoleGroup.Provider value={sole}>{children}</SoleGroup.Provider>
      </div>
    </div>
  )
}

/**
 * A field's own copy of a value it edits, committed on blur rather than on
 * every keystroke.
 *
 * Re-seeded when the value changes underneath it - a restart, a Clear button,
 * another surface writing the same setting - by adjusting state during render,
 * which is what React documents for this. An effect would paint one frame of a
 * stale draft first and would be a cascading render besides.
 */
export function useDraft(value: string): [string, (next: string) => void, () => void] {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  return [draft, setDraft, () => setDraft(value)]
}

/**
 * Whether the group being drawn is its section's only one. Such a group is the
 * page: the section's title already names it, so it draws no heading of its
 * own and its hint becomes the line under that title.
 */
export const SoleGroup = createContext(false)

/**
 * One group of settings.
 *
 * A section of the page, titled with the caps label every other section in the
 * app uses and set off from the one above by a faded rule - not a card. The pane
 * is the island (DESIGN.md 3), and a card per group was a box inside it, eleven
 * times over. Future groups append; nothing here knows how many there are.
 */
export function Group({
  name,
  title,
  hint,
  children
}: {
  name: string
  title: string
  hint?: string | undefined
  children: ReactNode
}): JSX.Element {
  // Named by its heading, so each group is a region a screen reader can jump
  // to, under the title a person reads.
  const headingId = useId()
  const sole = useContext(SoleGroup)
  if (sole) {
    return (
      <section data-settings-group={name} aria-label={title}>
        {hint !== undefined && <p className="mt-1 text-[12px] leading-[1.5] text-fg-muted">{hint}</p>}
        <div className="mt-6">{children}</div>
      </section>
    )
  }
  return (
    <section
      data-settings-group={name}
      aria-labelledby={headingId}
      className="mt-6"
    >
      <div aria-hidden className="island-rule mb-5" />
      <header className="pb-2.5">
        <h2
          id={headingId}
          className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase"
        >
          {title}
        </h2>
        {hint !== undefined && (
          <p className="mt-1 text-[11.5px] leading-[1.5] text-fg-muted">{hint}</p>
        )}
      </header>
      <div>{children}</div>
    </section>
  )
}

/** Label and hint on the left, control on the right - wrapping when narrow. */
export function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1.5">
      <div className="min-w-[220px] flex-1">
        <p className="text-[12.5px] text-fg">{label}</p>
        {hint !== undefined && (
          <p className="mt-0.5 text-[11px] leading-[1.5] text-fg-subtle">{hint}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Between rows in a group. Fades at the ends - DESIGN.md, `.island-rule`. */
export function Divider(): JSX.Element {
  return <div aria-hidden className="island-rule my-1.5" />
}

export function Actions({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-3 flex flex-wrap gap-2">{children}</div>
}

/**
 * The resolved-status line: a tone dot and a sentence, not a paragraph.
 *
 * Takes further `data-*` attributes so a group with more than one thing to say
 * can name *which* of its states this sentence is - the tone alone cannot,
 * since two different outcomes can honestly share one. `data-settings-verdict`
 * stays the tone in every group, so a driver reads the two together.
 */
export function Verdict({
  tone,
  text,
  ...rest
}: { tone: 'ok' | 'warn' | 'todo'; text: string } & Record<
  `data-${string}`,
  unknown
>): JSX.Element {
  return (
    <p
      data-settings-verdict={tone}
      {...rest}
      className="flex items-center gap-2 text-[12.5px] text-fg"
    >
      <span
        className={cn(
          'grid size-4 shrink-0 place-items-center rounded-full',
          tone === 'ok'
            ? 'bg-success/15 text-success'
            : tone === 'warn'
              ? 'bg-warn/15 text-warn'
              : 'bg-surface-sunken text-fg-subtle'
        )}
      >
        {tone === 'ok' ? (
          <CheckIcon width={9} height={9} />
        ) : tone === 'warn' ? (
          <WarnIcon width={9} height={9} />
        ) : null}
      </span>
      {text}
    </p>
  )
}

/** A machine fact: a caps label and a mono value that can be selected. */
export function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-[52px] shrink-0 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted select-text">
        {children}
      </dd>
    </div>
  )
}

/**
 * A bounded integer with two buttons.
 *
 * Buttons rather than a text field because the range is small and every value
 * in it is one the user might want to sit and look at: this is a setting people
 * nudge until the terminal looks right, and every nudge repaints every open
 * pane. It also means the control cannot produce a value the validator would
 * reject, so the two never have to disagree.
 */
export function Stepper({
  value,
  min,
  max,
  label,
  onChange,
  ...rest
}: {
  value: number
  min: number
  max: number
  label: string
  onChange: (value: number) => void
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <div
      {...rest}
      className="flex items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
    >
      <StepButton
        label={`Decrease ${label.toLowerCase()}`}
        glyph="−"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      />
      <span
        aria-live="polite"
        aria-label={label}
        className="w-9 text-center font-mono text-[11.5px] tabular-nums text-fg"
      >
        {value}
      </span>
      <StepButton
        label={`Increase ${label.toLowerCase()}`}
        glyph="+"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      />
    </div>
  )
}

export function StepButton({
  label,
  glyph,
  disabled,
  onClick
}: {
  label: string
  glyph: string
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-6 place-items-center rounded-raised text-[13px] leading-none transition-colors',
        'text-fg-subtle hover:bg-hover hover:text-fg',
        'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent'
      )}
    >
      {glyph}
    </button>
  )
}

/**
 * A number too large for a stepper, committed on blur or Enter rather than per
 * keystroke - typing "25000" through a live write would ask for 2, then 25,
 * then 250, and every one of those is a scrollback truncation.
 */
export function NumberField({
  value,
  min,
  max,
  label,
  onCommit,
  ...rest
}: {
  value: number
  min: number
  max: number
  label: string
  onCommit: (value: number) => void
} & Record<`data-${string}`, unknown>): JSX.Element {
  const [draft, setDraft, reset] = useDraft(String(value))

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    if (!Number.isFinite(parsed)) {
      reset()
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') reset()
      }}
      {...rest}
      className={cn(
        'h-[30px] w-[92px] rounded-well border border-border bg-surface-sunken px-2.5',
        'text-right font-mono text-[11.5px] tabular-nums text-fg select-text',
        'focus:border-accent focus:outline-none'
      )}
    />
  )
}

/**
 * A native `<select>` in the sunken-well shape, matching the one in
 * `ProfileEditor`. Native and not a listbox of our own for the same reason: a
 * driver sets it through `HTMLSelectElement.prototype.value`, and a div cannot
 * be set that way.
 */
export function Select({
  value,
  onChange,
  label,
  children,
  ...rest
}: {
  value: string
  onChange: (value: string) => void
  label: string
  children: ReactNode
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <span className="relative block">
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
        className={cn(
          'h-[30px] w-[220px] appearance-none rounded-well border border-border bg-surface-sunken',
          'pr-7 pl-2.5 text-[12px] text-fg transition-colors',
          'hover:border-border-strong focus:border-accent focus:outline-none'
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

/** A button in a settings row: secondary, or primary - outlined in the accent, never filled (DESIGN.md 4). */
export function Action({
  children,
  onClick,
  disabled = false,
  primary = false,
  ...rest
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  title?: string
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...rest}
      className={cn(
        'rounded-well border px-3 py-1.5 text-[12px] transition-colors',
        'disabled:cursor-default disabled:opacity-50',
        primary
          ? 'border-accent text-accent-text hover:bg-accent-soft'
          : 'border-border-strong text-fg hover:bg-hover'
      )}
    >
      {children}
    </button>
  )
}
