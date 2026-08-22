// The packaging criteria, in three phases, because they are claims about
// three different things.
//
// Phase 1 is about this machine: the grep audit over the checkout, and whether
// the CLI Helm would launch is the one that is actually installed here.
//
// Phase 2 is about a machine that does not exist yet. "A fresh ~/.claude and no
// harness at all" is not a state the developer's own profile can enter, and
// faking it by deleting things would be the worst possible way to find out. So
// this starts a *second* app with PORTABLE_EXECUTABLE_DIR pointed at a
// temporary directory - the app's own portable-mode mechanism, not a test hook,
// which redirects userData beside it. The child opens an empty database in that
// directory and is pointed away from the real ~/.claude with --claude-home=.
// Nothing of the user's is backed up because nothing of the user's is opened.
//
// Phase 3 is about the artefacts. It builds them if they are not there, copies
// the portable exe to a path with spaces, and runs --selftest out of it.
//
// It does **not** install anything. Verifying the NSIS package means installing
// it over the Helm on this machine and uninstalling it again, which ends the
// Claude Code sessions Helm is hosting - so that is `scripts/verify-installer.mjs`,
// a tool run by name with --yes, and not a group this suite can reach. PKG-2
// stands open in the report rather than passing, so "packaging-check green"
// cannot come to mean "the installer works".
//
// The report is the verdict, not the exit status - node-pty's teardown can lose
// the exit code after the checks have already passed.

import { spawnSync } from 'node:child_process'
// Only the *asking* half. `endInstalledApp` lives in the same module and is
// deliberately not imported here: nothing in this suite may end the app.
import { countInstalledProcesses, installedAppDir } from './installed-app.mjs'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const appData = process.env.APPDATA ?? process.env.HOME ?? '.'
const realDataDir = join(appData, 'Helm')
const machineReport = join(realDataDir, 'packaging-report.json')
const desktopDir = resolve(import.meta.dirname, '..')
const distDir = join(desktopDir, 'dist-app')
const { default: electron } = await import('electron')

const args = process.argv.slice(2)
const onlyArg = args.find((a) => a.startsWith('--only='))
const groups = onlyArg ? onlyArg.slice('--only='.length).split(',') : null

/**
 * Every group here is safe to run on the machine you work on.
 *
 * That is a property of this file now, not a list to keep. The one destructive
 * thing this repository has - installing the NSIS package over the Helm on this
 * machine and uninstalling it again - **is not a group of this suite and cannot
 * be reached from it**. It lives in `scripts/verify-installer.mjs` and is run by
 * name, deliberately, with `--yes`.
 *
 * It used to be a group here, kept out of the default run by an opt-in list.
 * That was better than nothing and it was still the wrong shape: a list is a
 * thing somebody can add to, `--only=installer` was a spelling away from a
 * sweep, and the guard meant to catch the accident had itself never been run.
 * It cost a session and an app that had to be reinstalled by hand.
 *
 * So the rule is structural rather than careful: a step that stops, removes or
 * replaces the installed app is a tool somebody asks for, never a group a suite
 * reaches on its own. `packaging-check` covers everything a release needs and
 * **records that the installer was not verified here** rather than letting
 * "packaging-check green" quietly stop including it.
 */
const wants = (name) => (groups === null ? true : groups.includes(name))

const version = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')).version
const checks = []

const say = (line) => console.log(line)

const repoRoot = resolve(desktopDir, '..', '..')

/**
 * Everything the packaged artefacts are built out of.
 *
 * The three source trees, the manifest that carries the version and the
 * dependency list, the electron-builder configuration, the script that drives
 * it, and the lockfile. Written out rather than derived from `git ls-files` so
 * that an uncommitted edit counts too - the question is what is on disk, not
 * what has been committed.
 */
const PACKAGE_INPUTS = [
  join(repoRoot, 'packages', 'core', 'src'),
  join(repoRoot, 'packages', 'ui', 'src'),
  join(desktopDir, 'src'),
  join(desktopDir, 'package.json'),
  join(desktopDir, 'electron-builder.yml'),
  join(desktopDir, 'scripts', 'dist-win.mjs'),
  join(repoRoot, 'pnpm-lock.yaml')
]

