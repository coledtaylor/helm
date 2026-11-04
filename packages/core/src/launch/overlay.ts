import {
  lstatSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'
import type { OverlayLinkMode } from '../types'

/**
 * The overlay shims an earlier version of Helm built under its data folder,
 * when it ran sessions in its own process, and the sweep that clears them at
 * start. The local host composes overlays in each session's own launch folder
 * now, so nothing here builds a shim; what is left is collecting the ones an
 * upgraded install still holds, without ever reaching the repositories they
 * link to.
 *
 *     <shimRoot>/overlay-acme/
 *     ├── .claude-plugin/plugin.json
 *     ├── .helm-overlay.json              the stamp: who holds it
 *     ├── skills/     ──link──▶  repos/acme/.claude/skills
 *     └── ...
 *
 * The links are junctions on Windows and directory symlinks on macOS and
 * Linux.
 */

/** The stamp in every shim Helm built, which marks it as Helm's to remove. */
const STAMP = '.helm-overlay.json'

/** Prefix on every shim directory. */
const SHIM_PREFIX = 'overlay-'

/** Prefix on every composed instruction file swept beside the shims. */
const MEMORY_PREFIX = 'memory-'

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * A Helm process that has this shim in play.
 *
 * `startedAt` is when *the process* started, not when the stamp was written, and
 * that distinction is what makes the pre-boot rule in `ownerVerdict` sound: a
 * pid is only meaningful for as long as the process holding it lives, and no
 * process can have started before the machine booted.
 */
export interface ShimOwner {
  pid: number
  /** ISO; the owning process's start time. */
  startedAt: string
}

interface Stamp {
  name: string
  projectPath: string
  mode: OverlayLinkMode
  linked: string[]
  fingerprint: string
  builtAt: string
  /**
   * Every Helm currently holding this shim, oldest claim first.
   *
   * A *list* rather than the single owner the shape suggests, because the whole
   * point is more than one Helm being up: two apps that launch the same profile
   * both have sessions reading this directory, and a single slot would let the
   * second claim overwrite the first - so a sweep after the second exited would
   * delete a plugin directory the first is still serving. Dead entries are
   * pruned whenever the stamp is written, so the list stays as short as the
   * number of live Helms.
   *
   * Absent on a stamp written by a Helm from before this existed; see
   * `ownerVerdict` for what is assumed then.
   */
  owners?: ShimOwner[]
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

/** Whether a pid names a process that is still there. */
export type OwnerLiveness = 'alive' | 'gone' | 'unknown'

/**
 * Signal 0: asks the kernel about a pid without sending it anything.
 *
 * **`EPERM` is alive, not absent.** It means the process exists and belongs to
 * somebody this one may not signal - a Helm started by another account, or one
 * running elevated - and reading it as "gone" is the reading that deletes a live
 * session's plugin directory. Anything else the platform can raise is `unknown`,
 * which the sweep treats as a reason to leave the shim alone.
 */
export function probeProcess(pid: number): OwnerLiveness {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'gone'
    if (code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

/**
 * The two facts about the machine that decide whether an owner is real, passed
 * in so a test can produce an `EPERM` and a pre-boot stamp without needing a
 * process it may not signal or a reboot.
 */
export interface ShimWorld {
  probe: (pid: number) => OwnerLiveness
  /** When this machine last booted, ms since epoch. */
  bootAtMs: number
}

function realWorld(): ShimWorld {
  return { probe: probeProcess, bootAtMs: Date.now() - uptime() * 1000 }
}

/**
 * Whether anything still owns this shim.
 *
 * Three answers and not two, and the asymmetry between them is the whole
 * design. A stale shim left behind costs a directory and is collected at the
 * next start; a live shim deleted is a session that has silently lost its
 * skills and will not say so. So only `gone` - positively established - removes
 * anything, and `unknown` leaves the directory where it is.
 *
 * Two rules make pid reuse safe rather than merely unlikely:
 *
 *   - **A claim from before this boot is dead by construction.** Pids do not
 *     survive a restart, so a `startedAt` earlier than boot means the number in
 *     the stamp now belongs to somebody else, or to nobody. This is also what
 *     collects the shims of a Helm that was killed and the shims of every Helm
 *     that predates the `owners` field.
 *   - **Within one boot, a reused pid reads as alive** and the shim is left. It
 *     is then collected at the next boot. That is the cheap side of the trade.
 */
function ownerVerdict(stamp: Stamp, world: ShimWorld): OwnerLiveness {
  const owners = Array.isArray(stamp.owners) ? stamp.owners : null

  // No `owners` at all: a stamp from a Helm that did not record one. Nothing can
  // be said about who holds it, so the only safe verdict comes from the clock -
  // a shim built before this boot cannot be held by anything running now.
  if (owners === null) {
    const builtAtMs = Date.parse(stamp.builtAt ?? '')
    return Number.isFinite(builtAtMs) && builtAtMs < world.bootAtMs ? 'gone' : 'unknown'
  }

  // An empty list is a positive statement: the last process to touch this stamp
  // pruned every claim on it and did not add its own.
  let verdict: OwnerLiveness = 'gone'
  for (const owner of owners) {
    const state = livenessOf(owner, world)
    if (state === 'alive') return 'alive'
    if (state === 'unknown') verdict = 'unknown'
  }
  return verdict
}

function livenessOf(owner: ShimOwner, world: ShimWorld): OwnerLiveness {
  if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return 'unknown'
  }
  const startedAtMs = Date.parse(owner.startedAt ?? '')
  // A malformed timestamp is not evidence of anything, so it does not get to
  // stand in for the pre-boot rule; the pid probe answers on its own.
  if (Number.isFinite(startedAtMs) && startedAtMs < world.bootAtMs) return 'gone'
  if (owner.pid === process.pid) return 'alive'
  return world.probe(owner.pid)
}

/**
 * Removes a shim directory, unlinking its links (junctions on Windows,
 * symlinks on macOS and Linux) before anything recurses.
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
 * Removes shim directories nothing is using, and returns what it removed.
 *
 * Called at app start: the shims an upgraded install holds were left by an
 * earlier version of Helm, which may still be running beside this one.
 *
 * "Nothing is using" used to mean "this process has only just started, so
 * nothing is". That reasoning holds for one Helm and is false for two: a second
 * copy starting - the dev build beside the installed one, a portable beside an
 * install - would unlink the first copy's live `--plugin-dir` out from under a
 * running session, which keeps going and silently loses its skills. So a shim
 * names the processes holding it and this asks the kernel about each one; see
 * `ownerVerdict` for the three answers and why only one of them deletes.
 *
 * Only `overlay-*` directories carrying Helm's own stamp are touched. The shim
 * root is Helm's, but a user who pointed it somewhere shared should not lose a
 * directory to a cleanup that assumed everything around it was disposable.
 *
 * `world` is the machine, injected so a test can produce an `EPERM` and a
 * pre-boot stamp without needing a process it may not signal or a reboot.
 */
export function cleanStaleShims(
  shimRoot: string,
  keep: readonly string[] = [],
  world: Partial<ShimWorld> = {}
): string[] {
  const machine: ShimWorld = { ...realWorld(), ...world }
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
    if (!isDir(dir)) continue
    const stamp = readStamp(dir)
    if (stamp === null) continue
    // Somebody is still serving this plugin directory, or nobody can say
    // whether they are. Either way it is not this process's to remove.
    if (ownerVerdict(stamp, machine) !== 'gone') continue
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
