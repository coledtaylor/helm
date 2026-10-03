import { spawn, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { World } from './world'

/**
 * Profiles and overlay shims in a test world: a harness with a repository worth
 * composing, and the two things a shim test needs that `world.ts` does not
 * have - a process that has exited and one that is still running.
 *
 * A shim holds junctions into the world's own repositories, so anything that
 * makes one removes it with `removeShims` before the world is disposed.
 */

export interface PlantedHarness {
  /** The harness root, inside the world's projects folder so its scan finds it. */
  root: string
  /** `repos/tools`, carrying a skill, an agent and a CLAUDE.md to compose. */
  overlay: string
  /** The overlay's skill directory name. */
  skill: string
  /** The overlay's agent name. */
  agent: string
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** Where `plantHarness` puts its harness, without writing anything. */
export function harnessIn(world: World, name = 'hub'): PlantedHarness {
  const root = join(world.projectsDir, name)
  return { root, overlay: join(root, 'repos', 'tools'), skill: 'think', agent: 'reviewer' }
}

export function plantHarness(world: World, name = 'hub'): PlantedHarness {
  const planted = harnessIn(world, name)
  const { root, overlay } = planted
  write(join(root, 'harness.yaml'), `name: "${name}"\nversion: 1\n`)
  mkdirSync(join(root, '.claude'), { recursive: true })
  write(join(overlay, '.claude', 'skills', 'think', 'SKILL.md'), '---\nname: think\ndescription: Think it through.\n---\n# think\n')
  write(join(overlay, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews a change.\n---\nReview it.\n')
  write(join(overlay, 'CLAUDE.md'), '# tools\n\nThe tools repository.\n')
  return planted
}

const STAMP = '.helm-overlay.json'

/** The pids a shim's stamp says are holding it. */
export function shimOwners(shim: string): number[] {
  const stamp = JSON.parse(readFileSync(join(shim, STAMP), 'utf8')) as { owners?: { pid: number }[] }
  return (stamp.owners ?? []).map((owner) => owner.pid)
}

/**
 * Rewrites a real shim's claim so another process holds it, standing in for a
 * second Helm that launched the same overlay. The start time is now, inside
 * this boot, so the sweep has to ask the kernel about the pid.
 */
export function claimShimFor(shim: string, pid: number): void {
  const file = join(shim, STAMP)
  const stamp = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  stamp['owners'] = [{ pid, startedAt: new Date().toISOString() }]
  writeFileSync(file, JSON.stringify(stamp, null, 2))
}

/** A pid whose process has already exited. */
export function exitedPid(): number {
  const run = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  if (run.pid === undefined || run.status !== 0) throw new Error('could not run a process to exit')
  return run.pid
}

/** A process that keeps running until `stop`. */
export function runningProcess(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
  if (child.pid === undefined) throw new Error('could not start a process')
  return { pid: child.pid, stop: () => child.kill() }
}

/** Whether `path` is a link (a junction, on Windows) rather than a real directory. */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Removes every shim under `shimRoot`, unlinking its junctions first so that
 * nothing recursive is ever handed a directory with a link in it.
 */
export function removeShims(shimRoot: string): void {
  let names: string[]
  try {
    names = readdirSync(shimRoot)
  } catch {
    return
  }
  for (const name of names) {
    const dir = join(shimRoot, name)
    if (!lstatSync(dir).isDirectory()) continue
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (!isLink(path)) continue
      try {
        unlinkSync(path)
      } catch {
        rmdirSync(path)
      }
    }
  }
  rmSync(shimRoot, { recursive: true, force: true })
}
