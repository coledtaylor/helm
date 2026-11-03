import { useEffect, useEffectEvent, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  DEFAULT_PAIRING_ROLE,
  describeInstallFailure,
  describeTransport,
  type HostCheck,
  type HostCheckTarget,
  type InstallOffer,
  type InstallOutcome,
  type DeviceRoleName,
  type HostTransport,
  type PairingRole,
  type QuitSessions,
  type RemoteHost,
  type RemoteHostConnection,
  remoteHostFromDraft,
  type RemoteHostDraft,
  REMOTE_CONNECT_LINE,
  transportFix
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import { Chip, type ChipTone } from './Chip'
import { Action, Divider, Group, Select } from './SettingsKit'

/**
 * Settings > Hosts: the hosts on other computers this device reaches, each
 * with how it is reached, where its link stands, what quitting does to the
 * sessions this device started there, and Remove; and a small form that adds
 * one by an ssh target or a command, and the role this PC is approved with
 * there as it pairs.
 *
 * Everything here is kept on this device (`hosts` and `quitSessions`) and
 * written through `settings:write`. Removing a host forgets it here and ends
 * nothing on it. Where each link stands is the desktop's to say
 * (`connection`); null while it has said nothing.
 *
 * Adding a host checks its computer first, through the same login and in
 * batch mode, and adds it only once floti there can talk to this Helm. When
 * floti is missing or too old there, the form says what installing or
 * updating it would do and where, and does it only after the user's yes; a
 * host already added whose floti is too old or missing offers the same.
 * Every failure shows the last line written there, unedited, with the fix.
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
  /** Adds a host the form checked, with a fresh id. */
  onAdd: (host: RemoteHost) => void
  /** Forgets a host on this device, with its quit choice. Ends nothing there. */
  onRemove: (id: string) => void
  onQuitChange: (id: string, choice: QuitSessions) => void
  /** Whether the add form is open; the page's Add a host… button opens it. */
  adding: boolean
  onAddingChange: (adding: boolean) => void
  install: HostInstallActions
  /** Floti was installed or updated on host `id`, at `floti` there. */
  onInstalled: (id: string, floti: string) => void
  /** Starts updating that host's floti, as its Update floti button does: from the sidebar. */
  updateRequest?: { id: string; nonce: number } | null | undefined
}

