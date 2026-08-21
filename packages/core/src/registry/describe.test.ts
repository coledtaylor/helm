import { describe, expect, it } from 'vitest'
import {
  describeDuration,
  describeSessionDetail,
  describeSessionGone,
  describeSessionListing,
  heldBy,
  type HostedSessionFacts
} from './describe'
import { SESSION_ACTIVITIES, type LiveSession, type SessionResources } from '../types'

const READ_AT = 1_787_280_000_000

function live(over: Partial<LiveSession> = {}): LiveSession {
  return {
    helmSessionId: null,
    pid: 4242,
    registered: true,
    cwd: 'C:\\repos\\api',
    name: 'api',
    activity: 'idle',
    waitingFor: null,
    statusSinceMs: READ_AT - 90_000,
    version: '2.1.238',
    entrypoint: 'cli',
    startedAtMs: READ_AT - 600_000,
    claudeSessionId: 'fcbc98b5-5d39-41eb-aa14-e2379c06d662',
    ...over
  }
}

function facts(over: Partial<HostedSessionFacts> = {}): HostedSessionFacts {
  return {
    helmSessionId: 7,
    branch: 'main',
    profile: null,
    overlays: [],
    startedAtMs: READ_AT - 600_000,
    ...over
  }
}

describe('the listing', () => {
  it('marks the caller from the id it was given and marks nothing else', () => {
    const text = describeSessionListing({
      sessions: [
        live({ pid: 100, helmSessionId: 7, name: 'mine' }),
        live({ pid: 200, helmSessionId: 8, name: 'theirs' })
      ],
      readAtMs: READ_AT,
      callerHelmSessionId: 7
    })

    expect(text).toContain('#100  "mine"  (this session)')
    expect(text).toContain('#200  "theirs"')
    expect(text).not.toContain('#200  "theirs"  (this session)')
    // Exactly one, whatever else is in the listing: the marking comes from the
    // bearer token upstream, and two of them would mean it had come from
    // something the caller said.
    expect(text.match(/\(this session\)/g)).toHaveLength(1)
  })

  it('marks nothing when the caller has no session of its own', () => {
    const text = describeSessionListing({
      sessions: [live({ pid: 100, helmSessionId: 7 })],
      readAtMs: READ_AT,
      callerHelmSessionId: null
    })
    expect(text).not.toContain('(this session)')
  })

  it('lists a session Helm did not start, and says that is what it is', () => {
    const text = describeSessionListing({
      sessions: [
        live({ pid: 100, helmSessionId: 7, name: 'hosted' }),
        live({ pid: 200, helmSessionId: null, name: 'in a terminal' })
      ],
      readAtMs: READ_AT,
      callerHelmSessionId: 7
    })
    expect(text).toContain('2 Claude Code sessions running on this machine, 1 of them hosted by Helm.')
    expect(text).toContain('"in a terminal"')
    expect(text).toContain('started somewhere else on this machine')
  })

  it('says so rather than nothing when there is nothing running', () => {
    const text = describeSessionListing({ sessions: [], readAtMs: READ_AT, callerHelmSessionId: 1 })
    expect(text).toContain('No Claude Code sessions are running')
  })

  /*
   * The rule the whole surface inherits: a status Helm could not read is
   * reported as unknown, never omitted and never guessed. An agent told nothing
   * concludes there is nothing there, and "nothing is running in this
   * directory" is exactly what somebody checks before starting a second agent.
   */
  it('reports an unreadable status as unknown rather than as idle', () => {
    const unregistered = describeSessionListing({
      sessions: [live({ helmSessionId: 3, registered: false, activity: null })],
      readAtMs: READ_AT,
      callerHelmSessionId: null
    })
    expect(unregistered).toContain('unknown')
    expect(unregistered).toContain('has not written a record for it yet')
    expect(unregistered).not.toContain('idle')

    const noStatus = describeSessionListing({
      sessions: [live({ registered: true, activity: null })],
      readAtMs: READ_AT,
      callerHelmSessionId: null
    })
    expect(noStatus).toContain('published no status Helm recognises')
    expect(noStatus).not.toContain('idle')
  })

  /** Four statuses, four different sentences - none of them collapses onto another. */
  it('gives every status the CLI publishes its own words', () => {
    const sentences = SESSION_ACTIVITIES.map((activity) =>
      describeSessionListing({
        sessions: [live({ activity, waitingFor: activity === 'waiting' ? 'permission prompt' : null })],
        readAtMs: READ_AT,
        callerHelmSessionId: null
      })
        .split('\n')
        .find((line) => line.includes('status'))
    )
    expect(new Set(sentences).size).toBe(SESSION_ACTIVITIES.length)
    expect(sentences.some((line) => line?.includes('permission prompt'))).toBe(true)
  })

  /*
   * How long a status has held is a fact; how old the record is says nothing
   * about liveness. The first is what this prints, measured against the moment
   * the registry was read rather than against `Date.now()`, so the number
   * belongs to the pass it came from.
   */
  it('says how long the status has held, from the read that produced it', () => {
    const text = describeSessionListing({
      sessions: [live({ activity: 'busy', statusSinceMs: READ_AT - 4 * 60_000 })],
      readAtMs: READ_AT,
      callerHelmSessionId: null
    })
    expect(text).toContain('busy - the model is working, for 4m')
  })

  it('leaves the duration off a record that carries no transition time', () => {
    const text = describeSessionListing({
      sessions: [live({ activity: 'busy', statusSinceMs: null })],
      readAtMs: READ_AT,
      callerHelmSessionId: null
    })
    expect(text).toContain('busy - the model is working')
    expect(text).not.toContain(', for ')
  })
})

