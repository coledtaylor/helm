// Verifies the NSIS installer end to end: installs it, runs the installed app,
// and uninstalls it again.
//
// **This is a tool, not a check, and that distinction is the whole point of the
// file existing.**
//
// It is the only thing in this repository that stops, replaces and removes the
// Helm installed on this machine. Every check gets its own data directory
// precisely so it cannot reach the app somebody is using; this one cannot be
// isolated, because it is *about* where an installer puts things. So instead of
// being isolated it is made **unreachable by accident**: it is not a group of
// any suite, no `--only=` reaches it, and `pnpm packaging-check` cannot run it
// however it is invoked.
//
// That is a rule about structure rather than about care, and it is written this
// way because care has already failed twice:
//
//   - It ran inside a `pnpm packaging-check` sweep, killed the installed Helm,
//     took the Claude Code session somebody was working in down with it, and
//     then uninstalled the app so it had to be put back by hand.
//   - The guard meant to prevent that had itself never been run - once because
//     `psLiteral` doubled its backslashes so the process probe matched nothing
//     and answered "nothing is running" without having looked, and once because
//     it was a `const` arrow in a temporal dead zone and threw out of the very
//     branch that exists to refuse.
//
// A branch that refuses only when Helm is open is a branch nobody takes on the
// machine that wrote it. Moving the whole thing out of the suite means the
// dangerous path is one somebody chooses, by name, rather than one a sweep can
// wander into.
//
// Helm **hosts sessions**. Terminating it is not like terminating an editor
// with everything saved.
//
//   pnpm verify:installer --yes                     # install, run, uninstall
//   pnpm verify:installer --yes --replace-running   # ... even if Helm is open
//
// Without `--yes` it explains itself and does nothing.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  countInstalledProcesses,
  endInstalledApp,
  installedAppDir,
  isElevated,
  readUninstallRegistry,
  waitForEmpty,
  waitForFile
} from './installed-app.mjs'

const desktopDir = resolve(import.meta.dirname, '..')
const distDir = join(desktopDir, 'dist-app')
const appData = process.env.APPDATA ?? process.env.HOME ?? '.'
const realDataDir = join(appData, 'Helm')
const version = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')).version

const args = process.argv.slice(2)
const say = (line) => console.log(line)

/**
 * The consent gate.
 *
 * A named script is already harder to reach by accident than a `--only=` group,
 * but "harder" is what the last two guards were. `--yes` is the flag that makes
 * running this a sentence somebody typed rather than a side effect of a command
 * that sounded like verification.
 */
if (!args.includes('--yes')) {
  say('verify-installer: this is a destructive tool and it did nothing.')
  say('')
  say('It installs the built NSIS package over the Helm on this machine, runs the')
  say('installed app, and uninstalls it. It does not put your install back.')
  say('Helm hosts Claude Code sessions, so it also ends whatever is running in them.')
  say('')
  say(`  install directory : ${installedAppDir()}`)
  say(`  running now       : ${String(countInstalledProcesses(installedAppDir()))} process(es)`)
  say(`  app data          : ${realDataDir}  (kept - the uninstaller does not remove it)`)
  say('')
  say('Run it deliberately, on a machine where nobody is working:')
  say('  pnpm verify:installer --yes')
  say('  pnpm verify:installer --yes --replace-running   # if Helm is open and that is intended')
  process.exit(2)
}

const setupExe = join(distDir, `Helm-${version}-setup.exe`)
if (!existsSync(setupExe)) {
  console.error(`FAIL  no installer at ${setupExe}`)
  console.error('Build it first: pnpm dist:win')
  process.exit(1)
}

const checks = installerChecks(setupExe)

mkdirSync(realDataDir, { recursive: true })
const report = join(realDataDir, 'packaging-installer.json')
const failed = checks.filter((c) => !c.ok)
writeFileSync(
  report,
  JSON.stringify(
    { startedAt: new Date().toISOString(), tool: 'verify-installer', pass: failed.length === 0, checks },
    null,
    2
  )
)

console.log('')
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)
console.log(`\nreport: ${report}`)

if (checks.length === 0 || failed.length > 0) {
  console.error(`\nFAIL  ${String(failed.length)} of ${String(checks.length)} checks`)
  process.exit(1)
}
console.log(`\nPASS  all ${String(checks.length)} checks`)

// ---------------------------------------------------------------------------