const CONNECTION_CHIP: Record<RemoteHostConnection['state'], { tone: ChipTone; label: string }> = {
  connected: { tone: 'success', label: 'Connected' },
  retrying: { tone: 'warn', label: 'Not connected, retrying' },
  pairing: { tone: 'warn', label: 'Not paired' },
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
  adding,
  onAddingChange,
  install,
  onInstalled,
  updateRequest = null
}: HostsSettingsProps): JSX.Element {
  return (
    <Group
      name="hosts"
      title="Hosts"
      hint="Hosts on your other computers, reached with your own ssh or a command you choose. Each runs its own sessions."
    >
      {adding && (
        <>
          <AddHostForm
            hosts={hosts.map((entry) => entry.host)}
            install={install}
            onAdd={(host) => {
              onAdd(host)
              onAddingChange(false)
            }}
            onCancel={() => onAddingChange(false)}
          />
          {hosts.length > 0 && <Divider />}
        </>
      )}
      {hosts.length === 0 && !adding && (
        <p data-settings-hosts-empty className="py-1.5 text-[12px] text-fg-muted">
          No other hosts yet. Add one with the target you give ssh, such as build-box or you@build-box.
        </p>
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
  updateRequest
}: {
  entry: SettingsHost
  onRemove: (id: string) => void
  onQuitChange: (id: string, choice: QuitSessions) => void
  install: HostInstallActions
  onInstalled: (id: string, floti: string) => void
  /** Changes each time the sidebar asks to update this host's floti. */
  updateRequest: number | null
}): JSX.Element {
  const { host, quit, connection } = entry
  const chip = connection === null ? null : CONNECTION_CHIP[connection.state]
  const flow = useInstallFlow(install)
  const startUpdate = (): void =>
    flow.start({ host: host.id }, host, ({ floti }) => {
      if (floti !== undefined) onInstalled(host.id, floti)
    })
  const requested = useEffectEvent(startUpdate)
  useEffect(() => {
    if (updateRequest !== null) requested()
  }, [updateRequest])
  const offersUpdate = connection?.state === 'tooOld' || connection?.state === 'missing'
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
        {chip !== null && (
          <Chip tone={chip.tone}>{chip.label}</Chip>
        )}
        {connection?.state === 'connected' && connection.role !== undefined && (
          <span data-settings-host-role={connection.role} className="text-[11.5px] text-fg-muted">
            {ROLE_LABEL[connection.role]}
          </span>
        )}
      </div>
      <p
        data-settings-host-reached
        className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle select-text"
        title={describeTransport(host.transport)}
      >
        {describeTransport(host.transport)}
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
        <Action data-settings-host-remove={host.id} onClick={() => onRemove(host.id)}>
          Remove
        </Action>
      </div>
    </div>
  )
}

/** What a link that is not simply connected or retrying needs from the user. */
function ConnectionDetail({ connection, host }: { connection: RemoteHostConnection; host: RemoteHost }): ReactNode {
  if (connection.state === 'pairing') {
    return (
      <div data-settings-host-pairing className="mt-2 text-[11.5px] leading-[1.5] text-fg-muted">
        {connection.approvalFailed !== undefined && (
          <>
            <p>Helm could not approve this PC on {host.name} itself. It said:</p>
            <p
              data-settings-host-approval-failed
              className="mt-1 mb-2 font-mono text-[11px] break-all text-fg select-text"
            >
              {connection.approvalFailed}
            </p>
          </>
        )}
        <p>This PC is not paired with {host.name} yet. To approve it, run this in a terminal there:</p>
        <p className="mt-1 font-mono text-[11.5px] text-fg select-text">floti devices approve {connection.code}</p>
      </div>
    )
  }
  if (connection.state === 'failed') {
    return (
      <div data-settings-host-failed className="mt-2 text-[11.5px] leading-[1.5] text-fg-muted">
        <p className="font-mono text-[11px] break-all text-fg select-text">{connection.lastLine}</p>
        <p className="mt-1">{transportFix(host.transport)}</p>
      </div>
    )
  }
  if (connection.state === 'missing') {
    return (
      <div data-settings-host-missing className="mt-2 text-[11.5px] leading-[1.5] text-fg-muted">
        <p className="font-mono text-[11px] break-all text-fg select-text">{connection.lastLine}</p>
        <p className="mt-1">
          {host.name}’s login has no floti to run. Install floti there, over the same login, with no admin rights.
        </p>
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
   * for host `id` and calls `done` with the path it installed at.
   */
  start: (target: HostCheckTarget, host: RemoteHost, done: (outcome: { floti: string | undefined }) => void) => void
}

/**
 * The check, the offer and the install, as one small state machine shared by
 * the add form and a host's row: nothing is copied to or run on that computer
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
  const done = useRef<(outcome: { floti: string | undefined }) => void>(() => undefined)
  const show = (next: FlowStage | null): void => {
    if (live.current) setStage(next)
  }

  const checked = (check: HostCheck, host: RemoteHost): void => {
    const { name, id, transport } = host
    if (check.kind === 'ready') {
      show(null)
      done.current({ floti: undefined })
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
          done.current({ floti: outcome.floti })
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

/** What installing or updating floti on a host's computer would do, and where, before anything is done. */
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
  const { system, found, action, how, version, folder, sessions } = offer
  const update = action === 'update'
  const button = update
    ? sessions !== null && sessions > 0
      ? `Update floti on ${name}, ending ${sessionsWord(sessions)}`
      : `Update floti on ${name}`
    : `Install on ${name}`
  return (
    <div
      data-settings-host-offer={action}
      className="flex flex-col gap-2 rounded-well border border-border bg-surface-sunken p-3"
    >
      <p className="text-[12.5px] text-fg">{update ? `Update floti on ${name}?` : `Install floti on ${name}?`}</p>
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
      <div className="mt-1 flex gap-2">
        <Action data-settings-host-offer-cancel onClick={onCancel}>
          Cancel
        </Action>
        <Action primary data-settings-host-install onClick={onConfirm}>
          {button}
        </Action>
      </div>
    </div>
  )
}

const VIA_LABEL: Record<HostTransport['kind'], string> = { ssh: 'ssh', command: 'Command' }

/** A role, as Settings names it. */
export const ROLE_LABEL: Record<DeviceRoleName, string> = { admin: 'Admin', operator: 'Operator', viewer: 'Viewer' }

const PAIRING_ROLE_HINT: Record<PairingRole, string> = {
  admin: 'This PC can do everything there, pairing and revoking devices included.',
  operator: 'This PC can start, use and end sessions there, but not pair or revoke devices or change its settings.'
}

/** A small choice of a few words, one picked: the segmented control the add forms use. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  name
}: {
  label: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  /** Each option's `data-<name>` attribute, for tests and drivers. */
  name: string
}): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex w-fit items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          {...{ [`data-${name}`]: option.value }}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-raised px-2.5 py-1 text-[11.5px] transition-colors',
            value === option.value ? SEGMENT_ON : 'text-fg-subtle hover:text-fg'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const VIA_HINT: Record<HostTransport['kind'], string> = {
  ssh: `Helm runs your own ssh with this target, exactly as typed, and ${REMOTE_CONNECT_LINE} there. It uses your ssh config, keys and agent, never asks for a password and keeps none.`,
  command: `Run without a shell, with ${REMOTE_CONNECT_LINE} added as its last argument. It must carry input and output unchanged and ask nothing.`
}

