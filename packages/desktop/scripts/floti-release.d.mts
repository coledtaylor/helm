// Types for floti-release.mjs, so the release files' names, header checks and sums can be tested from TypeScript.

export interface ReleaseTarget {
  /** `<os>-<cpu>`, as the release's file names say it. */
  name: string
  os: 'windows' | 'macos' | 'linux'
  cpu: 'x64' | 'arm64'
  /** The Rust target it is built for. */
  triple: string
  /** Node's `process.platform` and `process.arch` for it. */
  platform: string
  arch: string
}

export interface BinaryFacts {
  os: 'windows' | 'macos' | 'linux' | null
  cpu?: string
  linkage?: 'static' | 'dynamic' | 'unreadable'
}

export const RELEASE_TARGETS: readonly ReleaseTarget[]
export const STAGED_SUMS_NAME: string
export function desktopVersion(file?: string): string
export function targetNamed(name: string): ReleaseTarget
export function targetFor(platform: string, arch: string): ReleaseTarget | null
export function releaseFileName(version: string, target: ReleaseTarget): string
export function sumsFileName(version: string): string
export function releaseFileNames(version: string): string[]
export function binaryFacts(bytes: Uint8Array): BinaryFacts
export function binaryProblem(bytes: Uint8Array, target: ReleaseTarget): string | null
export function versionProblem(said: { short: string; line: string }, version: string, target: ReleaseTarget): string | null
export function sha256Of(bytes: Uint8Array): string
export function formatSums(entries: { name: string; sha256: string }[]): string
export function parseSums(text: string): { name: string; sha256: string }[]
export function releaseFilesProblem(names: string[], version: string, options: { withSums: boolean }): string | null
export function writeSums(folder: string, version: string): string
export function stagePrebuilt(options: {
  prebuilt: string
  sums?: string
  stagedDir: string
  version: string
  platform?: string
  arch?: string
}): { binary: string; sums: string | null; target: ReleaseTarget }
