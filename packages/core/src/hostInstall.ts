/**
 * Installing and updating floti on a host's computer, as far as it can be
 * said without running anything: reading what that computer answered, judging
 * whether this Helm can talk to its floti (P6), choosing which build goes
 * there, and the words the window shows for each outcome.
 *
 * Pure by construction and re-exported through `types.ts`: the desktop's main
 * process runs the lines through the host's own transport
 * (`main/host/remote-install.ts`), and Settings > Hosts draws the offer.
 *
 * Nothing is copied to or run on a computer before the user says yes: the
 * check runs `floti version` there and, only when floti is missing, one line
 * that names its OS and CPU. Both change nothing.
 */

import type { HostTransport } from './hosts'

/** The OSes a floti is built for, as `floti version` and the release's file names say them. */
export type FlotiOs = 'windows' | 'macos' | 'linux'

/** Each OS and CPU a release carries floti for: `packages/desktop/scripts/floti-release.mjs`'s `RELEASE_TARGETS`. */
export const FLOTI_TARGETS: readonly { name: string; os: FlotiOs; cpu: string; platform: string; arch: string }[] = [
  { name: 'windows-x64', os: 'windows', cpu: 'x64', platform: 'win32', arch: 'x64' },
  { name: 'windows-arm64', os: 'windows', cpu: 'arm64', platform: 'win32', arch: 'arm64' },
  { name: 'macos-arm64', os: 'macos', cpu: 'arm64', platform: 'darwin', arch: 'arm64' },
  { name: 'linux-x64', os: 'linux', cpu: 'x64', platform: 'linux', arch: 'x64' },
  { name: 'linux-arm64', os: 'linux', cpu: 'arm64', platform: 'linux', arch: 'arm64' }
]

/**
 * The one line the check runs when floti is missing, to name the computer's OS
 * and CPU: `uname -sm` in a POSIX shell, and in Windows' `cmd` (the shell its
 * OpenSSH runs a line in), where there is no `uname`, the `echo` after `||`.
 */
export const SYSTEM_LINE = 'uname -sm || echo %OS% %PROCESSOR_ARCHITECTURE%'

/** `floti setup`'s status when the host is registered and nobody is signed in (`crates/host/src/setup.rs`). */
export const SETUP_AT_NEXT_SIGN_IN_EXIT = 10

/** `floti connect`'s line when no host is running on that computer (`crates/host/src/connect.rs`). */
export const NO_HOST_LINE = 'floti connect: no Floti host is running there.'

/** A computer's OS and CPU, as the check found them. */
export interface RemoteSystem {
  /** The OS a floti build is named for, or null for one floti is not built for. */
  os: FlotiOs | null
  /** `x64`, `arm64`, or the machine's own word for any other CPU. */
  cpu: string
  /** What the window shows: `Linux · x86_64`, in that computer's own words. */
  label: string
}

/** A floti found on a computer, as its version line says. */
export interface FlotiFound {
  version: string
  /** The protocol it speaks (`1.0`), or null for a floti too old to say. */
  protocol: string | null
}

/**
 * What adding or updating a host found there.
 *
 * - `ready`: a floti this Helm can talk to is there: nothing to install.
 * - `offer`: floti is missing, or too old to talk to; `id` names the plan
 *   main keeps for `remoteHosts:install`.
 * - `newer`: its floti speaks a protocol newer than this Helm's: update Helm
 *   on this PC. Nothing is offered there.
 * - `noBuild`: there is no floti this Helm can install there.
 * - `failed`: the check could not run there; `lastLine` is what ssh, the
 *   command or that computer's shell wrote, unedited.
 */
export type HostCheck =
  | { kind: 'ready'; found: FlotiFound }
  | { kind: 'offer'; id: string; offer: InstallOffer }
  | { kind: 'newer'; found: FlotiFound; ours: string }
  | { kind: 'noBuild'; system: RemoteSystem; reason: string }
  | { kind: 'failed'; lastLine: string }

/** What Helm offers to do on a host's computer, said before anything is done. */
export interface InstallOffer {
  system: RemoteSystem
  /** The floti found there, which an update replaces; null when there is none. */
  found: FlotiFound | null
  action: 'install' | 'update'
  /** `copy`: this Helm's own floti, over the same login. `download`: that computer fetches the release's. */
  how: 'copy' | 'download'
  /** The version installed: this Helm's. */
  version: string
  /** Where it goes there, as that computer's user would write it. */
  folder: string
  /** For an update, how many sessions it ends there, or null when that floti cannot say. */
  sessions: number | null
}

