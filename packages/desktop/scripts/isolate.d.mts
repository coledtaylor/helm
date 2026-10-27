// Types for isolate.mjs, so the data-directory rules can be tested from TypeScript.

type Env = Readonly<Record<string, string | undefined>>

export function realDataDirFor(platform: NodeJS.Platform, env: Env, home: string): string
export function isolatedBaseFor(platform: NodeJS.Platform, env: Env, home: string): string
export function realDataDir(): string
export const UI_STATE_KEYS: string[]
export function isolatedRoot(name: string, group?: string | null): string
export function isolate(
  name: string,
  options?: { seed?: boolean; concurrent?: boolean; group?: string | null; keepUiState?: boolean }
): { root: string; dataDir: string; env: Record<string, string | undefined> }
export function clearDatabase(dataDir: string): true | 'busy'
export function seedDatabase(dataDir: string, options?: { keepUiState?: boolean }): boolean | 'busy'