/**
 * The newest **file** mtime under a path, and the file carrying it.
 *
 * Directories are walked but never timed, and that is the whole of the care
 * needed here. A directory's mtime moves whenever an entry is added or removed
 * inside it, which has nothing to do with whether its contents went into the
 * package - and `electron-vite build`, which runs at the head of every
 * `packaging-check`, moves several of them. Timing directories made the rule
 * self-fulfilling: build, watch the build touch a source directory, decide the
 * source is newer than the artefact just written, rebuild. Measured with the
 * first cut of this: `packages/core/src` stamped 15:17:34 against a setup.exe
 * written at 15:17:00, while the newest file under it was from 14:41.
 */
function newestUnder(path) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return null
  }
  if (!stat.isDirectory()) return { path, mtimeMs: stat.mtimeMs }

  let best = null
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const found = newestUnder(join(path, entry.name))
    if (found && (best === null || found.mtimeMs > best.mtimeMs)) best = found
  }
  return best
}

/**
 * The source file newer than the oldest artefact, or null if none is.
 *
 * Compared against the *oldest* of them, because both have to be current: a
 * portable exe rebuilt on its own would otherwise vouch for a stale installer.
 */
function newerThanArtefacts(artefacts) {
  const times = artefacts.map((file) => (existsSync(file) ? statSync(file).mtimeMs : 0))
  const oldest = Math.min(...times)
  if (oldest === 0) return null // missing; the caller builds anyway

  let newest = null
  for (const input of PACKAGE_INPUTS) {
    const found = newestUnder(input)
    if (found && found.mtimeMs > oldest && (newest === null || found.mtimeMs > newest.mtimeMs)) {
      newest = found
    }
  }
  return newest === null ? null : newest.path.slice(repoRoot.length + 1)
}

// ---------------------------------------------------------------------------
// Phase 1: this machine
// ---------------------------------------------------------------------------

if (wants('audit') || wants('cli')) {
  say('--- phase 1: the checkout, and the CLI this machine has ---')
  rmSync(machineReport, { force: true })
  const passThrough = groups ? [`--only=${groups.join(',')}`] : []
  const { status } = spawnSync(electron, ['.', '--packaging-check', ...passThrough], { stdio: 'inherit' })
  if (status !== 0) say(`(phase 1 exited with ${String(status)}; the report decides, not this)`)

  if (!existsSync(machineReport)) {
    console.error(`FAIL  phase 1 wrote no report to ${machineReport}`)
    process.exit(1)
  }
  checks.push(...(JSON.parse(readFileSync(machineReport, 'utf8')).checks ?? []))
}

// ---------------------------------------------------------------------------
// Phase 2: a machine with nothing on it
// ---------------------------------------------------------------------------

const FIRSTRUN_GROUPS = ['firstrun', 'harness', 'scan', 'version']

