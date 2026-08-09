import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'

/**
 * Where to point a fresh install. Helm is harness-agnostic by design, so this
 * only ever *suggests* - it never scans somewhere the user did not choose, and
 * it never falls back to the home directory, which would walk a decade of
 * unrelated files on first run.
 */

const HARNESS_MANIFEST = 'harness.yaml'

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isHarness(path: string): Promise<boolean> {
  try {
    return (await stat(join(path, HARNESS_MANIFEST))).isFile()
  } catch {
    return false
  }
}

/**
 * Walks up from `startDir` looking for a `harness.yaml`. Helm is normally run
 * from inside the harness it manages, so its own location is the strongest
 * available hint.
 */
export async function findEnclosingHarness(startDir: string): Promise<string | null> {
  let current = resolve(startDir)
  const root = parse(current).root

  for (;;) {
    if (await isHarness(current)) return current
    if (current === root) return null
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Ordered best guesses for a first-run scan root: the harness Helm is running
 * inside, then its parent (which usually holds sibling harnesses), then a
 * conventional `~/.harness`. Empty is a legitimate answer - the launcher then
 * asks rather than guessing.
 */
export async function suggestRoots(cwd = process.cwd()): Promise<string[]> {
  const candidates: string[] = []

  const enclosing = await findEnclosingHarness(cwd)
  if (enclosing) {
    // The parent covers this harness *and* its siblings, which is what someone
    // running several harnesses actually wants pointed at.
    candidates.push(dirname(enclosing))
  }

  candidates.push(join(homedir(), '.harness'))

  const out: string[] = []
  for (const candidate of candidates) {
    const normalised = resolve(candidate)
    if (out.some((existing) => existing.toLowerCase() === normalised.toLowerCase())) continue
    if (await isDirectory(normalised)) out.push(normalised)
  }
  return out
}
