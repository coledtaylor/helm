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

export function MonitorIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="12" height="8" rx="1.25" />
      <path d="M6 13.5h4M8 11v2.5" />
    </Icon>
  )
}
