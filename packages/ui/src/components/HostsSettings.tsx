import { useEffect, useEffectEvent, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  classifyHostFailure,
  describeHostSystem,
  describeInstallFailure,
  describeTransport,
  hostSystem,
  type HostCheck,
  type HostCheckTarget,
  type HostSystem,
  type InstallOffer,
  type InstallOutcome,
  type HostTransport,
  type QuitSessions,
  type RemoteHost,
  type RemoteHostConnection,
  lineToTryByHand,
  localHostVersionsSentence,
  transportFix,
  type LocalHostVersions
} from '@helm/core/types'
import { Chip, type ChipTone } from './Chip'
import { PlusIcon } from './icons'
import { Action, Divider, Group, Select } from './SettingsKit'

/**
 * Settings > Hosts: the hosts on other computers this device reaches, each
 * with how it is reached, the floti version and OS there, where its link
 * stands, what quitting does to the sessions this device started there, and
 * Remove. Adding one is the add-a-host dialog's (`AddHostDialog`), which the
 * page's Add a host… opens.
 *
 * The user's login is the access: adding a host is connecting to it through
 * that login, and its first connection pins the key it proves. There is no
 * role, code or approval. A host that later proves another key says so,
 * naming it, until it is removed and added again; Remove forgets the host and
 * the key pinned for it.
 *
 * Everything here is kept on this device (`hosts` and `quitSessions`) and
 * written through `settings:write`. Removing a host forgets it here and ends
 * nothing on it. Where each link stands is the desktop's to say
 * (`connection`); null while it has said nothing.
 *
 * A host whose floti is too old or missing offers to update or install it:
 * what that would do and where is said first, and it is done only after the
 * user's yes. A link that cannot connect says why the way the dialog does
 * (`classifyHostFailure`), with the last line written there, unedited.
 *
 * Above them, while this PC's host and this Helm are on different floti
 * versions, a notice says which is behind, naming both. An older host is
 * offered Restart host to update, which says what it ends before anything
 * happens; one on protocol 1.x is told to stop through its notification-area
 * menu, which ends its sessions, after which Helm starts the host it carries
 * and History offers them to resume. A Helm behind its host is told to update
 * Helm. Nothing is restarted without the user's click.
 */

/** What Settings > Hosts asks the desktop to check, install and cancel on a host's computer. */
export interface HostInstallActions {
  check: (target: HostCheckTarget) => Promise<HostCheck>
  /** Does what the check with `id` offered, for the host whose id is `host`. */
  install: (id: string, host: string) => Promise<InstallOutcome>
  cancel: (id: string) => void
}

/** One remote host as Settings > Hosts draws it. */
export interface SettingsHost {
  host: RemoteHost
  /** What quitting Helm does to the sessions it started there (`quitChoice`). */
  quit: QuitSessions
  /** Where this device's link to it stands, or null while nothing has been heard. */
  connection: RemoteHostConnection | null
}

export interface HostsSettingsProps {
  hosts: readonly SettingsHost[]
  /** Opens the add-a-host dialog. */
  onAdd: () => void
  /** Forgets a host on this device, with its quit choice. Ends nothing there. */
  onRemove: (id: string) => void
  onQuitChange: (id: string, choice: QuitSessions) => void
  install: HostInstallActions
  /** Floti was installed or updated on host `id`, at `floti` there, on a computer whose OS and CPU are `system`. */
  onInstalled: (id: string, floti: string, system: HostSystem) => void
  /** Starts updating that host's floti, as its Update floti button does: from the sidebar. */
  updateRequest?: { id: string; nonce: number } | null | undefined
  /** Reconnect now on a host that is not connected: its link tries at once rather than after the wait. */
  onReconnect?: ((id: string) => void) | undefined
  /** This PC's host, while it and this Helm are on different versions; null or absent otherwise. */
  localHost?: { versions: LocalHostVersions; onRestart: () => void } | null | undefined
}

