import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectedShell } from '@helm/core'
import { createWorld, disposeWorld, fakeClaudeLogs, type World } from '../../test/world'
import type * as ChildProcess from 'node:child_process'
import type { IpcContext } from './ipc'
import type * as PtermModule from './pterm'
import type { PtermHost } from './pterm'
import type * as PtyModule from './pty'
import type { SessionHandle, SessionSpawnOptions } from './pty'
import type { SessionHost } from './sessions'
import type * as ServicesModule from './services'
import type { Services } from './services'

/**
 * Which executable a project shell runs, and that a Claude session is never
 * one of them.
 *
 * Shells are not started here: a project shell's pty (`shell:` ids) is
 * recorded and handed a dummy, because what is under test is which program
 * Helm asks for. A Claude session is the exception - it runs for real, against
 * the fake `claude`, because the claim is about what actually ran.
 */

const ptys = vi.hoisted(() => ({
  spawned: [] as Array<{ id: string; file: string; args: SessionSpawnOptions['args']; cwd: string }>,
  /** Executables that fail to start, as an uninstalled shell would. */
  missing: new Set<string>()
}))

vi.mock('./pty', async (importOriginal) => {
  const real = await importOriginal<typeof PtyModule>()
  return {
    ...real,
    spawnSession: (opts: SessionSpawnOptions): SessionHandle => {
      ptys.spawned.push({ id: opts.id, file: opts.file, args: opts.args, cwd: opts.cwd })
      if (!opts.id.startsWith('shell:')) return real.spawnSession(opts)
      if (ptys.missing.has(opts.file)) throw new Error(`File not found: ${opts.file}`)
      return { id: opts.id, pid: 0, write: () => undefined, resize: () => undefined, kill: () => undefined, exitCode: () => null }
    }
  }
})

/** `where.exe` on this pretend machine: what PATH resolves, and nothing else. */
const ON_PATH: Record<string, string> = {
  'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'cmd.exe': 'C:\\Windows\\System32\\cmd.exe'
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcess>()
  const execFileSync = ((file: string, args?: readonly string[], options?: object) => {
    if (file !== 'where.exe') return real.execFileSync(file, args, options)
    const found = ON_PATH[args?.[0] ?? '']
    if (found === undefined) throw new Error('INFO: Could not find files for the given pattern(s).')
    return `${found}\r\n`
  }) as typeof real.execFileSync
  return { ...real, default: { ...real, execFileSync }, execFileSync }
})

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>() }))

vi.mock('electron', async () => {
  const fake = (await import('../../test/electron')).electronFake()
  return {
    ...fake,
    ipcMain: {
      ...(fake['ipcMain'] as object),
      handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
        ipc.handlers.set(channel, handler)
      }
    }
  }
})

let world: World
let services: Services
let sessions: SessionHost
let pterm: typeof PtermModule
let updateSettings: typeof ServicesModule.updateSettings
/** Where this machine's installers put the shells PATH does not know about. */
let storePwsh: string
let gitBash: string

function plant(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '')
}

beforeAll(async () => {
  world = createWorld()
  Object.assign(process.env, {
    PORTABLE_EXECUTABLE_DIR: world.portableDir,
    USERPROFILE: world.home,
    HOME: world.home
  })
  delete process.env['CLAUDE_CONFIG_DIR']

  // PowerShell 7 from the Store, whose launcher is not on PATH, and Git's bash,
  // whose bin directory is not either.
  const programFiles = join(world.root, 'Program Files')
  const localAppData = join(world.root, 'AppData', 'Local')
  storePwsh = join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe')
  gitBash = join(programFiles, 'Git', 'bin', 'bash.exe')
  plant(storePwsh)
  plant(gitBash)
  const saved = {
    ProgramW6432: process.env['ProgramW6432'],
    ProgramFiles: process.env['ProgramFiles'],
    'ProgramFiles(x86)': process.env['ProgramFiles(x86)'],
    LOCALAPPDATA: process.env['LOCALAPPDATA']
  }
  Object.assign(process.env, {
    ProgramW6432: programFiles,
    ProgramFiles: programFiles,
    'ProgramFiles(x86)': join(world.root, 'Program Files (x86)'),
    LOCALAPPDATA: localAppData
  })

  pterm = await import('./pterm')
  // Detection is memoised for the life of the process, so this is the answer
  // every test below sees; the machine's own variables go back afterwards.
  pterm.detectShells()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  const servicesModule = await import('./services')
  const { createSessionHost } = await import('./sessions')
  const { setClaudeOverride } = await import('./claude-cli')
  updateSettings = servicesModule.updateSettings
  setClaudeOverride(world.claude)
  services = servicesModule.createServices()
  sessions = createSessionHost({
    services,
    window: () => null,
    confirm: () => Promise.resolve(true)
  })
})

afterAll(async () => {
  for (const session of sessions.list()) {
    if (session.status === 'running') await sessions.close({ id: session.id, force: true })
  }
  await vi.waitFor(() => expect(sessions.list().filter((s) => s.status === 'running')).toEqual([]), {
    timeout: 10_000
  })
  // As before-quit does: a killed pty can report its exit after this, and
  // the host must not write it to a store that has been closed.
  sessions.shutdown()
  services.store.close()
  disposeWorld(world)
})

beforeEach(() => {
  ptys.spawned.length = 0
  ptys.missing.clear()
})

/** A host wired the way the app wires it: the setting read at every open. */
function shellHost(): PtermHost {
  return pterm.createPtermHost({ window: () => null, defaultShell: () => services.settings.terminalShell })
}

