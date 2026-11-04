/**
 * What went wrong reaching a host on another computer, said the one way every
 * surface says it: the add-a-host dialog's failure screen and a host's row in
 * Settings > Hosts. A title naming what went wrong, a short chip, the last
 * line ssh, the command, floti or the install script wrote, unedited, and the
 * fix.
 *
 * Pure by construction and re-exported through `types.ts`. It reads the
 * transport, the last line and, where there is more, everything that was
 * written (a changed host key and an unknown one end on the same line), plus
 * what only main can tell (`HostFailureCause`): that the transport's program
 * is not on this PC, or that the login printed text before floti's own line.
 * A line it does not know falls back to `transportFix`.
 *
 * Every fix points at the user's own setup and never changes it: Helm runs
 * ssh in batch mode, answers no prompt, accepts no host key and edits no ssh
 * config. Where the fix names the line to run by hand, it is the transport as
 * the user gave it (`ssh build-box`).
 */

import { NO_HOST_LINE, saysNotFound, describeInstallFailure, type InstallStep } from './hostInstall'
import { describeTransport, sshTargetOf, transportFix, type HostTransport } from './hosts'

/** What main tells apart that the last line alone cannot say. */
export type HostFailureCause =
  /** The transport's program is not on this PC (`ENOENT`). */
  | { kind: 'transportMissing' }
  /** The login wrote text before floti's own line; `lastLine` is the first line it printed. */
  | { kind: 'loginOutput' }
  /** The host proved another key than the one this device pinned for it. */
  | { kind: 'keyChanged' }
  /** Its floti is newer than this Helm: by version from the check, or by protocol from a refused hello. */
  | { kind: 'newer'; host: string; ours: string; by: 'version' | 'protocol' }
  /** Its floti is too old for this Helm, by protocol. */
  | { kind: 'tooOld'; host: string; ours: string }
  /** There is no floti build for that computer; `system` is its OS and CPU, as it said them. */
  | { kind: 'noBuild'; system: string }
  /** An install or update step failed there. */
  | { kind: 'install'; step: InstallStep; folder: string }

export interface HostFailureInput {
  /** The host's name in Helm. */
  name: string
  transport: HostTransport
  /** The last line written, shown unedited. */
  lastLine: string
  /** Everything ssh or the command wrote, when more than the last line is known. */
  said?: string | undefined
  cause?: HostFailureCause | undefined
  /** Which step failed: the check names its title for the check. */
  step?: 'check' | 'connect' | undefined
}

export type HostFailureKind =
  | 'noTransport'
  | 'unresolved'
  | 'unreachable'
  | 'password'
  | 'unknownKey'
  | 'hostKeyChanged'
  | 'pinChanged'
  | 'loginOutput'
  | 'noBuild'
  | 'installFailed'
  | 'newer'
  | 'tooOld'
  | 'notRunning'
  | 'missing'
  | 'noDistro'
  | 'noWsl'
  | 'other'

/** One failure as every surface draws it. */
export interface HostFailure {
  kind: HostFailureKind
  /** What went wrong, as a sentence without its full stop. */
  title: string
  /** A word or two for the host's chip. */
  chip: string
  /** Who wrote the line: `ssh said`, `The command said`, `floti said`, `The login printed`, `The install script said`. */
  saidBy: string
  /** The line, unedited. */
  line: string
  /** What to do, ending with what to do next. */
  fix: string
}

const UNRESOLVED =
  /Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution|No such host is known/i
const UNREACHABLE =
  /Connection timed out|Operation timed out|Connection refused|No route to host|Network is unreachable|Host is down/i
const PASSWORD =
  /Permission denied|Too many authentication failures|passphrase|password|keyboard-interactive|verification code/i
const KEY_CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i
const KEY_UNKNOWN = /Host key verification failed|host key is known for|host key .* is not known/i

/** wsl.exe's words for a distro it does not have. */
const NO_DISTRO = /WSL_E_DISTRO_NOT_FOUND|There is no distribution with the supplied name/i
/** wsl.exe's, or Windows', words for a PC with no WSL. */
const NO_WSL =
  /Windows Subsystem for Linux is not installed|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|'wsl(\.exe)?' is not recognized|wsl(\.exe)?: (command )?not found/i