/** The step of an install or update that failed. */
export type InstallStep = 'stop' | 'install' | 'setup'

/** How an install or update ended. */
export type InstallOutcome =
  | {
      ok: true
      /** The full path floti was put at there. */
      floti: string
      /** Setup registered the host, nobody is signed in there, and it starts at the next sign-in. */
      startsAtNextSignIn: boolean
    }
  | { ok: false; step: InstallStep; lastLine: string }

/** What `remoteHosts:check` is asked about: a host being added, or one added already, by id. */
export type HostCheckTarget = { transport: HostTransport; floti?: string } | { host: string }

/** The protocol version as `floti version` and the refused hello say it. */
export interface ProtocolVersionNumbers {
  major: number
  minor: number
}

/** `1.0`. */
export function formatProtocol(version: ProtocolVersionNumbers): string {
  return `${String(version.major)}.${String(version.minor)}`
}

/**
 * The floti `floti version` names (`floti 2.6.0 protocol 1.0 linux x64`), or
 * null for anything else. The OS and CPU are that floti's build.
 */
export function parseVersionLine(
  output: string
): (FlotiFound & { protocolNumbers: ProtocolVersionNumbers; os: string; cpu: string }) | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^floti (\S+) protocol (\d+)\.(\d+) (\S+) (\S+)$/.exec(line.trim())
    if (match === null) continue
    const [, version, major, minor, os, cpu] = match as unknown as [string, string, string, string, string, string]
    const protocolNumbers = { major: Number(major), minor: Number(minor) }
    return { version, protocol: formatProtocol(protocolNumbers), protocolNumbers, os, cpu }
  }
  return null
}

/** The version `floti --version` names (`floti 0.1.0`), for a floti too old to have `floti version`. */
export function parseShortVersion(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^floti (\S+)$/.exec(line.trim())
    if (match !== null) return match[1] ?? null
  }
  return null
}

const OS_LABEL: Record<FlotiOs, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }

function cpuOf(machine: string): string {
  const lower = machine.toLowerCase()
  if (lower === 'x86_64' || lower === 'amd64' || lower === 'x64') return 'x64'
  if (lower === 'aarch64' || lower === 'arm64') return 'arm64'
  return lower
}

/**
 * The OS and CPU `SYSTEM_LINE` answered: `Linux x86_64`, `Darwin arm64`, or
 * Windows' `Windows_NT AMD64`. A Windows login whose shell is MSYS's names
 * itself `MINGW64_NT-10.0 x86_64`. Null for an answer that is none of these.
 */
export function parseSystemLine(output: string): RemoteSystem | null {
  const line = output
    .split(/\r?\n/)
    .map((each) => each.trim())
    .find((each) => each !== '')
  if (line === undefined) return null
  const words = line.split(/\s+/)
  if (words.length !== 2) return null
  const [kernel, machine] = words as [string, string]
  // `%OS%` unexpanded: a shell that is neither.
  if (kernel.includes('%') || machine.includes('%')) return null
  const os: FlotiOs | null =
    kernel === 'Linux'
      ? 'linux'
      : kernel === 'Darwin'
        ? 'macos'
        : kernel === 'Windows_NT' || /^(MINGW|MSYS|CYGWIN)/.test(kernel)
          ? 'windows'
          : null
  const label = `${os === null ? kernel : OS_LABEL[os]} · ${machine}`
  return { os, cpu: cpuOf(machine), label }
}

/** What a floti's own version line says of the computer it runs on. */
export function systemOfBuild(os: string, cpu: string): RemoteSystem {
  const known = os === 'windows' || os === 'macos' || os === 'linux' ? os : null
  return { os: known, cpu, label: `${known === null ? os : OS_LABEL[known]} · ${cpu}` }
}

/**
 * Whether what a shell wrote, with the status it exited with, says the
 * program it was asked to run is not there: `sh`'s and bash's `not found`
 * (status 127), or `cmd`'s `is not recognized`, which it spreads over two
 * lines.
 */