if (FIRSTRUN_GROUPS.some(wants)) {
  say('\n--- phase 2: a fresh profile, a fresh .claude, and no harness ---')
  // `--sandbox=` puts the throwaway profile somewhere chosen rather than in the
  // temp directory. The one reason to use it is screenshots: everything this
  // phase paints shows the paths it was given, and a temp path carries the
  // account name into every image. The README's screenshots were taken with the
  // sandbox under a directory that has nobody's name in it.
  const sandboxArg = args.find((a) => a.startsWith('--sandbox='))
  const sandbox = sandboxArg
    ? (mkdirSync(sandboxArg.slice('--sandbox='.length), { recursive: true }),
      sandboxArg.slice('--sandbox='.length))
    : mkdtempSync(join(tmpdir(), 'helm-packaging-'))
  // A path with a space in it, deliberately: CLAUDE.md requires those to work
  // and this is the one place a fresh install's own data directory is created.
  const portableDir = join(sandbox, 'Portable Install')
  const fixtures = join(sandbox, 'fixtures')
  const claudeHome = join(sandbox, 'fresh home', '.claude')
  mkdirSync(portableDir, { recursive: true })
  mkdirSync(fixtures, { recursive: true })

  const appDataBefore = existsSync(realDataDir) ? readdirSync(realDataDir).sort() : []
  const dbBefore = existsSync(join(realDataDir, 'helm.db'))
    ? statSync(join(realDataDir, 'helm.db')).mtimeMs
    : null

  const passThrough = groups ? [`--only=${groups.join(',')}`] : []
  const { status } = spawnSync(
    electron,
    [
      '.',
      '--packaging-firstrun',
      `--fixtures=${fixtures}`,
      `--claude-home=${claudeHome}`,
      ...passThrough
    ],
    { stdio: 'inherit', env: { ...process.env, PORTABLE_EXECUTABLE_DIR: portableDir } }
  )
  if (status !== 0) say(`(phase 2 exited with ${String(status)}; the report decides, not this)`)

  const firstRunReport = join(portableDir, 'helm-data', 'packaging-firstrun-report.json')
  if (!existsSync(firstRunReport)) {
    console.error(`FAIL  phase 2 wrote no report to ${firstRunReport}`)
    process.exit(1)
  }
  checks.push(...(JSON.parse(readFileSync(firstRunReport, 'utf8')).checks ?? []))

  // The isolation, checked from outside the process that claimed it.
  const appDataAfter = existsSync(realDataDir) ? readdirSync(realDataDir).sort() : []
  const dbAfter = existsSync(join(realDataDir, 'helm.db'))
    ? statSync(join(realDataDir, 'helm.db')).mtimeMs
    : null
  const added = appDataAfter.filter((f) => !appDataBefore.includes(f))
  checks.push({
    id: 'PKG-F1',
    criterion: 'setup: the first-run phase left the real profile alone',
    title: 'A whole first run happened and %APPDATA%\\Helm did not change',
    ok: added.length === 0 && dbBefore === dbAfter && existsSync(join(portableDir, 'helm-data')),
    detail: {
      realDataDir,
      entriesBefore: appDataBefore.length,
      entriesAfter: appDataAfter.length,
      entriesAdded: added,
      databaseMtimeBefore: dbBefore,
      databaseMtimeAfter: dbAfter,
      sandboxDataDir: join(portableDir, 'helm-data'),
      sandboxFiles: existsSync(join(portableDir, 'helm-data'))
        ? readdirSync(join(portableDir, 'helm-data')).sort()
        : []
    },
    notes: [
      'Asserted by this process rather than by the one under test: a program cannot be its own witness that it did not write somewhere.',
      "The child's whole database, screenshots and report are beside the temporary portable directory, which is what portable mode is for."
    ]
  })

  say(`(sandbox kept for inspection: ${sandbox})`)
}

// ---------------------------------------------------------------------------
// Phase 3: the artefacts
// ---------------------------------------------------------------------------

if (wants('package')) {
  say('\n--- phase 3: the portable exe ---')
  const portableExe = join(distDir, `Helm-${version}-portable.exe`)
  const setupExe = join(distDir, `Helm-${version}-setup.exe`)

  /**
   * Build if the artefacts are missing **or older than the source**.
   *
   * Existence alone was the test, and it is not one. The artefact is named for
   * the version - `Helm-0.2.3-setup.exe` - and the version does not move
   * between commits, so once a package exists any number of commits can land
   * behind it while this phase goes on installing the old one and reporting
   * green. Measured: a run of this phase installed a package built 22 minutes
   * before the commit that fixed this very script, and PKG-2 passed. This is
   * the only check that proves the installer works, and it was proving it
   * about a build nobody had asked about.
   *
   * The dependency is a `make` rule and nothing cleverer: newer source than
   * artefact means rebuild. `out/` is deliberately not in the set - the
   * `electron-vite build` at the head of every run rewrites it, so comparing
   * against it would mean rebuilding the installer every time.
   */
  const stale = newerThanArtefacts([portableExe, setupExe])
  if (!existsSync(portableExe) || !existsSync(setupExe) || stale !== null) {
    if (stale !== null) say(`${stale} is newer than the packaged artefacts; rebuilding.`)
    say('building (electron-builder --win); this takes a few minutes...')
    const built = spawnSync('pnpm', ['run', 'dist:win'], {
      cwd: desktopDir,
      stdio: 'inherit',
      shell: true
    })
    if (built.status !== 0) {
      console.error('FAIL  the build did not produce artefacts')
      process.exit(1)
    }
  }

  checks.push(unpackedNativeModulesCheck())
  checks.push(...portableChecks(portableExe))
  checks.push(installerNotVerifiedHere(setupExe))
}

// ---------------------------------------------------------------------------

const failed = checks.filter((c) => !c.ok)

// Every phase's checks in one file. Phases one and two write their own, but
// phase three has no app behind it to write anything, and a packaging failure
// with nothing to read afterwards is a packaging failure nobody can diagnose.
const combined = join(realDataDir, 'packaging-packaging.json')
mkdirSync(realDataDir, { recursive: true })
writeFileSync(
  combined,
  JSON.stringify(
    { startedAt: new Date().toISOString(), groups: groups ?? 'all', pass: failed.length === 0, checks },
    null,
    2
  )
)

