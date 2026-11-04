import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  classifyHostFailure,
  describeAgents,
  describeHostSystem,
  describeTransport,
  hostSystem,
  lineToTryByHand,
  REMOTE_CONNECT_LINE,
  remoteHostFromDraft,
  sameDistro,
  wslHostName,
  type AgentRow,
  type HostAddOutcome,
  type HostAddRequest,
  type HostCheck,
  type HostCheckTarget,
  type HostFailure,
  type HostFailureInput,
  type HostTransport,
  type InstallOffer,
  type InstallOutcome,
  type QuitSessions,
  type RemoteHost,
  type RemoteSystem,
  type SshConfigHosts,
  type WslDistroList
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { Chip, type ChipTone } from './Chip'
import {
  DialogFooter,
  DialogHeader,
  DialogProblem,
  dialogInput,
  dialogLabel,
  primaryButton,
  secondaryButton
} from './DialogParts'
import { installButtonLabel, installQuestion, OfferDetails } from './HostsSettings'
import { CheckIcon, RefreshIcon, ServerIcon } from './icons'
import { Overlay } from './Overlay'

/**
 * Adding a host on another computer, as one dialog of five screens: pick a
 * host, checking it, installing floti there (only when it is missing or too
 * old), added, and the failure screen any step can end on.
 *
 * Adding is connecting. The dialog asks main to check the computer through
 * the user's own ssh or command (`check`), to install floti there after the
 * user's yes (`install`), then to add the host (`add`): main makes the first
 * connection, which pins the host's key, and only then writes the host. Until
 * Connect nothing is contacted: the pick screen reads only the Host names of
 * this computer's ssh config (`sshHosts`), and the WSL distros on this PC and
 * on each connected Windows host (`wslDistros`), which `wsl.exe --list` reads
 * without starting one. A distro picked is checked, installed into and
 * reached through `wsl.exe -d <distro> --`, here or through that PC's ssh,
 * the same way. Cancel or close stops what is running (`cancelAdd`,
 * `cancelInstall`), and nothing is added or kept.
 *
 * The user's login is the access: there is no pairing code, approval, role or
 * prompt, and Helm never asks for a password or accepts a host key. Every
 * failure says what went wrong the one way Settings > Hosts says it
 * (`classifyHostFailure`), with the last line written, unedited, and the fix.
 */

/** What the dialog asks the desktop to do. */
export interface AddHostActions {
  /** The Host names of this computer's ssh config and the files it includes. */
  sshHosts: () => Promise<SshConfigHosts>
  /** The WSL distros on this PC and on each connected Windows host; none are listed when absent. */
  wslDistros?: () => Promise<WslDistroList[]>
  check: (target: HostCheckTarget) => Promise<HostCheck>
  /** Does what the check with `id` offered; `host` names what it is for. */
  install: (id: string, host: string) => Promise<InstallOutcome>
  /** Forgets the offer with `id`, and what it was doing. */
  cancelInstall: (id: string) => void
  add: (request: HostAddRequest) => Promise<HostAddOutcome>
  /** Stops the check or the connection made under `attempt`. */
  cancelAdd: (attempt: string) => void
}

export interface AddHostDialogProps {
  actions: AddHostActions
  /** The hosts this device has, so a name is not given twice. */
  hosts: readonly RemoteHost[]
  /** Writes what quitting Helm does to the sessions it starts on the added host. */
  onQuitChange: (id: string, choice: QuitSessions) => void
  onClose: () => void
  /** Mints the id of each check and connection; the browser's random UUID when absent. */
  newAttempt?: () => string
}

/** What is being added: the name it gets here and how it is reached. */
interface Subject {
  name: string
  transport: HostTransport
}

/** Which step of checking, installing and connecting is running. */
type Phase = 'check' | 'install' | 'connect'

/** What Try again runs again. */
type Retry = { step: 'check' } | { step: 'connect'; floti: string | undefined; system: RemoteSystem | null }

type Screen =
  | { step: 'pick' }
  | { step: 'checking'; phase: Phase; installed: boolean }
  | { step: 'install'; id: string; offer: InstallOffer }
  | {
      step: 'added'
      host: RemoteHost
      version: string
      system: RemoteSystem | null
      agents: AgentRow[] | null
      agentsError: string | null
      quit: QuitSessions
    }
  | { step: 'failed'; failure: HostFailure; retry: Retry }