const shellSpawns = (): Array<{ file: string; args: SessionSpawnOptions['args']; cwd: string }> =>
  ptys.spawned.filter((spawn) => spawn.id.startsWith('shell:')).map(({ file, args, cwd }) => ({ file, args, cwd }))

describe('shellArgs', () => {
  it('quiets the PowerShell banner and passes nothing to any other shell', () => {
    expect(pterm.shellArgs('pwsh.exe')).toEqual(['-NoLogo'])
    expect(pterm.shellArgs('C:\\Program Files\\PowerShell\\7\\PWSH.EXE')).toEqual(['-NoLogo'])
    expect(pterm.shellArgs(ON_PATH['powershell.exe'] ?? '')).toEqual(['-NoLogo'])
    expect(pterm.shellArgs('C:\\Windows\\System32\\cmd.exe')).toEqual([])
    expect(pterm.shellArgs('C:\\Windows\\System32\\wsl.exe')).toEqual([])
    expect(pterm.shellArgs('C:\\Program Files\\Git\\bin\\bash.exe')).toEqual([])
  })

  it('keys on the file name, not on a path that happens to mention PowerShell', () => {
    expect(pterm.shellArgs('C:\\pwsh-tools\\bin\\bash.exe')).toEqual([])
    expect(pterm.shellArgs('C:\\Tools\\nu.exe')).toEqual([])
  })
})

describe('shell detection', () => {
  it('finds shells on PATH and where installers put them off it', () => {
    const expected: DetectedShell[] = [
      { path: storePwsh, name: 'pwsh.exe', label: 'PowerShell 7', args: ['-NoLogo'] },
      { path: ON_PATH['powershell.exe'] ?? '', name: 'powershell.exe', label: 'Windows PowerShell', args: ['-NoLogo'] },
      { path: ON_PATH['cmd.exe'] ?? '', name: 'cmd.exe', label: 'Command Prompt', args: [] },
      { path: gitBash, name: 'bash.exe', label: 'Bash', args: [] }
    ]

    expect(pterm.detectShells()).toEqual(expected)
  })

  it('hands the renderer the same list over pterm:shells', async () => {
    const { registerIpc } = await import('./ipc')
    const host = shellHost()
    // Registration subscribes to theme changes; nothing else it is handed is
    // touched until a channel is called.
    const themes = { onChange: () => undefined, listing: () => [] }
    registerIpc({ services, window: () => null, pterm: host, themes } as unknown as IpcContext)

    const answer = await ipc.handlers.get('pterm:shells')?.({}, undefined)

    expect(answer).toEqual(pterm.detectShells())
  })
})

describe('which shell a project pane runs', () => {
  it('is whatever terminalShell says at the moment it opens, with no restart', () => {
    const host = shellHost()

    updateSettings(services, { terminalShell: gitBash })
    expect(host.open({ path: world.projects.alpha, cols: 100, rows: 20 }).shell).toBe(gitBash)

    updateSettings(services, { terminalShell: ON_PATH['cmd.exe'] ?? null })
    expect(host.open({ path: world.projects.beta, cols: 100, rows: 20 }).shell).toBe(ON_PATH['cmd.exe'])

    expect(shellSpawns()).toEqual([
      { file: gitBash, args: [], cwd: world.projects.alpha },
      { file: ON_PATH['cmd.exe'], args: [], cwd: world.projects.beta }
    ])
  })

  it('is the first detected shell when the setting is null', () => {
    const host = shellHost()
    updateSettings(services, { terminalShell: null })

    host.open({ path: world.projects.alpha, cols: 100, rows: 20 })

    expect(shellSpawns()).toEqual([{ file: storePwsh, args: ['-NoLogo'], cwd: world.projects.alpha }])
  })

  it('is the pane’s own pick over the setting, for that pane only', () => {
    const host = shellHost()
    updateSettings(services, { terminalShell: ON_PATH['cmd.exe'] ?? null })

    host.open({ path: world.projects.alpha, cols: 100, rows: 20, shell: gitBash })
    host.open({ path: world.projects.beta, cols: 100, rows: 20 })

    expect(shellSpawns().map((spawn) => spawn.file)).toEqual([gitBash, ON_PATH['cmd.exe']])
  })

  it('falls back to a shell that starts when the chosen one will not, and says why', () => {
    const host = shellHost()
    updateSettings(services, { terminalShell: null })
    ptys.missing.add(gitBash)

    const opened = host.open({ path: world.projects.alpha, cols: 100, rows: 20, shell: gitBash })

    expect(opened.shell).toBe(storePwsh)
    expect(opened.requested).toBe(gitBash)
    expect(opened.problem).toContain('File not found')
  })
})

describe('Claude sessions', () => {
  it('run the claude CLI whatever the shell setting says', async () => {
    const shell = join(world.root, 'Shells', 'nu.exe')
    updateSettings(services, { terminalShell: shell })

    const record = await sessions.start({
      cwd: world.projects.alpha,
      projectPath: world.projects.alpha,
      name: 'alpha',
      cols: 100,
      rows: 30
    })

    expect(record.status).toBe('running')
    await vi.waitFor(() => {
      const run = fakeClaudeLogs(world).find((log) => log.sessionId === record.claudeSessionId)
      expect(run?.cwd.toLowerCase()).toBe(world.projects.alpha.toLowerCase())
    })
    expect(ptys.spawned.some((spawn) => spawn.file === shell)).toBe(false)
  })
})