const CONNECTION_CHIP: Record<RemoteHostConnection['state'], { tone: ChipTone; label: string }> = {
  connected: { tone: 'success', label: 'Connected' },
  retrying: { tone: 'warn', label: 'Not connected, retrying' },
  keyChanged: { tone: 'danger', label: 'Key changed' },
  failed: { tone: 'danger', label: 'Cannot connect' },
  missing: { tone: 'warn', label: 'floti not found' },
  tooOld: { tone: 'warn', label: 'floti too old' },
  newer: { tone: 'warn', label: 'Newer floti' },
  startsAtSignIn: { tone: 'neutral', label: 'Starts at next sign-in' }
}

export function HostsSettings({
  hosts,
  onAdd,
  onRemove,
  onQuitChange,
  install,
  onInstalled,
  updateRequest = null,
  onReconnect,
  localHost = null
}: HostsSettingsProps): JSX.Element {
  return (
    <Group
      name="hosts"
      title="Hosts"
      hint="Hosts on your other computers, reached with your own ssh or a command you choose. Each runs its own sessions."
    >
      {localHost !== null && (
        <>
          <LocalHostNotice versions={localHost.versions} onRestart={localHost.onRestart} />
          <Divider />
        </>
      )}
      {hosts.length === 0 && (
        <div data-settings-hosts-empty className="flex flex-col items-start gap-2 py-1.5">
          <p className="text-[12px] text-fg-muted">
            No other hosts yet. A host is Helm on another computer, such as a server or your other PC, reached with
            your own ssh.
          </p>
          <Action data-settings-hosts-empty-add onClick={onAdd}>
            <span className="flex items-center gap-1.5">
              <PlusIcon width={12} height={12} />
              Add a host…
            </span>
          </Action>
        </div>
      )}
      {hosts.map((entry, index) => (
        <div key={entry.host.id}>
          {index > 0 && <Divider />}
          <HostRow
            entry={entry}
            onRemove={onRemove}
            onQuitChange={onQuitChange}
            install={install}
            onInstalled={onInstalled}
            updateRequest={updateRequest?.id === entry.host.id ? updateRequest.nonce : null}
            onReconnect={onReconnect}
          />
        </div>
      ))}
      {hosts.length > 0 && (
        <p className="mt-3 text-[11px] leading-[1.5] text-fg-subtle">
          Remove forgets a host on this PC. Its sessions keep running there, and your ssh config is not touched.
        </p>
      )}
    </Group>
  )
}