/** A distro picked from a WSL list: its name, and the PC it is on. */
interface PickedDistro {
  distro: string
  /** The ssh target of the Windows PC, or null for this PC. */
  through: string | null
  /** That PC's name in Helm, for the name the host gets. */
  pcName: string
}

interface Draft {
  via: HostTransport['kind']
  /** The Host picked from the ssh config list. */
  picked: string | null
  /** The distro picked from a WSL list, read when `via` is `wsl`. */
  distro: PickedDistro | null
  /** A target typed instead. */
  target: string
  command: string
  name: string
  /** Once the user edits the name it stops following the pick. */
  named: boolean
}

const EMPTY_DRAFT: Draft = { via: 'ssh', picked: null, distro: null, target: '', command: '', name: '', named: false }

/** The ssh target the draft names: the typed one, or else the pick. */
function targetOf(draft: Draft): string {
  return draft.target.trim() !== '' ? draft.target.trim() : (draft.picked ?? '')
}

/** The name the draft gives the host: as typed once edited, or else what it follows. */
function nameOf(draft: Draft): string {
  if (draft.named) return draft.name
  if (draft.via === 'wsl' && draft.distro !== null) {
    const { distro, through, pcName } = draft.distro
    return wslHostName(distro, through === null ? undefined : pcName)
  }
  return draft.via === 'ssh' ? targetOf(draft) : ''
}

const randomAttempt = (): string => globalThis.crypto.randomUUID()

