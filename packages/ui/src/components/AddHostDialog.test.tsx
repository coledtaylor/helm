import type {
  HostAddOutcome,
  HostAddRequest,
  HostCheck,
  HostCheckTarget,
  InstallOffer,
  InstallOutcome,
  RemoteHost,
  SshConfigHosts,
  WslDistroList
} from '@helm/core/types'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AddHostDialog, type AddHostActions } from './AddHostDialog'

/** A promise the test settles. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

const LINUX = { os: 'linux' as const, cpu: 'x64', label: 'Linux · x86_64' }
const READY: HostCheck = { kind: 'ready', found: { version: '3.0.0', protocol: '1.0' }, system: LINUX }
const OFFER: InstallOffer = {
  system: LINUX,
  found: null,
  action: 'install',
  how: 'download',
  version: '3.0.0',
  folder: '~/.local/bin',
  sessions: null
}
const CONFIG: SshConfigHosts = { found: true, hosts: ['build-box', 'studio-mac', 'homelab'] }

const SIGNED_IN = {
  installed: true,
  version: '2.1.241 (Claude Code)',
  semver: '2.1.241',
  signedIn: { state: 'known' as const, value: true },
  signInSignal: 'credentials file',
  error: null
}

function added(request: HostAddRequest, agents: Record<string, typeof SIGNED_IN> | null = { 'claude-code': SIGNED_IN }): HostAddOutcome {
  return {
    kind: 'added',
    host: {
      id: 'h-new',
      name: request.name,
      transport: request.transport,
      ...(request.system === undefined ? {} : { system: request.system })
    },
    version: '3.0.0',
    agents
  }
}

/**
 * The dialog over fake actions: each call to check, install and add waits on
 * a promise the test settles, so a test sees every screen between them.
 */
function world(options: { config?: SshConfigHosts; hosts?: RemoteHost[]; wsl?: WslDistroList[] } = {}) {
  const checks: { target: HostCheckTarget; answer: ReturnType<typeof deferred<HostCheck>> }[] = []
  const installs: { id: string; answer: ReturnType<typeof deferred<InstallOutcome>> }[] = []
  const adds: { request: HostAddRequest; answer: ReturnType<typeof deferred<HostAddOutcome>> }[] = []
  let attempts = 0
  const actions = {
    sshHosts: vi.fn<AddHostActions['sshHosts']>(async () => options.config ?? CONFIG),
    check: vi.fn<AddHostActions['check']>((target) => {
      const answer = deferred<HostCheck>()
      checks.push({ target, answer })
      return answer.promise
    }),
    install: vi.fn<AddHostActions['install']>((id) => {
      const answer = deferred<InstallOutcome>()
      installs.push({ id, answer })
      return answer.promise
    }),
    cancelInstall: vi.fn<AddHostActions['cancelInstall']>(),
    add: vi.fn<AddHostActions['add']>((request) => {
      const answer = deferred<HostAddOutcome>()
      adds.push({ request, answer })
      return answer.promise
    }),
    cancelAdd: vi.fn<AddHostActions['cancelAdd']>(),
    wslDistros: vi.fn<NonNullable<AddHostActions['wslDistros']>>(async () => options.wsl ?? [])
  }
  const onQuitChange = vi.fn()
  const onClose = vi.fn()
  render(
    <AddHostDialog
      actions={actions}
      hosts={options.hosts ?? []}
      onQuitChange={onQuitChange}
      onClose={onClose}
      newAttempt={() => `attempt-${String((attempts += 1))}`}
    />
  )
  const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Add a host' })
  const step = (): string | null => dialog().getAttribute('data-add-host-dialog')
  const button = (name: string | RegExp): HTMLElement => within(dialog()).getByRole('button', { name })
  return { actions, checks, installs, adds, onQuitChange, onClose, dialog, step, button }
}