/** PKG-2: the NSIS installer, installed, launched, and uninstalled. */
function installerChecks(setupExe) {
  const CRITERION =
    'NSIS installer installs per-user without elevation, the installed app launches and passes the same smoke checks, app data lands in %APPDATA%, and uninstall removes it cleanly'

  // electron-builder's one-click, per-user NSIS target installs here and asks
  // for no elevation. If it had asked, a silent run would fail outright rather
  // than silently succeeding.
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const installDir = installedAppDir()
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

  /**
   * Stop if the installed Helm is **running**.
   *
   * The second guard, kept even though this file is no longer reachable from a
   * suite. `--yes` says "I meant to run the tool"; this says "and I know
   * something is open right now". They are different sentences and the second
   * one is the one that has cost a session.
   */
  const running = countInstalledProcesses(installDir)
  if (running > 0 && !args.includes('--replace-running')) {
    say('')
    say(`FAIL  PKG-2  ${String(running)} Helm process(es) are running from ${installDir}.`)
    say('This tool terminates the installed app, uninstalls it, and does not put it back.')
    say('Helm hosts Claude Code sessions, so that ends whatever is running in them.')
    say('Close it and run this again, or pass --replace-running if that is what you want.')
    return [
      {
        id: 'PKG-2',
        criterion: CRITERION,
        title: `Refused: ${String(running)} process(es) are running from the install directory`,
        ok: false,
        detail: {
          installDir,
          running,
          remedy: 'close the installed Helm, or pass --replace-running'
        },
        notes: [
          'Not a failure of the installer. This tool would have uninstalled an app somebody',
          'is using, which it has done once already - see the header of this file.'
        ]
      }
    ]
  }

  say('installing silently, as the current user...')
  const elevated = isElevated()
  spawnSync(setupExe, ['/S'], { stdio: 'inherit', timeout: 300_000 })
  // NSIS one-click returns before the files have settled on some machines.
  waitForFile(installedExe, 60_000)
  // `runAfterFinish` is true, because an installer that finishes and does
  // nothing looks broken to the person who ran it - there is no completion page
  // on a one-click install to say otherwise.
  //
  // NSIS suppresses that auto-run under `/S`, which is what this install uses,
  // so today nothing is started here and this call is a no-op. It stays anyway:
  // everything below - the selftest, the "nothing was written beside the exe"
  // read, and an uninstall that cannot remove files a live process holds -
  // assumes no app is running, and the day this install stops being silent that
  // assumption breaks silently. Measured on 2026-08-10: `/S` launched nothing,
  // the same installer double-clicked launched the app.
  endInstalledApp(installDir)

  const installed = existsSync(installedExe)
  const shortcutCreated = existsSync(startMenu)
  const desktopShortcutCreated = !desktopShortcutBefore && existsSync(desktopShortcut)
  const registry = readUninstallRegistry()

  let selftest = null
  let appDataFilesAfter = []
  let besideExe = []
  if (installed) {
    say('running the installed app...')
    spawnSync(installedExe, ['--selftest'], { stdio: 'inherit', timeout: 300_000 })
    const reportFile = join(realDataDir, 'spike-report.json')
    selftest = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null
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

  say('')
  say('The installed Helm has been REMOVED. If you were using it, reinstall it:')
  say(`  ${setupExe}`)

  return [
    {
      id: 'PKG-2',
      criterion: CRITERION,
      title: `Installed to ${installDir}, ran, and uninstalled`,
      ok:
        installed &&
        !elevated &&
        installDir.toLowerCase().startsWith(localAppData.toLowerCase()) &&
        selftest !== null &&
        selftest.pass === true &&
        selftest.mode === 'installed' &&
        String(selftest.dataDir ?? '').toLowerCase() === realDataDir.toLowerCase() &&
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
        installedMode: selftest?.mode ?? null,
        installedDataDir: selftest?.dataDir ?? null,
        expectedDataDir: realDataDir,
        selftestPass: selftest?.pass ?? null,
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
        '%APPDATA%\\Helm is deliberately NOT removed by the uninstaller. deleteAppDataOnUninstall stays false: the database holds the user\'s profiles, session index and config snapshots, and an uninstall is not a request to destroy them.',
        'This tool leaves the machine with NO installed Helm. That is the honest end state of verifying an uninstall, and it is why this is not part of any suite.'
      ]
    }
  ]
}
