import type { PermissionMode, Profile, Project } from '@helm/core/types'

/**
 * What the new-session launcher decides before anything is drawn: which
 * folders a query lists and in what order, which profile a folder starts with,
 * and the sentence that says what Enter will run.
 *
 * Paths are compared by case folding and nothing else - the rule the sidebar's
 * pinned list and the launch warning follow, so the launcher cannot disagree
 * with either about whether two spellings are one folder.
 */

const key = (path: string): string => path.toLowerCase()

/**
 * What each permission mode is called in the picker, in the order it is
 * offered: from asking about everything to asking about nothing. The CLI's own
 * name for the mode is what the launch sentence prints, in mono, so the label
 * here can be words.
 */
export const PERMISSION_CHOICES: readonly { mode: PermissionMode; label: string }[] = [
  { mode: 'manual', label: 'Ask first' },
  { mode: 'plan', label: 'Plan' },
  { mode: 'acceptEdits', label: 'Accept edits' },
  { mode: 'auto', label: 'Auto' },
  { mode: 'dontAsk', label: 'Don’t ask' },
  { mode: 'bypassPermissions', label: 'Bypass permissions' }
]

/** A folder the query listed, and where in its name the query was found. */
export interface ProjectMatch {
  project: Project
  /** `[start, end)` of the match in the name, or null where it matched the path or nothing was typed. */
  hit: readonly [number, number] | null
}

/**
 * The folders a query lists, best first.
 *
 * A name that starts with the query beats a name that contains it, which beats
 * a path that contains it, and within each the folder worked in most recently
 * comes first - with nothing typed, that recency is the whole order, since the
 * folder somebody wants is usually one they were just in. `recency` is keyed by
 * the lower-cased path; a folder with no history sorts after every folder with
 * some, by name.
 */
