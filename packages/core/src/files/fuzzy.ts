/**
 * Ranking file paths against what somebody typed into Ctrl+P.
 *
 * fzy's scorer: every character of the query must appear in the path, in
 * order, and a match is worth more where a person would have started typing -
 * after a slash, at the start of a word, on a capital - and more again when it
 * runs on from the previous one. Gaps cost a little, so of two paths that both
 * match, the tighter and the shorter wins. It is the one most editors converge
 * on because it agrees with intuition on the cases that matter: `tabbar` finds
 * `TabBar.tsx` before `TabBar.test.tsx`, and `ui/tb` finds
 * `packages/ui/src/components/TabBar.tsx`.
 *
 * Pure and browser-safe. The renderer ranks in-process on every keystroke over
 * a list main sent once, so typing never waits on IPC.
 */

export interface PathMatch {
  path: string
  score: number
  /** Indices into `path` of the characters that matched, ascending. */
  hits: number[]
}

const SCORE_MIN = Number.NEGATIVE_INFINITY
const GAP_LEADING = -0.005
const GAP_TRAILING = -0.005
const GAP_INNER = -0.01
const MATCH_CONSECUTIVE = 1.0
const MATCH_SLASH = 0.9
const MATCH_WORD = 0.8
const MATCH_CAPITAL = 0.7
const MATCH_DOT = 0.6
/**
 * A match that starts inside the file name, which is the part of a path people
 * type. Without it `button` ranks `buttons/index.ts` level with `Button.tsx`.
 */
const IN_NAME = 0.5
/** Past this the scorer is not run: a path this long is not one anybody types at. */
const MAX_PATH = 1024

/** What precedes a character decides how much starting a match there is worth. */
function bonusAt(path: string, index: number): number {
  if (index === 0) return MATCH_SLASH
  const prev = path[index - 1]!
  if (prev === '/' || prev === '\\') return MATCH_SLASH
  if (prev === '-' || prev === '_' || prev === ' ') return MATCH_WORD
  if (prev === '.') return MATCH_DOT
  const here = path[index]!
  if (prev === prev.toLowerCase() && here !== here.toLowerCase() && prev !== prev.toUpperCase()) {
    return MATCH_CAPITAL
  }
  return 0
}

/** The query as it is matched: no spaces, and either slash means a slash. */
export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, '').replace(/\\/g, '/')
}

/**
 * Scores one path, or null when the query is not a subsequence of it.
 *
 * `query` is expected normalised (`normalizeQuery`) and non-empty.
 */
export function matchPath(query: string, path: string): PathMatch | null {
  const n = query.length
  const m = path.length
  if (n === 0 || n > m || m > MAX_PATH) return null

  const q = query.toLowerCase()
  const h = path.toLowerCase()

  // The cheap test first: most paths fail it, and they never reach the matrix.
  let k = 0
  for (let j = 0; j < m && k < n; j += 1) if (h[j] === q[k]) k += 1
  if (k < n) return null

  const bonus = new Float64Array(m)
  for (let j = 0; j < m; j += 1) bonus[j] = bonusAt(path, j)

  // D: the best score with query[i] matched exactly at path[j].
  // M: the best score for query[0..i] anywhere in path[0..j].
  const D = new Float64Array(n * m)
  const M = new Float64Array(n * m)
  for (let i = 0; i < n; i += 1) {
    let prev = SCORE_MIN
    const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER
    for (let j = 0; j < m; j += 1) {
      const at = i * m + j
      if (q[i] === h[j]) {
        let score = SCORE_MIN
        if (i === 0) score = j * GAP_LEADING + bonus[j]!
        else if (j > 0) {
          const before = (i - 1) * m + (j - 1)
          score = Math.max(M[before]! + bonus[j]!, D[before]! + MATCH_CONSECUTIVE)
        }
        D[at] = score
        prev = Math.max(score, prev + gap)
        M[at] = prev
      } else {
        D[at] = SCORE_MIN
        prev = prev + gap
        M[at] = prev
      }
    }
  }

  let score = M[(n - 1) * m + (m - 1)]!
  if (score === SCORE_MIN) return null

  // Walk back through the matrix for the positions the best score used.
  const hits = new Array<number>(n)
  let mustMatch = false
  let j = m - 1
  for (let i = n - 1; i >= 0; i -= 1) {
    for (; j >= 0; j -= 1) {
      const at = i * m + j
      const d = D[at]!
      if (d !== SCORE_MIN && (mustMatch || d === M[at])) {
        mustMatch = i > 0 && j > 0 && M[at] === D[(i - 1) * m + (j - 1)]! + MATCH_CONSECUTIVE
        hits[i] = j
        j -= 1
        break
      }
    }
  }

  // A match that starts in the file name is not charged for the folders in
  // front of it: how deep a file sits says nothing about whether it is the one
  // being typed, and charging for it ranked `docs/tabbar.md` over the real
  // `packages/ui/src/components/TabBar.tsx` for no better reason than depth.
  const name = path.lastIndexOf('/') + 1
  if (hits[0]! >= name) score += IN_NAME - name * GAP_LEADING
  return { path, score, hits }
}

/**
 * The best `limit` paths for a query, best first.
 *
 * Ties go to the shorter path and then the alphabet, so the same list always
 * comes back in the same order. An empty query matches nothing: what to show
 * before anything is typed is the caller's decision, not a ranking.
 */
export function rankPaths(query: string, paths: readonly string[], limit = 50): PathMatch[] {
  const q = normalizeQuery(query)
  if (q === '') return []
  const found: PathMatch[] = []
  for (const path of paths) {
    const match = matchPath(q, path)
    if (match !== null) found.push(match)
  }
  found.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path)
  )
  return found.slice(0, limit)
}
