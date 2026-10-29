// Types for test-leftovers.mjs, so what it selects can be tested from TypeScript.

export interface ProcessRow {
  pid: number
  parentPid: number
  /** As `processName` normalises it: base name, lower case, no `.exe`. */
  name: string
  /** Null when the OS would not say. */
  commandLine: string | null
  /** Milliseconds since the epoch; with the pid, what makes a process the same one. */
  start: number
}

export interface Snapshot {
  tmp: string
  /** Null when the process table could not be read on this OS. */
  processes: ProcessRow[] | null
  /** Names of the test folders in `tmp`. */
  folders: string[]
}

export interface Leftovers {
  /** Full paths. */
  folders: string[]
  processes: ProcessRow[] | null
}

export const TEST_FOLDER_PREFIXES: readonly string[]
export function isTestFolder(name: string): boolean
export function isTestProcess(name: string): boolean
export function processName(raw: string): string
export function selectLeftovers(input: {
  before: Pick<Snapshot, 'processes' | 'folders'>
  after: Pick<Snapshot, 'processes' | 'folders'>
  self: number
  tmp: string
}): Leftovers
export function formatLeftovers(leftovers: Leftovers): string[]
export function parseWindowsTable(text: string): ProcessRow[]
export function parsePsTable(table: string, args: string): ProcessRow[]
export function readProcessTable(platform?: NodeJS.Platform): ProcessRow[] | null
export function snapshot(tmp?: string): Snapshot
export function check(before: Snapshot): 0 | 1