export function AddHostDialog({
  actions,
  hosts,
  onQuitChange,
  onClose,
  newAttempt = randomAttempt
}: AddHostDialogProps): JSX.Element {
  const [screen, setScreen] = useState<Screen>({ step: 'pick' })
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [problem, setProblem] = useState<string | null>(null)
  const [sshList, setSshList] = useState<SshConfigHosts | null>(null)
  const [wslLists, setWslLists] = useState<WslDistroList[] | null>(null)
  const [subject, setSubject] = useState<Subject | null>(null)
  // The check or connection running, which Cancel stops, and the offer shown,
  // which Cancel forgets. A result that comes back for an earlier run, or
  // after the dialog closed, is dropped.
  const running = useRef<{ run: number; attempt: string | null; offer: string | null }>({
    run: 0,
    attempt: null,
    offer: null
  })
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    let current = true
    actions.sshHosts().then(
      (list) => {
        if (current) setSshList(list)
      },
      () => {
        if (current) setSshList({ found: false, hosts: [] })
      }
    )
    const listing = actions.wslDistros?.() ?? Promise.resolve([])
    listing.then(
      (lists) => {
        if (current) setWslLists(lists)
      },
      () => {
        if (current) setWslLists([])
      }
    )
    return () => {
      current = false
      live.current = false
    }
    // Read once, as the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Starts a run, and says whether a result is still its run's to show. */
  const begin = (attempt: string | null): (() => boolean) => {
    const run = running.current.run + 1
    running.current = { run, attempt, offer: null }
    return () => live.current && running.current.run === run
  }

  /** Stops whatever is running, and forgets an offer shown. */
  const stop = (): void => {
    const { attempt, offer, run } = running.current
    if (attempt !== null) actions.cancelAdd(attempt)
    if (offer !== null) actions.cancelInstall(offer)
    running.current = { run: run + 1, attempt: null, offer: null }
  }

  const cancel = (): void => {
    stop()
    onClose()
  }

  const fail = (who: Subject, input: Omit<HostFailureInput, 'name' | 'transport'>, retry: Retry): void => {
    running.current = { ...running.current, attempt: null }
    setScreen({ step: 'failed', failure: classifyHostFailure({ ...input, ...who }), retry })
  }

  const connect = (who: Subject, floti: string | undefined, system: RemoteSystem | null, installed: boolean): void => {
    const attempt = newAttempt()
    const current = begin(attempt)
    setScreen({ step: 'checking', phase: 'connect', installed })
    const request: HostAddRequest = {
      attempt,
      name: who.name,
      transport: who.transport,
      ...(floti === undefined ? {} : { floti }),
      ...(system === null ? {} : { system: hostSystem(system) })
    }
    const retry: Retry = { step: 'connect', floti, system }
    actions.add(request).then(
      (outcome) => {
        if (!current()) return
        running.current = { ...running.current, attempt: null }
        if (outcome.kind === 'added') {
          setScreen({
            step: 'added',
            host: outcome.host,
            version: outcome.version,
            system,
            agents: outcome.agents === null ? null : describeAgents(outcome.agents, system?.os ?? null),
            agentsError: outcome.agentsError ?? null,
            quit: 'keep'
          })
        } else if (outcome.kind === 'failed') {
          fail(who, { lastLine: outcome.lastLine, cause: outcome.cause, step: 'connect' }, retry)
        }
      },
      (error: unknown) => {
        if (current()) fail(who, { lastLine: (error as Error).message, step: 'connect' }, retry)
      }
    )
  }

  const checked = (who: Subject, check: HostCheck): void => {
    const retry: Retry = { step: 'check' }
    if (check.kind === 'ready') {
      connect(who, undefined, check.system, false)
    } else if (check.kind === 'offer') {
      running.current = { ...running.current, attempt: null, offer: check.id }
      setScreen({ step: 'install', id: check.id, offer: check.offer })
    } else if (check.kind === 'newer') {
      fail(
        who,
        {
          lastLine: `floti ${check.found.version}${check.found.protocol === null ? '' : ` protocol ${check.found.protocol}`}`,
          cause: { kind: 'newer', host: check.found.version, ours: check.helm, by: 'version' },
          step: 'check'
        },
        retry
      )
    } else if (check.kind === 'noBuild') {
      fail(who, { lastLine: check.reason, cause: { kind: 'noBuild', system: check.system.label }, step: 'check' }, retry)
    } else {
      fail(
        who,
        {
          lastLine: check.lastLine,
          said: check.said,
          cause: check.cause === undefined ? undefined : { kind: check.cause },
          step: 'check'
        },
        retry
      )
    }
  }

  const runCheck = (who: Subject): void => {
    const attempt = newAttempt()
    const current = begin(attempt)
    setScreen({ step: 'checking', phase: 'check', installed: false })
    actions.check({ transport: who.transport, attempt }).then(
      (check) => {
        if (current()) checked(who, check)
      },
      (error: unknown) => {
        if (current()) fail(who, { lastLine: (error as Error).message, step: 'check' }, { step: 'check' })
      }
    )
  }

  const start = (): void => {
    const picked = draft.via === 'wsl' ? draft.distro : null
    const result = remoteHostFromDraft(
      {
        via: draft.via,
        name: nameOf(draft),
        target: targetOf(draft),
        command: draft.command,
        ...(picked === null ? {} : { distro: picked.distro }),
        ...(picked === null || picked.through === null ? {} : { through: picked.through })
      },
      hosts,
      'adding'
    )
    if (!result.ok) {
      setProblem(result.error)
      return
    }
    const who = { name: result.host.name, transport: result.host.transport }
    setSubject(who)
    runCheck(who)
  }

  const install = (who: Subject, id: string, offer: InstallOffer): void => {
    const current = begin(null)
    running.current = { ...running.current, offer: id }
    setScreen({ step: 'checking', phase: 'install', installed: false })
    // Main's install names what it is for by a host id; a host being added
    // has none yet, so the offer's own id stands in.
    actions.install(id, id).then(
      (outcome) => {
        if (!current()) return
        running.current = { ...running.current, offer: null }
        if (outcome.ok) {
          connect(who, outcome.floti, offer.system, true)
          return
        }
        fail(
          who,
          { lastLine: outcome.lastLine, cause: { kind: 'install', step: outcome.step, folder: offer.folder } },
          { step: 'check' }
        )
      },
      (error: unknown) => {
        if (!current()) return
        fail(
          who,
          { lastLine: (error as Error).message, cause: { kind: 'install', step: 'install', folder: offer.folder } },
          { step: 'check' }
        )
      }
    )
  }

  const back = (): void => {
    stop()
    setScreen({ step: 'pick' })
  }

  const tryAgain = (who: Subject, retry: Retry): void => {
    if (retry.step === 'check') runCheck(who)
    else connect(who, retry.floti, retry.system, retry.floti !== undefined)
  }

  const another = (): void => {
    running.current = { run: running.current.run + 1, attempt: null, offer: null }
    setDraft(EMPTY_DRAFT)
    setProblem(null)
    setSubject(null)
    setScreen({ step: 'pick' })
  }

  const edit = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    setProblem(null)
  }

  const name = subject?.name ?? ''
  let title = 'Add a host'
  let body: ReactNode
  let footer: ReactNode
  if (screen.step === 'pick' || subject === null) {
    body = (
      <PickScreen
        draft={draft}
        list={sshList}
        wslLists={wslLists}
        hosts={hosts}
        problem={problem}
        onEdit={edit}
        onSubmit={start}
      />
    )
    footer = (
      <>
        <GhostButton data-add-host-cancel onClick={cancel}>
          Cancel
        </GhostButton>
        <span className="flex-1" />
        <button type="button" data-add-host-connect onClick={start} className={primaryButton(true)}>
          Connect
        </button>
      </>
    )
  } else if (screen.step === 'checking') {
    title = `Checking ${name}`
    body = <CheckingScreen subject={subject} phase={screen.phase} installed={screen.installed} />
    footer = (
      <>
        <GhostButton data-add-host-cancel onClick={cancel}>
          Cancel
        </GhostButton>
        <span className="flex-1" />
        <button type="button" disabled className={primaryButton(false)}>
          Connect
        </button>
      </>
    )
  } else if (screen.step === 'install') {
    title = installQuestion(name, screen.offer)
    body = (
      <div data-add-host-install={screen.offer.action} className="flex flex-col gap-2">
        <OfferDetails name={name} offer={screen.offer} />
      </div>
    )
    const { id, offer } = screen
    footer = (
      <>
        <GhostButton data-add-host-cancel onClick={cancel}>
          Cancel
        </GhostButton>
        <span className="flex-1" />
        <button type="button" data-add-host-back onClick={back} className={secondaryButton}>
          Back
        </button>
        <button
          type="button"
          data-add-host-install-confirm
          onClick={() => install(subject, id, offer)}
          className={primaryButton(true)}
        >
          {installButtonLabel(name, offer)}
        </button>
      </>
    )
  } else if (screen.step === 'added') {
    title = `${screen.host.name} is added`
    const { host } = screen
    body = (
      <AddedScreen
        screen={screen}
        onQuit={(quit) => {
          setScreen({ ...screen, quit })
          onQuitChange(host.id, quit)
        }}
      />
    )
    footer = (
      <>
        <GhostButton data-add-host-another onClick={another}>
          Add another
        </GhostButton>
        <span className="flex-1" />
        <button type="button" data-add-host-done onClick={onClose} className={primaryButton(true)}>
          Done
        </button>
      </>
    )
  } else {
    title = screen.failure.title
    body = <FailedScreen subject={subject} failure={screen.failure} />
    const { retry } = screen
    footer = (
      <>
        <GhostButton data-add-host-cancel onClick={cancel}>
          Cancel
        </GhostButton>
        <span className="flex-1" />
        <button type="button" data-add-host-back onClick={back} className={secondaryButton}>
          Back
        </button>
        <button
          type="button"
          data-add-host-retry={retry.step}
          onClick={() => tryAgain(subject, retry)}
          className={cn(primaryButton(true), 'flex items-center gap-1.5')}
        >
          <RefreshIcon width={12} height={12} />
          Try again
        </button>
      </>
    )
  }

  return (
    <Overlay
      aria-label="Add a host"
      data-add-host-dialog={screen.step}
      className="max-w-[520px]"
      // Closing is Cancel until the host is added; then it is Done.
      onDismiss={screen.step === 'added' ? onClose : cancel}
    >
      <DialogHeader
        icon={<ServerIcon width={13} height={13} />}
        title={title}
        onClose={screen.step === 'added' ? onClose : cancel}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-2 pb-4">{body}</div>
      <DialogFooter>{footer}</DialogFooter>
    </Overlay>
  )
}

