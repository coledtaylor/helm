import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as PtyModule from './pty'

/**
 * The order a closed session's processes are ended in, stepped with a fake pty
 * and a recorded tree kill, for each of the two orders `treekill.ts` chooses
 * between by OS. The real kills are `treekill.test.ts` and the session tests'.
 */

interface FakePty {
  pid: number
  kill: () => void
  onData: (listener: (chunk: string) => void) => void
  onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void
  /** Reports the process's exit, as node-pty does. */
  exit: () => void
}

interface Harness {
  pty: typeof PtyModule
  /** What happened, in order: `hangup` for `IPty.kill()`, `tree` for a tree kill. */
  steps: string[]
  /** Finishes the oldest tree kill still in flight, running its `done`. */
  finishTree: () => void
  fake: () => FakePty
}

async function load(treeBeforeHangup: boolean): Promise<Harness> {
  vi.resetModules()
  const steps: string[] = []
  const inFlight: (() => void)[] = []
  let current: FakePty | null = null

  vi.doMock('./treekill', () => ({
    TREE_BEFORE_HANGUP: treeBeforeHangup,
    treeKill: (pid: number, _sync: boolean, done: () => void = () => undefined) => {
      steps.push(`tree ${pid}`)
      inFlight.push(done)
    }
  }))
  vi.doMock('node-pty', () => ({
    spawn: () => {
      let exitListener: ((event: { exitCode: number }) => void) | null = null
      const made: FakePty = {
        pid: 4242,
        kill: () => {
          steps.push('hangup')
        },
        onData: () => undefined,
        onExit: (listener) => {
          exitListener = listener
        },
        exit: () => exitListener?.({ exitCode: 1 })
      }
      current = made
      return made
    }
  }))

  return {
    pty: await import('./pty'),
    steps,
    finishTree: () => {
      const done = inFlight.shift()
      if (done === undefined) throw new Error('no tree kill is in flight')
      done()
    },
    fake: () => {
      if (current === null) throw new Error('no pty was spawned')
      return current
    }
  }
}

function start(h: Harness): void {
  h.pty.spawnSession({
    id: 'one',
    file: 'claude',
    args: [],
    cols: 80,
    rows: 24,
    cwd: '.',
    onData: () => undefined,
    onExit: () => undefined
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.doUnmock('./treekill')
  vi.doUnmock('node-pty')
  vi.resetModules()
})

describe('closing a session where the tree goes first (Windows)', () => {
  it('ends the tree while its root still names its children, then releases the pty', async () => {
    const h = await load(true)
    start(h)

    h.pty.killSession('one')
    expect(h.steps).toEqual(['tree 4242'])

    h.finishTree()
    expect(h.steps).toEqual(['tree 4242', 'hangup'])
  })

  it('still releases the pty when its exit was reported before the tree kill finished', async () => {
    const h = await load(true)
    start(h)

    h.pty.killSession('one')
    h.fake().exit()
    expect(h.pty.getSession('one')).toBeUndefined()

    h.finishTree()
    expect(h.steps).toEqual(['tree 4242', 'hangup'])
  })

  it('starts nothing more when the tab is closed a second time', async () => {
    const h = await load(true)
    start(h)

    h.pty.killSession('one')
    h.pty.killSession('one')
    h.finishTree()
    h.pty.killSession('one')

    expect(h.steps).toEqual(['tree 4242', 'hangup'])
    expect(() => h.finishTree()).toThrow('no tree kill is in flight')
  })
})

describe('closing a session where the hangup goes first (macOS and Linux)', () => {
  it('hangs up first and kills the tree only once the root outlives the grace', async () => {
    vi.useFakeTimers()
    const h = await load(false)
    start(h)

    h.pty.killSession('one')
    expect(h.steps).toEqual(['hangup'])

    vi.advanceTimersByTime(1499)
    expect(h.steps).toEqual(['hangup'])
    vi.advanceTimersByTime(1)
    expect(h.steps).toEqual(['hangup', 'tree 4242'])
  })

  it('kills no tree when the root honours the hangup within the grace', async () => {
    vi.useFakeTimers()
    const h = await load(false)
    start(h)

    h.pty.killSession('one')
    h.fake().exit()
    vi.runAllTimers()

    expect(h.steps).toEqual(['hangup'])
  })

  it('hangs up once and arms one backstop when the tab is closed a second time', async () => {
    vi.useFakeTimers()
    const h = await load(false)
    start(h)

    h.pty.killSession('one')
    h.pty.killSession('one')
    vi.runAllTimers()

    expect(h.steps).toEqual(['hangup', 'tree 4242'])
  })
})