export function rankProjects(
  projects: readonly Project[],
  query: string,
  recency: ReadonlyMap<string, number>
): ProjectMatch[] {
  const q = query.trim().toLowerCase()
  // A path typed with either separator finds a path written with the other.
  const qPath = q.replace(/\//g, '\\')
  const ranked: { match: ProjectMatch; tier: number; at: number }[] = []

  for (const project of projects) {
    const at = recency.get(key(project.path)) ?? -1
    if (q === '') {
      ranked.push({ match: { project, hit: null }, tier: 0, at })
      continue
    }
    const name = project.name.toLowerCase()
    const index = name.indexOf(q)
    if (index === 0) ranked.push({ match: { project, hit: [0, q.length] }, tier: 0, at })
    else if (index > 0) ranked.push({ match: { project, hit: [index, index + q.length] }, tier: 1, at })
    else if (key(project.path).replace(/\//g, '\\').includes(qPath)) {
      ranked.push({ match: { project, hit: null }, tier: 2, at })
    }
  }

  return ranked
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.at - a.at ||
        a.match.project.name.localeCompare(b.match.project.name, undefined, { sensitivity: 'base' })
    )
    .map((entry) => entry.match)
}

/**
 * The profile a folder starts with in the launcher: the one most about it, or
 * none.
 *
 * A profile is about a folder when the folder is its root or one of its
 * overlays. Profiles are mostly made at a harness root and name their project
 * through their overlays - the harness itself, then the repository - so the
 * root alone would match the harness to every profile and a repository to
 * almost none. Among those that are about it, the one composing the fewest
 * folders is the most specific: the harness's own profile for the harness, a
 * repository's own for the repository, and a profile spanning five
 * repositories for none of them in particular.
 *
 * Ties go to the profile rooted there, then to the pinned order, then to the
 * name, so the same folder always starts with the same profile.
 */
export function profileFor(path: string, profiles: readonly Profile[]): Profile | null {
  const target = key(path)
  const candidates = profiles.flatMap((profile) => {
    const rooted = key(profile.root) === target
    if (!rooted && !profile.overlays.some((overlay) => key(overlay) === target)) return []
    const folders = new Set([key(profile.root), ...profile.overlays.map(key)])
    return [{ profile, rooted, folders: folders.size }]
  })
  candidates.sort(
    (a, b) =>
      a.folders - b.folders ||
      Number(b.rooted) - Number(a.rooted) ||
      (a.profile.pinnedOrder ?? Number.MAX_SAFE_INTEGER) -
        (b.profile.pinnedOrder ?? Number.MAX_SAFE_INTEGER) ||
      a.profile.name.localeCompare(b.profile.name, undefined, { sensitivity: 'base' })
  )
  return candidates[0]?.profile ?? null
}

/**
 * A path from `~` where it is under the home directory, for a row with no room
 * for the rest. Shown only - every path Helm acts on stays absolute.
 */
export function homePath(path: string, home: string | null): string {
  if (home === null || home === '') return path
  const root = home.replace(/[\\/]+$/, '')
  const lower = key(path)
  const base = key(root)
  if (lower === base) return '~'
  if (lower.startsWith(`${base}\\`) || lower.startsWith(`${base}/`)) {
    return `~${path.slice(root.length)}`
  }
  return path
}

/** The last segment of a path. */
export function folderName(path: string): string {
  return path.split(/[\\/]+/).filter((part) => part !== '').at(-1) ?? path
}

/** One run of the launch sentence; machine parts are mono. */
export interface SentencePart {
  text: string
  mono?: true
}

/** `a`, `a and b`, `a, b and c` - each name a mono part. */
function listOf(names: readonly string[]): SentencePart[] {
  return names.flatMap((name, index): SentencePart[] => {
    const parts: SentencePart[] = [{ text: name, mono: true }]
    if (index < names.length - 2) parts.push({ text: ', ' })
    else if (index === names.length - 2) parts.push({ text: ' and ' })
    return parts
  })
}

/**
 * The launch disclosure (DESIGN.md 5): what Enter will run, in words, with the
 * program, the folder and every flag Helm supplies in mono.
 *
 * Built from the same profile fields main composes argv from, and in the same
 * terms: overlays by their folder's name, which is how their skills are typed
 * at a `/` prompt, and flags exactly as the CLI takes them. A reopened
 * conversation says so first, and never mentions an opening prompt - a resume
 * drops it.
 */
export function launchSentence(options: {
  cwd: string
  home: string | null
  profile: Profile | null
  permissionMode: PermissionMode | null
  /** The conversation being reopened, by the name its row shows. */
  resume: string | null
}): SentencePart[] {
  const { cwd, home, profile, permissionMode, resume } = options
  const parts: SentencePart[] =
    resume === null
      ? [{ text: 'Runs ' }, { text: 'claude', mono: true }]
      : [{ text: `Reopens “${resume}” with ` }, { text: 'claude --resume', mono: true }]
  parts.push({ text: ' in ' }, { text: homePath(cwd, home), mono: true })

  if (profile !== null) {
    parts.push({ text: ` with the ${profile.name} profile` })
    const overlays = profile.overlays.map(folderName)
    if (overlays.length > 0) parts.push({ text: ', composing ' }, ...listOf(overlays))
    const composed = new Set(profile.overlays.map(key))
    const extra = profile.access.filter((path) => !composed.has(key(path))).map(folderName)
    if (extra.length > 0) parts.push({ text: ', with access to ' }, ...listOf(extra))
  }

  const flags = [
    ...(profile?.model ? ['--model', profile.model] : []),
    ...(profile?.effort ? ['--effort', profile.effort] : []),
    ...(permissionMode !== null ? ['--permission-mode', permissionMode] : []),
    ...(profile?.agent ? ['--agent', profile.agent] : [])
  ]
  if (flags.length > 0) {
    parts.push({ text: profile === null ? ' with ' : ', and ' }, { text: flags.join(' '), mono: true })
  }
  parts.push({ text: '.' })

  const prompt = resume === null ? profile?.openingPrompt?.trim() : undefined
  if (prompt) parts.push({ text: ' It opens by saying ' }, { text: prompt, mono: true }, { text: '.' })
  return parts
}
