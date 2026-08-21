// What the installed Helm is, and how to ask about it safely.
//
// Split out of `run-packaging.mjs` when the installer verification became a
// tool of its own (`verify-installer.mjs`). Two callers need these now and they
// want different things from them: the packaging suite only ever *asks*
// - "is something running out of the install directory" - while the installer
// tool also stops and replaces it. Keeping the asking half here means the suite
// never imports the module that can end anything.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A synchronous pause. These callers are sequences of blocking installs; there
 * is no event loop to yield to and nothing else waiting on them.
 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !existsSync(path)) sleepSync(500)
  return existsSync(path)
}

/** Waits for a directory to be gone, or to hold nothing. */
export function waitForEmpty(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const empty = () => !existsSync(path) || readdirSync(path).length === 0
  while (Date.now() < deadline && !empty()) sleepSync(500)
  return empty()
}

/**
 * A Windows path as a PowerShell **string literal**.
 *
 * `JSON.stringify` is not that, and the difference is not cosmetic. It doubles
 * every backslash, and a PowerShell double-quoted string does not undo that -
 * backslash is not PowerShell's escape character, backtick is. So a path went
 * across as `"C:\\Users\\user\\..."`, a literal path with doubled separators,
 * and `StartsWith` on it was false for every process on the machine.
 *
 * What that silently did: `endInstalledApp` matched nothing and killed nothing,
 * `stillRunning()` answered "no" without ever having looked, and the installer
 * phase then installed and uninstalled **over a running Helm**. Measured - the
 * JSON form returns 0 and this one returns 4, with the app plainly open. It took
 * down a Claude Code session somebody was working in.
 *
 * Single quotes, because a PowerShell single-quoted string is literal: only `'`
 * needs escaping, by doubling, and a backslash is just a backslash.
 */
export function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Where electron-builder's one-click, per-user NSIS target installs, and the
 * only Helm that writes to `%APPDATA%\Helm`.
 */
export function installedAppDir() {
  return join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Helm')
}

/**
 * How many Helm processes are running out of `installDir`.
 *
 * Matched by **executable path**, not image name, so a portable build or a
 * `pnpm dev` running from elsewhere on this machine is not counted - the
 * question is only ever about the installed one.
 */
export function countInstalledProcesses(installDir) {
  const probe = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name = 'Helm.exe'" | ` +
        `Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${psLiteral(installDir)}) }).Count`
    ],
    { encoding: 'utf8', timeout: 60_000 }
  )
  return Number((probe.stdout ?? '0').trim()) || 0
}

/**
 * Ends the app the installer launched, and only that one.
 *
 * Matched by `ExecutablePath` under the install directory rather than by image
 * name: whoever runs this almost certainly has a dev or portable Helm open, and
 * killing by name would take those with it. Waits for the processes to actually
 * be gone, because an uninstall cannot remove files a live process still holds.
 *
 * **Only `verify-installer.mjs` may call this.** It is the one function in this
 * repository that ends the app somebody is working in, and it is deliberately
 * not reachable from any suite - see the header of that file.
 */
export function endInstalledApp(installDir) {
  const script =
    `Get-CimInstance Win32_Process -Filter "Name = 'Helm.exe'" | ` +
    `Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${psLiteral(installDir)}) } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    timeout: 60_000
  })

  const stillRunning = () => countInstalledProcesses(installDir) > 0

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && stillRunning()) sleepSync(500)
  return !stillRunning()
}

export function isElevated() {
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
export function readUninstallRegistry() {
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
