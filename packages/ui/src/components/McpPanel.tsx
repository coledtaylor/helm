import type { JSX } from 'react'
import { useState } from 'react'
import type { EffectiveMcpServer, McpPreview, McpResult, McpScope } from '@helm/core'
import { validateJson } from '@helm/core/types'
import { cn } from '../lib/cn'
import { Result } from './ConfigEditor'
import { CheckIcon, PlugIcon, RefreshIcon, TrashIcon, WarnIcon } from './icons'

export interface McpPanelProps {
  /** The directory servers are resolved against - the scope on screen. */
  cwd: string
  servers: EffectiveMcpServer[]
  /** `claude mcp list` output, which health-checks. Null until asked for. */
  listing: McpResult | null
  listing_busy: boolean
  onList: () => void

  draft: { name: string; scope: McpScope; json: string }
  onDraftChange: (draft: { name: string; scope: McpScope; json: string }) => void
  /** The predicted document, requested when the draft is complete. */
  preview: McpPreview | null
  onPreview: () => void
  onApply: () => void
  onCancelPreview: () => void
  applying: boolean
  result: McpResult | null
  onDismissResult: () => void

  onRemove: (server: EffectiveMcpServer) => void
  onApprove: (server: EffectiveMcpServer, approved: boolean) => void
  onOpenFile: (path: string) => void
}

const SCOPES: Array<{ value: McpScope; label: string; hint: string }> = [
  {
    value: 'project',
    label: 'project',
    hint: 'Written to .mcp.json, which is committed - and gated behind approval on first launch.'
  },
  {
    value: 'local',
    label: 'local',
    hint: 'Written to ~/.claude.json under this directory. Yours, this machine, this folder.'
  },
  {
    value: 'user',
    label: 'user',
    hint: 'Written to ~/.claude.json at the top level. Every project you open.'
  }
]

/**
 * MCP servers, per scope.
 *
 * Every write here is `claude mcp add-json` in a subprocess rather than a JSON
 * edit (SPEC 4.2). Three scopes write to two different files in three different
 * shapes, and the CLI is the only thing that knows all of it - a second
 * implementation of somebody else's format would be wrong the first time they
 * changed it.
 *
 * The diff is shown *before* the subprocess runs, computed by merging the same
 * object into the same document. It is a prediction and is labelled as one; the
 * file is re-read afterwards, so a prediction that was wrong is visible rather
 * than assumed. The file is snapshotted first either way, because a write Helm
 * delegates is still a write Helm caused.
 */
