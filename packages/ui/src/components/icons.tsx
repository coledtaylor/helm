import type { JSX, SVGProps } from 'react'

/**
 * Hand-rolled rather than an icon package: the shell needs eight glyphs, and
 * they are drawn on a 16-unit grid with a 1.5 stroke so they sit on the same
 * optical weight as 13px Segoe UI text. An icon font or a 300-icon dependency
 * would be more code shipped than drawn.
 */

type IconProps = SVGProps<SVGSVGElement>

function Icon({ children, ...props }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

export function BranchIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="5.5" r="1.75" />
      <path d="M4.5 5.25v5.5" />
      <path d="M11.5 7.25c0 2-1.6 3.1-3.4 3.4-1.4.25-2.6.6-3.6 1.35" />
    </Icon>
  )
}

export function HarnessIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3z" />
      <path d="M8 8 2.5 5.5M8 8l5.5-2.5M8 8v5.5" />
    </Icon>
  )
}

export function RepoIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3.5 3.25A1.25 1.25 0 0 1 4.75 2h7.75v9.5H4.75a1.25 1.25 0 0 0-1.25 1.25z" />
      <path d="M3.5 12.75A1.25 1.25 0 0 0 4.75 14h7.75v-2.5" />
    </Icon>
  )
}

export function FolderIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2 4.75A1.25 1.25 0 0 1 3.25 3.5h2.4c.4 0 .78.19 1.01.51l.68.94h5.41A1.25 1.25 0 0 1 14 6.2v5.05a1.25 1.25 0 0 1-1.25 1.25h-9.5A1.25 1.25 0 0 1 2 11.25z" />
    </Icon>
  )
}

export function SparkIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 2.25 9.4 6.1 13.25 7.5 9.4 8.9 8 12.75 6.6 8.9 2.75 7.5 6.6 6.1z" />
    </Icon>
  )
}

export function AgentIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="10" height="7.5" rx="2" />
      <path d="M8 2.5V5" />
      <circle cx="6.25" cy="8.5" r=".75" fill="currentColor" stroke="none" />
      <circle cx="9.75" cy="8.5" r=".75" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function CommandIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 5.5 6.75 8 4 10.5" />
      <path d="M8.5 10.75h3.5" />
    </Icon>
  )
}

export function RefreshIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.62-3.79" />
      <path d="M13.5 2.75v3h-3" />
    </Icon>
  )
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Icon>
  )
}

export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" />
    </Icon>
  )
}

export function SunIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.06 1.06M11.34 11.34l1.06 1.06M12.4 3.6l-1.06 1.06M4.66 11.34L3.6 12.4" />
    </Icon>
  )
}

export function MoonIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.75 5.75 0 1 0 6.6 6.6z" />
    </Icon>
  )
}

/** Ahead/behind markers. Drawn rather than typed as U+2191/U+2193, whose stems
 * render about a pixel wide at 11px and read as stray punctuation next to a
 * digit. */
export function AheadIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 12.5V4M4.5 7.5 8 4l3.5 3.5" />
    </Icon>
  )
}

export function BehindIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 3.5V12M4.5 8.5 8 12l3.5-3.5" />
    </Icon>
  )
}

export function DirtyIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.75" fill="currentColor" stroke="none" />
    </Icon>
  )
}

/** The launch affordance. A prompt caret, not a media "play" triangle. */
export function TerminalIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M4.75 6.5 6.75 8.25l-2 1.75" />
      <path d="M8.75 10.25h3" />
    </Icon>
  )
}

export function MonitorIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="12" height="8" rx="1.25" />
      <path d="M6 13.5h4M8 11v2.5" />
    </Icon>
  )
}

/** A profile: stacked planes, because a profile is repos composed into one. */
export function LayersIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 1.75 2 5l6 3.25L14 5z" />
      <path d="m2.75 8 5.25 2.85L13.25 8" />
      <path d="m2.75 11 5.25 2.85L13.25 11" />
    </Icon>
  )
}

/** Session history: a clock with the hands set back. */
export function HistoryIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2.75 8a5.25 5.25 0 1 0 1.62-3.79" />
      <path d="M2.5 2.75v3h3" />
      <path d="M8 5.25V8l2 1.25" />
    </Icon>
  )
}

/** Resume: the prompt caret of TerminalIcon, pointed back into a conversation. */
export function ResumeIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M13.25 8a5.25 5.25 0 1 0-1.62 3.79" />
      <path d="M13.5 12.75v-3h-3" />
      <path d="M6.75 5.75 10 8l-3.25 2.25z" />
    </Icon>
  )
}

