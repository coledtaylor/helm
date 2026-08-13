// A data directory of the check's own, so a run cannot disturb the Helm the
// user is sitting in front of.
//
// The drivers used to point the app they launch at `%APPDATA%\Helm` - the real
// one - and settings-check went further and said so on purpose: it parked
// settings on fixture values and put them back at the end. That is defensible
// for a claim about persistence and indefensible in practice, because Helm is a
// desktop app somebody is using while its checks run. Observed: a check run
// flipped the live app's theme, font and default shell underneath it, and the
// only reason the settings came back at all is that the run got as far as its
// restore. A run that dies leaves them parked.
//
// So the app under test gets its own directory, and it is told about it with
// **PORTABLE_EXECUTABLE_DIR** - the app's own portable-mode mechanism, the same
// one `run-packaging.mjs` already uses as isolation, rather than a hook that exists
// only for checks. `paths.ts` reads it, puts `helm-data` under it and calls
// `app.setPath('userData')`, so the database, the overlay shims, the reports and
// Chromium's own profile all move together.
//
// Deliberately **not** under `%TEMP%`. The isolated directory holds
// `overlays/`, whose subdirectories are junctions into the user's real
// repositories, and CLAUDE.md's rule about that is not relaxed by the directory
// being a check's: a temp cleaner that follows a reparse point rather than
// unlinking it deletes the repo's `.claude/skills`.
//
// The database is seeded with a **copy of the real one** rather than starting
// empty. The checks assert against the machine's actual projects, roots and
// history, and that is what makes them worth running; a blank database would
// turn most of them into assertions about fixtures. `VACUUM INTO` is what takes
// the copy - one consistent snapshot through a read-only connection, which is
// the only safe way to read a SQLite file another process has open in WAL mode.
// Copying the three files by hand can catch a write in flight.
//
// What the copy does **not** carry is where the developer left the app - see
// `UI_STATE_KEYS`. That distinction cost three probes before anyone drew it.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** The Electron binary, resolved the way the drivers already resolve it. */
const electronBinary = createRequire(import.meta.url)('electron')

/** The real Helm's data directory - read from, never written to. */
export function realDataDir() {
  return join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Helm')
}

/**
 * The `app_settings` rows that say **where the developer left the app**, as
 * opposed to what is true of the machine. Stripped from a check's copy.
 *
 * The seed exists so a check sees the machine's real projects, roots and
 * history. These two are not that. They are one person's last session, and a
 * driver that starts the app is the thing that decides what is open and how big
 * the window is - inheriting either means the check measures a different app on
 * every machine, and on the same machine on different days.
 *
 * It is not hypothetical, and the shape of the damage is worth keeping:
 *
 * - **`workspaceTabs`** carried eight panes into every check on the machine
 *   this was found on, six of them project shells that each spawn a terminal.
 *   `S-1` cycles Ctrl+Tab expecting to land back where it started and found a
 *   ten-tab ring; `S-10` asserted "every terminal is attached" while counting
 *   terminals it never started. Both are right about the app and were failing
 *   about the strip.
 * - **`windowBounds`** is the same bug one layer out and had not been noticed
 *   at all. `designshot.ts` says "1280 is the default" and computes what a pane
 *   is worth at that width; the window it was actually photographing was 1757
 *   wide, because that is where the developer left it.
 *
 * Both now start from the app's own defaults - an empty strip, 1280x820 - on
 * every machine, which is what those comments already claimed.
 *
 * **`firstRunCompletedAt` is deliberately not here.** It is the same *kind* of
 * row, and clearing it would put every check into the first-run setup pane
 * instead of the app. "Internal state" is not the rule; "where the developer
 * left the app" is, and completing first-run is not somewhere anybody left it.
 */
export const UI_STATE_KEYS = ['workspaceTabs', 'windowBounds']

/**
 * Where `name`'s run keeps its data.
 *
 * One directory per check rather than per run, so a failed run's database and
 * screenshots are still there to look at afterwards.
 *
 * `group` separates the two things that use this. Checks share `checks/`; `null`
 * puts the directory straight under `%LOCALAPPDATA%\Helm`, which is where
 * `pnpm dev` goes - beside the checks rather than among them, so that "delete
 * every check's leftovers" stays something somebody can do without throwing
 * away the projects and settings their dev app has accumulated.
 */
export function isolatedRoot(name, group = 'checks') {
  const base = process.env.LOCALAPPDATA ?? process.env.HOME ?? '.'
  return group === null ? join(base, 'Helm', name) : join(base, 'Helm', group, name)
}

/**
 * Prepare `name`'s directory and return what a driver needs to launch into it.
 *
 * `seed: false` for a check that wants an empty database - a first run has to
 * start without one.
 *
 * `concurrent: true` when the thing being launched is an app somebody keeps
 * open rather than a check that runs and exits. A second one then gets
 * `<name>-2` rather than failing, because the first still holds `helm.db` and
 * Windows will not let the seed replace an open file. Checks leave this off on
 * purpose: two of them in one directory would interleave their fixtures and
 * their reports, and the honest answer to that is to stop, not to shard.
 *
 * `group` is the subdirectory of `%LOCALAPPDATA%\Helm` this lands under; see
 * `isolatedRoot`.
 *
 * `keepUiState` carries `UI_STATE_KEYS` through into the copy. It defaults off
 * for a check and on for `pnpm dev`, and `group` is what tells them apart
 * because that is already the difference: `group === null` is an app somebody
 * sits in front of, where restoring the tabs and the window is the feature.
 * A check is a driver, and a driver decides for itself what is open.
 */
