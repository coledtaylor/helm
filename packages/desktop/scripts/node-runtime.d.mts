// Types for node-runtime.mjs, so the pin lookup and checksum check can be tested from TypeScript.

export interface NodePins {
  version: string
  platforms: Record<string, { archive: string; sha256: string; binary: string }>
}

export interface NodePin {
  /** `<platform>-<arch>`, the pin file's key. */
  platform: string
  version: string
  archive: string
  sha256: string
  url: string
  /** Where Node's binary sits under the staged folder: `node.exe` or `bin/node`. */
  binary: string
  /** The two archive members extracted: Node's binary and its LICENSE. */
  members: { binary: string; license: string }
}

export type FetchArchive = (url: string, dest: string) => Promise<void>

export const PIN_FILE: string
export function readPins(file?: string): NodePins
export function pinFor(pins: NodePins, platform: string, arch: string): NodePin
export function sha256Of(file: string): Promise<string>
export function verifyArchive(file: string, pin: NodePin): Promise<void>
export function download(url: string, dest: string): Promise<void>
export function obtainArchive(
  pin: NodePin,
  cacheDir: string,
  fetchArchive?: FetchArchive
): Promise<{ file: string; reused: boolean }>
export function tarProgram(platform?: string, env?: NodeJS.ProcessEnv): string
export function extractAndStage(
  pin: NodePin,
  archive: string,
  cacheDir: string,
  stagedDir: string,
  tar?: string
): { binary: string; license: string }
export function stageNode(options: {
  cacheDir: string
  stagedDir: string
  platform?: string
  arch?: string
  pins?: NodePins
  fetchArchive?: FetchArchive
  tar?: string
}): Promise<{ pin: NodePin; archive: string; reused: boolean; binary: string; license: string }>
