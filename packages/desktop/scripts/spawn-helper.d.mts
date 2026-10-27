// Types for spawn-helper.mjs, so the fix for node-pty's macOS spawn-helper can be tested from TypeScript.

export function spawnHelpers(nodePtyDir: string): string[]
export function makeSpawnHelpersExecutable(nodePtyDir: string): string[]
