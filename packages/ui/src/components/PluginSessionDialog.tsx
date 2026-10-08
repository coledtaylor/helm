import type { JSX, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { cn } from '../lib/cn'
import { DialogFooter, DialogHeader, DialogProblem, dialogLabel, primaryButton, secondaryButton } from './DialogParts'
import { TerminalIcon } from './icons'
import { Overlay } from './Overlay'

export interface PluginSessionDialogProps {
  /** The plugin asking, by the name Settings shows. */
  pluginName: string
  cwd: string
  /** What the session is called, before it is made unique among the running ones. */
  name: string
  /** Its first message. */
  prompt: string
  /** The launch is under way. */
  busy: boolean
  /** Why it did not start. The request is spent: only closing is left. */
  error: string | null
  onStart: () => void
  onCancel: () => void
}

/** The command a person would type for this session, as the dialog shows it. */
export function pluginSessionCommand(name: string, prompt: string): string {
  const quote = (arg: string): string => (/[\s&|<>^()%!]/.test(arg) ? `"${arg}"` : arg)
  return ['claude', '-n', quote(name), quote(prompt)].join(' ')
}

/**
 * A plugin asking to start a Claude Code session, put to the user.
 *
 * Everything that will run is on screen: the folder, the name, the first
 * message and the command. Main launches exactly that, from what it holds for
 * the request; this dialog says only yes or no.
 *
 * Cancel has the focus, as in `ConfirmSessionDialog`: the request comes from a
 * click in a page, and an Enter meant for something else must not start a
 * session. Escape and the backdrop both cancel.
 */
export function PluginSessionDialog({
  pluginName,
  cwd,
  name,
  prompt,
  busy,
  error,
  onStart,
  onCancel
}: PluginSessionDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const spent = error !== null
  const title = `${pluginName} wants to start a session`
  // Dismissing while it launches would leave a session starting behind a
  // dialog that is gone, with nowhere to say how it went.
  const dismiss = (): void => {
    if (!busy) onCancel()
  }

  return (
    <Overlay role="alertdialog" aria-label={title} data-plugin-session className="max-w-[520px]" onDismiss={dismiss}>
      <DialogHeader icon={<TerminalIcon width={13} height={13} />} title={title} onClose={dismiss} />

      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-2 pb-4">
        <p className="text-[11px] leading-[1.55] text-fg-muted">
          Claude Code opens in this folder and is sent this as its first message. After that the session is yours:{' '}
          {pluginName} cannot type into it or read it.
        </p>

        <dl className="mt-4 flex flex-col gap-[14px]">
          <Field label="Folder" data="folder">
            <span className="font-mono text-[12px] break-all text-fg">{cwd}</span>
          </Field>
          <Field label="Name" data="name">
            <span className="text-[12.5px] break-words text-fg">{name}</span>
          </Field>
          <Field label="First message" data="prompt">
            <span className="block max-h-[120px] overflow-y-auto rounded-well border border-border bg-surface-sunken px-2.5 py-[7px] font-mono text-[12px] leading-[1.5] break-words whitespace-pre-wrap text-fg">
              {prompt}
            </span>
          </Field>
          <Field label="Runs" data="command">
            <span className="font-mono text-[11.5px] break-all text-fg-muted">{pluginSessionCommand(name, prompt)}</span>
          </Field>
        </dl>

        {spent && <DialogProblem>{error}</DialogProblem>}
      </div>

      <DialogFooter>
        <button
          ref={cancelRef}
          type="button"
          data-plugin-session-cancel
          disabled={busy}
          onClick={onCancel}
          // `:focus` rather than the global `:focus-visible`, for the reason
          // `ConfirmSessionDialog` gives: focus placed by script paints no ring.
          // The hover wash rather than that dialog's accent border: beside an
          // accent-outlined Start, an accent Cancel would read as a second Start.
          className={cn(secondaryButton, 'focus:bg-hover focus:outline-none', busy && 'opacity-60')}
        >
          {spent ? 'Close' : 'Cancel'}
        </button>
        {!spent && (
          <button
            type="button"
            data-plugin-session-start
            disabled={busy}
            onClick={onStart}
            className={primaryButton(!busy)}
          >
            {busy ? 'Starting…' : 'Start session'}
          </button>
        )}
      </DialogFooter>
    </Overlay>
  )
}

function Field({ label, data, children }: { label: string; data: string; children: ReactNode }): JSX.Element {
  return (
    <div data-plugin-session-field={data} className="select-text">
      <dt className={dialogLabel}>{label}</dt>
      <dd className="mt-[5px]">{children}</dd>
    </div>
  )
}
