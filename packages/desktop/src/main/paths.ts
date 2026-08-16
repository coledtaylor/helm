import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppMode } from '../shared/ipc'

/**
 * Where Helm keeps its data.
 *
 * Portable builds put it beside the exe so the whole install travels on a
 * stick; installed builds use `%APPDATA%`. electron-builder's portable launcher
 * is what tells us which we are: it sets `PORTABLE_EXECUTABLE_DIR` to the
 * directory the exe was double-clicked from (the exe itself runs from a temp
 * extraction directory, so `process.execPath` would point at the wrong place).
 */

const portableDir = process.env['PORTABLE_EXECUTABLE_DIR']

/**
 * Which of the four this run is.
 *
 * Two questions, not one. `app.isPackaged` says whether this is a build or a
 * checkout, and `PORTABLE_EXECUTABLE_DIR` says whether the data lives somewhere
 * of its own - and the pair matters because the case with no directory of its
 * own is the dangerous one. `productName` is `Helm`, so an unpackaged run with
 * no portable directory resolves `userData` to **`%APPDATA%\Helm`**: the same
 * `helm.db`, the same `overlays/` and the same Chromium profile as the Helm
 * somebody is using. That is `dev-live`, it is what `pnpm dev:live` asks for on
 * purpose, and it is named rather than inferred so the status bar can say it.
 *
 * `pnpm dev` and every check go through `scripts/isolate.mjs` instead, which
 * sets `PORTABLE_EXECUTABLE_DIR` to a directory under `%LOCALAPPDATA%\Helm`.
 */
export const appMode: AppMode = app.isPackaged
  ? portableDir
    ? 'portable'
    : 'installed'
  : portableDir
    ? 'dev'
    : 'dev-live'

export const dataDir: string = portableDir ? join(portableDir, 'helm-data') : app.getPath('userData')

/** Must run before anything reads `app.getPath('userData')`. */
export function initDataDir(): void {
  mkdirSync(dataDir, { recursive: true })
  if (portableDir) app.setPath('userData', dataDir)
}

export const dbFile: string = join(dataDir, 'helm.db')

/**
 * Where the user's harness templates live.
 *
 * The same `PORTABLE_EXECUTABLE_DIR` branch `dataDir` takes, and that is the
 * whole of the mechanism - one rule covering all four run modes rather than a
 * second override invented for this one:
 *
 *   installed, dev:live   `~/.config/helm/templates`
 *   portable              `helm-data/templates` beside the exe
 *   pnpm dev              its own, under `%LOCALAPPDATA%\Helm\dev`
 *   every check           its own, under `%LOCALAPPDATA%\Helm\checks\<name>`
 *
 * The last two come for free: both go through `scripts/isolate.mjs`, which sets
 * the variable. `pnpm dev` needs its own rather than sharing because in-app
 * authoring makes the dev app a *writer* of templates - harmless while it can
 * only read, and somebody's templates directory the moment it cannot.
 * `scripts/run-dev.mjs` seeds it by copying the real one, the way the database
 * is seeded from a `VACUUM INTO` copy.
 *
 * Not under `%APPDATA%\Helm` for the installed case, and that is deliberate:
 * these are files a person writes and edits by hand, likely keeps in git, and
 * has to be able to find. `~/.config/helm` is where somebody looks for that;
 * `%APPDATA%` is where an application keeps things about itself.
 */
export const templatesDir: string = portableDir
  ? join(dataDir, 'templates')
  : join(homedir(), '.config', 'helm', 'templates')

/**
 * Where synthesised overlay plugins go.
 *
 * SPEC 2 sketched these under `%TEMP%`, and they are not there. A shim's
 * subdirectories are junctions into the user's real repositories, and every
 * temp-cleaning tool on Windows - Disk Cleanup, Storage Sense, the third-party
 * ones - walks `%TEMP%` and deletes what it finds. One that follows a reparse
 * point instead of unlinking it deletes the repo's `.claude/skills`, which is
 * an unrecoverable outcome for a directory Helm only borrowed.
 *
 * Under the data directory they are ours, they travel with a portable install,
 * and `cleanStaleShims` at startup is the only thing that removes them.
 */
export const shimRoot: string = join(dataDir, 'overlays')

/**
 * Where the per-session `--mcp-config` documents go.
 *
 * Under the data directory for the same reason the shims are, and one reason
 * more: each file carries a **bearer token** for Helm's loopback endpoint, and
 * a token written into `%TEMP%` is a token in a directory every process on the
 * machine enumerates by habit. Here it travels with a portable install, it
 * moves with `PORTABLE_EXECUTABLE_DIR` so a check writes its own, and
 * `cleanStaleMcpConfigs` is the only thing that removes what a crash left.
 *
 * Not `overlays/`, though it could have been: a sweep that has to tell a shim
 * directory from a token file by filename is a sweep with a rule in it, and the
 * rule would be the thing that went wrong.
 */
export const mcpConfigDir: string = join(dataDir, 'mcp')