describe('one session in detail', () => {
  it('says what is knowable about a session Helm did not start, and no more', () => {
    const text = describeSessionDetail({
      session: live({ helmSessionId: null }),
      hosted: null,
      holding: null,
      readAtMs: READ_AT,
      isCaller: false
    })
    expect(text).toContain('Helm did not start this session')
    expect(text).toContain('C:\\repos\\api')
    // The sentence names what is missing; what must not appear is a *field*
    // claiming to know it.
    expect(text).not.toMatch(/^branch /m)
    expect(text).not.toMatch(/^profile /m)
    expect(text).not.toMatch(/^Helm tab /m)
    expect(text).not.toMatch(/^Holding/m)
  })

  it('carries the branch as the branch at spawn, not as the branch now', () => {
    const text = describeSessionDetail({
      session: live({ helmSessionId: 7 }),
      hosted: facts({ branch: 'feat/cart', profile: 'reviewer', overlays: ['C:\\repos\\helm'] }),
      holding: null,
      readAtMs: READ_AT,
      isCaller: true
    })
    expect(text).toContain('(this session)')
    expect(text).toContain('feat/cart (the branch at spawn')
    expect(text).toContain('captured and never followed')
    expect(text).toContain('reviewer')
    expect(text).toContain('C:\\repos\\helm')
  })

  /*
   * The three answers `SessionResources` is shaped to keep apart, kept apart in
   * words. A surface that merged them would tell somebody a session is holding
   * nothing at the exact moment Helm had failed to ask.
   */
  it('never says "nothing" when it means "could not look"', () => {
    const base = { rootPid: 4242, opaque: 0, atMs: READ_AT }
    const blind: SessionResources = { ...base, id: 7, processes: null, rootSeen: false, ports: null }
    const gone: SessionResources = { ...base, id: 7, processes: [], rootSeen: false, ports: [] }
    const empty: SessionResources = {
      ...base,
      id: 7,
      rootSeen: true,
      ports: [],
      processes: [
        { pid: 4242, parentPid: 1, name: 'claude.exe', commandLine: 'claude', depth: 0, ports: [] }
      ]
    }

    const detail = (resources: SessionResources): string =>
      describeSessionDetail({
        session: live({ helmSessionId: 7 }),
        hosted: facts(),
        holding: heldBy(resources),
        readAtMs: READ_AT,
        isCaller: false
      })

    expect(detail(blind)).toContain('the process enumeration could not run')
    expect(detail(blind)).not.toContain('nothing but the session itself')
    expect(detail(gone)).toContain('was not in it')
    expect(detail(gone)).not.toContain('nothing but the session itself')
    expect(detail(empty)).toContain('nothing but the session itself')
    expect(detail(empty)).toContain('nothing in this session’s tree is listening')
  })

  it('keeps a failed socket query apart from a tree that is listening on nothing', () => {
    const withoutPorts: SessionResources = {
      id: 7,
      rootPid: 4242,
      rootSeen: true,
      opaque: 0,
      atMs: READ_AT,
      ports: null,
      processes: [
        { pid: 4242, parentPid: 1, name: 'claude.exe', commandLine: 'claude', depth: 0, ports: null }
      ]
    }
    const text = describeSessionDetail({
      session: live({ helmSessionId: 7 }),
      hosted: facts(),
      holding: heldBy(withoutPorts),
      readAtMs: READ_AT,
      isCaller: false
    })
    expect(text).toContain('the socket query could not run')
    expect(text).not.toContain('nothing in this session’s tree is listening')
  })

  it('prints the tree with its ports, and admits what it could not read', () => {
    const resources: SessionResources = {
      id: 7,
      rootPid: 4242,
      rootSeen: true,
      opaque: 1,
      atMs: READ_AT - 2000,
      ports: [{ port: 5173, pid: 9002, process: 'node.exe', addresses: ['127.0.0.1'] }],
      processes: [
        { pid: 4242, parentPid: 1, name: 'claude.exe', commandLine: 'claude', depth: 0, ports: [] },
        {
          pid: 9001,
          parentPid: 4242,
          name: 'docker.exe',
          commandLine: 'docker compose up',
          depth: 1,
          ports: []
        },
        {
          pid: 9002,
          parentPid: 9001,
          name: 'node.exe',
          // A prompt on the process table, which is what a subagent looks like
          // from outside and the sharpest reason a tool may not print these.
          commandLine: 'claude -p "summarise the vite config"',
          depth: 2,
          ports: [5173]
        }
      ]
    }
    const text = describeSessionDetail({
      session: live({ helmSessionId: 7 }),
      hosted: facts(),
      holding: heldBy(resources),
      readAtMs: READ_AT,
      isCaller: false
    })

    expect(text).toContain('2 processes under it')
    expect(text).toContain('docker.exe #9001')
    expect(text).toContain('node.exe #9002')
    expect(text).toContain('listening on 5173')

    /*
     * And **no command line**, which is the argv decision one level down.
     *
     * A child process's command line can be another conversation - a subagent
     * is `claude -p "<prompt>"` - or a credential passed as an argument, and it
     * is more than the question this tool answers: `docker.exe` and the port
     * already say "somebody is holding this tree". The mechanism is that
     * `HeldProcess` has no field for one, so this is asserting that `heldBy`
     * really is the only route in.
     */
    expect(text).not.toContain('docker compose up')
    expect(text).not.toContain('summarise the vite config')
    expect(text).not.toContain('claude -p')
    // The fixture is discriminating: the pass it was built from does carry
    // those strings, so their absence above is a fact about the shaping.
    expect(resources.processes?.some((row) => row.commandLine?.includes('docker compose up'))).toBe(
      true
    )
    expect(heldBy(resources).processes?.every((row) => !('commandLine' in row))).toBe(true)
    // The root itself is not printed as one of its own children.
    expect(text).not.toContain('claude.exe #4242')
    expect(text).toContain('Helm last looked 2s ago')
  })

  it('says a pid nothing is running under is gone rather than inventing an answer', () => {
    expect(describeSessionGone(1234)).toContain('No Claude Code session with pid 1234')
    expect(describeSessionGone(1234)).toContain('sessions_list')
  })
})

describe('durations', () => {
  it('reads the way a person would say it', () => {
    expect(describeDuration(0)).toBe('0s')
    expect(describeDuration(-5000)).toBe('0s')
    expect(describeDuration(45_000)).toBe('45s')
    expect(describeDuration(4 * 60_000)).toBe('4m')
    expect(describeDuration(90 * 60_000)).toBe('1h 30m')
    expect(describeDuration(30 * 60 * 60_000)).toBe('1d 6h')
  })
})