function GhostButton({
  children,
  onClick,
  ...rest
}: { children: ReactNode; onClick: () => void } & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-well px-2.5 py-1.5 text-[12px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      {...rest}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Pick
// ---------------------------------------------------------------------------

const VIA_HINT: Record<HostTransport['kind'], string> = {
  ssh: 'Helm reads only the Host names in ~/.ssh/config. ssh works out the address, user and key when it connects.',
  command: `Run without a shell, with ${REMOTE_CONNECT_LINE} added as its last argument. It must carry input and output unchanged and ask nothing.`,
  wsl: `Helm runs floti in the distro with wsl.exe -d <distro> -- ${REMOTE_CONNECT_LINE}, through ssh for another PC’s. Nothing is approved in the distro.`
}

function PickScreen({
  draft,
  list,
  wslLists,
  hosts,
  problem,
  onEdit,
  onSubmit
}: {
  draft: Draft
  list: SshConfigHosts | null
  wslLists: WslDistroList[] | null
  hosts: readonly RemoteHost[]
  problem: string | null
  onEdit: (patch: Partial<Draft>) => void
  onSubmit: () => void
}): JSX.Element {
  // A distro is picked on the ssh screen, beside the ssh hosts.
  const ssh = draft.via !== 'command'
  const typed = draft.target.trim() !== ''
  return (
    <form
      data-add-host-pick
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <p className="text-[11.5px] leading-[1.55] text-fg-muted">
        A host is Helm on another computer, such as a server or your other PC. Helm reaches it with your own{' '}
        {ssh ? (
          <>
            ssh, the way <span className="font-mono">ssh {targetOf(draft) === '' ? 'build-box' : targetOf(draft)}</span>{' '}
            does in a terminal.
          </>
        ) : (
          'command, which carries its input and output.'
        )}
      </p>
      {ssh ? (
        <>
          <div className="flex flex-col gap-1.5">
            <span className={dialogLabel}>From your SSH config</span>
            <SshHostList
              list={list}
              picked={typed || draft.via === 'wsl' ? null : draft.picked}
              onPick={(picked) => onEdit({ via: 'ssh', picked, distro: null, target: '' })}
            />
          </div>
          {wslLists?.map((each) => (
            <WslDistroPicks
              key={each.through ?? ''}
              list={each}
              hosts={hosts}
              picked={draft.via === 'wsl' ? draft.distro : null}
              onPick={(distro) => onEdit({ via: 'wsl', distro, picked: null, target: '' })}
            />
          ))}
          <div className="flex gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className={dialogLabel}>Or type a target</span>
              <input
                type="text"
                data-add-host-target
                aria-label="ssh target"
                placeholder="user@host"
                spellCheck={false}
                value={draft.target}
                onChange={(event) => onEdit({ via: 'ssh', distro: null, target: event.target.value })}
                className={cn(dialogInput, 'font-mono text-[11.5px]')}
              />
            </label>
            <NameField draft={draft} onEdit={onEdit} />
          </div>
        </>
      ) : (
        <div className="flex gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className={dialogLabel}>Command</span>
            <input
              type="text"
              data-add-host-command
              aria-label="Command"
              placeholder="wsl.exe -d Ubuntu --"
              spellCheck={false}
              value={draft.command}
              onChange={(event) => onEdit({ command: event.target.value })}
              className={cn(dialogInput, 'font-mono text-[11.5px]')}
            />
          </label>
          <NameField draft={draft} onEdit={onEdit} />
        </div>
      )}
      <p className="text-[11px] leading-[1.5] text-fg-subtle">{VIA_HINT[draft.via]}</p>
      <button
        type="button"
        data-add-host-via={ssh ? 'command' : 'ssh'}
        onClick={() => onEdit({ via: ssh ? 'command' : 'ssh', distro: null })}
        className="w-fit text-[11px] text-fg-subtle underline-offset-2 transition-colors hover:text-fg hover:underline"
      >
        {ssh ? 'Reach it with a command instead' : 'Reach it with ssh instead'}
      </button>
      {problem !== null && <DialogProblem>{problem}</DialogProblem>}
      {/* Enter in a field connects. */}
      <button type="submit" hidden aria-hidden tabIndex={-1} />
    </form>
  )
}

function NameField({ draft, onEdit }: { draft: Draft; onEdit: (patch: Partial<Draft>) => void }): JSX.Element {
  return (
    <label className="flex w-[160px] shrink-0 flex-col gap-1.5">
      <span className={dialogLabel}>Name in Helm</span>
      <input
        type="text"
        data-add-host-name
        aria-label="Name in Helm"
        placeholder={draft.via === 'command' ? 'wsl-ubuntu' : draft.via === 'wsl' ? 'Ubuntu' : 'build-box'}
        spellCheck={false}
        value={nameOf(draft)}
        onChange={(event) => onEdit({ name: event.target.value, named: true })}
        className={dialogInput}
      />
    </label>
  )
}

/**
 * One PC's WSL distros: `WSL distros on this PC`, or on a Windows host. Each
 * row in mono; a distro already added shows an Added chip and is not offered
 * again. A PC with none, or no WSL, says so with the line wsl.exe wrote.
 */
function WslDistroPicks({
  list,
  hosts,
  picked,
  onPick
}: {
  list: WslDistroList
  hosts: readonly RemoteHost[]
  picked: PickedDistro | null
  onPick: (distro: PickedDistro) => void
}): JSX.Element {
  const title = `WSL distros on ${list.pcName}`
  const through = list.through ?? undefined
  const added = (distro: string): boolean =>
    hosts.some((host) =>
      sameDistro(host.transport, {
        kind: 'wsl',
        distro,
        ...(through === undefined ? {} : { through })
      })
    )
  return (
    <div data-add-host-wsl={list.through ?? 'this PC'} className="flex flex-col gap-1.5">
      <span className={dialogLabel}>{title}</span>
      {list.distros.length === 0 ? (
        <p
          data-add-host-wsl-none
          className="rounded-well border border-border bg-surface-sunken px-3 py-2 text-[11.5px] leading-[1.5] text-fg-muted"
        >
          {list.through === null ? 'This PC has no WSL distros to add.' : `${list.pcName} has no WSL distros to add.`}
          {list.said !== null && (
            <span
              data-add-host-wsl-said
              className="mt-1 block font-mono text-[11px] break-words text-fg-subtle select-text"
            >
              {list.said}
            </span>
          )}
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label={title}
          className="flex max-h-[148px] flex-col overflow-y-auto rounded-well border border-border bg-surface-sunken p-0.5"
        >
          {list.distros.map((distro) => {
            const isAdded = added(distro)
            const on = picked !== null && picked.distro === distro && picked.through === list.through
            return (
              <button
                key={distro}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={isAdded}
                data-add-host-wsl-distro={distro}
                data-add-host-wsl-added={isAdded ? '' : undefined}
                onClick={() => onPick({ distro, through: list.through, pcName: list.pcName })}
                className={cn(
                  'flex h-7 shrink-0 items-center gap-2 rounded-raised px-2 text-left font-mono text-[12px] transition-colors',
                  isAdded
                    ? 'cursor-default text-fg-subtle'
                    : on
                      ? 'bg-active text-fg'
                      : 'text-fg-muted hover:bg-hover hover:text-fg'
                )}
              >
                <ServerIcon width={13} height={13} className={cn('shrink-0', on ? 'text-accent' : 'text-fg-subtle')} />
                <span className="min-w-0 flex-1 truncate">{distro}</span>
                {isAdded && <Chip tone="neutral">Added</Chip>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SshHostList({
  list,
  picked,
  onPick
}: {
  list: SshConfigHosts | null
  picked: string | null
  onPick: (name: string) => void
}): JSX.Element {
  if (list === null) {
    return (
      <p data-add-host-ssh-reading className="text-[11.5px] text-fg-subtle">
        Reading ~/.ssh/config…
      </p>
    )
  }
  if (list.hosts.length === 0) {
    return (
      <p
        data-add-host-ssh-empty={list.found ? 'wildcards' : 'none'}
        className="rounded-well border border-border bg-surface-sunken px-3 py-2 text-[11.5px] leading-[1.5] text-fg-muted"
      >
        {list.found
          ? 'Your ssh config names no host without a wildcard. Type the target you give ssh below.'
          : 'This PC has no ssh config. Type the target you give ssh below, such as you@build-box.'}
      </p>
    )
  }
  return (
    <div
      role="radiogroup"
      aria-label="From your SSH config"
      data-add-host-ssh-list
      className="flex max-h-[148px] flex-col overflow-y-auto rounded-well border border-border bg-surface-sunken p-0.5"
    >
      {list.hosts.map((host) => (
        <button
          key={host}
          type="button"
          role="radio"
          aria-checked={picked === host}
          data-add-host-ssh-host={host}
          onClick={() => onPick(host)}
          className={cn(
            'flex h-7 shrink-0 items-center gap-2 rounded-raised px-2 text-left font-mono text-[12px] transition-colors',
            picked === host ? 'bg-active text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'
          )}
        >
          <ServerIcon width={13} height={13} className={cn('shrink-0', picked === host ? 'text-accent' : 'text-fg-subtle')} />
          <span className="min-w-0 truncate">{host}</span>
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

type StepState = 'done' | 'now' | 'wait'

/** The line the check runs, as typed by hand: `ssh -o BatchMode=yes build-box floti version`, `wsl.exe -d Debian -- floti version`. */
function checkLine(transport: HostTransport): string {
  switch (transport.kind) {
    case 'ssh':
      return `ssh -o BatchMode=yes ${transport.target} floti version`
    case 'command':
      return `${describeTransport(transport)} floti version`
    case 'wsl': {
      const wsl = `wsl.exe -d ${transport.distro} -- floti version`
      return transport.through === undefined ? wsl : `ssh -o BatchMode=yes ${transport.through} ${wsl}`
    }
  }
}

function CheckingScreen({
  subject,
  phase,
  installed
}: {
  subject: Subject
  phase: Phase
  installed: boolean
}): JSX.Element {
  const { name, transport } = subject
  // ssh carries the check and the connection, to the host or to the PC a distro is on.
  const ssh = transport.kind === 'ssh' || (transport.kind === 'wsl' && transport.through !== undefined)
  const versionLine = checkLine(transport)
  const through =
    transport.kind === 'wsl'
      ? transport.through === undefined
        ? 'wsl.exe'
        : 'your ssh and that PC’s wsl.exe'
      : transport.kind === 'ssh'
        ? 'your ssh'
        : 'your command'
  const order: Phase[] = ['check', 'install', 'connect']
  const at = order.indexOf(phase)
  const state = (step: Phase): StepState => {
    const index = order.indexOf(step)
    return index < at ? 'done' : index === at ? 'now' : 'wait'
  }
  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-[11.5px] leading-[1.55] text-fg-muted">
        Helm asks {name}, through {through}, whether floti is there and which version, then connects to it. Nothing is
        changed there without your yes.
      </p>
      <ol data-add-host-steps className="flex flex-col gap-2.5">
        <Step state={state('check')} step="check" title={`Reach ${name} and look for floti there`} line={versionLine} />
        <Step
          state={state('install')}
          step="install"
          title={
            phase === 'connect' && !installed ? 'Install floti, if it is missing: it is there' : 'Install floti, if it is missing'
          }
        />
        <Step
          state={state('connect')}
          step="connect"
          title={`Connect to ${name}`}
          line={lineToTryByHand({ transport })}
        />
        <Step state="wait" step="quit" title="Choose what quitting does there" />
      </ol>
      <p className="text-[11px] leading-[1.5] text-fg-subtle">
        {ssh
          ? 'ssh runs without a terminal, so it never stops here to ask for a password. If it needs one, Helm says so and what to do.'
          : `${transport.kind === 'wsl' ? 'wsl.exe' : 'The command'} runs without a terminal, so it never stops here to ask for anything. If it needs something, Helm shows what it said.`}
      </p>
    </div>
  )
}

function Step({
  state,
  step,
  title,
  line
}: {
  state: StepState
  step: string
  title: string
  line?: string
}): JSX.Element {
  return (
    <li data-add-host-step={step} data-add-host-step-state={state} className="flex items-start gap-2.5">
      <span
        aria-hidden
        className={cn(
          'mt-[1px] grid size-4 shrink-0 place-items-center rounded-full border-[1.5px]',
          state === 'done' && 'border-success text-success',
          state === 'now' && 'animate-pulse border-accent',
          state === 'wait' && 'border-border-strong'
        )}
      >
        {state === 'done' && <CheckIcon width={9} height={9} />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn('text-[12px]', state === 'wait' ? 'text-fg-subtle' : 'text-fg')}>{title}</span>
        {line !== undefined && state !== 'wait' && (
          <span className="truncate font-mono text-[10.5px] text-fg-subtle select-text" title={line}>
            {line}
          </span>
        )}
      </span>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Added, and failed
// ---------------------------------------------------------------------------

function HostLine({
  name,
  detail,
  mono,
  chip
}: {
  name: string
  detail: string
  mono: boolean
  chip: { tone: ChipTone; label: string }
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 rounded-well border border-border bg-surface-sunken px-3 py-2">
      <ServerIcon width={14} height={14} className="shrink-0 text-fg-subtle" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-[12.5px] text-fg">{name}</span>
        <span data-add-host-detail className={cn('truncate text-[11px] text-fg-subtle', mono && 'font-mono')}>
          {detail}
        </span>
      </span>
      <Chip tone={chip.tone}>{chip.label}</Chip>
    </div>
  )
}

const QUIT_OPTIONS: readonly { value: QuitSessions; title: string; detail: (name: string) => string }[] = [
  {
    value: 'keep',
    title: 'Keep them running',
    detail: (name) => `Sessions you start on ${name} keep running there. Open Helm again to pick them up.`
  },
  {
    value: 'end',
    title: 'End my sessions there',
    detail: (name) => `Sessions you started on ${name} end when you quit.`
  }
]

function AddedScreen({
  screen,
  onQuit
}: {
  screen: Extract<Screen, { step: 'added' }>
  onQuit: (quit: QuitSessions) => void
}): JSX.Element {
  const { host, version, system, agents, agentsError, quit } = screen
  const os = host.system !== undefined ? describeHostSystem(host.system) : system === null ? null : system.label
  return (
    <div data-add-host-added={host.id} className="flex flex-col gap-3.5">
      <p className="text-[11.5px] leading-[1.55] text-fg-muted">
        Its workspaces and sessions appear in the sidebar beside this PC’s. Its key is pinned on this PC: from now on
        Helm connects only to the host that proves it.
      </p>
      <HostLine
        name={host.name}
        detail={[`floti ${version}`, ...(os === null ? [] : [os])].join(' · ')}
        mono
        chip={{ tone: 'success', label: 'Connected' }}
      />
      <Agents name={host.name} rows={agents} error={agentsError} />
      <div className="flex flex-col gap-1.5">
        <span className={dialogLabel}>When you quit Helm, on {host.name}</span>
        <div role="radiogroup" aria-label={`When you quit Helm, on ${host.name}`} className="flex flex-col gap-1">
          {QUIT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={quit === option.value}
              data-add-host-quit={option.value}
              onClick={() => onQuit(option.value)}
              className={cn(
                'flex items-start gap-2.5 rounded-well border px-3 py-2 text-left transition-colors',
                quit === option.value ? 'border-border-strong bg-surface-sunken' : 'border-border hover:bg-hover'
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-[2px] grid size-3.5 shrink-0 place-items-center rounded-full border-[1.5px]',
                  quit === option.value ? 'border-accent' : 'border-border-strong'
                )}
              >
                {quit === option.value && <span className="size-1.5 rounded-full bg-accent" />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-[12px] text-fg">
                  {option.title}
                  {option.value === 'keep' && <span className="text-[10.5px] text-fg-subtle">Default</span>}
                </span>
                <span className="text-[11px] leading-[1.5] text-fg-muted">{option.detail(host.name)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] leading-[1.5] text-fg-subtle">
        A lost connection never ends a session there. Change this in Settings &gt; Hosts.
      </p>
    </div>
  )
}

const SIGN_IN_CHIP: Record<AgentRow['signIn'], { tone: ChipTone; label: string }> = {
  signedIn: { tone: 'success', label: 'Signed in' },
  notSignedIn: { tone: 'warn', label: 'Not signed in' },
  unknown: { tone: 'neutral', label: 'Unknown' }
}

/** Each agent there: its version, whether it is installed and signed in, and what to do when it is not. */
function Agents({ name, rows, error }: { name: string; rows: AgentRow[] | null; error: string | null }): JSX.Element {
  return (
    <div data-add-host-agents className="flex flex-col gap-1.5">
      <span className={dialogLabel}>Agents on {name}</span>
      {rows === null || rows.length === 0 ? (
        <p data-add-host-agents-unknown className="text-[11.5px] leading-[1.5] text-fg-muted">
          {rows === null
            ? `Helm can’t tell which agents are on ${name}${error === null ? '.' : `: ${error}`}`
            : `${name} named no agents.`}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => {
            const signIn = row.installed ? SIGN_IN_CHIP[row.signIn] : null
            return (
              <li key={row.id} data-add-host-agent={row.id} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] text-fg">{row.name}</span>
                  {row.version !== null && (
                    <span data-add-host-agent-version className="font-mono text-[11px] text-fg-subtle">
                      {row.version}
                    </span>
                  )}
                  <span className="flex-1" />
                  <Chip tone={row.installed ? 'success' : 'warn'}>{row.installed ? 'Installed' : 'Not installed'}</Chip>
                  {signIn !== null && <Chip tone={signIn.tone}>{signIn.label}</Chip>}
                </span>
                {row.fix !== null && (
                  <span data-add-host-agent-fix className="text-[11px] leading-[1.5] text-fg-muted select-text">
                    {row.fix}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function FailedScreen({ subject, failure }: { subject: Subject; failure: HostFailure }): JSX.Element {
  return (
    <div role="alert" data-add-host-failed={failure.kind} className="flex flex-col gap-3.5">
      <HostLine name={subject.name} detail="Not added" mono={false} chip={{ tone: 'danger', label: failure.chip }} />
      <div className="flex flex-col gap-1.5">
        <span className={dialogLabel}>{failure.saidBy}</span>
        <p
          data-add-host-line
          className="rounded-well border border-border bg-surface-sunken px-3 py-2 font-mono text-[11px] break-words text-fg select-text"
        >
          {failure.line}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={dialogLabel}>To fix it</span>
        <p data-add-host-fix className="text-[11.5px] leading-[1.55] text-fg-muted select-text">
          {failure.fix}
        </p>
      </div>
    </div>
  )
}