console.log('')
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)
console.log(`\nreport: ${combined}`)

if (checks.length === 0 || failed.length > 0) {
  console.error(`\nFAIL  ${String(failed.length)} of ${String(checks.length)} checks`)
  process.exit(1)
}
console.log(`\nPASS  all ${String(checks.length)} checks`)

// ---------------------------------------------------------------------------

/**
 * PKG-P0: the two native modules are unpacked beside the asar.
 *
 * Checked before either exe is run, because the failure it catches is silent at
 * build time and loud only much later. `process.dlopen` cannot load a `.node`
 * from inside an asar archive and node-pty's ConPTY helpers have to exist as
 * real files to be spawned, so `asarUnpack` is load-bearing (Spike B). When
 * electron-builder cannot get a dependency graph out of the package manager it
 * does not fail - it warns "cannot find path for dependency ...@undefined" and
 * ships a 95 MB exe with no `app.asar.unpacked` at all. That happened on this
 * machine and is what `scripts/dist-win.mjs` now prevents.
 */
function unpackedNativeModulesCheck() {
  const unpacked = join(distDir, 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules')
  const wanted = {
    'better-sqlite3': join(unpacked, 'better-sqlite3', 'prebuilds'),
    'node-pty': join(unpacked, 'node-pty', 'prebuilds')
  }
  const found = Object.fromEntries(
    Object.entries(wanted).map(([name, path]) => [
      name,
      existsSync(path) ? readdirSync(path).sort() : null
    ])
  )
  const helpers = [
    join(unpacked, 'node-pty', 'prebuilds', 'win32-x64', 'winpty-agent.exe'),
    join(unpacked, 'node-pty', 'prebuilds', 'win32-x64', 'conpty', 'OpenConsole.exe')
  ]
  return {
    id: 'PKG-P0',
    criterion: 'packaging: the native modules are unpacked beside the asar, not inside it',
    title: 'better-sqlite3 and node-pty prebuilds are real files in app.asar.unpacked',
    ok:
      found['better-sqlite3'] !== null &&
      found['node-pty'] !== null &&
      helpers.every((path) => existsSync(path)),
    detail: {
      unpackedDir: unpacked,
      prebuilds: found,
      helperBinaries: helpers.map((path) => ({ path, exists: existsSync(path) }))
    },
    notes: [
      'A build that loses these produces an exe that starts and then dies on its first dlopen, so it is checked before anything is run rather than diagnosed afterwards.',
      "electron-builder reports the cause as a warning, not an error - `cannot find path for dependency ...@undefined` - which is why this is an assertion and not a reading of the build log."
    ]
  }
}

/** PKG-1: the portable exe, run from a directory it has never seen. */
function portableChecks(exe) {
  if (!existsSync(exe)) {
    return [
      {
        id: 'PKG-1',
        criterion: 'Portable exe runs on a Windows machine with no admin rights, from any path',
        title: 'No portable exe was built',
        ok: false,
        detail: { expected: exe },
        notes: []
      }
    ]
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'helm-portable-'))
  // A path with spaces, no install, nowhere near the build directory.
  const runDir = join(sandbox, 'Helm Test With Spaces')
  mkdirSync(runDir, { recursive: true })
  const copied = join(runDir, 'Helm.exe')
  cpSync(exe, copied)

  /*
   * Whether `%APPDATA%\Helm` can be read as evidence at all.
   *
   * "The portable exe wrote nothing beside the installed app" is measured by
   * listing that directory either side of the run - which is only a statement
   * about the portable exe while nothing *else* is writing there. The installed
   * Helm writes there whenever it is open, so with one running this read is
   * about two processes and attributable to neither.
   *
   * It is asked rather than assumed because this phase is now in the default
   * run, and the default run happens on the machine somebody works on. A silent
   * pass would be luck and a silent failure would be a bug hunt; the answer is
   * to record which of the two claims this run is making.
   */
  const installedRunning = countInstalledProcesses(installedAppDir())
  const appDataBefore = existsSync(realDataDir) ? readdirSync(realDataDir).sort() : []
  say(`running the portable exe from ${runDir}`)
  const run = spawnSync(copied, ['--selftest'], { stdio: 'inherit', timeout: 300_000 })

  const dataDir = join(runDir, 'helm-data')
  const reportFile = join(dataDir, 'spike-report.json')
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null
  const appDataAfter = existsSync(realDataDir) ? readdirSync(realDataDir).sort() : []
  const leaked = appDataAfter.filter((f) => !appDataBefore.includes(f))

  return [
    {
      id: 'PKG-1',
      criterion: 'Portable exe runs on a Windows machine with no admin rights, from any path',
      title: `Ran from a path with spaces and kept its data beside itself`,
      ok:
        report !== null &&
        report.pass === true &&
        report.mode === 'portable' &&
        existsSync(join(dataDir, 'helm.db')) &&
        (installedRunning > 0 || leaked.length === 0),
      detail: {
        exe: copied,
        runDir,
        exitStatus: run.status,
        mode: report?.mode ?? null,
        selftestPass: report?.pass ?? null,
        selftest: report
          ? { sqlite: report.sqlite, pty: report.pty, resize: report.resize, claude: report.claude }
          : null,
        dataDir,
        dataFiles: existsSync(dataDir) ? readdirSync(dataDir).sort() : [],
        appDataEntriesAdded: leaked,
        appDataReadIsEvidence: installedRunning === 0,
        installedHelmProcessesRunning: installedRunning,
        elevated: false
      },
      notes: [
        'Run as the ordinary user this script is running as - no elevation is requested anywhere, and the exe writes only inside its own directory.',
        'The selftest is Spike B\'s: a SQLite WAL roundtrip, an interactive pwsh through ConPTY, renderer-synthesized keystrokes, a resize verified inside the shell, and the real claude TUI reaching its version banner.',
        '"Beside the exe" is checked twice: helm.db exists in the run directory, and %APPDATA%\\Helm gained no files while it ran.',
        'The second of those is dropped when an installed Helm is running, because that app writes to %APPDATA%\\Helm itself and the read would then be about two processes. appDataReadIsEvidence says which run this was; the first half - helm.db beside the exe - holds either way.'
      ]
    }
  ]
}