/** Says what went wrong reaching a host, from its transport, the lines written and what main told apart. */
export function classifyHostFailure(input: HostFailureInput): HostFailure {
  const { name, transport, lastLine, cause } = input
  const reach = describeTransport(transport)
  // ssh's own failures read the same whether ssh reaches the host or a
  // Windows PC a distro is on.
  const sshTarget = sshTargetOf(transport)
  const ssh = sshTarget !== null
  const transportSaid =
    transport.kind === 'ssh'
      ? 'ssh said'
      : transport.kind === 'wsl'
        ? ssh
          ? 'ssh said'
          : 'wsl.exe said'
        : 'The command said'
  const said = input.said ?? lastLine
  const wsl = transport.kind === 'wsl' ? transport : null
  /** Where the distro is: `this PC`, or the ssh target of the PC it is on. */
  const wslPc = wsl?.through ?? 'this PC'
  const failure = (kind: HostFailureKind, title: string, chip: string, fix: string, saidBy = transportSaid): HostFailure => ({
    kind,
    title,
    chip,
    saidBy,
    line: lastLine,
    fix
  })

  const noWsl = (): HostFailure =>
    failure(
      'noWsl',
      `WSL is not installed on ${wslPc}`,
      'No WSL',
      `Run wsl --install in a terminal${wsl?.through === undefined ? '' : ` on ${wslPc}`}, restart if it asks, then try again.`,
      'wsl.exe said'
    )

  switch (cause?.kind) {
    case 'transportMissing':
      // This PC's wsl.exe is not there: WSL is not installed here.
      if (wsl !== null && !ssh) return noWsl()
      return ssh || transport.kind !== 'command'
        ? failure(
            'noTransport',
            'Helm could not find ssh on this PC',
            'No ssh',
            'Install the OpenSSH client (on Windows, Settings > System > Optional features). Helm has no ssh of its own. Then try again.',
            'Helm said'
          )
        : failure(
            'noTransport',
            `Helm could not find ${transport.program} on this PC`,
            'Not found',
            `Check that ${transport.program} is installed and the command names it as it is, then try again.`,
            'Helm said'
          )
    case 'loginOutput':
      return failure(
        'loginOutput',
        `${name}’s login printed text where floti’s connection goes`,
        'Login output',
        'Make whatever prints in its shell start-up files run only for interactive shells, then try again.',
        'The login printed'
      )
    case 'keyChanged':
      return failure(
        'pinChanged',
        `${name} proved another key than the one this PC pinned for it`,
        'Key changed',
        `If floti was reinstalled there on purpose, remove ${name} and add it again.`,
        'floti said'
      )
    case 'newer':
      return failure(
        'newer',
        cause.by === 'version'
          ? `${name} runs floti ${cause.host}, newer than this Helm ${cause.ours}`
          : `${name}’s floti speaks protocol ${cause.host}, newer than this Helm’s ${cause.ours}`,
        'Newer floti',
        'Update Helm on this PC, then try again.',
        'floti said'
      )
    case 'tooOld':
      return failure(
        'tooOld',
        `${name}’s floti is too old for this Helm`,
        'floti too old',
        `It speaks protocol ${cause.host}, and this Helm speaks ${cause.ours}. Update floti there, then try again.`,
        'floti said'
      )
    case 'noBuild':
      return failure(
        'noBuild',
        `There is no floti for ${cause.system} yet`,
        'No build',
        'None from Helm’s side: that computer can’t be a host yet.',
        'Helm said'
      )
    case 'install': {
      if (cause.step === 'install') {
        return failure(
          'installFailed',
          `Installing floti on ${name} failed`,
          'Install failed',
          'Run the install command in a terminal there to see all of its output, then try again.',
          'The install script said'
        )
      }
      const words = describeInstallFailure(cause.step, name, cause.folder)
      return failure('installFailed', words.title, 'Install failed', words.fix, 'floti said')
    }
    default:
      break
  }

  if (wsl !== null) {
    if (NO_DISTRO.test(said)) {
      return failure(
        'noDistro',
        `WSL has no distro named ${wsl.distro} on ${wslPc}`,
        'No distro',
        `wsl --list in a terminal${wsl.through === undefined ? '' : ` on ${wslPc}`} shows the distros there. Pick one of those, then try again.`,
        'wsl.exe said'
      )
    }
    if (NO_WSL.test(said)) return noWsl()
  }

  if (KEY_CHANGED.test(said)) {
    return failure(
      'hostKeyChanged',
      `${name}’s host key changed`,
      'Host key',
      `Run ${reach} once in a terminal and check the fingerprint it shows. Helm never accepts a host key for you.`
    )
  }
  if (KEY_UNKNOWN.test(said)) {
    return failure(
      'unknownKey',
      `ssh does not trust ${name} yet`,
      'Host key',
      `Run ${reach} once in a terminal and check the fingerprint it shows. Helm never accepts a host key for you.`
    )
  }
  if (UNRESOLVED.test(said)) {
    return failure(
      'unresolved',
      ssh ? `ssh does not know ${sshTarget}` : `The command does not know ${name}`,
      'Unknown name',
      'Check the name, or add a Host for it to ~/.ssh/config, then try again.'
    )
  }
  if (UNREACHABLE.test(said)) {
    return failure(
      'unreachable',
      `Can’t reach ${name}`,
      'Unreachable',
      `Check that ${name} is on and connected to your network, and that its SSH server is running. In a terminal, ${reach} should reach it. Then try again.`
    )
  }
  if (PASSWORD.test(said)) {
    return failure(
      'password',
      `${name} wants a password`,
      'Needs a key',
      `Use a key, added there or loaded into the SSH agent, so ${reach} gets in without asking. Then try again.`
    )
  }
  if (lastLine === NO_HOST_LINE) {
    return failure(
      'notRunning',
      `floti is on ${name}, but its host is not running`,
      'Not running',
      'Run floti setup there in a terminal, or sign in there so the host starts, then try again.',
      'floti said'
    )
  }
  if (saysNotFound(null, lastLine)) {
    return failure(
      'missing',
      `${name}’s login has no floti to run`,
      'floti not found',
      'Try again: Helm checks it and offers to install floti there.'
    )
  }
  return failure(
    'other',
    input.step === 'check' ? `Helm could not check ${name}` : `Helm could not connect to ${name}`,
    'Cannot connect',
    transportFix(transport)
  )
}