/** A search field's glyph. */
export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </Icon>
  )
}

/** The config console: sliders, because a scope is a set of knobs with values. */
export function SlidersIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2.75 4.5h10.5M2.75 11.5h10.5" />
      <circle cx="6" cy="4.5" r="1.75" />
      <circle cx="10.5" cy="11.5" r="1.75" />
    </Icon>
  )
}

/**
 * Helm's own settings: a gear, which is the one glyph nobody has to learn.
 *
 * Not `SlidersIcon` - that belongs to the config console, which edits Claude's
 * `.claude` trees, and the whole point of this pane is that the two are
 * different things. Eight teeth drawn as a stroked ring with radial ticks
 * rather than a filled cog: at 14px a cog outline turns to mush, and this sits
 * at the same optical weight as its neighbours in the title bar.
 */
export function GearIcon(props: IconProps): JSX.Element {
  const teeth = Array.from({ length: 6 }, (_, i) => {
    const a = (i * 2 * Math.PI) / 6 + Math.PI / 6
    return {
      x1: 8 + 5.1 * Math.cos(a),
      y1: 8 + 5.1 * Math.sin(a),
      x2: 8 + 6.9 * Math.cos(a),
      y2: 8 + 6.9 * Math.sin(a)
    }
  })
  return (
    <Icon {...props}>
      {/* Six teeth rather than eight, a wide ring, and a filled hub rather than
          a stroked one. At 14px on a 1x display the 1.5 stroke is a fixed
          budget, so the only way to keep air inside the glyph is to spend it
          further out: a small stroked circle closes to a blob, and eight teeth
          on a tight ring read as the sun two buttons along. */}
      <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="5.1" />
      {teeth.map((t, i) => (
        <line
          key={i}
          x1={t.x1.toFixed(2)}
          y1={t.y1.toFixed(2)}
          x2={t.x2.toFixed(2)}
          y2={t.y2.toFixed(2)}
        />
      ))}
    </Icon>
  )
}

/** A plain document, for CLAUDE.md and anything else read as prose. */
export function DocIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3.5 2.75h5l4 4v6.5a.75.75 0 0 1-.75.75h-8.25a.75.75 0 0 1-.75-.75V3.5a.75.75 0 0 1 .75-.75z" />
      <path d="M8.5 2.75v4h4" />
    </Icon>
  )
}

/** An MCP server: a plug, since the thing being configured is a connection. */
export function PlugIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6 2.25v3.5M10 2.25v3.5" />
      <path d="M3.75 5.75h8.5v2a4.25 4.25 0 0 1-8.5 0z" />
      <path d="M8 12v1.75" />
    </Icon>
  )
}

/** The health panel. A pulse line, not a cross - nothing here is medical. */
export function PulseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M1.75 8h3l1.5-4 3 8 1.5-4h3.5" />
    </Icon>
  )
}

/** A hook, for the `hooks/` group. */
export function HookIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 2.25v6.5a2.5 2.5 0 0 1-5 0" />
      <path d="M6 4.25 8 2.25l2 2" />
      <circle cx="8" cy="12.75" r="1.25" />
    </Icon>
  )
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m3.25 8.5 3 3 6.5-7" />
    </Icon>
  )
}

/** A warning that is not an error: the file is fine, the situation is not. */
export function WarnIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 2.5 14.25 13.25H1.75z" />
      <path d="M8 6.5v3.25" />
      <circle cx="8" cy="11.5" r=".6" fill="currentColor" stroke="none" />
    </Icon>
  )
}

/** Restore a snapshot: an arrow turning back on itself. */
export function RestoreIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2.75 8a5.25 5.25 0 1 0 1.62-3.79" />
      <path d="M2.5 2.75v3h3" />
    </Icon>
  )
}

export function SaveIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 3.5A.5.5 0 0 1 3.5 3h7l2.5 2.5v7a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5z" />
      <path d="M5.25 3v3.25h5V3" />
      <path d="M5.25 13V9.75h5.5V13" />
    </Icon>
  )
}

export function PinIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6 2.25h4l-.5 3.5 2 2.25H4.5l2-2.25z" />
      <path d="M8 8v5.75" />
    </Icon>
  )
}

export function PencilIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M11.25 2.75 13.25 4.75 5.5 12.5 2.75 13.25 3.5 10.5z" />
      <path d="m9.75 4.25 2 2" />
    </Icon>
  )
}

export function TrashIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2.75 4.25h10.5" />
      <path d="M6.25 4.25V2.75h3.5v1.5" />
      <path d="M4.25 4.25 5 13.25h6l.75-9" />
    </Icon>
  )
}