function HostRow({
  entry,
  onRemove,
  onQuitChange,
  install,
  onInstalled,
  updateRequest,
  onReconnect
}: {
  entry: SettingsHost
  onRemove: (id: string) => void
  onQuitChange: (id: string, choice: QuitSessions) => void
  install: HostInstallActions
  onInstalled: (id: string, floti: string, system: HostSystem) => void
  /** Changes each time the sidebar asks to update this host's floti. */
  updateRequest: number | null
  onReconnect: ((id: string) => void) | undefined
}): JSX.Element {
  const { host, quit, connection } = entry
  const chip =
    connection === null
      ? null
      : connection.state === 'failed'
        ? { tone: CONNECTION_CHIP.failed.tone, label: failureOf(host, connection.lastLine).chip }
        : CONNECTION_CHIP[connection.state]
  const flow = useInstallFlow(install)
  const startUpdate = (): void =>
    flow.start({ host: host.id }, host, ({ floti, system }) => {
      if (floti !== undefined) onInstalled(host.id, floti, system)
    })
  const version = connection?.state === 'connected' ? connection.version : undefined
  const reached = [
    describeTransport(host.transport),
    ...(version === undefined ? [] : [`floti ${version}`]),
    ...(host.system === undefined ? [] : [describeHostSystem(host.system)])
  ].join(' · ')
  const requested = useEffectEvent(startUpdate)
  useEffect(() => {
    if (updateRequest !== null) requested()
  }, [updateRequest])
  const offersUpdate = connection?.state === 'tooOld' || connection?.state === 'missing'
  // A link that dropped or could not get in is waiting to try again: the user
  // may have just fixed what it needed, so it can try at once.
  const offersReconnect =
    onReconnect !== undefined &&
    (connection?.state === 'retrying' || connection?.state === 'failed' || connection?.state === 'missing')
  return (
    <div
      data-settings-host={host.id}
      data-settings-host-connection={connection?.state ?? 'unknown'}
      aria-label={host.name}
      role="group"
      className="py-2"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="min-w-0 truncate font-mono text-[12.5px] text-fg">{host.name}</span>
        {chip !== null && <Chip tone={chip.tone}>{chip.label}</Chip>}
      </div>
      <p
        data-settings-host-reached
        className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle select-text"
        title={reached}
      >
        {reached}
      </p>
      {connection !== null && <ConnectionDetail connection={connection} host={host} />}
      {flow.panel !== null && <div className="mt-2">{flow.panel}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[12px] text-fg-muted">When you quit</span>
        <Select
          value={quit}
          label={`When you quit, on ${host.name}`}
          data-settings-host-quit={quit}
          onChange={(value) => onQuitChange(host.id, value === 'end' ? 'end' : 'keep')}
        >
          <option value="end">End my sessions there</option>
          <option value="keep">Keep them running</option>
        </Select>
        <span className="flex-1" />
        {offersUpdate && flow.panel === null && (
          <Action primary data-settings-host-update={host.id} onClick={startUpdate}>
            {connection?.state === 'missing' ? 'Install floti' : 'Update floti'}
          </Action>
        )}
        {offersReconnect && (
          <Action data-settings-host-reconnect={host.id} onClick={() => onReconnect(host.id)}>
            Reconnect now
          </Action>
        )}
        <Action data-settings-host-remove={host.id} onClick={() => onRemove(host.id)}>
          Remove
        </Action>
      </div>
    </div>
  )
}

/** This PC's host and this Helm on different versions: which is behind, and what to do. */
function LocalHostNotice({
  versions,
  onRestart
}: {
  versions: LocalHostVersions
  onRestart: () => void
}): JSX.Element {
  const restarts = versions.older === 'host' && !versions.stopFromMenu
  return (
    <div data-settings-local-host={versions.older} aria-label="This PC" role="group" className="py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="min-w-0 truncate text-[12.5px] text-fg">This PC</span>
        <Chip tone="warn">{versions.older === 'host' ? 'Older host' : 'Update Helm'}</Chip>
      </div>
      <p data-settings-local-host-versions className="mt-2 text-[11.5px] leading-[1.5] text-fg-muted">
        {localHostVersionsSentence(versions)}
      </p>
      {restarts && (
        <div className="mt-2 flex items-center">
          <Action primary data-settings-local-host-restart onClick={onRestart}>
            Restart host to update
          </Action>
        </div>
      )}
    </div>
  )
}

/** What a link that is not simply connected or retrying needs from the user. */
function ConnectionDetail({ connection, host }: { connection: RemoteHostConnection; host: RemoteHost }): ReactNode {
  if (connection.state === 'keyChanged') {
    return (
      <p data-settings-host-key-changed className="mt-2 text-[11.5px] leading-[1.5] text-fg-muted">
        {host.name}’s key changed: the host reached there proved another key than the one this PC pinned for it, so Helm
        connects to nothing there. If floti was reinstalled there on purpose, remove {host.name} and add it again.
      </p>
    )
  }
  if (connection.state === 'failed') {
    const failure = failureOf(host, connection.lastLine)
    return (
      <div
        data-settings-host-failed={failure.kind}
        className="mt-2 flex flex-col gap-1 text-[11.5px] leading-[1.5] text-fg-muted"
      >
        <p data-settings-host-failure-title className="text-fg">
          {failure.title}.
        </p>
        <p>
          <span className="text-fg-subtle">{failure.saidBy}: </span>
          <span data-settings-host-last-line className="font-mono text-[11px] break-all text-fg select-text">
            {failure.line}
          </span>
        </p>
        <p data-settings-host-fix>{failure.fix}</p>
        <TryByHand host={host} />
      </div>
    )
  }
  if (connection.state === 'missing') {
    return (
      <div data-settings-host-missing className="mt-2 text-[11.5px] leading-[1.5] text-fg-muted">
        <p data-settings-host-last-line className="font-mono text-[11px] break-all text-fg select-text">
          {connection.lastLine}
        </p>
        <p className="mt-1">
          {host.name}’s login has no floti to run. Install floti there, over the same login, with no admin rights.
        </p>
        <TryByHand host={host} />
      </div>
    )
  }
  if (connection.state === 'tooOld') {
    return (
      <p data-settings-host-too-old className="mt-2 text-[11.5px] leading-[1.5] text-fg-muted">
        {host.name}’s floti is too old for this Helm: it speaks protocol{' '}
        <span className="font-mono text-fg">{connection.host}</span>, and this Helm speaks{' '}
        <span className="font-mono text-fg">{connection.client}</span>. Update floti there.
      </p>
    )
  }
  if (connection.state === 'newer') {
    return (
      <p data-settings-host-newer className="mt-2 text-[11.5px] leading-[1.5] text-fg-muted">
        {host.name} runs a newer floti than this Helm: it speaks protocol{' '}
        <span className="font-mono text-fg">{connection.host}</span>, and this Helm speaks{' '}
        <span className="font-mono text-fg">{connection.client}</span>. Update Helm on this PC, then it connects.
      </p>
    )
  }
  if (connection.state === 'startsAtSignIn') {
    return (
      <p data-settings-host-starts-at-sign-in className="mt-2 text-[11.5px] leading-[1.5] text-fg-muted">
        floti is installed on {host.name}. Nobody is signed in there, so its host starts at the next sign-in, and Helm
        connects then.
      </p>
    )
  }
  return null
}

/** Why a host's link cannot connect, said as the add-a-host dialog says it. */
function failureOf(host: RemoteHost, lastLine: string): ReturnType<typeof classifyHostFailure> {
  return classifyHostFailure({ name: host.name, transport: host.transport, lastLine, step: 'connect' })
}

/**
 * The line to try by hand in a terminal, where ssh or the command can ask for
 * what it needs: Helm never answers it, and changes nothing of ssh's setup.
 */
function TryByHand({ host }: { host: RemoteHost }): JSX.Element {
  return (
    <p className="mt-1">
      Try it by hand in a terminal:{' '}
      <span data-settings-host-try className="font-mono text-[11px] text-fg select-text">
        {lineToTryByHand(host)}
      </span>
    </p>
  )
}

// ---------------------------------------------------------------------------
// Checking a host's computer, and installing or updating floti there
// ---------------------------------------------------------------------------

type FlowStage =
  | { step: 'checking'; transport: HostTransport | null }
  | { step: 'offer'; id: string; host: string; offer: InstallOffer }
  | { step: 'working'; offer: InstallOffer }
  | { step: 'problem'; title: string; line: string | null; fix: string }

interface InstallFlow {
  /** What to draw for where the flow stands, or null when it is not running. */
  panel: ReactNode
  /**
   * Checks `target`'s computer. With floti ready there it calls `done` with
   * nothing installed; otherwise it shows the offer and, on a yes, installs
   * for host `id` and calls `done` with the path it installed at. Either way
   * `done` is given that computer's OS and CPU.
   */
  start: (
    target: HostCheckTarget,
    host: RemoteHost,
    done: (outcome: { floti: string | undefined; system: HostSystem }) => void
  ) => void
}

/**
 * The check, the offer and the install, as one small state machine for a
 * host's row: nothing is copied to or run on that computer
 * until the offer's button is pressed, and Cancel forgets the offer.
 */
function useInstallFlow(actions: HostInstallActions): InstallFlow {
  const [stage, setStage] = useState<FlowStage | null>(null)
  // The host the flow runs for, set as it starts.
  const [who, setWho] = useState<RemoteHost | null>(null)
  const name = who?.name ?? ''
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const done = useRef<(outcome: { floti: string | undefined; system: HostSystem }) => void>(() => undefined)
  const show = (next: FlowStage | null): void => {
    if (live.current) setStage(next)
  }

  const checked = (check: HostCheck, host: RemoteHost): void => {
    const { name, id, transport } = host
    if (check.kind === 'ready') {
      show(null)
      done.current({ floti: undefined, system: hostSystem(check.system) })
    } else if (check.kind === 'offer') {
      show({ step: 'offer', id: check.id, host: id, offer: check.offer })
    } else if (check.kind === 'newer') {
      show({
        step: 'problem',
        title: `${name}’s floti is newer than this Helm`,
        line: `${name} runs floti ${check.found.version}, which speaks protocol ${check.found.protocol ?? 'unknown'}; this Helm speaks ${check.ours}.`,
        fix: 'Update Helm on this PC, then try again. Nothing was added.'
      })
    } else if (check.kind === 'noBuild') {
      show({
        step: 'problem',
        title: `There is no floti Helm can install on ${name}`,
        line: check.reason,
        fix: `Nothing was installed or added: that computer (${check.system.label}) can’t be a host yet.`
      })
    } else {
      show({
        step: 'problem',
        title: `Helm could not check ${name}`,
        line: check.lastLine,
        fix: transportFix(transport)
      })
    }
  }

  const start: InstallFlow['start'] = (target, host, then) => {
    done.current = then
    setWho(host)
    show({ step: 'checking', transport: host.transport })
    actions.check(target).then(
      (check) => checked(check, host),
      (error: unknown) =>
        show({
          step: 'problem',
          title: `Helm could not check ${host.name}`,
          line: (error as Error).message,
          fix: 'Try again.'
        })
    )
  }

  const cancel = (): void => {
    if (stage?.step === 'offer') actions.cancel(stage.id)
    show(null)
  }

  const confirm = (): void => {
    if (stage?.step !== 'offer') return
    const { id, host, offer } = stage
    show({ step: 'working', offer })
    actions.install(id, host).then(
      (outcome) => {
        if (outcome.ok) {
          show(null)
          done.current({ floti: outcome.floti, system: hostSystem(offer.system) })
          return
        }
        const words = describeInstallFailure(outcome.step, name, offer.folder)
        show({ step: 'problem', title: words.title, line: outcome.lastLine, fix: words.fix })
      },
      (error: unknown) =>
        show({
          step: 'problem',
          title: `Installing floti on ${name} failed`,
          line: (error as Error).message,
          fix: 'Try again.'
        })
    )
  }

  let panel: ReactNode = null
  if (stage?.step === 'checking') {
    panel = (
      <p data-settings-host-checking className="text-[11.5px] leading-[1.5] text-fg-muted">
        Checking {name}: asking it through{' '}
        <span className="font-mono">{stage.transport === null ? 'its login' : describeTransport(stage.transport)}</span>,
        in batch mode, whether floti is there and which version. Nothing is changed there.
      </p>
    )
  } else if (stage?.step === 'offer') {
    panel = <OfferPanel name={name} offer={stage.offer} onCancel={cancel} onConfirm={confirm} />
  } else if (stage?.step === 'working') {
    panel = (
      <p data-settings-host-working className="text-[11.5px] leading-[1.5] text-fg-muted">
        {stage.offer.action === 'install' ? 'Installing' : 'Updating'} floti {stage.offer.version} on {name}…
      </p>
    )
  } else if (stage?.step === 'problem') {
    panel = (
      <div
        role="alert"
        data-settings-host-problem
        className="flex flex-col gap-1 rounded-well border border-border bg-surface-sunken p-3"
      >
        <p className="text-[12.5px] text-danger">{stage.title}</p>
        {stage.line !== null && stage.line !== '' && (
          <p data-settings-host-problem-line className="font-mono text-[11px] break-words text-fg select-text">
            {stage.line}
          </p>
        )}
        {stage.fix !== '' && <p className="text-[11.5px] leading-[1.5] text-fg-muted">{stage.fix}</p>}
        <div className="mt-1 flex gap-2">
          <Action data-settings-host-problem-back onClick={() => show(null)}>
            Back
          </Action>
        </div>
      </div>
    )
  }
  return { panel, start }
}

const sessionsWord = (n: number): string => `${String(n)} ${n === 1 ? 'session' : 'sessions'}`

/** The offer's button: what it installs or updates, and how many sessions an update ends. */
export function installButtonLabel(name: string, offer: InstallOffer): string {
  const { action, sessions } = offer
  if (action === 'install') return `Install on ${name}`
  return sessions !== null && sessions > 0
    ? `Update floti on ${name}, ending ${sessionsWord(sessions)}`
    : `Update floti on ${name}`
}

/** The offer's question: `Install floti on build-box?`. */
export function installQuestion(name: string, offer: InstallOffer): string {
  return offer.action === 'update' ? `Update floti on ${name}?` : `Install floti on ${name}?`
}

/**
 * What installing or updating floti on a host's computer would do, and where,
 * before anything is done: the row's offer and the add-a-host dialog's install
 * screen both say it this way.
 */
export function OfferDetails({ name, offer }: { name: string; offer: InstallOffer }): JSX.Element {
  const { system, found, action, how, version, folder, sessions } = offer
  const update = action === 'update'
  return (
    <>
      <p className="text-[11.5px] leading-[1.5] text-fg-muted">
        {update
          ? `${name} has floti ${found?.version ?? ''}, too old for this Helm to talk to. Helm can update it to ${version} now, as you, with no admin rights.`
          : `${name} answers, but floti is not installed there. Helm can install it now, as you, with no admin rights.`}
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-fg-muted">
        <span className="text-fg">{name}</span>
        <span data-settings-host-offer-system>{system.label}</span>
        <span data-settings-host-offer-found>
          {found === null
            ? 'floti not found'
            : `floti ${found.version}${found.protocol !== null ? ` · protocol ${found.protocol}` : ''}`}
        </span>
      </div>
      <p className="text-[11.5px] text-fg-muted">What it does on {name}</p>
      <ul data-settings-host-offer-steps className="list-disc pl-4 text-[11.5px] leading-[1.5] text-fg">
        {update && (
          <li>
            {sessions === 0
              ? 'Stops the floti host there for the update; no session is running there'
              : `Stops the floti host there for the update, ending ${sessions === null ? 'the sessions it runs' : sessionsWord(sessions)}; they are offered back with claude --resume when it starts again`}
          </li>
        )}
        <li>
          {how === 'copy'
            ? `Copies this PC’s floti ${version} over the same login and checks its SHA-256 there`
            : `Downloads floti ${version} for ${system.label} from its release and checks the SHA-256`}
        </li>
        <li>
          Puts it in <span className="font-mono">{folder}</span>
        </li>
        <li>Runs floti setup: the host starts now, and again at each sign-in</li>
      </ul>
      {how === 'download' && (
        <p className="text-[11px] leading-[1.5] text-fg-subtle">
          This PC has no floti for {system.label}, so {name} fetches its own. This PC sends only to {name}.
        </p>
      )}
    </>
  )
}

/** A host row's offer, with its Cancel and its button. */
function OfferPanel({
  name,
  offer,
  onCancel,
  onConfirm
}: {
  name: string
  offer: InstallOffer
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <div
      data-settings-host-offer={offer.action}
      className="flex flex-col gap-2 rounded-well border border-border bg-surface-sunken p-3"
    >
      <p className="text-[12.5px] text-fg">{installQuestion(name, offer)}</p>
      <OfferDetails name={name} offer={offer} />
      <div className="mt-1 flex gap-2">
        <Action data-settings-host-offer-cancel onClick={onCancel}>
          Cancel
        </Action>
        <Action primary data-settings-host-install onClick={onConfirm}>
          {installButtonLabel(name, offer)}
        </Action>
      </div>
    </div>
  )
}
