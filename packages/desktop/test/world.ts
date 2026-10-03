import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createProfile,
  openStore,
  writeSettings,
  type AppSettings,
  type Profile,
  type ProfileDraft
} from '@helm/core'

/**
 * A machine of Helm's own for one test: a home directory with its own
 * `.claude`, a fake `claude` and a fake `gh`, two git projects, and a data
 * directory for the app. Nothing in it touches the network, a real `~/.claude`,
 * a real CLI or the installed app.
 *
 * The root has a space in it on purpose: Helm is Windows-first and paths with
 * spaces are where quoting breaks.
 */
export interface World {
  root: string
  /** `USERPROFILE` for anything launched into this world. */
  home: string
  /** `<home>/.claude`, Claude Code's directory. */
  claudeDir: string
  /** `PORTABLE_EXECUTABLE_DIR`: the app keeps its data under `<portableDir>/helm-data`. */
  portableDir: string
  dataDir: string
  projectsDir: string
  projects: { alpha: string; beta: string }
  /** The fake `claude`, as a `.cmd` shim like an npm install. */
  claude: string
  /** The fake `gh`, in its synthetic mode. */
  gh: string
  /** The environment for any process that belongs to this world. */
  env: Record<string, string>
}

/** What `fake-claude.mjs` writes about itself, one file per run. */
export interface FakeClaudeLog {
  pid: number
  argv: string[]
  cwd: string
  sessionId: string
  resumed: boolean
  received: string[]
  resized: { cols: number; rows: number }[]
  exitCode: number | null
}

/** The repository root, found from wherever the test runner started. */
export function repoRoot(): string {
  let dir = process.cwd()
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${process.cwd()}`)
    dir = parent
  }
  return dir
}

const desktopDir = (): string => join(repoRoot(), 'packages', 'desktop')

/** Variables from the machine running the tests that must not reach the world. */
const LEAKY = /^(ANTHROPIC_|CLAUDE|GH_|GITHUB_|ELECTRON_RUN_AS_NODE$|PORTABLE_EXECUTABLE_DIR$)/i

export function createWorld(): World {
  const root = mkdtempSync(join(tmpdir(), 'helm world-'))
  const home = join(root, 'home')
  const claudeDir = join(home, '.claude')
  const portableDir = join(root, 'app')
  const projectsDir = join(root, 'projects')
  const bin = join(root, 'bin')
  for (const dir of [claudeDir, portableDir, projectsDir, bin]) mkdirSync(dir, { recursive: true })

  // Signed in as far as Helm can tell: it reads only that onboarding finished.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, userID: 'helm-tests' }))

  const node = process.execPath
  const claude = join(bin, 'claude.cmd')
  writeFileSync(
    claude,
    ['@echo off', `"${node}" "${join(desktopDir(), 'test', 'fake-claude.mjs')}" %*`, 'exit /b %ERRORLEVEL%', ''].join(
      '\r\n'
    )
  )
  const gh = join(bin, 'gh.cmd')
  writeFileSync(
    gh,
    [
      '@echo off',
      'setlocal',
      'set "HELM_FAKE_GH_SYNTHETIC=1"',
      `"${node}" "${join(desktopDir(), 'scripts', 'fake-gh.mjs')}" %*`,
      'exit /b %ERRORLEVEL%',
      ''
    ].join('\r\n')
  )

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !LEAKY.test(key)) env[key] = value
  }
  Object.assign(env, { USERPROFILE: home, HOME: home, PORTABLE_EXECUTABLE_DIR: portableDir })

  const alpha = gitProject(join(projectsDir, 'alpha'), 'main')
  const beta = gitProject(join(projectsDir, 'beta'), 'feature/beta')

  return {
    root,
    home,
    claudeDir,
    portableDir,
    dataDir: join(portableDir, 'helm-data'),
    projectsDir,
    projects: { alpha, beta },
    claude,
    gh,
    env
  }
}

function gitProject(dir: string, branch: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), `# ${branch}\n`)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  git('init', '-q', '-b', branch)
  git('-c', 'user.name=Helm Tests', '-c', 'user.email=tests@helm.invalid', 'add', '.')
  git('-c', 'user.name=Helm Tests', '-c', 'user.email=tests@helm.invalid', 'commit', '-q', '-m', 'init')
  return dir
}

/**
 * The settings a world starts with: its projects folder scanned, its fake
 * `claude` chosen, first run done, and the update check off so nothing goes to
 * the network. Written through the app's own store, before the app opens it.
 */
export function seedSettings(world: World, patch: Partial<AppSettings> = {}): void {
  const store = openStore({ file: join(world.dataDir, 'helm.db') })
  try {
    writeSettings(store, {
      scanRoots: [world.projectsDir],
      claudePath: world.claude,
      updateCheck: false,
      firstRunCompletedAt: new Date().toISOString(),
      ...patch
    })
  } finally {
    store.close()
  }
}

/** A saved profile, written through the app's own store before the app opens it. */
export function seedProfile(world: World, draft: ProfileDraft): Profile {
  const store = openStore({ file: join(world.dataDir, 'helm.db') })
  try {
    return createProfile(store, draft)
  } finally {
    store.close()
  }
}

export function fakeClaudeLogs(world: World): FakeClaudeLog[] {
  const dir = join(world.claudeDir, 'fake-claude')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as FakeClaudeLog)
}

/**
 * Removes the world. It holds no junctions into anything outside itself, so a
 * recursive remove cannot reach past it.
 */
export function disposeWorld(world: World): void {
  rmSync(world.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