/** Import and export, distinguished by the arrow's direction against the tray. */
export function ImportIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 2.25v7" />
      <path d="M5 6.25 8 9.25l3-3" />
      <path d="M2.75 11.25v1.5c0 .28.22.5.5.5h9.5a.5.5 0 0 0 .5-.5v-1.5" />
    </Icon>
  )
}

export function ExportIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 9.25v-7" />
      <path d="M5 5.25 8 2.25l3 3" />
      <path d="M2.75 11.25v1.5c0 .28.22.5.5.5h9.5a.5.5 0 0 0 .5-.5v-1.5" />
    </Icon>
  )
}

/** The content viewer's own glyphs (M6). */
export function BookIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2.75 3.25A1.5 1.5 0 0 1 4.25 2H7.5v11H4.25a1.5 1.5 0 0 0-1.5 1.25z" />
      <path d="M13.25 3.25A1.5 1.5 0 0 0 11.75 2H8.5v11h3.25a1.5 1.5 0 0 1 1.5 1.25z" />
    </Icon>
  )
}

/** An HTML artifact: a document with a frame around it rather than lines on it. */
export function ArtifactIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2.25" y="3" width="11.5" height="10" rx="1.5" />
      <path d="M2.25 6h11.5" />
      <path d="M4.25 4.5h.01M6 4.5h.01" />
    </Icon>
  )
}

/** The split editor/preview toggle. */
export function SplitIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2.25" y="3" width="11.5" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </Icon>
  )
}

export function EyeIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M1.5 8s2.4-4.25 6.5-4.25S14.5 8 14.5 8s-2.4 4.25-6.5 4.25S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.75" />
    </Icon>
  )
}

/** A wikilink: two nodes joined. */
export function LinkIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6.75 9.25a2.5 2.5 0 0 0 3.5 0l2-2a2.475 2.475 0 0 0-3.5-3.5l-.75.75" />
      <path d="M9.25 6.75a2.5 2.5 0 0 0-3.5 0l-2 2a2.475 2.475 0 0 0 3.5 3.5l.75-.75" />
    </Icon>
  )
}

/** Table of contents. */
export function ListIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5.75 4.25h7.5M5.75 8h7.5M5.75 11.75h7.5" />
      <path d="M2.9 4.25h.01M2.9 8h.01M2.9 11.75h.01" />
    </Icon>
  )
}

/**
 * The brand mark: the ship's wheel the app icon is drawn from.
 *
 * Same proportions as `scripts/make-icon.mjs`, converted from its 256 grid to
 * this 16 one (rim 62, spokes 101, knobs 13, hub 21, all x 16/256) - so the
 * mark in the window and the icon on the taskbar are the same drawing, not two
 * that resemble each other.
 *
 * Vector rather than the .ico the window itself is given: this renders at
 * whatever the display's pixel ratio is, and a 16px bitmap on a 150% monitor is
 * the one place that artwork visibly softens.
 *
 * Filled, not stroked, because it inherits `currentColor` and sits at 13-15px:
 * a 0.8-wide stroke at that size lands under one device pixel on a 1x display
 * and drops out.
 */
export function HelmMarkIcon(props: IconProps): JSX.Element {
  const spokes = Array.from({ length: 8 }, (_, i) => {
    const a = (i * 2 * Math.PI) / 8
    return { x: 8 + 6.31 * Math.cos(a), y: 8 + 6.31 * Math.sin(a) }
  })
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {/* Spokes first, so the rim and hub paint over their inner ends. */}
      {spokes.map((p, i) => (
        <line
          key={i}
          x1="8"
          y1="8"
          x2={p.x.toFixed(2)}
          y2={p.y.toFixed(2)}
          strokeWidth="0.85"
          strokeLinecap="round"
        />
      ))}
      {spokes.map((p, i) => (
        <circle key={`k${String(i)}`} cx={p.x.toFixed(2)} cy={p.y.toFixed(2)} r="0.95" fill="currentColor" stroke="none" />
      ))}
      <circle cx="8" cy="8" r="3.88" strokeWidth="1" />
      <circle cx="8" cy="8" r="1.31" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * The disclosure caret on a collapsible section. Points right; the caller
 * rotates it 90deg when the section is open, so the two states are one glyph
 * turning rather than two glyphs swapping.
 */
export function CaretIcon(props: IconProps): JSX.Element {
  return (
    <Icon strokeWidth="2" {...props}>
      <path d="M6.25 3.5 10.75 8l-4.5 4.5" />
    </Icon>
  )
}