export function isolate(
  name,
  { seed = true, concurrent = false, group = 'checks', keepUiState = group === null } = {}
) {
  const limit = concurrent ? 8 : 1
  for (let attempt = 0; attempt < limit; attempt++) {
    const dirName = attempt === 0 ? name : `${name}-${String(attempt + 1)}`
    const root = isolatedRoot(dirName, group)
    const dataDir = join(root, 'helm-data')
    mkdirSync(dataDir, { recursive: true })
    const env = { ...process.env, PORTABLE_EXECUTABLE_DIR: root }

    // `seed: false` still *clears*. "Start without a database" has to mean the
    // same thing on the second run as on the first, and a directory that has
    // been used before already has one - so leaving it alone would quietly turn
    // the first-run mode into the ordinary one after a single use.
    const prepared = seed ? seedDatabase(dataDir, { keepUiState }) : clearDatabase(dataDir)
    if (prepared !== 'busy') return { root, dataDir, env }
    if (attempt + 1 < limit) console.log(`(${dirName} is in use; trying the next one)`)
  }

  console.error(
    `${name} is already running against ${isolatedRoot(name, group)}.\n` +
      'Its database is open, so a fresh copy cannot be put in place. Close it and run this again.'
  )
  process.exit(1)
}

/**
 * Removes the isolated database, and the `-wal`/`-shm` beside it.
 *
 * Both of those, always: SQLite reads a stale write-ahead log back over a file
 * that has been replaced, so deleting only `helm.db` produces a database that
 * is neither the old one nor the new one.
 *
 * Returns `'busy'` when an app still has it open. Windows holds a mandatory
 * lock on an open file, so the delete fails with EPERM rather than succeeding
 * the way it would on Unix - which is the right answer and not an obstacle:
 * quietly leaving the old database in place would run the next thing against a
 * copy of unknown age while reporting a fresh one.
 */
export function clearDatabase(dataDir) {
  const dest = join(dataDir, 'helm.db')
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${dest}${suffix}`, { force: true })
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EBUSY') return 'busy'
      throw err
    }
  }
  return true
}

/**
 * Replace the isolated database with a fresh consistent copy of the real one.
 *
 * Fresh every run, not once: the point of copying at all is that the checks see
 * the machine as it is, and a copy taken a week ago is neither that nor a
 * fixture.
 *
 * Returns `'busy'` when an app still has the previous copy open - see
 * `clearDatabase`, which is what makes room for this one - and `false` when the
 * machine has no real database to copy, which is not a failure: the isolated
 * one then starts empty.
 */
export function seedDatabase(dataDir, { keepUiState = false } = {}) {
  const source = join(realDataDir(), 'helm.db')
  const dest = join(dataDir, 'helm.db')
  if (!existsSync(source)) {
    console.log(`(no database at ${source}; the isolated one starts empty)`)
    return clearDatabase(dataDir) === 'busy' ? 'busy' : false
  }
  if (clearDatabase(dataDir) === 'busy') return 'busy'

  // `VACUUM INTO` through Electron's own node, because better-sqlite3 is built
  // for Electron's ABI and will not load under a plain one. The destination is
  // bound as a parameter rather than pasted into the SQL: a path is not a
  // string literal, and this one contains backslashes.
  //
  // Then, unless the caller wants them, the rows naming where the developer
  // left the app go - see `UI_STATE_KEYS`. On the copy, never the source, which
  // this connection could not write to anyway.
  //
  // The delete is followed by a **read back**, and a surviving row stops the
  // run. Deleting nothing is the ordinary case on a machine where the app has
  // never been opened, so a zero count proves nothing either way; what has to
  // be true afterwards is that the rows are not there. A renamed key or a table
  // that moved would otherwise put the old behaviour back silently, and a check
  // quietly reverting to inheriting somebody's tabs is precisely the failure
  // this is here to end.
  const script = [
    "const Database = require('better-sqlite3')",
    "const db = new Database(process.argv[1], { readonly: true, fileMustExist: true })",
    "db.prepare('VACUUM INTO ?').run(process.argv[2])",
    'db.close()',
    'const strip = JSON.parse(process.argv[3])',
    'if (strip.length > 0) {',
    '  const copy = new Database(process.argv[2], { fileMustExist: true })',
    "  const holes = strip.map(() => '?').join(',')",
    '  copy.prepare(`DELETE FROM app_settings WHERE key IN (${holes})`).run(...strip)',
    '  const left = copy',
    '    .prepare(`SELECT key FROM app_settings WHERE key IN (${holes})`)',
    '    .all(...strip)',
    '    .map((row) => row.key)',
    '  copy.close()',
    '  if (left.length > 0) throw new Error(`still in the copy after the strip: ${left.join(", ")}`)',
    '}'
  ].join('\n')
  const { status, stderr } = spawnSync(
    electronBinary,
    ['-e', script, source, dest, JSON.stringify(keepUiState ? [] : UI_STATE_KEYS)],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8'
    }
  )
  if (status !== 0) {
    console.error(`could not copy ${source} into ${dest}:\n${stderr ?? ''}`)
    console.error('an isolated run would otherwise start against an empty database - stopping')
    process.exit(1)
  }
  return true
}
