import { app } from 'electron'
import { mkdirSync } from 'node:fs'
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
