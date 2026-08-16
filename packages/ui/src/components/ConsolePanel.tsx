import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import { CloseIcon, ConsoleIcon } from './icons'

/**
 * A line something wrote to a console, from either of the two places Helm
 * captures one.
 *
 * `at` is optional because the artifact capture predates this panel and its
 * entries do not carry a timestamp. The panel prints a clock only where there
 * is one rather than inventing `Date.now()` at render, which would put a time
 * on an entry that says when it was *drawn*.
 */
export interface ConsoleEntry {
  level: string
  message: string
  source: string
  line: number
  at?: number | undefined
}

export type ConsoleFilter = 'all' | 'errors' | 'warnings' | 'logs'

export interface ConsolePanelProps {
  /** Names the panel for a driver: `browser` or `artifact`. */
  name: string
  entries: readonly ConsoleEntry[]
  open: boolean
  onToggle: () => void
  /**
   * Evaluate this in the page and resolve with what to print.
   *
   * **Absent means read-only, and that is the whole difference between the two
   * places this component is used.** An HTML artifact runs in a frame with an
   * opaque origin, where `postMessage` is deliberately the only channel in
   * (`ContentDocumentPane`); Helm cannot execute in there and should not gain
   * the ability to. A browser view is a `WebContentsView` whose web contents
   * the main process owns, so it can - and the same `executeJavaScript`
   * plumbing is what M17's `browser_evaluate` is built on.
   */
  onEvaluate?: ((source: string) => Promise<{ ok: boolean; value: string; error: string | null }>) | undefined
  /** Extra sentence under the header - the artifact's "read-only" note. */
  note?: string | undefined
}

/**
 * The console panel: a collapsed chip that counts errors, and a scroll of
 * entries under it.
 *
 * **One component, two places, and the second one is a bug being fixed on the
 * way past.** The content viewer has captured what an HTML artifact writes to
 * its console since artifacts landed - `attachArtifactConsole` streams it,
 * `useContent` keeps the last fifty - and the only way to see any of it was a
 * `title` attribute on a count. The data was there and there was no way to read
 * it. That count is now this panel's toggle.
 *
 * The evaluating input line is what the two uses differ by, and it is a
 * capability rather than a decoration: a console you can only read is half a
 * console. It is absent for the artifact because Helm genuinely cannot reach
 * into that frame, which is the design and not a limitation to route around.
 */