export function saysNotFound(code: number | null, said: string): boolean {
  if (code === 127) return true
  // ssh's own failures: what it says is about ssh, never the line it ran.
  if (code === 255 || code === 0) return false
  return /: (command )?not found\s*$|is not recognized as an internal or external command|: No such file or directory\s*$/m.test(
    said
  )
}

/**
 * Whether this Helm can talk to a floti speaking `remote` (P6): the host
 * accepts its own protocol and the previous minor of the same major. Too old
 * is the host's to update; newer is this Helm's.
 */
export function judgeProtocol(
  remote: ProtocolVersionNumbers,
  ours: ProtocolVersionNumbers
): 'ok' | 'tooOld' | 'newer' {
  const accepted = ours.major === remote.major && (ours.minor === remote.minor || ours.minor + 1 === remote.minor)
  if (accepted) return 'ok'
  const oursIsOlder = ours.major < remote.major || (ours.major === remote.major && ours.minor < remote.minor)
  return oursIsOlder ? 'newer' : 'tooOld'
}

/** Where floti goes on a computer of `os`, in its own user's folder, as that user would write it. */
export function installFolderFor(os: FlotiOs): string {
  return os === 'windows' ? '%LOCALAPPDATA%\\Programs\\Floti\\bin' : '~/.local/bin'
}

/** `floti-<version>-<os>-<cpu>`, with `.exe` on Windows: the release's file for that target. */
export function releaseFileName(version: string, os: FlotiOs, cpu: string): string {
  return `floti-${version}-${os}-${cpu}${os === 'windows' ? '.exe' : ''}`
}

/** The entries of a `sha256sum` list: file name to lowercase SHA-256. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim())
    if (match !== null) sums.set(match[2] as string, (match[1] as string).toLowerCase())
  }
  return sums
}

/** The OS and CPU this Helm runs on, in Node's words, as a floti build names them. */
export function desktopSystem(platform: string, arch: string): { os: FlotiOs | null; cpu: string } {
  const os: FlotiOs | null =
    platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : null
  return { os, cpu: cpuOf(arch) }
}

/** Which build goes to a computer, and its SHA-256, or why there is none. */
export type InstallSource =
  | { how: 'copy' }
  | { how: 'download'; file: string; sha256: string }
  | { how: 'none'; reason: string }

/**
 * Which floti goes to a computer of `system`: this Helm's own when that
 * computer's OS and CPU are this PC's and this Helm carries one; otherwise the
 * release's build for that target, checked against the SHA-256 this Helm
 * carries for it (`sums`, null for a build that carries none, as a
 * development build does). None when neither fits.
 */
export function chooseSource(options: {
  system: RemoteSystem
  desktop: { platform: string; arch: string }
  ownBuild: boolean
  version: string
  sums: ReadonlyMap<string, string> | null
}): InstallSource {
  const { system } = options
  const here = desktopSystem(options.desktop.platform, options.desktop.arch)
  if (system.os !== null && system.os === here.os && system.cpu === here.cpu && options.ownBuild) {
    return { how: 'copy' }
  }
  const target = FLOTI_TARGETS.find((each) => each.os === system.os && each.cpu === system.cpu)
  if (target === undefined) return { how: 'none', reason: `There is no floti for ${system.label} yet.` }
  const file = releaseFileName(options.version, target.os, target.cpu)
  const sha256 = options.sums?.get(file)
  if (sha256 === undefined) {
    return {
      how: 'none',
      reason: `This Helm ${options.version} has no published floti to send, and its own floti is not for ${system.label}.`
    }
  }
  return { how: 'download', file, sha256 }
}

/** The title and the fix the window shows for a failed install or update step. */
export function describeInstallFailure(
  step: InstallStep,
  host: string,
  folder: string
): { title: string; fix: string } {
  if (step === 'stop') {
    return {
      title: `Helm could not stop the floti host on ${host} for the update`,
      fix: `Nothing was replaced, and its sessions are still running. Try again, or run floti update-stop --stop there.`
    }
  }
  if (step === 'setup') {
    return {
      title: `floti is installed on ${host}, but its setup failed`,
      fix: `Run floti setup in a terminal there to see all of its output, then try again.`
    }
  }
  return {
    title: `Installing floti on ${host} failed`,
    fix: `Nothing replaced a floti that was there. Check that ${folder} there can be written to and, for a download, that ${host} reaches github.com, then try again.`
  }
}
