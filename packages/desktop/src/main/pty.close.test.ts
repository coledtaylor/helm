import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as PtyModule from './pty'

/**
 * The order a closed session's processes are ended in, stepped with fake ptys
 * and a recorded tree kill, for each of the two orders `treekill.ts` chooses
 * between by OS, and the turns closed sessions take to end. The real kills are
 * `treekill.test.ts` and the session tests'.
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
  /** What happened, in order: `hangup <pid>` for `IPty.kill()`, `tree <pid>` for a tree kill. */
  steps: string[]
  /** Finishes the oldest tree kill still in flight, running its `done`. */
  finishTree: () => void
  /** The pty spawned for a session, by its id. */
  fake: (id?: string) => FakePty
}

/** The first fake pty's pid; each one after it gets the next. */
const FIRST_PID = 4242

async function load(treeBeforeHangup: boolean): Promise<Harness> {
  vi.resetModules()
  const steps: string[] = []
  const inFlight: (() => void)[] = []
  const spawned: FakePty[] = []

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
      const pid = FIRST_PID + spawned.length
      const made: FakePty = {
        pid,
        kill: () => {
          steps.push(`hangup ${pid}`)
        },
        onData: () => undefined,
        onExit: (listener) => {
          exitListener = listener
        },
        exit: () => exitListener?.({ exitCode: 1 })
      }
      spawned.push(made)
      return made
    }
  }))

  const ids: string[] = []
  const pty = await import('./pty')
  const spawnSession = pty.spawnSession
  return {
    pty: {
      ...pty,
      spawnSession: (opts) => {
        ids.push(opts.id)
        return spawnSession(opts)
      }
    },
    steps,
    finishTree: () => {
      const done = inFlight.shift()
      if (done === undefined) throw new Error('no tree kill is in flight')
      done()
    },
    fake: (id = 'one') => {
      const made = spawned[ids.indexOf(id)]
      if (made === undefined) throw new Error(`no pty was spawned for ${id}`)
      return made
    }
  }
}

function start(h: Harness, id = 'one'): void {
  h.pty.spawnSession({
    id,
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
  it('ends the tree while its root still names its children, then releases the pty once its exit is reported', async () => {
    const h = await load(true)
    start(h)

    h.pty.killSession('one')
    expect(h.steps).toEqual(['tree 4242'])

    h.finishTree()
    expect(h.steps).toEqual(['tree 4242'])

    h.fake().exit()
    expect(h.steps).toEqual(['tree 4242', 'hangup 4242'])
  })

  it('still releases the pty when its exit was reported before the tree kill finished', async () => {
    const h = await load(true)
    start(h)

    h.pty.killSession('one')
    h.fake().exit()
    expect(h.pty.getSession('one')).toBeUndefined()

    h.finishTree()
    expect(h.steps).toEqual(['tree 4242', 'hangup 4242'])
  })

  it('releases the pty after the grace when its exit is never reported', async () => {
    vi.useFakeTimers()
    const h = await load(true)
    start(h)

    h.pty.killSession('one')
    h.finishTree()
    vi.advanceTimersByTime(1499)
    expect(h.steps).toEqual(['tree 4242'])
    vi.advanceTimersByTime(1)
    expect(h.steps).toEqual(['tree 4242', 'hangup 4242'])

    // A late exit releases nothing a second time.
    h.fake().exit()
    expect(h.steps).toEqual(['tree 4242', 'hangup 4242'])
  })

  it('starts nothing more when the tab is closed a second time', async () => {
    const h = await load(true)
    start(h)

    h.pty.killSession('one')
    h.pty.killSession('one')
    h.finishTree()
    h.pty.killSession('one')
    h.fake().exit()

    expect(h.steps).toEqual(['tree 4242', 'hangup 4242'])
    expect(() => h.finishTree()).toThrow('no tree kill is in flight')
  })

  it('ends closed sessions one at a time, the next once the last has reported its exit', async () => {
    const h = await load(true)
    start(h, 'one')
    start(h, 'two')
    start(h, 'three')

    h.pty.killSession('one')
    h.pty.killSession('two')
    h.pty.killSession('three')
    expect(h.steps).toEqual(['tree 4242'])

    h.finishTree()
    h.fake('one').exit()
    expect(h.steps).toEqual(['tree 4242', 'hangup 4242', 'tree 4243'])

    h.fake('two').exit()
    h.finishTree()
    expect(h.steps).toEqual(['tree 4242', 'hangup 4242', 'tree 4243', 'hangup 4243', 'tree 4244'])
  })

  it('kills no tree for a waiting session that exited on its own, whose pid may name another process', async () => {
    const h = await load(true)
    start(h, 'one')
    start(h, 'two')
    start(h, 'three')

    h.pty.killSession('one')
    h.pty.killSession('two')
    h.pty.killSession('three')
    h.fake('two').exit()

    h.finishTree()
    h.fake('one').exit()
    expect(h.steps).toEqual(['tree 4242', 'hangup 4242', 'hangup 4243', 'tree 4244'])
  })
})

describe('closing a session where the hangup goes first (macOS and Linux)', () => {
  it('hangs up first and kills the tree only once the root outlives the grace', async () => {
    vi.useFakeTimers()
    const h = await load(false)
    start(h)

    h.pty.killSession('one')
    expect(h.steps).toEqual(['hangup 4242'])

    vi.advanceTimersByTime(1499)
    expect(h.steps).toEqual(['hangup 4242'])
    vi.advanceTimersByTime(1)
    expect(h.steps).toEqual(['hangup 4242', 'tree 4242'])
  })

  it('kills no tree when the root honours the hangup within the grace', async () => {
    vi.useFakeTimers()
    const h = await load(false)
    start(h)

    h.pty.killSession('one')
    h.fake().exit()
    vi.runAllTimers()

    expect(h.steps).toEqual(['hangup 4242'])
  })

  it('hangs up once and arms one backstop when the tab is closed a second time', async () => {
    vi.useFakeTimers()
    const h = await load(false)
    start(h)

    h.pty.killSession('one')
    h.pty.killSession('one')
    vi.runAllTimers()

    expect(h.steps).toEqual(['hangup 4242', 'tree 4242'])
  })

  it('ends closed sessions one at a time, the next once the last has exited or its tree kill is done', async () => {
    vi.useFakeTimers()
    const h = await load(false)
    start(h, 'one')
    start(h, 'two')
    start(h, 'three')

    h.pty.killSession('one')
    h.pty.killSession('two')
    h.pty.killSession('three')
    expect(h.steps).toEqual(['hangup 4242'])

    h.fake('one').exit()
    expect(h.steps).toEqual(['hangup 4242', 'hangup 4243'])

    vi.advanceTimersByTime(1500)
    expect(h.steps).toEqual(['hangup 4242', 'hangup 4243', 'tree 4243'])
    h.finishTree()
    expect(h.steps).toEqual(['hangup 4242', 'hangup 4243', 'tree 4243', 'hangup 4244'])
  })
})