export function ConsolePanel({
  name,
  entries,
  open,
  onToggle,
  onEvaluate,
  note
}: ConsolePanelProps): JSX.Element {
  const [filter, setFilter] = useState<ConsoleFilter>('all')
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  /**
   * What the input line has been asked and answered, newest last.
   *
   * Kept beside the captured entries rather than merged into them: a page's own
   * `console.log` and an expression somebody typed are different kinds of
   * thing, and a filter that hid your own answer because it was not an error
   * would be a filter that hid the reason you opened the panel.
   */
  const [evaluated, setEvaluated] = useState<
    Array<{ source: string; value: string; error: string | null }>
  >([])
  const scrollRef = useRef<HTMLDivElement>(null)

  const errors = useMemo(
    () => entries.filter((entry) => LEVEL[entry.level] === 'error' || LEVEL[entry.level] === 'warning'),
    [entries]
  )

  const shown = useMemo(() => {
    if (filter === 'all') return entries
    if (filter === 'errors') return entries.filter((entry) => LEVEL[entry.level] === 'error')
    if (filter === 'warnings') return entries.filter((entry) => LEVEL[entry.level] === 'warning')
    return entries.filter((entry) => LEVEL[entry.level] !== 'error' && LEVEL[entry.level] !== 'warning')
  }, [entries, filter])

  // A console scrolls with its output. Only while it is open and only when
  // something new arrived, so reading back through old entries is not
  // interrupted by a page that is still logging.
  const count = entries.length + evaluated.length
  useEffect(() => {
    if (!open || scrollRef.current === null) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [open, count])

  const evaluate = (): void => {
    const source = input.trim()
    if (source === '' || onEvaluate === undefined || running) return
    setRunning(true)
    void onEvaluate(source)
      .then((answer) => {
        setEvaluated((current) => [
          ...current.slice(-49),
          { source, value: answer.value, error: answer.error }
        ])
        setInput('')
      })
      .catch((err: unknown) => {
        setEvaluated((current) => [
          ...current.slice(-49),
          { source, value: '', error: err instanceof Error ? err.message : String(err) }
        ])
      })
      .finally(() => setRunning(false))
  }

  return (
    <div
      data-console={name}
      data-console-open={open ? 'true' : 'false'}
      data-console-entries={entries.length}
      data-console-errors={errors.length}
      className="flex min-h-0 shrink-0 flex-col border-t border-border bg-surface"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          data-console-toggle={name}
          onClick={onToggle}
          aria-expanded={open}
          title={open ? 'Hide the console' : 'Show the console'}
          className={cn(
            'flex items-center gap-1.5 rounded-well px-1.5 py-0.5 text-[11px] transition-colors',
            'text-fg-subtle hover:bg-hover hover:text-fg'
          )}
        >
          <ConsoleIcon width={12} height={12} className="shrink-0" />
          <span>Console</span>
          <span
            data-console-chip={name}
            className={cn(
              'tabular-nums',
              errors.length > 0 ? 'text-danger' : 'text-fg-subtle'
            )}
          >
            {errors.length > 0
              ? `${String(errors.length)} error${errors.length === 1 ? '' : 's'}`
              : entries.length > 0
                ? `${String(entries.length)}`
                : 'clean'}
          </span>
        </button>

        <span className="flex-1" />

        {open && (
          <div role="group" aria-label="Filter console entries" className="flex items-center gap-0.5">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                data-console-filter={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  'rounded-well px-1.5 py-0.5 text-[11px] transition-colors',
                  filter === value ? SEGMENT_ON : 'text-fg-muted hover:bg-hover hover:text-fg'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {open && (
          <button
            type="button"
            data-console-close={name}
            onClick={onToggle}
            aria-label="Hide the console"
            className="grid size-5 place-items-center rounded-well text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <CloseIcon width={11} height={11} />
          </button>
        )}
      </div>

      {open && (
        <>
          {note !== undefined && (
            <p className="shrink-0 border-t border-border px-3 py-1 text-[11px] text-fg-subtle">
              {note}
            </p>
          )}
          <div
            ref={scrollRef}
            data-console-scroll={name}
            className="min-h-0 flex-1 overflow-auto border-t border-border font-mono text-[11px] leading-[17px]"
          >
            {shown.length === 0 && evaluated.length === 0 ? (
              <p className="px-3 py-2 font-sans text-fg-subtle">
                {entries.length === 0
                  ? 'Nothing has been logged.'
                  : 'Nothing at this level.'}
              </p>
            ) : (
              <>
                {shown.map((entry, at) => (
                  <div
                    key={`${String(at)}-${String(entry.at ?? 0)}`}
                    data-console-entry={LEVEL[entry.level] ?? 'log'}
                    className={cn(
                      'flex gap-2 border-b border-border/50 px-3 py-1',
                      LEVEL[entry.level] === 'error'
                        ? 'text-danger'
                        : LEVEL[entry.level] === 'warning'
                          ? 'text-warn'
                          : 'text-fg-muted'
                    )}
                  >
                    {entry.at !== undefined && (
                      <span className="shrink-0 tabular-nums text-fg-subtle">{clock(entry.at)}</span>
                    )}
                    <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                      {entry.message}
                    </span>
                    {entry.source !== '' && (
                      <span
                        className="shrink-0 truncate text-fg-subtle"
                        style={{ maxWidth: '14rem' }}
                        title={`${entry.source}:${String(entry.line)}`}
                      >
                        {shortSource(entry.source)}
                        {entry.line > 0 ? `:${String(entry.line)}` : ''}
                      </span>
                    )}
                  </div>
                ))}
                {evaluated.map((answer, at) => (
                  <div key={`eval-${String(at)}`} data-console-eval className="border-b border-border/50">
                    <div className="flex gap-2 px-3 py-1 text-fg-subtle">
                      <span aria-hidden>›</span>
                      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                        {answer.source}
                      </span>
                    </div>
                    <div
                      data-console-eval-result
                      className={cn(
                        'flex gap-2 px-3 py-1',
                        answer.error === null ? 'text-fg' : 'text-danger'
                      )}
                    >
                      <span aria-hidden>‹</span>
                      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                        {answer.error ?? answer.value}
                      </span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          {onEvaluate !== undefined && (
            <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
              <span aria-hidden className="text-[11px] text-fg-subtle">
                ›
              </span>
              <input
                data-console-input={name}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  evaluate()
                }}
                placeholder="Evaluate in the page"
                aria-label="Evaluate JavaScript in the page"
                spellCheck={false}
                className={cn(
                  'min-w-0 flex-1 bg-transparent font-mono text-[11px] text-fg outline-none',
                  'placeholder:text-fg-subtle'
                )}
              />
              {running && <span className="text-[11px] text-fg-subtle">…</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Chromium's level names, folded to the three the panel paints.
 *
 * A map rather than a comparison, because the string has changed shape before:
 * `console-message` reported numeric levels until Electron 30 and reports
 * `'info' | 'warning' | 'error' | 'debug'` now. An unrecognised value falls
 * through to `log`, which is the safe direction - an entry drawn as ordinary
 * when it was a warning is a missed tint; the other way round would put a red
 * count on a clean page.
 */
const LEVEL: Record<string, 'error' | 'warning' | 'log'> = {
  error: 'error',
  '3': 'error',
  warning: 'warning',
  warn: 'warning',
  '2': 'warning',
  info: 'log',
  log: 'log',
  debug: 'log',
  verbose: 'log',
  '0': 'log',
  '1': 'log'
}

const FILTERS: Array<[ConsoleFilter, string]> = [
  ['all', 'All'],
  ['errors', 'Errors'],
  ['warnings', 'Warnings'],
  ['logs', 'Logs']
]

const clock = (at: number): string => {
  const when = new Date(at)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
}

/**
 * The tail of a source URL, which is the part that identifies it.
 *
 * The head is the origin, and every entry in a console shares it - so a column
 * ellipsised from the right shows the same twenty characters on every row.
 */
const shortSource = (source: string): string => {
  try {
    const parsed = new URL(source)
    const tail = parsed.pathname.split('/').filter(Boolean).at(-1)
    return tail !== undefined && tail !== '' ? tail : parsed.host
  } catch {
    return source
  }
}
