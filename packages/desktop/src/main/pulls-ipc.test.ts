import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSessions } from '@helm/core'
import { callsOf, createGhFixture, ghPull, pathWithoutGh, setOrigin, type GhFixture } from '../../test/gh-fixture'
import { createWorld, disposeWorld, fakeClaudeLogs, type FakeClaudeLog, type World } from '../../test/world'
import type { IpcContext } from './ipc'
import type { PullsService } from './pulls'
import type { Services } from './services'
import type { SessionHost } from './sessions'

/** What `registerIpc` hands `ipcMain.handle`, by channel. */
const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => unknown>())

vi.mock('electron', async () => {
  const fake = (await import('../../test/electron')).electronFake()
  return {
    ...fake,
    ipcMain: {
      ...(fake['ipcMain'] as object),
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        handlers.set(channel, handler)
      }
    }
  }
})

/**
 * The pull-request channels as the window reaches them: `settings:write` for
 * the GitHub group and `pr:review` for the Review button, through the real
 * handlers, with the real settings store, pulls service and session host
 * behind them. Sessions are real ptys running the fake `claude`; `gh` is the
 * fake, either the world's own (found on PATH) or a fixture picked as an
 * override.
 */
describe('pull requests over IPC', () => {
  let world: World
  let fx: GhFixture
  let services: Services
  let pulls: PullsService
  let host: SessionHost
  /** The branch the tree was on at the moment the session host was asked to spawn. */
  let branchAtSpawn: string | null = null

  const ALPHA = 'Acme/Alpha'
  const BETA = 'acme/beta'

  const invoke = async (channel: string, payload: unknown): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error(`no handler for ${channel}`)
    return handler({}, payload)
  }

  /** A settings write as the window makes one, then a sweep that has seen it. */
  const write = async (patch: Record<string, unknown>): Promise<void> => {
    await invoke('settings:write', patch)
    // The handler starts a sweep for some keys and this joins it; for the rest
    // it runs one. Either way nothing below races a pass still in flight.
    await pulls.refresh()
  }

  const branchOf = (dir: string): string =>
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()

  const runNamed = async (name: string): Promise<FakeClaudeLog> => {
    let found: FakeClaudeLog | undefined
    await vi.waitFor(() => {
      found = fakeClaudeLogs(world).find((log) => log.argv[log.argv.indexOf('-n') + 1] === name)
      expect(found).toBeDefined()
    })
    return found as FakeClaudeLog
  }

  beforeAll(async () => {
    world = createWorld()
    Object.assign(process.env, {
      PORTABLE_EXECUTABLE_DIR: world.portableDir,
      USERPROFILE: world.home,
      HOME: world.home,
      // Discovery finds the world's gh and nothing of the machine's.
      PATH: [dirname(world.gh), pathWithoutGh(process.env['PATH'] ?? '')].join(';'),
      ProgramFiles: join(world.root, 'program files'),
      'ProgramFiles(x86)': join(world.root, 'program files x86'),
      LOCALAPPDATA: join(world.root, 'local')
    })
    delete process.env['CLAUDE_CONFIG_DIR']

    fx = createGhFixture(join(world.root, 'gh fixture'))
    setOrigin(world.projects.alpha, 'https://github.com/Acme/Alpha.git')
    setOrigin(world.projects.beta, 'https://github.com/acme/beta.git')
    fx.list(ALPHA, [
      ghPull(ALPHA, 7, { title: 'Fix the thing', headRefName: 'fix/thing' }),
      ghPull(ALPHA, 9, { title: 'Nine' })
    ])
    fx.list(BETA, [ghPull(BETA, 3, { title: 'Three', headRefName: 'feature/three' })])

    const { createServices } = await import('./services')
    const { createSessionHost } = await import('./sessions')
    const { createPullsService } = await import('./pulls')
    const { registerIpc } = await import('./ipc')
    const { setClaudeOverride } = await import('./claude-cli')
    setClaudeOverride(world.claude)

    services = createServices()
    host = createSessionHost({ services, window: () => null, confirm: () => Promise.resolve(true) })
    pulls = createPullsService({
      store: services.store,
      settings: () => services.settings,
      projects: () => [
        { path: world.projects.alpha, name: 'alpha' },
        { path: world.projects.beta, name: 'beta' }
      ],
      onChange: () => undefined
    })
    const sessions: Partial<SessionHost> = {
      review: (plan, grid) => {
        branchAtSpawn = branchOf(plan.repoPath)
        return host.review(plan, grid)
      }
    }
    // Only what these channels and registration itself reach for.
    const themes = { onChange: () => undefined }
    registerIpc({ services, window: () => null, pulls, sessions, themes } as unknown as IpcContext)
  })

  afterAll(async () => {
    pulls.stop()
    for (const session of host.list()) {
      if (session.status === 'running') await host.close({ id: session.id, force: true })
    }
    await vi.waitFor(() => expect(host.list().filter((s) => s.status === 'running')).toEqual([]), {
      timeout: 10_000
    })
    // As before-quit does: a killed pty can report its exit after this, and
    // the host must not write it to a store that has been closed.
    host.shutdown()
    services.store.close()
    disposeWorld(world)
  })

  beforeEach(() => {
    fx.behave({})
  })

  /** Windows hands a PATH match back in PATHEXT's casing. */
  const samePath = (a: string | null, b: string): boolean => a?.toLowerCase() === b.toLowerCase()

  describe('the gh override', () => {
    it('Locate writes ghPath, and the status and the next fetch are that gh', async () => {
      fx.behave({ version: 'gh version 7.7.7 (fixture)' })
      const discovered = await pulls.refresh()
      expect(samePath(discovered.gh.path, world.gh)).toBe(true)
      expect(discovered.gh).toMatchObject({ source: 'discovered', version: 'gh version 2.86.0 (synthetic)' })
      expect(fx.calls()).toEqual([])

      await write({ ghPath: fx.gh })

      expect(services.settings.ghPath).toBe(fx.gh)
      const picked = pulls.snapshot()
      expect(picked.gh).toMatchObject({ path: fx.gh, source: 'setting', version: 'gh version 7.7.7 (fixture)' })
      expect(callsOf(fx.calls(), 'pr', 'list').length).toBeGreaterThan(0)
      expect(picked.repos.find((repo) => repo.slug === ALPHA)?.pulls.map((pull) => pull.number)).toEqual([7, 9])
    })

    it('clearing it returns to the discovered gh, and the sign-in problem clears on that fetch', async () => {
      fx.behave({ list: 'error', listError: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' })
      await write({ ghPath: fx.gh })
      await pulls.refresh()
      expect(pulls.snapshot().gh.problem?.kind).toBe('unauthenticated')

      await write({ ghPath: null })

      const cleared = pulls.snapshot().gh
      expect(samePath(cleared.path, world.gh)).toBe(true)
      expect(cleared).toMatchObject({ source: 'discovered', problem: null })
    })
  })

  describe('Review with Claude', () => {
    it('renders the stored template in main, ignores a prompt sent with the request, and starts claude in the repository', async () => {
      await write({ ghPath: fx.gh, prReviewPrompt: 'Review {slug}#{number} ({title}) on {branch} at {url}' })
      const expected = 'Review Acme/Alpha#7 (Fix the thing) on fix/thing at https://github.com/Acme/Alpha/pull/7'

      const launched = (await invoke('pr:review', {
        repoPath: world.projects.alpha,
        number: 7,
        cols: 100,
        rows: 30,
        prompt: 'something the window made up'
      })) as { prompt: string; session: { id: number; cwd: string; status: string; name: string } }

      expect(launched.prompt).toBe(expected)
      expect(launched.session.status).toBe('running')
      expect(launched.session.cwd.toLowerCase()).toBe(world.projects.alpha.toLowerCase())
      // The session is a row like any other, against the repository it reviews.
      const row = readSessions(services.store).find((session) => session.id === launched.session.id)
      expect(row).toMatchObject({ name: 'PR #7 review - Alpha', status: 'running' })
      expect(row?.projectPath?.toLowerCase()).toBe(world.projects.alpha.toLowerCase())

      const run = await runNamed('PR #7 review - Alpha')
      expect(run.cwd.toLowerCase()).toBe(world.projects.alpha.toLowerCase())
      expect(run.argv.slice(0, 2)).toEqual(['-n', 'PR #7 review - Alpha'])
      expect(run.argv.at(-1)).toBe(expected)
      expect(run.argv).not.toContain('something the window made up')
      // Neither is set, so neither flag is passed.
      expect(run.argv).not.toContain('--model')
      expect(run.argv).not.toContain('--effort')
    })

    it('passes the review model and effort before the trailing prompt, once they are set', async () => {
      await write({ prReviewPrompt: '/code-review {number}', prReviewModel: 'opus', prReviewEffort: 'high' })

      await invoke('pr:review', { repoPath: world.projects.alpha, number: 9, cols: 100, rows: 30 })

      const run = await runNamed('PR #9 review - Alpha')
      expect(run.argv.at(-1)).toBe('/code-review 9')
      const model = run.argv.indexOf('--model')
      const effort = run.argv.indexOf('--effort')
      expect(run.argv[model + 1]).toBe('opus')
      expect(run.argv[effort + 1]).toBe('high')
      expect(Math.max(model, effort) + 1).toBeLessThan(run.argv.length - 1)
      await write({ prReviewModel: null, prReviewEffort: null })
    })

    it('in checkout mode, refuses a dirty tree and starts nothing', async () => {
      await write({ prCheckout: 'checkout' })
      const scratch = join(world.projects.beta, 'scratch.txt')
      writeFileSync(scratch, 'not committed\n')
      try {
        await expect(
          invoke('pr:review', { repoPath: world.projects.beta, number: 3, cols: 100, rows: 30 })
        ).rejects.toThrow(/has 1 uncommitted change\./)
      } finally {
        rmSync(scratch)
      }
      expect(callsOf(fx.calls(), 'pr', 'checkout')).toEqual([])
      expect(fakeClaudeLogs(world).some((log) => log.cwd.toLowerCase() === world.projects.beta.toLowerCase())).toBe(
        false
      )
    })

    it('in checkout mode on a clean tree, checks the branch out in the repository before the session starts', async () => {
      expect(services.settings.prCheckout).toBe('checkout')
      expect(branchOf(world.projects.beta)).toBe('feature/beta')

      const launched = (await invoke('pr:review', {
        repoPath: world.projects.beta,
        number: 3,
        cols: 100,
        rows: 30
      })) as { checkedOut: string | null }

      expect(launched.checkedOut).toBe('feature/three')
      expect(branchAtSpawn).toBe('feature/three')
      const [checkout] = callsOf(fx.calls(), 'pr', 'checkout')
      expect(checkout?.argv).toEqual(['pr', 'checkout', '3', '--repo', BETA])
      expect(checkout?.cwd.toLowerCase()).toBe(world.projects.beta.toLowerCase())
      await runNamed('PR #3 review - beta')
      await write({ prCheckout: 'none' })
    })
  })
})