export function McpPanel({
  cwd,
  servers,
  listing,
  listing_busy,
  onList,
  draft,
  onDraftChange,
  preview,
  onPreview,
  onApply,
  onCancelPreview,
  applying,
  result,
  onDismissResult,
  onRemove,
  onApprove,
  onOpenFile
}: McpPanelProps): JSX.Element {
  const [adding, setAdding] = useState(false)
  const jsonProblem = validateJson(draft.json)
  const canPreview = draft.name.trim() !== '' && draft.json.trim() !== '' && jsonProblem === null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-7">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] leading-snug font-medium tracking-tight text-fg">
              MCP servers
            </h2>
            <p className="mt-1.5 text-[12px] leading-relaxed text-fg-muted">
              Resolved for{' '}
              <code className="font-mono text-[11px] text-fg-subtle">{cwd}</code>. Adding one runs{' '}
              <code className="font-mono">claude mcp add-json</code>; Helm shows what it expects to
              change first and snapshots the file either way.
            </p>
          </div>
          <button
            type="button"
            data-mcp-health
            onClick={onList}
            disabled={listing_busy}
            title="Runs `claude mcp list`, which connects to every server"
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-well border border-border-strong px-2.5 py-1',
              'text-[11px] text-fg transition-colors hover:bg-hover disabled:opacity-50'
            )}
          >
            <RefreshIcon width={12} height={12} className={cn(listing_busy && 'animate-spin')} />
            Health check
          </button>
        </header>

        {result !== null && (
          <div className="mt-4">
            <Result ok={result.ok}>
              <span className="block whitespace-pre-wrap">{result.output || 'Done.'}</span>
              <button
                type="button"
                onClick={onDismissResult}
                className="mt-1 text-[10px] underline underline-offset-2 opacity-80"
              >
                Dismiss
              </button>
            </Result>
          </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* Configured                                                     */}
        {/* ------------------------------------------------------------- */}
        <section className="mt-6">
          <h3 className="mb-2 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
            Configured
          </h3>
          {servers.length === 0 ? (
            <p className="rounded-raised border border-border bg-surface-raised px-3 py-6 text-center text-[12px] text-fg-subtle">
              No MCP server is configured for this directory at any scope.
            </p>
          ) : (
            <ul className="space-y-2">
              {servers.map((server) => (
                <li
                  key={`${server.scope}:${server.name}`}
                  data-mcp-server={server.name}
                  data-mcp-scope={server.scope}
                  className="overflow-hidden rounded-raised border border-border bg-surface-raised"
                >
                  <div className="flex items-center gap-2.5 px-3 py-2">
                    <PlugIcon
                      width={13}
                      height={13}
                      className={cn(
                        'shrink-0',
                        server.shadowedBy !== null ? 'text-fg-subtle' : 'text-accent'
                      )}
                    />
                    <span className="min-w-0 truncate text-[12px] font-medium text-fg">
                      {server.name}
                    </span>
                    <span className="shrink-0 rounded-sm bg-surface-sunken px-1.5 py-px text-[10px] text-fg-muted">
                      {server.scope}
                    </span>
                    <span className="shrink-0 text-[10px] text-fg-subtle">{server.transport}</span>
                    <span className="flex-1" />
                    {server.approved === false && (
                      <button
                        type="button"
                        data-mcp-approve={server.name}
                        onClick={() => onApprove(server, true)}
                        title="Adds the name to enabledMcpjsonServers in settings.local.json"
                        className="flex shrink-0 items-center gap-1 rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn transition-colors hover:bg-warn/20"
                      >
                        <WarnIcon width={10} height={10} />
                        Approve
                      </button>
                    )}
                    {server.approved === true && (
                      <span
                        data-mcp-approved={server.name}
                        title={server.approvedBy ?? 'Approved'}
                        className="flex shrink-0 items-center gap-1 text-[10px] text-success"
                      >
                        <CheckIcon width={10} height={10} />
                        approved
                      </span>
                    )}
                    <button
                      type="button"
                      data-mcp-remove={server.name}
                      onClick={() => onRemove(server)}
                      aria-label={`Remove ${server.name}`}
                      title={`Remove ${server.name} from the ${server.scope} scope`}
                      className="grid size-5 shrink-0 place-items-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-danger"
                    >
                      <TrashIcon width={11} height={11} />
                    </button>
                  </div>

                  {server.shadowedBy !== null && (
                    <p className="border-t border-border bg-surface-sunken px-3 py-1.5 text-[10px] text-fg-subtle">
                      A server of this name in the {server.shadowedBy} scope takes precedence, so
                      this one is not what a session would load.
                    </p>
                  )}

                  <pre className="max-h-40 overflow-auto border-t border-border bg-surface-sunken px-3 py-2 font-mono text-[10px] leading-[1.5] text-fg-muted select-text">
                    {server.config}
                  </pre>

                  <button
                    type="button"
                    onClick={() => onOpenFile(server.file)}
                    className="block w-full truncate border-t border-border px-3 py-1 text-left font-mono text-[10px] text-fg-subtle transition-colors hover:text-accent-text"
                  >
                    {server.file}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ------------------------------------------------------------- */}
        {/* Add                                                            */}
        {/* ------------------------------------------------------------- */}
        <section className="mt-7">
          <div className="mb-2 flex items-baseline gap-3">
            <h3 className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
              Add a server
            </h3>
            {!adding && (
              <button
                type="button"
                data-mcp-add-open
                onClick={() => setAdding(true)}
                className="text-[11px] text-accent transition-colors hover:brightness-110"
              >
                New
              </button>
            )}
          </div>

          {adding && (
            <div className="rounded-raised border border-border bg-surface-raised p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[10px] font-medium tracking-wide text-fg-subtle uppercase">
                    Name
                  </span>
                  <input
                    data-mcp-name
                    aria-label="MCP server name"
                    value={draft.name}
                    onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
                    spellCheck={false}
                    className={fieldClass}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] font-medium tracking-wide text-fg-subtle uppercase">
                    Scope
                  </span>
                  <select
                    data-mcp-scope-select
                    aria-label="MCP scope"
                    value={draft.scope}
                    onChange={(event) =>
                      onDraftChange({ ...draft, scope: event.target.value as McpScope })
                    }
                    className={fieldClass}
                  >
                    {SCOPES.map((scope) => (
                      <option key={scope.value} value={scope.value}>
                        {scope.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="mt-1.5 text-[10px] text-fg-subtle">
                {SCOPES.find((scope) => scope.value === draft.scope)?.hint}
              </p>

              <label className="mt-3 block">
                <span className="mb-1 block text-[10px] font-medium tracking-wide text-fg-subtle uppercase">
                  Configuration
                </span>
                <textarea
                  data-mcp-json
                  aria-label="MCP server configuration"
                  value={draft.json}
                  onChange={(event) => onDraftChange({ ...draft, json: event.target.value })}
                  spellCheck={false}
                  rows={5}
                  placeholder={'{ "command": "node", "args": ["server.mjs"] }'}
                  className={cn(
                    'w-full resize-y rounded-raised border bg-surface-sunken p-2',
                    'font-mono text-[11px] leading-[1.55] text-fg select-text placeholder:text-fg-subtle',
                    'focus:outline-none',
                    jsonProblem !== null ? 'border-danger/50' : 'border-border focus:border-accent'
                  )}
                />
              </label>
              {jsonProblem !== null && draft.json.trim() !== '' && (
                <p data-mcp-json-error className="mt-1 font-mono text-[10px] text-danger">
                  {jsonProblem.line}:{jsonProblem.column} {jsonProblem.message}
                </p>
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  data-mcp-preview
                  onClick={onPreview}
                  disabled={!canPreview}
                  className={cn(
                    'rounded-well border px-2.5 py-1 text-[11px] font-medium transition-colors',
                    canPreview
                      ? 'border-accent text-accent-text hover:bg-accent-soft'
                      : 'cursor-default border-border text-fg-subtle opacity-60'
                  )}
                >
                  Show what would change
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false)
                    onCancelPreview()
                  }}
                  className="rounded-well border border-border-strong px-2.5 py-1 text-[11px] text-fg transition-colors hover:bg-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>

        {/* ------------------------------------------------------------- */}
        {/* The diff                                                       */}
        {/* ------------------------------------------------------------- */}
        {preview !== null && (
          <section className="mt-5" data-mcp-diff>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
                Predicted change
              </h3>
              <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-subtle">
                {preview.file}
              </p>
            </div>

            {preview.error !== null ? (
              <Result ok={false}>{preview.error}</Result>
            ) : (
              <>
                {preview.replaces !== null && (
                  <p className="mb-2 rounded-raised border border-warn/30 bg-warn/10 px-3 py-1.5 text-[11px] text-fg-muted">
                    A server called <code className="font-mono">{draft.name}</code> is already
                    configured in this scope and would be replaced.
                  </p>
                )}
                <pre className="max-h-72 overflow-auto rounded-raised border border-border bg-surface-sunken py-2 font-mono text-[10px] leading-[1.55] select-text">
                  {preview.diff.map((line, index) => (
                    <div
                      key={index}
                      className={cn(
                        'px-3',
                        line.sign === '+' && 'bg-success/10 text-success',
                        line.sign === '-' && 'bg-danger/10 text-danger',
                        line.sign === ' ' && 'text-fg-subtle'
                      )}
                    >
                      <span className="mr-2 inline-block w-2 select-none opacity-70">
                        {line.sign}
                      </span>
                      {line.text || ' '}
                    </div>
                  ))}
                </pre>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    data-mcp-apply
                    onClick={onApply}
                    disabled={applying}
                    className={cn(
                      'rounded-well border border-accent px-2.5 py-1 text-[11px] font-medium text-accent-text transition-colors',
                      applying ? 'cursor-default opacity-60' : 'hover:bg-accent-soft'
                    )}
                  >
                    {applying ? 'Running the CLI…' : 'Run claude mcp add-json'}
                  </button>
                  <button
                    type="button"
                    onClick={onCancelPreview}
                    className="rounded-well border border-border-strong px-2.5 py-1 text-[11px] text-fg transition-colors hover:bg-hover"
                  >
                    Not now
                  </button>
                  <span className="text-[10px] text-fg-subtle">
                    Helm snapshots the file before the CLI touches it.
                  </span>
                </div>
              </>
            )}
          </section>
        )}

        {/* ------------------------------------------------------------- */}
        {/* Health                                                         */}
        {/* ------------------------------------------------------------- */}
        {listing !== null && (
          <section className="mt-7">
            <h3 className="mb-2 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
              claude mcp list
            </h3>
            <pre
              data-mcp-listing
              className="max-h-64 overflow-auto rounded-raised border border-border bg-surface-sunken px-3 py-2 font-mono text-[11px] leading-[1.55] text-fg-muted select-text"
            >
              {listing.output || 'No output.'}
            </pre>
          </section>
        )}
      </div>
    </div>
  )
}

const fieldClass = cn(
  'h-7 w-full rounded-well border border-border bg-surface-sunken px-2 text-[12px]',
  'text-fg placeholder:text-fg-subtle select-text',
  'focus:border-accent focus:outline-none'
)
