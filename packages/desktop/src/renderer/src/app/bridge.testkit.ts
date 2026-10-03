import type {
  EventChannel,
  EventPayload,
  HelmBridge,
  RequestChannel,
  RequestPayload,
  RequestResult,
  SendChannel,
  SendPayload
} from '../../../shared/ipc'

/**
 * The preload's bridge, faked, for every renderer test in jsdom.
 *
 * The test plays the main process. It answers the requests it cares about with
 * `answer`, pushes events with `emit`, and reads back what the renderer asked
 * for with `invoked` and `sent`. The module is shaped to stand in for
 * `bridge.ts` whole, so a test file mocks it in one line and addresses the same
 * object as `bridge`:
 *
 *   import { bridge } from './bridge.testkit'
 *
 *   vi.mock('./bridge', () => import('./bridge.testkit'))
 *
 * There is one bridge per test file. `bridge.ts` reads `window.helm` once, when
 * it loads, and so does every module that subscribes at import time
 * (`pterms.ts`); a single instance per file is what they all see. `reset` it
 * between tests.
 *
 * A request nothing answers rejects, naming its channel, so a hook reaching for
 * a channel nobody expected fails rather than hanging. A file whose hooks ask
 * for more than any one test is about says `whenUnanswered('pending')`, and
 * what it leaves unanswered then waits quietly instead of throwing into an
 * unhandled rejection.
 */
export interface FakeBridge extends HelmBridge {
  /**
   * Answers `invoke(channel)` from now on. The answer runs inside the invoke,
   * as the renderer makes it, so a test can keep a resolver it hands out and
   * settle the request later; a throw rejects the invoke.
   */
  answer<K extends RequestChannel>(channel: K, answer: Answer<K>): void
  /** What a request nothing answers does. `reject` until a test says otherwise. */
  whenUnanswered(rule: UnansweredRule): void
  /** Main pushing an event at the window: what `emit` in `main/ipc.ts` does for a window that is open. */
  emit<K extends EventChannel>(channel: K, payload: EventPayload<K>): void
  /** The payloads `channel` was invoked with, in order. */
  invoked<K extends RequestChannel>(channel: K): Array<RequestPayload<K>>
  /** The payloads sent on `channel`, in order. */
  sent<K extends SendChannel>(channel: K): Array<SendPayload<K>>
  /** Every invoke, in order, answered or not. */
  readonly invocations: readonly Invocation[]
  /** Every send, in order. */
  readonly sends: readonly Sending[]
  /** Forgets what was invoked and sent so far; answers and listeners stay. */
  clearRecords(): void
  /**
   * Forgets every answer and everything recorded, and puts the unanswered rule
   * back to `reject`. Listeners stay: each belongs to whoever subscribed - a
   * module at import time, or a component that unsubscribes when it unmounts -
   * and dropping them would leave an import-time subscriber deaf to every test
   * after the first.
   */
  reset(): void
}

/** How main answers one request channel, as a test plays it. */
export type Answer<K extends RequestChannel> = (
  payload: RequestPayload<K>
) => RequestResult<K> | Promise<RequestResult<K>>

export type UnansweredRule = 'reject' | 'pending'

/** One `invoke`, as the renderer made it. */
export type Invocation = { [K in RequestChannel]: { channel: K; payload: RequestPayload<K> } }[RequestChannel]

/** One `send`, as the renderer made it. */
export type Sending = { [K in SendChannel]: { channel: K; payload: SendPayload<K> } }[SendChannel]

function createBridge(): FakeBridge {
  const answers = new Map<RequestChannel, (payload: never) => unknown>()
  const listeners = new Map<EventChannel, Set<(payload: never) => void>>()
  const invocations: Invocation[] = []
  const sends: Sending[] = []
  let unanswered: UnansweredRule = 'reject'

  return {
    invoke<K extends RequestChannel>(
      channel: K,
      ...args: RequestPayload<K> extends void ? [] : [payload: RequestPayload<K>]
    ): Promise<RequestResult<K>> {
      const payload = args.at(0) as RequestPayload<K>
      invocations.push({ channel, payload } as Invocation)
      const answer = answers.get(channel) as Answer<K> | undefined
      if (answer === undefined) {
        return unanswered === 'pending'
          ? new Promise<never>(() => undefined)
          : Promise.reject(new Error(`fake bridge: nothing answers ${channel}`))
      }
      // A throw inside the executor rejects the promise it builds.
      return new Promise<RequestResult<K>>((resolve) => resolve(answer(payload)))
    },

    send<K extends SendChannel>(channel: K, ...args: SendPayload<K> extends void ? [] : [payload: SendPayload<K>]): void {
      sends.push({ channel, payload: args.at(0) } as Sending)
    },

    on<K extends EventChannel>(channel: K, listener: (payload: EventPayload<K>) => void): () => void {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
      return () => {
        set.delete(listener)
      }
    },

    answer(channel, answer) {
      answers.set(channel, answer)
    },
    whenUnanswered(rule) {
      unanswered = rule
    },
    emit<K extends EventChannel>(channel: K, payload: EventPayload<K>) {
      for (const listener of listeners.get(channel) ?? []) (listener as (payload: EventPayload<K>) => void)(payload)
    },
    invoked<K extends RequestChannel>(channel: K) {
      return invocations.filter((call) => call.channel === channel).map((call) => call.payload as RequestPayload<K>)
    },
    sent<K extends SendChannel>(channel: K) {
      return sends.filter((sending) => sending.channel === channel).map((sending) => sending.payload as SendPayload<K>)
    },
    invocations,
    sends,
    clearRecords() {
      invocations.length = 0
      sends.length = 0
    },
    reset() {
      answers.clear()
      invocations.length = 0
      sends.length = 0
      unanswered = 'reject'
    }
  }
}

/** This test file's bridge. */
export const bridge: FakeBridge = createBridge()

/** The same object, under the name `bridge.ts` exports it by. */
export const helm: HelmBridge = bridge
