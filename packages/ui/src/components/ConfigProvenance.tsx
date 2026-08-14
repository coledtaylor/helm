import type { JSX } from 'react'
import type { ConfigFile, ConfigLive } from '@helm/core'
import { cn } from '../lib/cn'
import { formatBytes } from '../lib/time'
import { DocIcon, HookIcon } from './icons'

/**
 * Why a file that is not read as prose is here at all.
 *
 * A hook and a status line are programs, and the interesting thing about a
 * program in a `.claude` tree is not its first line - it is what runs it. That
 * fact lives in a *different file* from the one on screen, which is exactly the
 * kind of thing a file-at-a-time editor can never say, and it is the reason
 * somebody opens a hook they did not write.
 *
 * So it goes above the source rather than beside it, and it names the settings
 * file so the answer to "why is this running" is one click rather than a search.
 */
export function HookProvenance({
  live,
  onOpenFile
}: {
  live: ConfigLive
  onOpenFile: (path: string) => void
}): JSX.Element | null {
  const rows = live.hooks
  if (rows.length === 0 && live.references.length === 0) {
    return (
      <div
        data-hook-provenance="0"
        className="mx-5 mt-4 rounded-raised border border-border bg-surface-raised px-4 py-2.5"
      >
        <p className="flex items-center gap-2 text-[11.5px] text-fg-muted">
          <HookIcon width={12} height={12} className="shrink-0 text-fg-subtle" />
          Nothing runs this file.
        </p>
        <p className="mt-1 text-[10.5px] leading-relaxed text-fg-subtle">{live.reason}</p>
      </div>
    )
  }

  return (
    <div
      data-hook-provenance={rows.length}
      className="mx-5 mt-4 overflow-hidden rounded-raised border border-border bg-surface-raised"
    >
      <p className="border-b border-border px-4 py-1.5 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
        {rows.length > 0 ? 'What runs this' : 'Referenced by'}
      </p>
      {rows.map((binding, at) => (
        <div
          key={`${binding.event}-${binding.file}-${String(at)}`}
          data-hook-event={binding.event}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border px-4 py-2 last:border-b-0"
        >
          <span className="rounded-full border border-border-strong px-2 py-px font-mono text-[10.5px] text-fg">
            {binding.event}
          </span>
          <span className="text-[10.5px] text-fg-subtle">
            {binding.matcher === null ? 'every tool' : 'matching'}
          </span>
          {binding.matcher !== null && (
            <span className="font-mono text-[10.5px] text-fg-muted">{binding.matcher}</span>
          )}
          <SourceLink file={binding.file} layer={binding.layer} onOpenFile={onOpenFile} />
          <span className="w-full truncate font-mono text-[10.5px] text-fg-subtle" title={binding.command}>
            {binding.command}
          </span>
        </div>
      ))}
      {rows.length === 0 &&
        live.references.map((reference) => (
          <div
            key={`${reference.key}-${reference.file}`}
            data-setting-reference={reference.key}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border px-4 py-2 last:border-b-0"
          >
            <span className="font-mono text-[11px] text-fg">{reference.key}</span>
            <SourceLink file={reference.file} layer={reference.layer} onOpenFile={onOpenFile} />
            <span className="w-full truncate font-mono text-[10.5px] text-fg-subtle" title={reference.value}>
              {reference.value}
            </span>
          </div>
        ))}
    </div>
  )
}

function SourceLink({
  file,
  layer,
  onOpenFile
}: {
  file: string
  layer: string
  onOpenFile: (path: string) => void
}): JSX.Element {
  const name = file.split(/[\\/]/).at(-1) ?? file
  return (
    <button
      type="button"
      data-open-settings={file}
      onClick={() => onOpenFile(file)}
      title={file}
      className="ml-auto shrink-0 font-mono text-[10.5px] text-fg-subtle transition-colors hover:text-accent-text"
    >
      {name} · {layer}
    </button>
  )
}

/**
 * What a skill bundles, on the skill's own pane.
 *
 * These are the files that used to land flat in `Other`. They are listed here
 * because the skill is what a session addresses and the bundle is part of it -
 * and each one opens, because "part of the skill" is a reason to show them
 * together, not a reason to make them unreachable.
 */
export function BundledResources({
  files,
  selected,
  onSelect
}: {
  files: ConfigFile[]
  selected: string | null
  onSelect: (file: ConfigFile) => void
}): JSX.Element | null {
  if (files.length === 0) return null
  return (
    <div
      data-bundled={files.length}
      className="mx-5 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-raised border border-border bg-surface-raised px-4 py-2.5"
    >
      <span className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
        Bundled with this skill
      </span>
      {files.map((file) => (
        <button
          key={file.path}
          type="button"
          data-bundled-file={file.relPath}
          onClick={() => onSelect(file)}
          title={file.path}
          className={cn(
            'flex items-baseline gap-1.5 rounded-well px-1.5 py-0.5 transition-colors hover:bg-hover',
            file.path === selected && 'bg-accent-soft hover:bg-accent-soft-hover'
          )}
        >
          <span className="font-mono text-[10.5px] text-fg-muted">
            {file.relPath.slice(file.relPath.lastIndexOf('/') + 1)}
          </span>
          <span className="font-mono text-[9.5px] tabular-nums text-fg-subtle">
            {formatBytes(file.size)}
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * A file no session reads, and the pane that says so instead of showing bytes.
 *
 * The whole `Other` group used to open in a monospace box, which invited the
 * reader to look for the meaning of `stats-cache.json` in its contents. There
 * is none: the meaning is who writes it and who reads it, and that is a
 * sentence rather than a file.
 */
export function ConfigOpaquePane({
  live,
  note
}: {
  live: ConfigLive | null
  /** What Helm knows about this file, when it is one the CLI owns. */
  note: string | null
}): JSX.Element {
  return (
    <div className="grid h-full place-items-center px-8 py-10">
      <div data-config-opaque className="max-w-96 text-center">
        {/* A plain document, not the skill spark: the glyph on this pane must
            not be the one that means "a skill" three rows up the list. */}
        <DocIcon width={18} height={18} className="mx-auto text-fg-subtle opacity-70" />
        <p className="mt-2 text-[12.5px] font-medium text-fg">Not part of a session</p>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-muted">
          {note ?? live?.reason ?? 'Nothing in this scope’s configuration refers to this file.'}
        </p>
      </div>
    </div>
  )
}
