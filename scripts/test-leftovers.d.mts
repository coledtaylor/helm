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

/** What `before` records: a snapshot, the folder the check runs from, and the step's mark. */
export interface State extends Snapshot {
  checkout: string
  mark: string
}

/** What the OS says of one process a reaper adopted; unmarked and null when it will not say. */
export interface ProcessTraits {
  /** It carries `TEST_LEFTOVERS_MARK=<the step's mark>` in its environment. */
  marked: boolean
  /** Its working folder, as the OS reports it. */
  cwd: string | null
}

/** Where a step's processes run: the temp folder and the checkout, each as given and resolved. */
export interface StepPlaces {
  temps: string[]
  checkouts: string[]
}

export interface Leftovers {
  /** Full paths. */
  folders: string[]
  processes: ProcessRow[] | null
}

export const TEST_FOLDER_PREFIXES: readonly string[]
export const MARK_VARIABLE: 'TEST_LEFTOVERS_MARK'
export function isTestFolder(name: string): boolean
export function isTestProcess(name: string): boolean
export function processName(raw: string): string
export function selectLeftovers(input: {
  before: Pick<Snapshot, 'processes' | 'folders'>
  after: Pick<Snapshot, 'processes' | 'folders'>
  self: number
  tmp: string
  places: StepPlaces
  /** Asked only about a process a reaper adopted. */
  inspect: (pid: number) => ProcessTraits
}): Leftovers
export function stepPlaces(tmp: string, checkout: string): StepPlaces
export function formatLeftovers(leftovers: Leftovers): string[]
export function parseWindowsTable(text: string): ProcessRow[]
export function parsePsTable(table: string, args: string): ProcessRow[]
/** What `readProcessTable` runs each listing with: `execFileSync`'s shape, answering stdout. */
export type ListingRunner = (file: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => string
export function readProcessTable(platform?: NodeJS.Platform, run?: ListingRunner): ProcessRow[] | null
export function parseLsofCwd(text: string): string | null
/** What `inspectProcess` reads with. */
export interface InspectIo {
  run: ListingRunner
  readFile: (path: string, encoding: 'utf8') => string
  readLink: (path: string) => string
}
export function inspectProcess(pid: number, mark: string, platform?: NodeJS.Platform, io?: InspectIo): ProcessTraits
export function snapshot(tmp?: string): Snapshot
export function begin(options?: { githubEnv?: string; tmp?: string; checkout?: string }): State
export function check(before: State): 0 | 1
