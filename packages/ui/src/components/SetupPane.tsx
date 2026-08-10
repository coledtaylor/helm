import type { JSX, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { CheckIcon, FolderIcon, RefreshIcon, WarnIcon } from './icons'

/**
 * What the setup pane needs to know about the CLI. Structurally identical to
 * the main process's `ClaudeStatus` and declared here rather than imported,
 * because `@helm/ui` may not depend on the Electron package - the shape travels
 * as props like every other piece of data this package renders.
 */
export interface SetupClaudeStatus {
  path: string | null
  source: 'setting' | 'discovered' | null
  version: string | null
  semver: string | null
  tested: boolean
  testedRange: { min: string; max: string }
  configDir: string
  configDirExists: boolean
  auth: 'authenticated' | 'unauthenticated' | 'unknown'
  authSignal: string
  error: string | null
}

export interface SetupPaneProps {
  status: SetupClaudeStatus | null
  /** Scan roots chosen so far. The pane finishes when there is at least one. */
  roots: string[]
  /** Directories discovery can justify suggesting. Often empty, which is fine. */
  suggestions: string[]
  /** Projects the current roots turned up, so "it worked" is visible here. */
  projectCount: number
  scanning: boolean
  checking: boolean
  onRecheck: () => void
  onLocateClaude: () => void
  onAddFolder: () => void
  onAcceptSuggestion: (path: string) => void
  onCreateHarness: () => void
  onConvertFolder: () => void
  onFinish: () => void
}

/**
 * First run.
 *
 * Three questions, in the order they block each other: is the CLI here, is this
 * machine signed in, and where is this person's work. Only the third can be
 * answered inside Helm - the first is a path and the second is emphatically not
 * Helm's business, so both are reported and handed back with an instruction
 * rather than a form. Signing in happens between the user and `claude`, in a
 * terminal Helm does not own.
 *
 * None of it blocks. A machine with no CLI can still finish setup and browse
 * config; the launch is what fails later, and it fails with the same sentence
 * this pane is already showing.
 */
export function SetupPane({
  status,
  roots,
  suggestions,
  projectCount,
  scanning,
  checking,
  onRecheck,
  onLocateClaude,
  onAddFolder,
  onAcceptSuggestion,
  onCreateHarness,
  onConvertFolder,
  onFinish
}: SetupPaneProps): JSX.Element {
  const ready = roots.length > 0

  return (
    <div className="h-full overflow-y-auto bg-bg" data-setup-pane>
      <div className="mx-auto w-full max-w-2xl px-8 py-12">
        <h1 className="text-[20px] font-semibold tracking-tight text-fg">Set up Helm</h1>
        <p className="mt-1.5 text-[13px] text-fg-muted">
          Helm hosts the real <code className="font-mono text-[12px]">claude</code> CLI and points it
          at your own folders. Two things to check and one to choose.
        </p>

        <ClaudeStep
          status={status}
          checking={checking}
          onRecheck={onRecheck}
          onLocateClaude={onLocateClaude}
        />

        <AuthStep status={status} />

        <Step
          n={3}
          title="Where is your work?"
          tone={ready ? 'ok' : 'todo'}
          detail={
            ready
              ? `${String(roots.length)} folder${roots.length === 1 ? '' : 's'} · ${
                  scanning ? 'scanning…' : `${String(projectCount)} projects`
                }`
              : 'Helm scans nothing until you say what to scan.'
          }
        >
          {roots.length > 0 && (
            <ul className="mb-3 overflow-hidden rounded-md border border-border">
              {roots.map((root) => (
                <li
                  key={root}
                  data-setup-root={root}
                  className="truncate border-b border-border px-3 py-1.5 font-mono text-[11px] text-fg-muted last:border-b-0"
                  title={root}
                >
                  {root}
                </li>
              ))}
            </ul>
          )}

          {suggestions.filter((s) => !roots.some((r) => r.toLowerCase() === s.toLowerCase()))
            .length > 0 && (
            <div className="mb-3">
              <p className="mb-1.5 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
                Found on this machine
              </p>
              <ul className="space-y-1">
                {suggestions
                  .filter((s) => !roots.some((r) => r.toLowerCase() === s.toLowerCase()))
                  .map((path) => (
                    <li key={path}>
                      <button
                        type="button"
                        data-setup-suggestion={path}
                        onClick={() => onAcceptSuggestion(path)}
                        title={path}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md border border-border px-3 py-1.5',
                          'text-left transition-colors hover:bg-hover'
                        )}
                      >
                        <FolderIcon width={13} height={13} className="shrink-0 text-fg-subtle" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
                          {path}
                        </span>
                        <span className="shrink-0 text-[11px] text-accent">Use this</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Action data-setup-add-folder onClick={onAddFolder} primary={roots.length === 0}>
              Add an existing folder
            </Action>
            <Action data-setup-create-harness onClick={onCreateHarness}>
              Create a new harness
            </Action>
            <Action data-setup-convert-folder onClick={onConvertFolder}>
              Turn a folder into a harness
            </Action>
          </div>
          <p className="mt-2 text-[11px] text-fg-subtle">
            A folder of repositories works on its own. A <em>harness</em> is any folder with a{' '}
            <code className="font-mono">harness.yaml</code> in it - that is the whole definition, and
            it is what lets one session compose several repos&rsquo; skills at once.
          </p>
        </Step>

        <div className="mt-8 flex items-center gap-3 border-t border-border pt-5">
          <button
            type="button"
            data-setup-finish
            disabled={!ready}
            onClick={onFinish}
            className={cn(
              'rounded-md px-3.5 py-1.5 text-[12px] font-medium transition-colors',
              ready
                ? 'bg-accent text-accent-fg shadow-panel hover:opacity-90'
                : 'cursor-default border border-border text-fg-subtle opacity-60'
            )}
          >
            Open the launcher
          </button>
          <span className="text-[11px] text-fg-subtle">
            {ready
              ? 'You can add more folders later from the sidebar.'
              : 'Choose at least one folder to continue.'}
          </span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function ClaudeStep({
  status,
  checking,
  onRecheck,
  onLocateClaude
}: {
  status: SetupClaudeStatus | null
  checking: boolean
  onRecheck: () => void
  onLocateClaude: () => void
}): JSX.Element {
  const found = status !== null && status.path !== null && status.version !== null
  const tone = status === null ? 'todo' : found ? (status.tested ? 'ok' : 'warn') : 'warn'

  return (
    <Step
      n={1}
      title="Claude Code"
      tone={tone}
      detail={
        status === null
          ? 'Looking…'
          : found
            ? `${status.version ?? ''} · ${status.path ?? ''}`
            : (status.error ?? 'Not found.')
      }
    >
      {found && !status.tested && (
        <p
          data-setup-version-warning
          className="mb-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn"
        >
          Helm was tested against {status.testedRange.min} up to (not including){' '}
          {status.testedRange.max}. {status.semver ?? status.version} is outside that, so a flag may
          have moved. Nothing is blocked - if a launch misbehaves, this is the first thing to
          suspect.
        </p>
      )}
      {!found && (
        <p className="mb-3 text-[12px] text-fg-muted">
          Install it from{' '}
          <span className="font-mono text-[11px]">https://claude.com/claude-code</span>, then check
          again. If it is installed somewhere unusual, point Helm at it.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Action data-setup-recheck onClick={onRecheck} disabled={checking}>
          <RefreshIcon className={cn('mr-1.5 inline', checking && 'animate-spin')} />
          Check again
        </Action>
        <Action data-setup-locate onClick={onLocateClaude}>
          Locate it manually…
        </Action>
      </div>
    </Step>
  )
}

function AuthStep({ status }: { status: SetupClaudeStatus | null }): JSX.Element {
  const auth = status?.auth ?? 'unknown'
  return (
    <Step
      n={2}
      title="Signed in"
      tone={auth === 'authenticated' ? 'ok' : auth === 'unknown' ? 'todo' : 'warn'}
      detail={
        status === null
          ? 'Looking…'
          : auth === 'authenticated'
            ? status.authSignal
            : auth === 'unknown'
              ? `Cannot tell from ${status.configDir}.`
              : 'Not signed in yet.'
      }
    >
      {auth !== 'authenticated' && (
        <div data-setup-auth-guidance>
          <p className="text-[12px] text-fg-muted">
            Helm never handles your credentials - it has no login screen and stores no token. Open a
            terminal and run <code className="font-mono text-[11px] text-fg">claude</code> once; it
            will walk you through signing in, and the session it writes to{' '}
            <code className="font-mono text-[11px]">{status?.configDir ?? '~/.claude'}</code> is the
            one Helm&rsquo;s sessions use.
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono text-[12px] text-fg select-text">
            claude
          </pre>
          <p className="mt-2 text-[11px] text-fg-subtle">
            Then press &ldquo;Check again&rdquo; above. You can finish setup without this - only
            launching a session needs it.
          </p>
        </div>
      )}
    </Step>
  )
}

type Tone = 'ok' | 'warn' | 'todo'

function Step({
  n,
  title,
  tone,
  detail,
  children
}: {
  n: number
  title: string
  tone: Tone
  detail: string
  children?: ReactNode
}): JSX.Element {
  return (
    <section className="mt-7" data-setup-step={String(n)} data-tone={tone}>
      <header className="flex items-center gap-2.5">
        <span
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold',
            tone === 'ok'
              ? 'bg-success/15 text-success'
              : tone === 'warn'
                ? 'bg-warn/15 text-warn'
                : 'bg-surface-sunken text-fg-subtle'
          )}
        >
          {tone === 'ok' ? (
            <CheckIcon width={11} height={11} />
          ) : tone === 'warn' ? (
            <WarnIcon width={11} height={11} />
          ) : (
            n
          )}
        </span>
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">{title}</h2>
      </header>
      <p className="mt-1 mb-3 ml-[30px] truncate font-mono text-[11px] text-fg-subtle" title={detail}>
        {detail}
      </p>
      <div className="ml-[30px]">{children}</div>
    </section>
  )
}

function Action({
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
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...rest}
      className={cn(
        'rounded-md px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50',
        primary
          ? 'border border-accent/40 bg-accent-soft text-fg hover:bg-hover'
          : 'border border-border bg-surface text-fg hover:bg-hover'
      )}
    >
      {children}
    </button>
  )
}