const FIELD = cn(
  'h-[30px] w-full rounded-well border border-border bg-surface-sunken px-2.5',
  'text-[12px] text-fg placeholder:text-fg-subtle select-text',
  'focus:border-accent focus:outline-none'
)

/** Name, and an ssh target or a command line. Checked as typed is submitted; nothing is written until it passes. */
function AddHostForm({
  hosts,
  install,
  onAdd,
  onCancel
}: {
  hosts: readonly RemoteHost[]
  install: HostInstallActions
  onAdd: (host: RemoteHost) => void
  onCancel: () => void
}): JSX.Element {
  const [draft, setDraft] = useState<RemoteHostDraft>({
    name: '',
    via: 'ssh',
    target: '',
    command: '',
    role: DEFAULT_PAIRING_ROLE
  })
  const [error, setError] = useState<string | null>(null)
  const edit = (patch: Partial<RemoteHostDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    setError(null)
  }
  const flow = useInstallFlow(install)
  const submit = (): void => {
    const result = remoteHostFromDraft(draft, hosts, globalThis.crypto.randomUUID())
    if (!result.ok) {
      setError(result.error)
      return
    }
    const { host } = result
    // Added only once floti there can talk to this Helm, with the path Helm
    // installed it at when it did.
    flow.start({ transport: host.transport }, host, ({ floti }) =>
      onAdd(floti === undefined ? host : { ...host, floti })
    )
  }

  if (flow.panel !== null) {
    return (
      <div data-settings-host-form aria-label="Add a host" role="form" className="flex flex-col gap-3 py-2">
        {flow.panel}
      </div>
    )
  }

  return (
    <form
      data-settings-host-form
      aria-label="Add a host"
      className="flex flex-col gap-3 py-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-fg-muted">Name</span>
        <input
          type="text"
          data-settings-host-name
          aria-label="Host name"
          placeholder={draft.via === 'ssh' ? 'The ssh target, unless you name it' : 'build-box'}
          spellCheck={false}
          autoFocus
          value={draft.name}
          onChange={(event) => edit({ name: event.target.value })}
          className={cn(FIELD, 'max-w-[280px]')}
        />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-[12px] text-fg-muted">Reached with</span>
        <Segmented
          label="Reached with"
          name="settings-host-via"
          options={(['ssh', 'command'] as const).map((via) => ({ value: via, label: VIA_LABEL[via] }))}
          value={draft.via}
          onChange={(via) => edit({ via })}
        />
        {draft.via === 'ssh' ? (
          <input
            type="text"
            data-settings-host-target
            aria-label="ssh target"
            placeholder="you@build-box, or a Host from ~/.ssh/config"
            spellCheck={false}
            value={draft.target}
            onChange={(event) => edit({ target: event.target.value })}
            className={cn(FIELD, 'mt-1 font-mono text-[11.5px]')}
          />
        ) : (
          <input
            type="text"
            data-settings-host-command
            aria-label="Command"
            placeholder="wsl.exe -d Ubuntu --"
            spellCheck={false}
            value={draft.command}
            onChange={(event) => edit({ command: event.target.value })}
            className={cn(FIELD, 'mt-1 font-mono text-[11.5px]')}
          />
        )}
        <p className="text-[11px] leading-[1.5] text-fg-subtle">{VIA_HINT[draft.via]}</p>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[12px] text-fg-muted">This PC's role there</span>
        <Segmented
          label="This PC's role there"
          name="settings-host-role"
          options={(['admin', 'operator'] as const).map((role) => ({ value: role, label: ROLE_LABEL[role] }))}
          value={draft.role}
          onChange={(role) => edit({ role })}
        />
        <p className="text-[11px] leading-[1.5] text-fg-subtle">
          {PAIRING_ROLE_HINT[draft.role]} Helm approves this PC with it over the same connection as it pairs.
        </p>
      </div>
      {error !== null && (
        <p role="alert" data-settings-host-error className="text-[12px] text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          data-settings-host-add
          className="rounded-well border border-accent px-3 py-1.5 text-[12px] text-accent-text transition-colors hover:bg-accent-soft"
        >
          Add host
        </button>
        <Action onClick={onCancel}>Cancel</Action>
      </div>
    </form>
  )
}
