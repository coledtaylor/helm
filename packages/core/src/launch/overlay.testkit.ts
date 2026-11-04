import { mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { OverlayLinkMode } from '../types'
import type { ShimOwner } from './overlay'

/**
 * Overlay shims as an earlier version of Helm built them under its data folder
 * when it ran sessions in its own process: the fixture the start-up sweep
 * (`cleanStaleShims`) is tested against. Nothing in the app builds one now.
 *
 * The layout, the stamp and the links are the ones that version wrote: a
 * junction on Windows and a directory symlink on macOS and Linux, into the
 * project's own `.claude` folders.
 */

/** The folders a shim linked, in the order it linked them. */
const LINKED_DIRS = ['skills', 'commands', 'agents', 'workflows'] as const

export interface PlantedShim {
  dir: string
  /** The `.claude` folders linked in. */
  linked: string[]
  mode: OverlayLinkMode
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** This process, as the stamp named the Helm that built a shim. */
function thisProcess(): ShimOwner {
  return { pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() }
}

/**
 * Builds the shim for `projectPath` under `shimRoot`, claimed by `owners`
 * (this process unless given). The directory is named after the project, as
 * that version named it: `overlay-<folder name>`.
 */
export function plantShim(projectPath: string, shimRoot: string, owners: ShimOwner[] = [thisProcess()]): PlantedShim {
  const source = resolve(projectPath)
  const name = basename(source).toLowerCase()
  const dir = join(shimRoot, `overlay-${name}`)
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name, version: '0.0.0', description: `Helm overlay for ${source}` }, null, 2)}\n`
  )

  const kind = process.platform === 'win32' ? ({ type: 'junction', mode: 'junction' } as const) : ({ type: 'dir', mode: 'symlink' } as const)
  const linked = LINKED_DIRS.filter((folder) => isDir(join(source, '.claude', folder)))
  for (const folder of linked) symlinkSync(join(source, '.claude', folder), join(dir, folder), kind.type)

  writeFileSync(
    join(dir, '.helm-overlay.json'),
    `${JSON.stringify(
      {
        name,
        projectPath: source,
        mode: kind.mode,
        linked,
        fingerprint: 'planted',
        builtAt: new Date().toISOString(),
        owners
      },
      null,
      2
    )}\n`
  )
  return { dir, linked: [...linked], mode: kind.mode }
}