async function pick(w: ReturnType<typeof world>, host = 'build-box'): Promise<void> {
  await userEvent.click(await within(w.dialog()).findByRole('radio', { name: host }))
}

describe('the add-a-host dialog', () => {
  it('S3: lists the Host names of the ssh config, with a target field and a name that follows the pick until edited; nothing is contacted until Connect', async () => {
    const w = world()
    const list = await within(w.dialog()).findByRole('radiogroup', { name: 'From your SSH config' })
    expect(within(list).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['build-box', 'studio-mac', 'homelab'])
    const name = within(w.dialog()).getByRole<HTMLInputElement>('textbox', { name: 'Name in Helm' })
    const target = within(w.dialog()).getByRole<HTMLInputElement>('textbox', { name: 'ssh target' })

    await pick(w, 'studio-mac')
    expect(name.value).toBe('studio-mac')
    await pick(w, 'build-box')
    expect(name.value).toBe('build-box')
    // A typed target replaces the pick, and the name follows it.
    await userEvent.type(target, 'me@lab')
    expect(name.value).toBe('me@lab')
    expect(within(list).getAllByRole('radio').every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true)
    // Once edited, the name stays as typed.
    await userEvent.clear(name)
    await userEvent.type(name, 'lab')
    await pick(w, 'homelab')
    expect(name.value).toBe('lab')

    expect(w.actions.check).not.toHaveBeenCalled()
    expect(w.actions.add).not.toHaveBeenCalled()
    // No pairing code, approval or role is asked.
    expect(w.dialog().textContent).not.toMatch(/pair|approv|role|code/i)
  })

  it('S4: with no ssh config, or one naming only wildcard Hosts, the list says so and the typed target is the way in', async () => {
    const none = world({ config: { found: false, hosts: [] } })
    expect((await within(none.dialog()).findByText(/This PC has no ssh config\./)).textContent).toContain('Type the target')
    cleanup()
    const wild = world({ config: { found: true, hosts: [] } })
    expect(
      (await within(wild.dialog()).findByText(/names no host without a wildcard/)).getAttribute('data-add-host-ssh-empty')
    ).toBe('wildcards')
  })

  it('S5, S7, S22: checks, connects through ssh <target> floti connect, then shows the version, OS, Connected and the agents; the quit choice is written at once', async () => {
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    expect(w.step()).toBe('checking')
    expect(w.checks[0]?.target).toEqual({ transport: { kind: 'ssh', target: 'build-box' }, attempt: 'attempt-1' })
    const steps = (): Record<string, string | null> =>
      Object.fromEntries(
        [...w.dialog().querySelectorAll('[data-add-host-step]')].map((each) => [
          each.getAttribute('data-add-host-step'),
          each.getAttribute('data-add-host-step-state')
        ])
      )
    expect(steps()).toEqual({ check: 'now', install: 'wait', connect: 'wait', quit: 'wait' })
    expect(w.dialog().textContent).toContain('ssh -o BatchMode=yes build-box floti version')

    w.checks[0]?.answer.resolve(READY)
    await vi.waitFor(() => expect(w.adds).toHaveLength(1))
    expect(steps()).toEqual({ check: 'done', install: 'done', connect: 'now', quit: 'wait' })
    expect(w.dialog().textContent).toContain('ssh build-box floti connect')
    expect(w.adds[0]?.request).toEqual({
      attempt: 'attempt-2',
      name: 'build-box',
      transport: { kind: 'ssh', target: 'build-box' },
      system: { os: 'Linux', cpu: 'x86_64' }
    })

    w.adds[0]?.answer.resolve(added(w.adds[0].request))
    await vi.waitFor(() => expect(w.step()).toBe('added'))
    expect(within(w.dialog()).getByRole('heading').textContent).toBe('build-box is added')
    expect(w.dialog().querySelector('[data-add-host-detail]')?.textContent).toBe('floti 3.0.0 · Linux x86_64')
    expect(w.dialog().textContent).toContain('Connected')
    // S22: its agents, read through the new link, with no credential read.
    const agent = w.dialog().querySelector('[data-add-host-agent="claude-code"]') as HTMLElement
    expect(agent.textContent).toContain('Claude Code')
    expect(agent.querySelector('[data-add-host-agent-version]')?.textContent).toBe('claude 2.1.241')
    expect(agent.textContent).toContain('Installed')
    expect(agent.textContent).toContain('Signed in')
    expect(agent.querySelector('[data-add-host-agent-fix]')).toBeNull()

    // S7: Keep is the default; End is written for the new host at once.
    const keep = within(w.dialog()).getByRole('radio', { name: /Keep them running/ })
    expect(keep.getAttribute('aria-checked')).toBe('true')
    expect(keep.textContent).toContain('Default')
    await userEvent.click(within(w.dialog()).getByRole('radio', { name: /End my sessions there/ }))
    expect(w.onQuitChange).toHaveBeenCalledWith('h-new', 'end')
    await userEvent.click(w.button('Done'))
    expect(w.onClose).toHaveBeenCalledOnce()
    expect(w.actions.cancelAdd).not.toHaveBeenCalled()
  })

  it('S7: Add another returns to an empty pick screen', async () => {
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[0]?.answer.resolve(READY)
    await vi.waitFor(() => expect(w.adds).toHaveLength(1))
    w.adds[0]?.answer.resolve(added(w.adds[0].request))
    await vi.waitFor(() => expect(w.step()).toBe('added'))
    await userEvent.click(w.button('Add another'))
    expect(w.step()).toBe('pick')
    expect(within(w.dialog()).getByRole<HTMLInputElement>('textbox', { name: 'Name in Helm' }).value).toBe('')
    expect(w.onClose).not.toHaveBeenCalled()
  })

  it('S6: floti missing there shows the OS and CPU, what installing does and where, with Install and Back; the yes installs then connects with the path', async () => {
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[0]?.answer.resolve({ kind: 'offer', id: 'offer-1', offer: OFFER })
    await vi.waitFor(() => expect(w.step()).toBe('install'))
    expect(within(w.dialog()).getByRole('heading').textContent).toBe('Install floti on build-box?')
    expect(w.dialog().querySelector('[data-settings-host-offer-system]')?.textContent).toBe('Linux · x86_64')
    expect(w.dialog().querySelector('[data-settings-host-offer-found]')?.textContent).toBe('floti not found')
    expect(w.dialog().textContent).toContain('~/.local/bin')
    expect(w.button('Back')).toBeTruthy()
    expect(w.actions.install).not.toHaveBeenCalled()

    await userEvent.click(w.button('Install on build-box'))
    expect(w.installs[0]?.id).toBe('offer-1')
    w.installs[0]?.answer.resolve({ ok: true, floti: '/home/me/.local/bin/floti', startsAtNextSignIn: false })
    await vi.waitFor(() => expect(w.adds).toHaveLength(1))
    expect(w.adds[0]?.request).toMatchObject({ floti: '/home/me/.local/bin/floti', system: { os: 'Linux', cpu: 'x86_64' } })
  })

  it('S6, S8: Cancel on the install screen runs nothing and adds nothing; Back returns to the pick with what was typed', async () => {
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[0]?.answer.resolve({ kind: 'offer', id: 'offer-1', offer: OFFER })
    await vi.waitFor(() => expect(w.step()).toBe('install'))
    await userEvent.click(w.button('Back'))
    expect(w.actions.cancelInstall).toHaveBeenCalledWith('offer-1')
    expect(w.step()).toBe('pick')
    expect(within(w.dialog()).getByRole<HTMLInputElement>('textbox', { name: 'Name in Helm' }).value).toBe('build-box')

    await userEvent.click(w.button('Connect'))
    w.checks[1]?.answer.resolve({ kind: 'offer', id: 'offer-2', offer: OFFER })
    await vi.waitFor(() => expect(w.step()).toBe('install'))
    await userEvent.click(w.button('Cancel'))
    expect(w.actions.cancelInstall).toHaveBeenLastCalledWith('offer-2')
    expect(w.onClose).toHaveBeenCalledOnce()
    expect(w.actions.install).not.toHaveBeenCalled()
    expect(w.actions.add).not.toHaveBeenCalled()
  })

  it('S8: Cancel or close while it checks or connects stops that attempt and adds nothing', async () => {
    const checking = world()
    await pick(checking)
    await userEvent.click(checking.button('Connect'))
    await userEvent.click(checking.button('Cancel'))
    expect(checking.actions.cancelAdd).toHaveBeenCalledWith('attempt-1')
    expect(checking.onClose).toHaveBeenCalledOnce()
    // What the check says after is dropped: nothing connects.
    checking.checks[0]?.answer.resolve(READY)
    await Promise.resolve()
    expect(checking.actions.add).not.toHaveBeenCalled()
    cleanup()

    const connecting = world()
    await pick(connecting)
    await userEvent.click(connecting.button('Connect'))
    connecting.checks[0]?.answer.resolve(READY)
    await vi.waitFor(() => expect(connecting.adds).toHaveLength(1))
    await userEvent.click(connecting.button('Close'))
    expect(connecting.actions.cancelAdd).toHaveBeenCalledWith('attempt-2')
    expect(connecting.onClose).toHaveBeenCalledOnce()
    expect(connecting.onQuitChange).not.toHaveBeenCalled()
  })

  it('S9: a command goes through the same flow, and a failure shows the command’s own last line', async () => {
    const w = world()
    await userEvent.click(w.button('Reach it with a command instead'))
    await userEvent.type(within(w.dialog()).getByRole('textbox', { name: 'Command' }), 'wsl.exe -d Ubuntu --')
    await userEvent.type(within(w.dialog()).getByRole('textbox', { name: 'Name in Helm' }), 'wsl')
    await userEvent.click(w.button('Connect'))
    expect(w.checks[0]?.target).toEqual({
      transport: { kind: 'command', program: 'wsl.exe', args: ['-d', 'Ubuntu', '--'] },
      attempt: 'attempt-1'
    })
    w.checks[0]?.answer.resolve({ kind: 'failed', lastLine: 'There is no distribution with the supplied name.' })
    await vi.waitFor(() => expect(w.step()).toBe('failed'))
    expect(w.dialog().textContent).toContain('The command said')
    expect(w.dialog().querySelector('[data-add-host-line]')?.textContent).toBe('There is no distribution with the supplied name.')
    expect(w.dialog().querySelector('[data-add-host-fix]')?.textContent).toContain('wsl.exe -d Ubuntu --')
  })

  it('S12, S19: a password failure says so with ssh’s line and the fix; Try again reruns the check, and Back keeps what was typed', async () => {
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    const line = 'build-box: Permission denied (publickey,password).'
    w.checks[0]?.answer.resolve({ kind: 'failed', lastLine: line, said: line })
    await vi.waitFor(() => expect(w.step()).toBe('failed'))
    expect(within(w.dialog()).getByRole('heading').textContent).toBe('build-box wants a password')
    expect(w.dialog().textContent).toContain('Not added')
    expect(w.dialog().textContent).toContain('Needs a key')
    expect(w.dialog().textContent).toContain('ssh said')
    expect(w.dialog().querySelector('[data-add-host-line]')?.textContent).toBe(line)
    expect(w.dialog().querySelector('[data-add-host-fix]')?.textContent).toContain('ssh build-box gets in without asking')
    // No field to type a password into, and no pairing code.
    expect(w.dialog().querySelector('input')).toBeNull()
    expect(w.dialog().textContent).not.toMatch(/pairing|code/i)

    await userEvent.click(w.button('Try again'))
    expect(w.checks).toHaveLength(2)
    expect(w.checks[1]?.target).toEqual({ transport: { kind: 'ssh', target: 'build-box' }, attempt: 'attempt-2' })
    w.checks[1]?.answer.resolve({ kind: 'failed', lastLine: line, said: line })
    await vi.waitFor(() => expect(w.step()).toBe('failed'))
    await userEvent.click(w.button('Back'))
    expect(w.step()).toBe('pick')
    expect(within(w.dialog()).getByRole<HTMLInputElement>('textbox', { name: 'Name in Helm' }).value).toBe('build-box')
  })

  it('S19: a connection that fails shows floti’s last line and Try again reruns the connection, not the check', async () => {
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[0]?.answer.resolve(READY)
    await vi.waitFor(() => expect(w.adds).toHaveLength(1))
    w.adds[0]?.answer.resolve({ kind: 'failed', lastLine: 'floti connect: no Floti host is running there.' })
    await vi.waitFor(() => expect(w.step()).toBe('failed'))
    expect(w.dialog().querySelector('[data-add-host-failed]')?.getAttribute('data-add-host-failed')).toBe('notRunning')
    expect(w.dialog().textContent).toContain('floti said')
    await userEvent.click(w.button('Try again'))
    expect(w.checks).toHaveLength(1)
    expect(w.adds).toHaveLength(2)
    expect(w.adds[1]?.request).toMatchObject({ attempt: 'attempt-3', name: 'build-box', system: { os: 'Linux', cpu: 'x86_64' } })
  })

  it.each([
    ['S10', { kind: 'failed', lastLine: 'spawn ssh ENOENT', cause: 'transportMissing' }, 'noTransport', 'Helm could not find ssh on this PC'],
    ['S11', { kind: 'failed', lastLine: 'ssh: Could not resolve hostname build-box: Name or service not known' }, 'unresolved', 'ssh does not know build-box'],
    ['S12', { kind: 'failed', lastLine: 'ssh: connect to host 10.0.0.7 port 22: Connection timed out' }, 'unreachable', 'Can’t reach build-box'],
    ['S14', { kind: 'failed', lastLine: 'Host key verification failed.', said: 'No ED25519 host key is known for build-box and you have requested strict checking.\nHost key verification failed.' }, 'unknownKey', 'ssh does not trust build-box yet'],
    ['S15', { kind: 'failed', lastLine: 'Welcome to build-box!', cause: 'loginOutput' }, 'loginOutput', 'build-box’s login printed text where floti’s connection goes'],
    ['S16', { kind: 'noBuild', system: { os: null, cpu: 'arm64', label: 'FreeBSD · arm64' }, reason: 'There is no floti for FreeBSD · arm64 yet.' }, 'noBuild', 'There is no floti for FreeBSD · arm64 yet'],
    ['S18', { kind: 'newer', found: { version: '3.2.0', protocol: '2.0' }, ours: '1.0', helm: '3.0.0' }, 'newer', 'build-box runs floti 3.2.0, newer than this Helm 3.0.0']
  ] as const)('%s: a check that fails as %s says what went wrong, with the line and the fix', async (_scenario, check, kind, title) => {
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[0]?.answer.resolve(check as HostCheck)
    await vi.waitFor(() => expect(w.step()).toBe('failed'))
    expect(w.dialog().querySelector('[data-add-host-failed]')?.getAttribute('data-add-host-failed')).toBe(kind)
    expect(within(w.dialog()).getByRole('heading').textContent).toBe(title)
    expect(w.dialog().querySelector('[data-add-host-fix]')?.textContent).not.toBe('')
    expect(w.actions.add).not.toHaveBeenCalled()
  })

  it('S17: an install that fails shows the install script’s last line, and Try again checks again', async () => {
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[0]?.answer.resolve({ kind: 'offer', id: 'offer-1', offer: OFFER })
    await vi.waitFor(() => expect(w.step()).toBe('install'))
    await userEvent.click(w.button('Install on build-box'))
    w.installs[0]?.answer.resolve({ ok: false, step: 'install', lastLine: 'curl: (6) Could not resolve host: github.com' })
    await vi.waitFor(() => expect(w.step()).toBe('failed'))
    expect(w.dialog().querySelector('[data-add-host-failed]')?.getAttribute('data-add-host-failed')).toBe('installFailed')
    expect(w.dialog().textContent).toContain('The install script said')
    expect(w.dialog().querySelector('[data-add-host-line]')?.textContent).toBe('curl: (6) Could not resolve host: github.com')
    await userEvent.click(w.button('Try again'))
    expect(w.checks).toHaveLength(2)
  })

  it('a Linux server installs, its setup says the host keeps running with nobody signed in, and it is added and connected with no next-sign-in note', async () => {
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[0]?.answer.resolve({ kind: 'offer', id: 'offer-1', offer: OFFER })
    await vi.waitFor(() => expect(w.step()).toBe('install'))
    await userEvent.click(w.button('Install on build-box'))
    w.installs[0]?.answer.resolve({ ok: true, floti: '/home/me/.local/bin/floti', startsAtNextSignIn: false })
    await vi.waitFor(() => expect(w.adds).toHaveLength(1))
    w.adds[0]?.answer.resolve(added(w.adds[0].request))
    await vi.waitFor(() => expect(w.step()).toBe('added'))
    expect(w.dialog().textContent).toContain('Connected')
    expect(w.dialog().textContent).not.toMatch(/sign-in|signs in/i)
  })

  it('a Linux server whose loginctl refuses lingering shows setup’s line unedited and adds nothing', async () => {
    const line =
      'floti setup: could not turn on lingering, which keeps the host running with nobody signed in: Could not enable linger: Access denied. Ask an administrator there to run sudo loginctl enable-linger me, then run floti setup again.'
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[0]?.answer.resolve({ kind: 'offer', id: 'offer-1', offer: OFFER })
    await vi.waitFor(() => expect(w.step()).toBe('install'))
    await userEvent.click(w.button('Install on build-box'))
    w.installs[0]?.answer.resolve({ ok: false, step: 'setup', lastLine: line })
    await vi.waitFor(() => expect(w.step()).toBe('failed'))
    expect(w.dialog().querySelector('[data-add-host-line]')?.textContent).toBe(line)
    expect(w.actions.add).not.toHaveBeenCalled()
  })

  it('S13: a host key that changed is told from one never seen, from all ssh wrote', async () => {
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[0]?.answer.resolve({
      kind: 'failed',
      lastLine: 'Host key verification failed.',
      said: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key for build-box has changed and you have requested strict checking.\nHost key verification failed.'
    })
    await vi.waitFor(() => expect(w.step()).toBe('failed'))
    expect(w.dialog().querySelector('[data-add-host-failed]')?.getAttribute('data-add-host-failed')).toBe('hostKeyChanged')
    expect(w.dialog().querySelector('[data-add-host-fix]')?.textContent).toContain('Helm never accepts a host key for you')
  })

  it('S23: Not installed names the install command, Not signed in names claude, Unknown says why; the host is added either way', async () => {
    const w = world()
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[0]?.answer.resolve(READY)
    await vi.waitFor(() => expect(w.adds).toHaveLength(1))
    w.adds[0]?.answer.resolve(
      added(w.adds[0].request, {
        'claude-code': { ...SIGNED_IN, installed: false, version: null as never, semver: null as never }
      })
    )
    await vi.waitFor(() => expect(w.step()).toBe('added'))
    const fix = (): string => w.dialog().querySelector('[data-add-host-agent-fix]')?.textContent ?? ''
    expect(w.dialog().textContent).toContain('Not installed')
    expect(fix()).toContain('curl -fsSL https://claude.ai/install.sh | bash')
    w.button('Add another').click()

    await vi.waitFor(() => expect(w.step()).toBe('pick'))
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[1]?.answer.resolve(READY)
    await vi.waitFor(() => expect(w.adds).toHaveLength(2))
    w.adds[1]?.answer.resolve(
      added(w.adds[1].request, { 'claude-code': { ...SIGNED_IN, signedIn: { state: 'known', value: false } as never } })
    )
    await vi.waitFor(() => expect(w.step()).toBe('added'))
    expect(w.dialog().textContent).toContain('Not signed in')
    expect(fix()).toContain('Sign in by running claude there once')
    w.button('Add another').click()

    await vi.waitFor(() => expect(w.step()).toBe('pick'))
    await pick(w)
    await userEvent.click(w.button('Connect'))
    w.checks[2]?.answer.resolve(READY)
    await vi.waitFor(() => expect(w.adds).toHaveLength(3))
    w.adds[2]?.answer.resolve({ ...added(w.adds[2].request, null), agentsError: 'setup:status is not served' } as HostAddOutcome)
    await vi.waitFor(() => expect(w.step()).toBe('added'))
    expect(w.dialog().querySelector('[data-add-host-agents-unknown]')?.textContent).toContain('setup:status is not served')
  })
})
describe('the add-a-host dialog’s WSL distros', () => {
  const HERE: WslDistroList = {
    through: null,
    pcName: 'this PC',
    distros: ['Ubuntu', 'Debian'],
    said: null
  }
  const WIN_BOX: WslDistroList = {
    through: 'win-box',
    pcName: 'win-box',
    distros: ['Ubuntu'],
    said: null
  }
  const UBUNTU_ADDED: RemoteHost = {
    id: 'h-ubuntu',
    name: 'Ubuntu',
    transport: { kind: 'wsl', distro: 'Ubuntu' }
  }

  it('S1: lists this PC’s distros beside the ssh hosts: Debian to pick, Ubuntu already added', async () => {
    const w = world({ wsl: [HERE], hosts: [UBUNTU_ADDED] })
    const list = await within(w.dialog()).findByRole('radiogroup', {
      name: 'WSL distros on this PC'
    })
    const rows = within(list).getAllByRole('radio')
    expect(rows.map((row) => row.getAttribute('data-add-host-wsl-distro'))).toEqual(['Ubuntu', 'Debian'])
    const ubuntu = rows[0] as HTMLButtonElement
    expect(ubuntu.disabled).toBe(true)
    expect(ubuntu.textContent).toContain('Added')
    expect((rows[1] as HTMLButtonElement).disabled).toBe(false)
    expect(w.actions.wslDistros).toHaveBeenCalledOnce()
  })

  it('S2: lists the distros of a Windows host under its name; a PC with no WSL says so with wsl.exe’s line, and the ssh list still works', async () => {
    const none: WslDistroList = {
      through: null,
      pcName: 'this PC',
      distros: [],
      said: 'For more information please visit https://aka.ms/wslinstall'
    }
    const w = world({ wsl: [none, WIN_BOX] })
    const there = await within(w.dialog()).findByRole('radiogroup', {
      name: 'WSL distros on win-box'
    })
    expect(
      within(there)
        .getAllByRole('radio')
        .map((row) => row.textContent)
    ).toEqual(['Ubuntu'])
    const here = w.dialog().querySelector('[data-add-host-wsl="this PC"]') as HTMLElement
    expect(here.querySelector('[data-add-host-wsl-none]')?.textContent).toContain('This PC has no WSL distros to add.')
    expect(here.querySelector('[data-add-host-wsl-said]')?.textContent).toBe(none.said)
    await pick(w)
    expect(
      within(w.dialog()).getByRole<HTMLInputElement>('textbox', {
        name: 'Name in Helm'
      }).value
    ).toBe('build-box')
  })

  it('S3, S4: picking this PC’s Debian checks through wsl.exe -d Debian -- floti version and adds it as Debian, reached through wsl.exe', async () => {
    const w = world({ wsl: [HERE] })
    await userEvent.click(await within(w.dialog()).findByRole('radio', { name: 'Debian' }))
    expect(
      within(w.dialog()).getByRole<HTMLInputElement>('textbox', {
        name: 'Name in Helm'
      }).value
    ).toBe('Debian')
    await userEvent.click(w.button('Connect'))
    expect(w.checks[0]?.target).toEqual({
      transport: { kind: 'wsl', distro: 'Debian' },
      attempt: 'attempt-1'
    })
    expect(w.dialog().textContent).toContain('wsl.exe -d Debian -- floti version')
    w.checks[0]?.answer.resolve(READY)
    await vi.waitFor(() => expect(w.adds).toHaveLength(1))
    expect(w.adds[0]?.request).toMatchObject({
      name: 'Debian',
      transport: { kind: 'wsl', distro: 'Debian' }
    })
    expect(w.dialog().textContent).toContain('wsl.exe -d Debian -- floti connect')
  })

  it('S5: picking Ubuntu on win-box checks through ssh win-box and its wsl.exe, and names it Ubuntu on win-box', async () => {
    const w = world({ wsl: [WIN_BOX] })
    await userEvent.click(await within(w.dialog()).findByRole('radio', { name: 'Ubuntu' }))
    expect(
      within(w.dialog()).getByRole<HTMLInputElement>('textbox', {
        name: 'Name in Helm'
      }).value
    ).toBe('Ubuntu on win-box')
    await userEvent.click(w.button('Connect'))
    expect(w.checks[0]?.target).toEqual({
      transport: { kind: 'wsl', distro: 'Ubuntu', through: 'win-box' },
      attempt: 'attempt-1'
    })
    expect(w.dialog().textContent).toContain('ssh -o BatchMode=yes win-box wsl.exe -d Ubuntu -- floti version')
  })

  it('S10: a distro gone says WSL has no distro of that name, with wsl.exe’s line and wsl --list; no WSL says to run wsl --install; nothing is added', async () => {
    const w = world({ wsl: [HERE] })
    await userEvent.click(await within(w.dialog()).findByRole('radio', { name: 'Debian' }))
    await userEvent.click(w.button('Connect'))
    const gone = 'Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'
    w.checks[0]?.answer.resolve({
      kind: 'failed',
      lastLine: gone,
      said: `There is no distribution with the supplied name.\n${gone}`
    })
    await vi.waitFor(() => expect(w.step()).toBe('failed'))
    expect(within(w.dialog()).getByRole('heading').textContent).toBe('WSL has no distro named Debian on this PC')
    expect(w.dialog().textContent).toContain('wsl.exe said')
    expect(w.dialog().querySelector('[data-add-host-line]')?.textContent).toBe(gone)
    expect(w.dialog().querySelector('[data-add-host-fix]')?.textContent).toContain('wsl --list')
    cleanup()

    const nowsl = world({ wsl: [HERE] })
    await userEvent.click(await within(nowsl.dialog()).findByRole('radio', { name: 'Debian' }))
    await userEvent.click(nowsl.button('Connect'))
    nowsl.checks[0]?.answer.resolve({
      kind: 'failed',
      lastLine: 'spawn wsl.exe ENOENT',
      cause: 'transportMissing'
    })
    await vi.waitFor(() => expect(nowsl.step()).toBe('failed'))
    expect(within(nowsl.dialog()).getByRole('heading').textContent).toBe('WSL is not installed on this PC')
    expect(nowsl.dialog().querySelector('[data-add-host-fix]')?.textContent).toContain('wsl --install')
    expect(nowsl.actions.add).not.toHaveBeenCalled()
  })
})
