// M7's acceptance criteria, in three phases, because they are claims about
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
// the portable exe to a path with spaces, installs the NSIS package silently,
// runs --selftest out of each, and uninstalls. This is the gap Spike B left:
// it built the installer and never ran it.
//
// The report is the verdict, not the exit status - node-pty's teardown can lose
// the exit code after the checks have already passed.

import { execFileSync, spawnSync } from 'node:child_process'
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
const machineReport = join(realDataDir, 'm7-report.json')
const desktopDir = resolve(import.meta.dirname, '..')
const distDir = join(desktopDir, 'dist-app')
const { default: electron } = await import('electron')

const args = process.argv.slice(2)
const onlyArg = args.find((a) => a.startsWith('--only='))
const groups = onlyArg ? onlyArg.slice('--only='.length).split(',') : null
const wants = (name) => groups === null || groups.includes(name)

const version = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')).version
const checks = []

const say = (line) => console.log(line)

// ---------------------------------------------------------------------------
// Phase 1: this machine
// ---------------------------------------------------------------------------

if (wants('audit') || wants('cli')) {
  say('--- phase 1: the checkout, and the CLI this machine has ---')
  rmSync(machineReport, { force: true })
  const passThrough = groups ? [`--only=${groups.join(',')}`] : []
  const { status } = spawnSync(electron, ['.', '--m7-check', ...passThrough], { stdio: 'inherit' })
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
    : mkdtempSync(join(tmpdir(), 'helm-m7-'))
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
      '--m7-firstrun',
      `--fixtures=${fixtures}`,
      `--claude-home=${claudeHome}`,
      ...passThrough
    ],
    { stdio: 'inherit', env: { ...process.env, PORTABLE_EXECUTABLE_DIR: portableDir } }
  )
  if (status !== 0) say(`(phase 2 exited with ${String(status)}; the report decides, not this)`)

  const firstRunReport = join(portableDir, 'helm-data', 'm7-firstrun-report.json')
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
    id: 'M7-F1',
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
  say('\n--- phase 3: the portable exe and the NSIS installer ---')
  const portableExe = join(distDir, `Helm-${version}-portable.exe`)
  const setupExe = join(distDir, `Helm-${version}-setup.exe`)

  if (!existsSync(portableExe) || !existsSync(setupExe)) {
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
  checks.push(...installerChecks(setupExe))
}

// ---------------------------------------------------------------------------

const failed = checks.filter((c) => !c.ok)

// Every phase's checks in one file. Phases one and two write their own, but
// phase three has no app behind it to write anything, and a packaging failure
// with nothing to read afterwards is a packaging failure nobody can diagnose.
const combined = join(realDataDir, 'm7-packaging.json')
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
 * M7-P0: the two native modules are unpacked beside the asar.
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
    id: 'M7-P0',
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

/** M7-1: the portable exe, run from a directory it has never seen. */
function portableChecks(exe) {
  if (!existsSync(exe)) {
    return [
      {
        id: 'M7-1',
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
      id: 'M7-1',
      criterion: 'Portable exe runs on a Windows machine with no admin rights, from any path',
      title: `Ran from a path with spaces and kept its data beside itself`,
      ok:
        report !== null &&
        report.pass === true &&
        report.mode === 'portable' &&
        existsSync(join(dataDir, 'helm.db')) &&
        leaked.length === 0,
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
        elevated: false
      },
      notes: [
        'Run as the ordinary user this script is running as - no elevation is requested anywhere, and the exe writes only inside its own directory.',
        'The selftest is Spike B\'s: a SQLite WAL roundtrip, an interactive pwsh through ConPTY, renderer-synthesized keystrokes, a resize verified inside the shell, and the real claude TUI reaching its version banner.',
        '"Beside the exe" is checked twice: helm.db exists in the run directory, and %APPDATA%\\Helm gained no files while it ran.'
      ]
    }
  ]
}

