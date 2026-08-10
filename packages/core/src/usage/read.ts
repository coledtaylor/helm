import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { claudeHome } from '../discovery/history'
import { parseUsage, usageProblem, type UsageSnapshot } from './shape'

/**
 * Getting `cachedUsageUtilization` off the disk, and nothing else.
 *
 * Separated from `shape.ts` because that file is pure and this one touches the
 * filesystem: the renderer re-derives the view it paints from the pure half on
 * a timer, and a `node:fs` import behind it would fail the browser bundle at
 * rollup rather than at typecheck (CLAUDE.md, hard rules).
 */

/**
 * Where the CLI keeps its config JSON.
 *
 * Normally `~/.claude.json`, a sibling of `~/.claude` rather than a file inside
 * it. `CLAUDE_CONFIG_DIR` moves the whole config directory - credentials
 * included, which is why M5 could not point a live session at a fixture home -
 * and the JSON goes with it. Rather than encode which of the two is right for a
 * given release, this prefers whichever is actually there, so a fixture may use
 * either layout.
 */
export function claudeConfigFileIn(home: string = claudeHome()): string {
  const inside = join(home, '.claude.json')
  if (existsSync(inside)) return inside
  return join(dirname(home), '.claude.json')
}

/**
 * Enough of the file's identity to tell "unchanged" from "changed" in one
 * syscall. Size alone is not enough: the CLI rewrites this file in place and a
 * refreshed percentage can land on exactly the same byte count.
 */
export interface UsageFileState {
  size: number
  mtimeMs: number
}

export function usageFileState(file: string): UsageFileState | null {
  try {
    const stats = statSync(file)
    return { size: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return null
  }
}

/**
 * A ceiling on what will be parsed on the main process's thread.
 *
 * `~/.claude.json` also holds per-project prompt history, so it grows with use:
 * 134 KB on the machine this was written against, which parses in about a
 * millisecond. 64 MB is far past any plausible version of that and is here so
 * that a file which has gone wrong stalls nothing - it reports a problem, which
 * shows as no number, which is the correct outcome anyway.
 */
const MAX_BYTES = 64 * 1024 * 1024

/**
 * The whole file, parsed, reduced to what Helm will show.
 *
 * Read whole rather than tailed - unlike `history.jsonl` this is not append
 * only, and one changed digit rewrites it. The incremental treatment that file
 * gets is not available here and is not needed: it is a single-figure read of a
 * small file, behind a debounce, gated on the file having changed at all.
 */
export function readUsage(file: string): UsageSnapshot {
  const state = usageFileState(file)
  if (state === null) {
    return usageProblem(file, 'no-file', `${file} is not there, so Claude Code has no figures yet.`)
  }
  if (state.size > MAX_BYTES) {
    return usageProblem(
      file,
      'unreadable',
      `${file} is ${String(Math.round(state.size / 1024 / 1024))} MB, which is too large to parse for one figure.`
    )
  }

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return usageProblem(file, 'unreadable', err instanceof Error ? err.message : String(err))
  }

  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (err) {
    // Reachable in normal use: the CLI rewrites this file in place, and a read
    // that lands mid-write sees half of it. The next pass sees the whole one.
    return usageProblem(
      file,
      'not-json',
      `${file} did not parse: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  return parseUsage(root, file)
}
