import { expect, vi } from 'vitest'
import type { SessionRecord } from '@helm/core'
import type { SessionHost, SessionHostDeps } from '../src/main/sessions'
import type { Services } from '../src/main/services'
import { createWorld, disposeWorld, fakeClaudeLogs, type FakeClaudeLog, type World } from './world'

/**
 * A session host running the fake `claude` in a world of its own, for the
 * main-process tests about a session's life: starting, ending, closing,
 * renaming and shutting down.
 *
 * The test file still mocks `electron` itself - `vi.mock` is hoisted per file -
 * and this imports the main-process modules only after the world's environment
 * is in place, because the data directory and Claude's home are read when they
 * load.
 */
export interface HostedWorld {
  world: World
  services: Services
  host: SessionHost
  /** Everything each session has printed, by session id. */
  output: Map<number, string>
  /** Resolves once the session's fake `claude` has drawn its prompt. */
  ready: (id: number) => Promise<void>
  /** The fake `claude`'s own record of the run behind a session, read fresh. */
  run: (record: Pick<SessionRecord, 'claudeSessionId'>) => Promise<FakeClaudeLog>
  /**
   * Ends whatever is still running, closes the store and removes the world.
   * It can outlast vitest's 10s hook default on a loaded machine, so a hook
   * calling it passes `DISPOSE_TIMEOUT_MS`.
   */
  dispose: () => Promise<void>
}

export type HostOptions = Partial<Omit<SessionHostDeps, 'services'>>

/** For the hooks that set up and dispose a hosted world: the suite's test timeout. */
export const DISPOSE_TIMEOUT_MS = 30_000

export async function hostInWorld(options: HostOptions = {}): Promise<HostedWorld> {
  const world = createWorld()
  Object.assign(process.env, {
    PORTABLE_EXECUTABLE_DIR: world.portableDir,
    USERPROFILE: world.home,
    HOME: world.home
  })
  delete process.env['CLAUDE_CONFIG_DIR']

  const { createServices } = await import('../src/main/services')
  const { createSessionHost } = await import('../src/main/sessions')
  const { setClaudeOverride } = await import('../src/main/claude-cli')
  setClaudeOverride(world.claude)

  const services = createServices()
  const output = new Map<number, string>()
  const host = createSessionHost({
    services,
    window: options.window ?? (() => null),
    browserMcp: options.browserMcp,
    observer: {
      ...options.observer,
      onOutput: (id, chunk) => {
        output.set(id, (output.get(id) ?? '') + chunk)
        options.observer?.onOutput?.(id, chunk)
      }
    },
    confirm: options.confirm ?? (() => Promise.resolve(true))
  })

  return {
    world,
    services,
    host,
    output,
    ready: (id) =>
      vi.waitFor(() => expect(output.get(id)).toContain('? for shortcuts'), { timeout: 10_000 }),
    run: async (record) => {
      expect(record.claudeSessionId).not.toBeNull()
      let found: FakeClaudeLog | undefined
      await vi.waitFor(() => {
        found = fakeClaudeLogs(world).find((log) => log.sessionId === record.claudeSessionId)
        expect(found).toBeDefined()
      }, { timeout: 10_000 })
      return found as FakeClaudeLog
    },
    dispose: async () => {
      const ids = host.list().map((session) => session.id)
      for (const id of ids) await host.close({ id, force: true })
      // A closed tab's entry is forgotten once its pty reports the exit, so
      // nothing is left holding a file inside the world when it is removed.
      await vi.waitFor(() => expect(ids.filter((id) => host.pid(id) !== null)).toEqual([]), {
        timeout: 10_000
      })
      services.store.close()
      // The pty reports its exit when its own process ends; the `claude` under
      // it can take a moment longer to leave its working directory, which
      // Windows will not remove while anything is in it.
      await vi.waitFor(() => disposeWorld(world), { timeout: 15_000, interval: 250 })
    }
  }
}

/** Whether a process is still running. `EPERM` means it exists and is not ours to signal. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