/**
 * PKG-2, recorded as **not run**, which is the whole reason it exists.
 *
 * A group that quietly disappears from the default run is how a suite stops
 * measuring something without anybody noticing - and the claim "packaging-check
 * is green" is exactly the kind of claim that outlives the run behind it. So
 * the default run still emits a PKG-2 line: it is in the console output, it is
 * in the report, and it says in its own title that nothing was installed.
 *
 * `ok: true`, deliberately, and it is the one entry here that is not a
 * measurement. A red line would make the safe run fail, which would push people
 * straight back to the destructive one; a missing line would let the release
 * gate silently shed a criterion. A green line that says "not run" is the only
 * one of the three that is both honest and usable.
 */
/**
 * PKG-2, standing open.
 *
 * Not a pass and not a failure - a record that this suite does not answer the
 * question, so "packaging-check green" cannot quietly come to mean "the
 * installer works". The suite has no way to answer it: installing the package
 * means removing the Helm somebody is using, which is why that lives in a tool
 * and not here.
 */
function installerNotVerifiedHere(setupExe) {
  return {
    id: 'PKG-2',
    criterion:
      'NSIS installer installs per-user without elevation, the installed app launches and passes the same smoke checks, app data lands in %APPDATA%, and uninstall removes it cleanly',
    title: 'Not verified here - the installer is a tool, not a check, and nothing was installed',
    ok: true,
    detail: {
      ranNothing: true,
      wouldHaveUsed: setupExe,
      builtAndReadable: existsSync(setupExe),
      howToRun: 'pnpm verify:installer --yes',
      whyItIsNotHere:
        'It installs over the Helm on this machine and uninstalls it, putting nothing back. Helm hosts Claude Code sessions, so that ends whatever is running in them. A step like that is a tool somebody asks for, never a group a suite can reach.'
    },
    notes: [
      'This is a placeholder, not a pass. The installer was neither run nor verified.',
      'Run `pnpm verify:installer --yes` on a machine where nobody is working - a spare',
      'machine, or before a release that changes packaging. It leaves no Helm installed.',
      'A release that does not touch electron-builder, the NSIS configuration, the native',
      'modules or `dist-win.mjs` is not a release that tool would have new information',
      'about; CI already runs `verify-artifact.mjs` over both exes on every publish.'
    ]
  }
}
