// Types for test-posix.mjs, so where the POSIX tests run can be tested from TypeScript.

export const REPO_ROOT: string
export const POSIX_TESTS: string[]
export function posixTestPlan(
  platform: NodeJS.Platform,
  args: readonly string[]
): { where: 'wsl' | 'native'; files: string[] }
export function mirrorName(root: string): string
export function pinnedPnpm(packageJson: { packageManager?: string }): string
export const WSL_SCRIPT: string
