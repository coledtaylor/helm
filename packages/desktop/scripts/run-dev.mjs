// `pnpm dev`, against a data directory of its own and a `gh` that answers
// offline.
//
// Why this exists at all: `package.json` sets `productName: Helm`, so an
// unpackaged Electron run resolves `app.getPath('userData')` to
// **`%APPDATA%\Helm`** - the very directory the installed app uses. Before this
// script, `pnpm dev` shared `helm.db`, `overlays/` and the Chromium profile with
// whichever Helm the developer had open. The visible half of that was two
// processes fighting over one Chromium profile ("Unable to move the cache:
// Access is denied"). The invisible half was worse: the app sweeps overlay shims
// at start, and starting dev beside a live installed session unlinked that
// session's `--plugin-dir` out from under it - the session kept running and
// silently lost its skills. The sweep is fixed too (`cleanStaleShims` now asks
// who owns a shim), but the sharing was never something to fix by making the
// sharing safe.
//
// Every check already gets a directory of its own through `isolate.mjs`. This is
// the same mechanism, pointed at `%LOCALAPPDATA%\Helm\dev`, with `concurrent`
// on - because unlike a check, this is a window somebody leaves open, and a
// second `pnpm dev` is a second window rather than a mistake.
//
//   pnpm dev            isolated, seeded from a copy of the real database
//   pnpm dev --fresh    isolated, no database at all: the first-run state
//   pnpm dev:live       today's behaviour, against %APPDATA%\Helm
//
// What is deliberately **not** isolated is `~/.claude`. `CLAUDE_CONFIG_DIR`
// moves credentials too, so a dev app pointed at a fixture home cannot sign in
// and cannot host a real session - and a dev mode that cannot launch a session
// is not one anybody would use to look at the app. The residue is real and
// named: dev sessions land in the real `~/.claude/history.jsonl`, and the config
// console still writes the real settings through its snapshot path.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { isolate, realDataDir } from './isolate.mjs'
import { writeDevGh } from './dev-gh.mjs'

const desktopDir = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

const argv = process.argv.slice(2)
const fresh = argv.includes('--fresh')
const driveArg = argv.find((arg) => arg === '--drive' || arg.startsWith('--drive='))
const passthrough = argv.filter((arg) => arg !== '--fresh' && arg !== driveArg)

const { root, dataDir, env } = isolate('dev', { seed: !fresh, concurrent: true, group: null })
const gh = writeDevGh(root)

/**
 * Chromium's remote debugging port, for `scripts/drive-dev.mjs`.
 *
 * **Off unless asked for.** An open debugging port is a door into a process
 * that can reach the real `~/.claude` and spawn real sessions, and this
 * repository's habit with doors is not to build the ones nothing needs - the
 * artifact scheme is `corsEnabled: false` for the same reason. One flag is a
 * small price for the port not existing the rest of the time.
 *
 * `electron-vite` reads it from the environment and passes
 * `--remote-debugging-port` to the app it starts, including across a `--watch`
 * restart.
 */
const drivePort = driveArg === undefined ? null : (driveArg.split('=')[1] ?? '9333')
if (drivePort !== null) env.REMOTE_DEBUGGING_PORT = drivePort

console.log('')
console.log(`Helm dev is isolated: ${dataDir}`)
console.log(`  database   ${fresh ? 'none - this is the first-run state' : 'a copy of the real one, taken just now'}`)
console.log(`  gh         ${gh} (synthetic; no network, and it refuses pr checkout)`)
console.log(`  ~/.claude  the real one, so sessions are real sessions`)
if (drivePort !== null) {
  console.log(`  drive      127.0.0.1:${drivePort} - node scripts/drive-dev.mjs text`)
}
console.log('')

// What the real directory looked like on the way in, so the claim this whole
// script exists to make - that a dev run does not touch it - is checked rather
// than asserted. A listing and one mtime: reading the code cannot tell you
// whether some path still resolves `userData` the old way.
const before = snapshot(realDataDir())

/**
 * `electron-vite dev --watch`, run through Node rather than the `.bin` shim.
 *
 * The shim is a `.CMD` on Windows and spawning one needs `shell: true`, which
 * hands the argument array to a shell as unescaped concatenation - and one of
 * these arguments is a path. `dist-win.mjs` avoids the same trap for pnpm.
 *
 * The bin is reached through the package's own `package.json` rather than
 * `require.resolve('electron-vite/bin/…')`: the package declares `exports` and
 * does not list its bin there, so the subpath resolve fails outright. The
 * `bin` field is the authority for where it is, and `package.json` is exported.
 *
 * `--watch` is what makes the main process and preload reload; without it only
 * the renderer has HMR. `--` forwards the rest to the Electron app itself.
 */
const manifestPath = require.resolve('electron-vite/package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const cli = resolve(manifestPath, '..', manifest.bin['electron-vite'])
const { status } = spawnSync(
  process.execPath,
  [cli, 'dev', '--watch', '--', `--gh=${gh}`, ...passthrough],
  { cwd: desktopDir, stdio: 'inherit', env }
)

report(before, snapshot(realDataDir()))
process.exit(status ?? 1)

/** Entry names and the database's size and mtime, which is what a run moves. */
function snapshot(dir) {
  if (!existsSync(dir)) return { entries: [], db: null }
  const db = join(dir, 'helm.db')
  let stamp = null
  try {
    const stat = statSync(db)
    stamp = `${String(stat.size)}@${String(Math.floor(stat.mtimeMs))}`
  } catch {
    // No database there, which the comparison below reports as such.
  }
  return { entries: readdirSync(dir).sort(), db: stamp }
}

/**
 * Says whether the real directory moved while dev was up.
 *
 * Printed rather than thrown, and this is the honest form: acceptance asks for
 * dev to write nothing there, but the installed Helm is allowed to be running
 * at the same time - that is the other half of what this change is for - and a
 * running Helm writes to its own directory constantly. So the comparison names
 * what changed and leaves the reading to whoever is looking, rather than
 * failing a dev run over somebody else's write.
 */
function report(start, end) {
  const added = end.entries.filter((entry) => !start.entries.includes(entry))
  const removed = start.entries.filter((entry) => !end.entries.includes(entry))
  const dbMoved = start.db !== end.db

  if (added.length === 0 && removed.length === 0 && !dbMoved) {
    // The numbers, not just the verdict: "unchanged" printed with nothing
    // behind it is what a comparison against an empty listing would also say.
    console.log(
      `\n${realDataDir()} is unchanged: ${String(end.entries.length)} entries, ` +
        `helm.db ${end.db ?? 'absent'} (size@mtime).`
    )
    return
  }

  console.log(`\n${realDataDir()} CHANGED while dev was up:`)
  if (added.length > 0) console.log(`  added    ${added.join(', ')}`)
  if (removed.length > 0) console.log(`  removed  ${removed.join(', ')}`)
  if (dbMoved) console.log(`  helm.db  ${String(start.db)} -> ${String(end.db)}`)
  console.log('  If the installed Helm was open, this is its own writing. If it was')
  console.log('  not, something in the dev run is still resolving the real userData.')
}