/** M7-2: the NSIS installer, installed, launched, and uninstalled. */
function installerChecks(setupExe) {
  if (!existsSync(setupExe)) {
    return [
      {
        id: 'M7-2',
        criterion:
          'NSIS installer installs per-user without elevation, the installed app launches and passes the same smoke checks, app data lands in %APPDATA%, and uninstall removes it cleanly',
        title: 'No installer was built',
        ok: false,
        detail: { expected: setupExe },
        notes: []
      }
    ]
  }

  // electron-builder's one-click, per-user NSIS target installs here and asks
  // for no elevation. If it had asked, a silent run would fail outright rather
  // than silently succeeding.
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const installDir = join(localAppData, 'Programs', 'Helm')
  const installedExe = join(installDir, 'Helm.exe')
  const uninstaller = join(installDir, 'Uninstall Helm.exe')
  const startMenu = join(
    process.env.APPDATA ?? '',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Helm.lnk'
  )
  // Deliberately not created (`createDesktopShortcut: false`), so its absence is
  // checked at both ends rather than only after the uninstall.
  const desktopShortcut = join(process.env.USERPROFILE ?? '', 'Desktop', 'Helm.lnk')
  const desktopShortcutBefore = existsSync(desktopShortcut)

  const alreadyInstalled = existsSync(installedExe)
  if (alreadyInstalled) {
    say(`(an existing install at ${installDir} is being replaced by this run)`)
  }

  say('installing silently, as the current user...')
  const elevated = isElevated()
  spawnSync(setupExe, ['/S'], { stdio: 'inherit', timeout: 300_000 })
  // NSIS one-click returns before the files have settled on some machines.
  waitForFile(installedExe, 60_000)
  // `runAfterFinish` is true, because an installer that finishes and does
  // nothing looks broken to the person who ran it. That means the install just
  // started the app, and everything below - the selftest, the "nothing was
  // written beside the exe" read, the uninstall - assumes it did not. End it,
  // matched by executable path rather than by image name, so a portable or dev
  // instance running from elsewhere on this machine is left alone.
  endInstalledApp(installDir)

  const installed = existsSync(installedExe)
  const shortcutCreated = existsSync(startMenu)
  const desktopShortcutCreated = !desktopShortcutBefore && existsSync(desktopShortcut)
  const registry = readUninstallRegistry()

  let report = null
  let appDataFilesAfter = []
  let besideExe = []
  if (installed) {
    say('running the installed app...')
    spawnSync(installedExe, ['--selftest'], { stdio: 'inherit', timeout: 300_000 })
    const reportFile = join(realDataDir, 'spike-report.json')
    report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null
    appDataFilesAfter = existsSync(realDataDir) ? readdirSync(realDataDir).sort() : []
    besideExe = readdirSync(installDir).filter((name) => /^helm-data$|\.db$|\.db-wal$/.test(name))
  }

  say('uninstalling...')
  let uninstallRan = false
  if (existsSync(uninstaller)) {
    // Through Start-Process -Wait, not spawnSync: the NSIS uninstaller
    // relaunches itself from a temp copy and the first process returns
    // immediately, so a plain spawn is a race against the thing being measured.
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath '${uninstaller}' -ArgumentList '/S' -Wait`
      ],
      { stdio: 'inherit', timeout: 300_000 }
    )
    uninstallRan = true
    waitForEmpty(installDir, 60_000)
  }
  // Empty counts as gone. NSIS deletes every file it installed but cannot
  // remove the directory the uninstaller is itself running out of, so a
  // successful uninstall routinely leaves an empty folder behind. What matters
  // is that nothing is left *in* it.
  const remaining = existsSync(installDir) ? readdirSync(installDir) : []
  const installDirGone = remaining.length === 0
  const registryAfter = readUninstallRegistry()
  const shortcutGone = !existsSync(startMenu)
  // Deliberately kept: uninstalling an app must not delete the user's data, and
  // `deleteAppDataOnUninstall` is off for exactly that reason.
  const appDataKept = existsSync(realDataDir)

  return [
    {
      id: 'M7-2',
      criterion:
        'NSIS installer installs per-user without elevation, the installed app launches and passes the same smoke checks, app data lands in %APPDATA%, and uninstall removes it cleanly',
      title: `Installed to ${installDir}, ran, and uninstalled`,
      ok:
        installed &&
        !elevated &&
        installDir.toLowerCase().startsWith(localAppData.toLowerCase()) &&
        report !== null &&
        report.pass === true &&
        report.mode === 'installed' &&
        String(report.dataDir ?? '').toLowerCase() === realDataDir.toLowerCase() &&
        besideExe.length === 0 &&
        shortcutCreated &&
        !desktopShortcutCreated &&
        uninstallRan &&
        installDirGone &&
        shortcutGone &&
        registryAfter.length === 0 &&
        appDataKept,
      detail: {
        setupExe,
        elevatedShell: elevated,
        installDir,
        installedExe,
        installed,
        replacedExistingInstall: alreadyInstalled,
        installedMode: report?.mode ?? null,
        installedDataDir: report?.dataDir ?? null,
        expectedDataDir: realDataDir,
        selftestPass: report?.pass ?? null,
        dataFilesBesideExe: besideExe,
        appDataEntries: appDataFilesAfter.length,
        startMenuShortcut: {
          path: startMenu,
          createdByInstall: shortcutCreated,
          goneAfterUninstall: shortcutGone
        },
        desktopShortcut: { path: desktopShortcut, createdByInstall: desktopShortcutCreated },
        uninstallEntriesBefore: registry,
        uninstallEntriesAfter: registryAfter,
        filesLeftInInstallDir: remaining,
        installDirEmptyAfterUninstall: installDirGone,
        appDataKeptOnPurpose: appDataKept
      },
      notes: [
        'Installed silently as the ordinary user. This shell is not elevated, and a per-machine installer would fail here rather than prompt, so "no elevation" is the reason it worked rather than an assumption.',
        'The installed app is asked for the same selftest the portable exe ran, and it reports its own mode and data directory, which are compared against %APPDATA%\\Helm.',
        'Nothing landed beside the exe: the install directory holds no helm-data, no .db and no WAL.',
        'A start-menu entry is created and a desktop icon deliberately is not. Both are checked, and the uninstall has to take back the one it made.',
        'An empty install directory counts as removed: NSIS deletes every file it installed but cannot remove the folder its own uninstaller is running out of, so an empty shell is the ordinary successful outcome.',
        '%APPDATA%\\Helm is deliberately NOT removed by the uninstaller. deleteAppDataOnUninstall stays false: the database holds the user\'s profiles, session index and config snapshots, and an uninstall is not a request to destroy them.'
      ]
    }
  ]
}

function isElevated() {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 }
    )
    return out.trim().toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** Per-user uninstall entries mentioning Helm. */
function readUninstallRegistry() {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName } | Where-Object { $_ -like '*Helm*' }"
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 }
    )
    return out.split(/\r?\n/).filter((line) => line.trim() !== '')
  } catch {
    return []
  }
}

/** A synchronous pause. This script is a sequence of blocking installs; there
 * is no event loop to yield to and nothing else waiting on it. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !existsSync(path)) sleepSync(500)
  return existsSync(path)
}

/**
 * Ends the app the installer launched, and only that one.
 *
 * Matched by `ExecutablePath` under the install directory rather than by image
 * name: a developer running this check almost certainly has a dev or portable
 * Helm open, and killing by name would take those with it. Waits for the
 * processes to actually be gone, because the uninstall that follows cannot
 * remove files a live process still holds.
 */
function endInstalledApp(installDir) {
  const script =
    `Get-CimInstance Win32_Process -Filter "Name = 'Helm.exe'" | ` +
    `Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${JSON.stringify(installDir)}) } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    timeout: 60_000
  })

  const stillRunning = () => {
    const probe = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `@(Get-CimInstance Win32_Process -Filter "Name = 'Helm.exe'" | ` +
          `Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${JSON.stringify(installDir)}) }).Count`
      ],
      { encoding: 'utf8', timeout: 60_000 }
    )
    return Number((probe.stdout ?? '0').trim()) > 0
  }

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && stillRunning()) sleepSync(500)
  return !stillRunning()
}

/** Waits for a directory to be gone, or to hold nothing. */
function waitForEmpty(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const empty = () => !existsSync(path) || readdirSync(path).length === 0
  while (Date.now() < deadline && !empty()) sleepSync(500)
  return empty()
}
