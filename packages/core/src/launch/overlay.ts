import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/**
 * Turning a repo's `.claude/` directory into something `--plugin-dir` accepts.
 *
 * A plugin is a directory with a manifest and convention subdirectories beside
 * it, which is what a `.claude/` directory already almost is - it just lacks the
 * manifest. So Helm synthesises the missing shape around the real thing rather
 * than copying it (SPEC 2, proved by Spike A):
 *
 *     <shimRoot>/overlay-acme/
 *     ├── .claude-plugin/plugin.json      generated
 *     ├── .helm-overlay.json              generated: what this was built from
 *     ├── skills/     ──junction──▶  repos/acme/.claude/skills
 *     ├── commands/   ──junction──▶  repos/acme/.claude/commands
 *     └── agents/     ──junction──▶  repos/acme/.claude/agents
 *
 * Junctions rather than symlinks because symlinks need elevation on Windows and
 * junctions do not, and rather than copies because a junction is the source
 * directory: editing a skill in the repo changes what the next session loads
 * without anything having to notice.
 */

/**
 * What gets linked, and in what order.
 *
 * `hooks/` is deliberately absent even though a plugin may carry one. A hook is
 * executable configuration whose commands are written against the repo's own
 * working directory, and the whole point of an overlay is that the session's
 * cwd is somewhere else - so composing one would run commands against paths
 * that are not there. Skills, commands and agents are declarative and do not
 * have that problem.
 */
export const OVERLAY_DIRS = ['skills', 'commands', 'agents'] as const

/** Everything Helm generates inside a shim, so a rebuild knows what is its own. */
const MANIFEST = join('.claude-plugin', 'plugin.json')
const STAMP = '.helm-overlay.json'

/** Prefix on every shim directory; also what marks one as ours to clean up. */
const SHIM_PREFIX = 'overlay-'

/** Prefix on every composed instruction file, for the same reason. */
export const MEMORY_PREFIX = 'memory-'

/**
 * A plugin name becomes the namespace every skill from that overlay is invoked
 * under, so it is read by a person at a `/` prompt and should look like the repo
 * it came from. Spike A's throwaway `acme-overlay:` prefix is exactly what
 * this exists to avoid.
 *
 * Lowercased and reduced to the characters a namespace can safely use; a name
 * that reduces to nothing falls back to `overlay`, which is still addressable.
 */
export function overlayPluginName(projectPath: string): string {
  const clean = basename(resolve(projectPath))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return clean.length > 0 ? clean : 'overlay'
}

/**
 * Plugin names within one launch, made distinct.
 *
 * Two projects can share a directory name - `repos/acme` in two different
 * harnesses - and the CLI namespaces skills by manifest name, so a collision
 * here would put two overlays' skills under one prefix. That is the one
 * collision Spike A's automatic namespacing does not solve, because it is
 * upstream of it.
 */
