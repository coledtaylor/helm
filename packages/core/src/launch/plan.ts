import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EffortLevel, LaunchPlan, PermissionMode, Profile } from '../types'
import {
  composeOverlayMemory,
  MEMORY_PREFIX,
  planOverlays,
  syncOverlay,
  type OverlayPlan
} from './overlay'
import { sanitizeSessionName } from './session'

/**
 * A profile becomes argv.
 *
 * This is the whole product in one function: the composition SPEC 2 describes
 * is not expressible in the CLI without assembling these flags by hand every
 * time, and eliminating that ceremony is what Helm is for.
 */

export interface LaunchRequest {
  /** Working directory. Claude Code resolves `.claude/` config from it. */
  root: string
  /** Session display name, before uniquing. */
  name: string
  /** Project paths to compose as plugins. */
  overlays?: readonly string[] | undefined
  /** Project paths to grant tool access to. */
  access?: readonly string[] | undefined
  model?: string | null | undefined
  effort?: EffortLevel | null | undefined
  permissionMode?: PermissionMode | null | undefined
  agent?: string | null | undefined
  /** Submitted as the session's first message. */
  openingPrompt?: string | null | undefined
  /** Where synthesised overlay shims live. Owned by the host. */
  shimRoot: string
}

/** The launch shape of a stored profile. */
export function launchRequestFromProfile(
  profile: Profile,
  shimRoot: string,
  name?: string
): LaunchRequest {
  return {
    root: profile.root,
    name: name ?? profile.name,
    overlays: profile.overlays,
    access: profile.access,
    model: profile.model,
    effort: profile.effort,
    permissionMode: profile.permissionMode,
    agent: profile.agent,
    openingPrompt: profile.openingPrompt,
    shimRoot
  }
}

/**
 * Argv after the executable.
 *
 * The order is not cosmetic. `--add-dir` is variadic - it consumes arguments
 * until the next one that starts with a dash - so anything positional placed
 * after it would be swallowed into the directory list. `-n` always follows it
 * and always exists, which terminates that list, and the opening prompt goes
 * last where the CLI expects a bare prompt.
 */
export function buildLaunchArgs(
  req: Omit<LaunchRequest, 'shimRoot'> & {
    /** Shim directories, already synthesised. */
    pluginDirs?: readonly string[] | undefined
    /** Composed project instructions, already written. */
    memoryFile?: string | null | undefined
  }
): string[] {
  const argv: string[] = []

  const access = dedupePaths(req.access ?? [])
  if (access.length > 0) argv.push('--add-dir', ...access)

  argv.push('-n', sanitizeSessionName(req.name))

  for (const dir of req.pluginDirs ?? []) argv.push('--plugin-dir', dir)
  if (req.memoryFile) argv.push('--append-system-prompt-file', req.memoryFile)

  if (req.model) argv.push('--model', req.model)
  if (req.effort) argv.push('--effort', req.effort)
  if (req.permissionMode) argv.push('--permission-mode', req.permissionMode)
  if (req.agent) argv.push('--agent', req.agent)

  // Last, and only if it is really there: an empty string here would be a
  // positional argument the CLI reads as an empty prompt.
  const prompt = req.openingPrompt?.trim()
  if (prompt) argv.push(prompt)

  return argv
}

/**
 * Case-insensitively unique, order preserved.
 *
 * A profile that lists the same repo under `overlays` and `access` - which is
 * the normal case, since composing a repo's skills without granting its files
 * is rarely what anyone wants - would otherwise pass the same path twice.
 */
function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    const abs = resolve(path)
    const key = abs.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(abs)
  }
  return out
}

/** Where a launch's composed instructions are written. */
function memoryFileFor(shimRoot: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session'
  return join(shimRoot, `${MEMORY_PREFIX}${slug}.md`)
}

/**
 * Synthesises everything a composed session needs and returns the argv for it.
 *
 * Does the disk work - shims, the composed memory file - because all of it is a
 * pure function of the profile and none of it belongs to a window. The host
 * supplies `shimRoot` and spawns the result.
 */
export function prepareLaunch(req: LaunchRequest): LaunchPlan {
  const warnings: string[] = []
  const shimRoot = resolve(req.shimRoot)
  mkdirSync(shimRoot, { recursive: true })

  const overlayPaths = dedupePaths(req.overlays ?? []).filter((path) => {
    if (existsSync(path)) return true
    warnings.push(`Overlay skipped - ${path} is not there any more.`)
    return false
  })

  const plans: OverlayPlan[] = planOverlays(overlayPaths, shimRoot)
  const shims = plans.map((plan) => {
    if (plan.links.length === 0 && plan.claudeMdPath === null) {
      warnings.push(`${plan.projectPath} has no .claude/ directory and no CLAUDE.md to compose.`)
    }
    return syncOverlay(plan)
  })

  // Note there is no sweep of other shims here. A launch knows which shims it
  // needs and nothing about which ones another live session is still reading
  // out of, and a plugin directory removed underneath a running session takes
  // its skills with it. Sweeping is `cleanStaleShims`, at app start, where the
  // answer to "is anything using this" is reliably no.

  const memory = composeOverlayMemory(plans)
  let memoryFile: string | null = null
  if (memory !== null) {
    memoryFile = memoryFileFor(shimRoot, req.name)
    writeFileSync(memoryFile, memory)
  } else if (plans.length > 0) {
    warnings.push('No overlay had a CLAUDE.md, so no project instructions were composed.')
  }

  const access = dedupePaths(req.access ?? []).filter((path) => {
    if (existsSync(path)) return true
    warnings.push(`Access directory skipped - ${path} is not there any more.`)
    return false
  })

  const argv = buildLaunchArgs({
    root: req.root,
    name: req.name,
    access,
    model: req.model,
    effort: req.effort,
    permissionMode: req.permissionMode,
    agent: req.agent,
    openingPrompt: req.openingPrompt,
    pluginDirs: shims.map((shim) => shim.dir),
    memoryFile
  })

  return {
    cwd: resolve(req.root),
    name: sanitizeSessionName(req.name),
    argv,
    overlays: shims,
    memoryFile,
    warnings
  }
}