export function overlayPluginNames(projectPaths: string[]): string[] {
  const taken = new Set<string>()
  return projectPaths.map((path) => {
    const base = overlayPluginName(path)
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base}-${String(n)}`
    taken.add(name)
    return name
  })
}

/** What a shim is to be built from, before anything touches the disk. */
export interface OverlayPlan {
  name: string
  projectPath: string
  /** Where the shim goes. */
  dir: string
  /** Convention directories the source actually has. */
  links: string[]
  /** The project's CLAUDE.md, if it has one. */
  claudeMdPath: string | null
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function planOverlays(projectPaths: string[], shimRoot: string): OverlayPlan[] {
  const names = overlayPluginNames(projectPaths)
  return projectPaths.map((projectPath, index) => {
    const root = resolve(projectPath)
    const claudeDir = join(root, '.claude')
    const claudeMd = join(root, 'CLAUDE.md')
    const name = names[index] ?? overlayPluginName(root)
    return {
      name,
      projectPath: root,
      dir: join(shimRoot, `${SHIM_PREFIX}${name}`),
      links: OVERLAY_DIRS.filter((dir) => isDir(join(claudeDir, dir))),
      claudeMdPath: isFile(claudeMd) ? claudeMd : null
    }
  })
}

/**
 * A cheap summary of what the source looks like right now.
 *
 * The scope calls for a hash check at launch rather than a watcher, and this is
 * what it compares. Size and mtime rather than content: the thing being
 * detected is "this tree is not what the shim was built from", a walk of every
 * skill's bytes would cost real time on a repo with forty of them, and a change
 * that keeps both the size and the timestamp is not a change a person made.
 *
 * CLAUDE.md is hashed by content, because that file is copied into the composed
 * memory rather than linked - a stale copy is invisible, where a stale junction
 * cannot happen.
 */
function fingerprint(plan: OverlayPlan): string {
  const hash = createHash('sha256')
  hash.update(plan.name)
  hash.update(plan.projectPath)

  for (const dir of plan.links) {
    hash.update(`dir:${dir}`)
    const base = join(plan.projectPath, '.claude', dir)
    const walk = (current: string, prefix: string): void => {
      let entries: Dirent[]
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      // Sorted, because readdir order is the filesystem's and a reordering
      // would read as a change.
      for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        const child = join(current, entry.name)
        const rel = `${prefix}/${entry.name}`
        if (entry.isDirectory()) {
          walk(child, rel)
        } else if (entry.isFile()) {
          try {
            const stat = statSync(child)
            hash.update(`${rel}:${String(stat.size)}:${String(Math.floor(stat.mtimeMs))}`)
          } catch {
            hash.update(`${rel}:missing`)
          }
        }
      }
    }
    walk(base, dir)
  }

  if (plan.claudeMdPath) {
    try {
      hash.update(readFileSync(plan.claudeMdPath))
    } catch {
      hash.update('claude-md:unreadable')
    }
  }
  return hash.digest('hex')
}

interface Stamp {
  name: string
  projectPath: string
  mode: 'junction' | 'copy'
  linked: string[]
  fingerprint: string
  builtAt: string
}

function readStamp(dir: string): Stamp | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, STAMP), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const stamp = parsed as Partial<Stamp>
    if (typeof stamp.fingerprint !== 'string' || typeof stamp.name !== 'string') return null
    return stamp as Stamp
  } catch {
    return null
  }
}

/**
 * Removes a shim directory, unlinking its junctions before anything recurses.
 *
 * `fs.rm(dir, { recursive: true })` is documented to unlink a link rather than
 * descend through it, and in a clean test it does. It was still observed
 * emptying the *source* repository's `.claude/skills` during a shim rebuild -
 * the skill directory behind the junction gone, its parent left behind. The
 * conditions that produce it are not worth characterising, because the cost of
 * being wrong is a user's skills deleted by a tool that only borrowed them.
 *
 * So the links go first, explicitly, and only a directory known to contain no
 * links is handed to a recursive delete. `rmdir` as well as `unlink`: Windows
 * removes a directory junction with one and a file symlink with the other, and
 * which of the two a given reparse point wants is not worth branching on.
 */
function removeShimDir(dir: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // Not there, which is the state this function exists to produce.
    rmSync(dir, { recursive: true, force: true })
    return
  }

  for (const entry of entries) {
    const path = join(dir, entry.name)
    let link: boolean
    try {
      link = lstatSync(path).isSymbolicLink()
    } catch {
      continue
    }
    if (!link) continue
    try {
      unlinkSync(path)
    } catch {
      try {
        rmdirSync(path)
      } catch {
        // Leave it rather than let the recursive delete below reach through it.
        // A shim that could not be torn down is a stale directory; a source
        // repo emptied through one is not recoverable.
        throw new Error(
          `Refusing to remove ${dir}: the link at ${path} could not be unlinked, ` +
            'and deleting the directory around it risks reaching the repository behind it.'
        )
      }
    }
  }

  rmSync(dir, { recursive: true, force: true })
}

/**
 * Links one convention directory, falling back to a copy.
 *
 * The fallback exists because a junction can fail for reasons that are not the
 * user's to fix - the shim root landing on a filesystem that has no reparse
 * points, most plausibly a network share or a FAT-formatted stick, which is a
 * real case for an app whose whole premise is being portable.
 */
function link(target: string, path: string): 'junction' | 'copy' {
  try {
    symlinkSync(target, path, 'junction')
    return 'junction'
  } catch {
    cpSync(target, path, { recursive: true, dereference: true })
    return 'copy'
  }
}

export interface SyncedOverlay {
  name: string
  projectPath: string
  dir: string
  linked: string[]
  mode: 'junction' | 'copy'
  hasClaudeMd: boolean
  rebuilt: boolean
}

/**
 * Brings one shim up to date, building it if it is not there.
 *
 * Rebuilds are whole-directory: the shim is removed and made again rather than
 * patched. Its entire contents are either generated or a link, so there is
 * nothing in it worth preserving, and "delete and rebuild" cannot leave a
 * junction pointing at a directory the source no longer has.
 *
 * Removing it is safe even though it contains junctions - `rm` unlinks a
 * junction rather than descending through it, so the source repo is never
 * reachable from here. That is load-bearing: the alternative deletes the user's
 * skills.
 */
export function syncOverlay(plan: OverlayPlan): SyncedOverlay {
  const current = fingerprint(plan)
  const stamp = readStamp(plan.dir)

  if (stamp && stamp.fingerprint === current && existsSync(join(plan.dir, MANIFEST))) {
    return {
      name: plan.name,
      projectPath: plan.projectPath,
      dir: plan.dir,
      linked: stamp.linked,
      mode: stamp.mode,
      hasClaudeMd: plan.claudeMdPath !== null,
      rebuilt: false
    }
  }

  removeShimDir(plan.dir)
  mkdirSync(join(plan.dir, '.claude-plugin'), { recursive: true })

  writeFileSync(
    join(plan.dir, MANIFEST),
    `${JSON.stringify(
      {
        name: plan.name,
        version: '0.0.0',
        description: `Helm overlay for ${plan.projectPath}`
      },
      null,
      2
    )}\n`
  )

  const linked: string[] = []
  let mode: 'junction' | 'copy' = 'junction'
  for (const dir of plan.links) {
    const how = link(join(plan.projectPath, '.claude', dir), join(plan.dir, dir))
    if (how === 'copy') mode = 'copy'
    linked.push(dir)
  }

  const next: Stamp = {
    name: plan.name,
    projectPath: plan.projectPath,
    mode,
    linked,
    fingerprint: current,
    builtAt: new Date().toISOString()
  }
  writeFileSync(join(plan.dir, STAMP), `${JSON.stringify(next, null, 2)}\n`)

  return {
    name: plan.name,
    projectPath: plan.projectPath,
    dir: plan.dir,
    linked,
    mode,
    hasClaudeMd: plan.claudeMdPath !== null,
    rebuilt: true
  }
}

/**
 * Removes shim directories nothing is using, and returns what it removed.
 *
 * Called at app start rather than at session end, because the case it exists
 * for is the one where there was no session end - a crash, or a kill from Task
 * Manager, leaves the shims of every profile that had been launched.
 *
 * Only `overlay-*` directories carrying Helm's own stamp are touched. The shim
 * root is Helm's, but a user who pointed it somewhere shared should not lose a
 * directory to a cleanup that assumed everything around it was disposable.
 */
export function cleanStaleShims(shimRoot: string, keep: readonly string[] = []): string[] {
  const kept = new Set(keep.map((name) => name.toLowerCase()))
  let entries: string[]
  try {
    entries = readdirSync(shimRoot)
  } catch {
    return []
  }

  const removed: string[] = []
  for (const entry of entries) {
    // The composed instruction files are generated per launch and named after
    // the session, so they accumulate one per distinct session name and nothing
    // else ever collects them. Swept alongside the shims they belong to.
    if (entry.startsWith(MEMORY_PREFIX) && entry.endsWith('.md')) {
      try {
        rmSync(join(shimRoot, entry), { force: true })
        removed.push(join(shimRoot, entry))
      } catch {
        // Fine to leave; it is a file, and the next start tries again.
      }
      continue
    }

    if (!entry.startsWith(SHIM_PREFIX)) continue
    if (kept.has(entry.slice(SHIM_PREFIX.length).toLowerCase())) continue
    const dir = join(shimRoot, entry)
    if (!isDir(dir) || readStamp(dir) === null) continue
    try {
      removeShimDir(dir)
      removed.push(dir)
    } catch {
      // A shim held open by a session that outlived its app is not worth
      // failing a launch over; the next start will find it again.
    }
  }
  return removed
}

/**
 * The composed project-instructions document, or null if there is nothing to
 * compose.
 *
 * This is the answer to the gap Spike A found and M3 was to close: a plugin does
 * not carry the overlaid repo's CLAUDE.md, and `--add-dir` - whose help text
 * suggested it might - does not either. Measured on 2.1.225: a session launched
 * from the harness root with both flags reported only the user and cwd
 * instruction files, and could not answer a question whose answer is in
 * `repos/acme/CLAUDE.md`. Passing this file to
 * `--append-system-prompt-file` does carry it.
 *
 * A file rather than `--append-system-prompt` with the text inline: two repos
 * here total 34 KB, and Windows caps a command line at 32,767 characters, so
 * the inline form is not merely wasteful but breaks on the second overlay.
 */
export function composeOverlayMemory(plans: readonly OverlayPlan[]): string | null {
  const parts: string[] = []
  for (const plan of plans) {
    if (!plan.claudeMdPath) continue
    let content: string
    try {
      content = readFileSync(plan.claudeMdPath, 'utf8')
    } catch {
      continue
    }
    // Attributed by path, because the instructions inside frequently say "this
    // repo" and the session's cwd is a different one.
    parts.push(
      `## Project instructions: ${plan.projectPath}\n\n` +
        `These apply to work in \`${plan.projectPath}\`, composed into this session as the ` +
        `\`${plan.name}\` overlay.\n\n${content.trim()}`
    )
  }
  if (parts.length === 0) return null

  return (
    '# Composed project instructions\n\n' +
    'The following CLAUDE.md files belong to projects composed into this session as ' +
    'overlays. The session\'s working directory is not theirs, so each block says which ' +
    'project it governs.\n\n' +
    `${parts.join('\n\n---\n\n')}\n`
  )
}
