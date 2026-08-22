import type { LiveSession, SessionPort, SessionResources } from '../types'

/**
 * What one session may be told about the others, in words.
 *
 * The shaping half of Helm's session-awareness tools: `main/session-tools.ts`
 * defines them and holds the token, and this decides what an answer says. In
 * core because `packages/core` never imports Electron and because this is where
 * a thing can be unit tested - the tools themselves are covered by
 * `sessions-check --only=tools`, which needs two real sessions to say anything.
 *
 * ## The rule this file exists to make structural
 *
 * **No answer may carry any part of another session's conversation** - not its
 * transcript, not its prompts, not its output. That is the direct analogue of
 * "a tool drives only the tabs its own session opened": a tool that could read
 * somebody else's conversation would be "Helm renders nothing for a live
 * session" defeated sideways, the same way a screenshot of somebody else's tab
 * would have defeated the credential rule through a picture.
 *
 * A promise in a comment is not a mechanism, so the mechanism is the input
 * type. `HostedSessionFacts` and `HeldProcess` are deliberately narrow, and the
 * three fields they do **not** have are the ones a reasonable person would have
 * added - the third, a child process's command line, is argued at `HeldProcess`
 * itself:
 *
 *   - **No argv.** `SessionRecord.argv` is right there and the sessions pane
 *     prints it, so leaving it out looks like an oversight. Two independent
 *     reasons it is not. A review session's argv carries its opening prompt
 *     verbatim - `prepareLaunch({ openingPrompt })` puts it in as the last
 *     positional - which is another session's first user message. And every
 *     argv carries `--mcp-config <file>`, and that file holds **that session's
 *     bearer token for this very endpoint**: handing it over would hand one
 *     session the credential of another, which is the whole attribution rule
 *     undone. The pane may print argv because the pane is the user looking at
 *     their own machine. A tool is a different audience.
 *   - **No conversation id.** `claudeSessionId` is an identifier rather than
 *     content, which is exactly why it is tempting. It is also the *filename*
 *     of the transcript under `~/.claude/projects/<slug>/`, so answering with
 *     it is handing over the map to the thing the rule forbids. It buys nothing
 *     for the question these tools exist for - who is working where, so I can
 *     stay out of their way - and resuming or addressing another session is
 *     coordination, which is explicitly out of scope.
 *
 * A future change that wanted either would have to widen this type, which is
 * where this comment is.
 *
 * ## And the rule it inherits
 *
 * "Paint nothing rather than a wrong number" applies to a tool result too, with
 * the sharper edge the sessions pane already has: **a status Helm could not
 * read is reported as unknown, never omitted and never guessed**, because an
 * agent told nothing will conclude there is nothing there - and "nothing is
 * running in this directory" is precisely what somebody checks before starting
 * a second agent in it.
 */

/** What Helm knows about one of its own sessions, beyond the registry record. */
export interface HostedSessionFacts {
  /** Helm's own session row id. The tab, for a user reading the answer. */
  helmSessionId: number
  /**
   * The branch the working tree was on when Helm spawned it.
   *
   * Captured at spawn and never followed, so it is what this session started
   * on rather than what is checked out now. Said in those words in the answer,
   * because "branch: main" that is quietly four checkouts old is worse than no
   * branch at all.
   */
  branch: string | null
  /** The profile it was launched from, by name, or null for a direct start. */
  profile: string | null
  /** The overlay directories that profile composes. Empty when there are none. */
  overlays: readonly string[]
  /** When Helm's own row says it started, epoch ms. */
  startedAtMs: number | null
}

export interface SessionListingInput {
  /** Every live session on the machine, as one pass saw them. */
  sessions: readonly LiveSession[]
  /** When that pass read the registry, epoch ms. */
  readAtMs: number
  /**
   * The caller's own Helm session row id, or null when it has none.
   *
   * **Established from the bearer token that arrived**, never from anything the
   * caller said. That is what makes "this session" a comparison rather than an
   * honour system, and it is why no tool here takes a session id at all.
   */
  callerHelmSessionId: number | null
}

/**
 * One process under a session, as another session may be told about it.
 *
 * **Deliberately not `SessionProcess`, and the missing field is
 * `commandLine`.** That is the argv decision one level down, and it took the
 * same shape for the same reasons rather than by inheritance from the pane:
 *
 *   - A child process's command line can be **another conversation**. A
 *     subagent is `claude -p "<prompt>"`, and that prompt is on the process
 *     table. The rule says no prompts, and it does not stop applying because
 *     the prompt arrived via the operating system.
 *   - It can be a **credential**: a key passed as an argument, or a nested
 *     session's own `--mcp-config` path, which is the argv trap exactly.
 *   - And it is **more than the question asked for**. What this tool exists to
 *     answer is "is somebody holding this tree" - a container up, a dev server
 *     on 5173. `docker.exe` and the port say that. Which compose project it is
 *     does not change whether an agent should stay out of the way.
 *
 * The counter-argument is real and was weighed: the calling agent can read the
 * process table itself, so withholding buys no absolute protection. It buys the
 * thing that matters anyway - Helm is not the one handing it over, and there is
 * no field here for a later convenience to fill. The sessions **pane** prints
 * command lines and is right to: that is a user looking at their own machine.
 * A tool is a different audience, and same data, different audience, different
 * answer is the general rule this surface follows.
 *
 * The other consequence is worth stating because it is a *reason* rather than a
 * cost: an unelevated `Win32_Process` withholds roughly 58% of command lines on
 * this machine, so a tool that returned them would be arbitrarily inconsistent
 * about it - present for some processes, absent for others, and an agent could
 * draw nothing systematic from either.
 */
export interface HeldProcess {
  pid: number
  /** The image name, e.g. `docker.exe`. */
  name: string
  /** How far below the session's own process this sits. The root is 0. */
  depth: number
  /** Ports it is listening on, or null where the socket query could not run. */
  ports: readonly number[] | null
}

/**
 * What a session is holding, as another session may be told about it.
 *
 * The same three states `SessionResources` keeps apart - could not look, was
 * not there, has nothing - because merging any two of them is how an agent gets
 * told a tree is free at the moment Helm failed to ask.
 */
export interface SessionHolding {
  /** The pty's pid: the root of the tree, and provably Helm's own child. */
  rootPid: number
  /** The tree under it, or null where the host could not be asked at all. */
  processes: readonly HeldProcess[] | null
  /** Whether `rootPid` was in the enumeration at all. */
  rootSeen: boolean
  /** Listening sockets anywhere in the tree, or null where none was asked for. */
  ports: readonly SessionPort[] | null
  /** When the pass that produced this ran, epoch ms. */
  atMs: number
}

/**
 * A resource pass, narrowed to what a tool may say.
 *
 * The one place `SessionProcess.commandLine` is dropped, so that the shaping
 * below cannot print a field it never receives. A change that wanted command
 * lines in a tool answer has to widen `HeldProcess` and pass them through here,
 * which is where the reasoning is.
 */
export function heldBy(resources: SessionResources): SessionHolding {
  return {
    rootPid: resources.rootPid,
    rootSeen: resources.rootSeen,
    ports: resources.ports,
    atMs: resources.atMs,
    processes:
      resources.processes === null
        ? null
        : resources.processes.map((row) => ({
            pid: row.pid,
            name: row.name,
            depth: row.depth,
            ports: row.ports
          }))
  }
}

export interface SessionDetailInput {
  session: LiveSession
  /** Helm's own facts, or null for a session Helm did not start. */
  hosted: HostedSessionFacts | null
  /**
   * The most recent resource pass for it, or null where none was taken.
   *
   * Null and a pass that could not look are different answers and both are
   * said out loud; so is a pass that ran and found the session childless. See
   * `SessionResources` for why those three are three.
   */
  holding: SessionHolding | null
  readAtMs: number
  isCaller: boolean
}

/**
 * A duration a person reads, from a millisecond count. Never negative.
 *
 * Not `describeAge` from the usage reader, which is otherwise the same idea:
 * that one starts at minutes, because a usage window is measured in hours and a
 * status bar has no room for a second hand. Here the short end is the
 * interesting end - "waiting on you, for 3s" and "waiting on you, for 40m" are
 * the difference between a prompt somebody is about to answer and one they have
 * walked away from - and both would read "0m" there.
 */
export function describeDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`
}

/**
 * What a session is doing, and how long it has been doing it.
 *
 * The age is the one thing here that has to be read carefully. The record is
 * written **on transition and never on a timer**, so the time since it was
 * written is exactly how long this status has held - which is the useful half,
 * and the difference between "it is working" and "it has been working for
 * fifty minutes". It says nothing whatever about whether the session is still
 * alive; that was settled before this was called, by `probeProcess`, and every
 * entry that reaches here has already been through it.
 */
function describeStatus(session: LiveSession, readAtMs: number): string {
  const held =
    session.statusSinceMs === null ? '' : `, for ${describeDuration(readAtMs - session.statusSinceMs)}`

  if (session.activity === null) {
    // Three ways into this and they are different sentences, because the first
    // is a session that is fine and the third is Helm admitting it cannot read
    // something. None of them is "idle", which is the guess that would make an
    // agent walk into a working tree.
    if (!session.registered) {
      return 'unknown - Helm started it and Claude Code has not written a record for it yet'
    }
    return 'unknown - it has registered but published no status Helm recognises'
  }

  if (session.activity === 'waiting') {
    // The CLI's own sentence, verbatim and never matched against: it comes from
    // whatever dialog is on top. Measured values on 2.1.238 are "dialog open"
    // and "permission prompt".
    const why = session.waitingFor === null ? 'something' : session.waitingFor
    return `waiting on the user (${why})${held}`
  }
  if (session.activity === 'shell') {
    return `shell - handed back to the user, with a background task still running${held}`
  }
  if (session.activity === 'busy') return `busy - the model is working${held}`
  return `idle - handed back to the user, nothing running${held}`
}

function describeName(session: LiveSession): string {
  return session.name === null || session.name === '' ? '(unnamed)' : `"${session.name}"`
}

/**
 * Every live session on the machine, one block each.
 *
 * **Machine-wide, and that is a decision rather than a free win.** A `claude`
 * somebody started in a terminal holds a working tree exactly as hard as a tab
 * does, and the argument against - that it tells an agent about work the user
 * never brought into Helm - does not survive contact with the machine. **Any
 * Claude Code session can already read `~/.claude/sessions/*.json` itself**, so
 * withholding here buys nothing real; what it would buy is two surfaces of the
 * same app contradicting each other about what is running on one machine, which
 * is worse than either answer on its own. Both halves are worth keeping written
 * down, because without the first somebody re-proposes the restriction and
 * without the second it looks like laziness.
 *
 * What is withheld instead is the half that is Helm's to withhold: nothing
 * about a session Helm did not start is invented, and nothing about any
 * session's conversation is ever returned.
 *
 * It is the same rule `browser_tabs` established, arrived at from the other
 * side: listing is not driving.
 */
export function describeSessionListing(input: SessionListingInput): string {
  const { sessions, readAtMs, callerHelmSessionId } = input
  if (sessions.length === 0) {
    // Not an empty string, and not an error. "Nothing is running" is a real
    // answer and it is the one that decides whether to start something.
    return 'No Claude Code sessions are running on this machine - not even this one, which means Helm read the registry and found nothing in it.'
  }

  const hosted = sessions.filter((session) => session.helmSessionId !== null).length
  const head =
    `${String(sessions.length)} Claude Code session${sessions.length === 1 ? '' : 's'} ` +
    `running on this machine, ${String(hosted)} of them hosted by Helm.`

  const blocks = sessions.map((session) => {
    const isCaller =
      callerHelmSessionId !== null && session.helmSessionId === callerHelmSessionId
    const lines = [
      `#${String(session.pid)}  ${describeName(session)}${isCaller ? '  (this session)' : ''}`,
      `    working in   ${session.cwd ?? 'unknown - the record carries no working directory'}`,
      `    status       ${describeStatus(session, readAtMs)}`,
      `    hosted       ${
        session.helmSessionId === null
          ? 'no - started somewhere else on this machine, so Helm knows only what Claude Code publishes about it'
          : `yes, in Helm tab ${String(session.helmSessionId)}`
      }`
    ]
    return lines.join('\n')
  })

  return [
    head,
    'Read-only. Nothing here sends a session anything, and no tool returns any part of another session’s conversation.',
    '',
    // A blank line between blocks: this is read by a model in one lump of text,
    // and four sessions run together are four sessions somebody has to parse.
    blocks.join('\n\n'),
    '',
    'session_detail takes one of the pids above.'
  ].join('\n')
}

/** The tree and the ports, or the reason there is nothing to print. */
function describeResources(resources: SessionHolding | null, readAtMs: number): string[] {
  if (resources === null) {
    return [
      'Holding      unknown - Helm has not looked at this machine’s processes for this session.'
    ]
  }

  const looked = `Helm last looked ${describeDuration(readAtMs - resources.atMs)} ago`

  if (resources.processes === null) {
    // The distinction the whole `SessionResources` shape is built around, in
    // words: this is Helm failing to ask, not the machine answering "nothing".
    return [
      `Holding      unknown - the process enumeration could not run (${looked}), so this says nothing about what the session is holding rather than that it is holding nothing.`
    ]
  }
  if (!resources.rootSeen) {
    return [
      `Holding      unknown - the pass ran but this session’s own process was not in it (${looked}), which is what a session that has just ended looks like.`
    ]
  }

  const children = resources.processes.filter((row) => row.pid !== resources.rootPid)
  const out: string[] = []

  if (children.length === 0) {
    out.push(`Holding      nothing but the session itself - no child processes (${looked}).`)
  } else {
    out.push(
      `Holding      ${String(children.length)} process${children.length === 1 ? '' : 'es'} under it (${looked}):`
    )
    // The image name, the pid and what it is listening on. No command line -
    // see `HeldProcess`, which has no field for one.
    for (const row of children) {
      const ports =
        row.ports === null ? '' : row.ports.length === 0 ? '' : `  listening on ${row.ports.join(', ')}`
      out.push(`    ${'  '.repeat(Math.max(0, row.depth - 1))}${row.name} #${String(row.pid)}${ports}`)
    }
  }

  if (resources.ports === null) {
    out.push(
      '    ports        unknown - the socket query could not run, which is a separate query from the one above and fails separately.'
    )
  } else if (resources.ports.length === 0) {
    out.push('    ports        none - nothing in this session’s tree is listening.')
  } else {
    for (const port of resources.ports) {
      out.push(
        `    port ${String(port.port)}    ${port.process} #${String(port.pid)} on ${port.addresses.length === 0 ? 'an address Helm could not read' : port.addresses.join(', ')}`
      )
    }
  }
  return out
}

/**
 * One session, in as much detail as Helm honestly has.
 *
 * **Listing is machine-wide; detail is Helm's own**, and the degradation needs
 * no special case because it is simply what is knowable: Helm did not spawn the
 * other sessions, so it has no branch, no profile and no process tree for them,
 * and says so in a sentence rather than by leaving fields out.
 */
export function describeSessionDetail(input: SessionDetailInput): string {
  const { session, hosted, holding, readAtMs, isCaller } = input

  const head = `#${String(session.pid)}  ${describeName(session)}${isCaller ? '  (this session)' : ''}`
  const lines = [
    head,
    '',
    `working in   ${session.cwd ?? 'unknown - the record carries no working directory'}`,
    `status       ${describeStatus(session, readAtMs)}`
  ]

  if (hosted === null) {
    lines.push(
      `Claude Code  ${session.version ?? 'version not published'}${
        session.entrypoint === null ? '' : `, entrypoint ${session.entrypoint}`
      }`,
      '',
      'Helm did not start this session, so there is nothing else to know about it: no branch, no profile, no overlays, no process tree and no ports. Everything above comes from the record Claude Code writes for every session on this machine.'
    )
    return lines.join('\n')
  }

  lines.push(
    `Helm tab     ${String(hosted.helmSessionId)}`,
    `branch       ${
      hosted.branch === null
        ? 'none - not a repository, a detached HEAD, or a read that failed'
        : `${hosted.branch} (the branch at spawn, captured and never followed - the tree may have been checked out since)`
    }`,
    `profile      ${hosted.profile ?? 'none - started straight from the project'}`,
    `overlays     ${
      hosted.overlays.length === 0 ? 'none' : hosted.overlays.join(', ')
    }`,
    `started      ${
      hosted.startedAtMs === null ? 'unknown' : `${describeDuration(readAtMs - hosted.startedAtMs)} ago`
    }`,
    '',
    ...describeResources(holding, readAtMs)
  )
  return lines.join('\n')
}

/** The answer for a pid nothing on this machine is running under any more. */
export function describeSessionGone(pid: number): string {
  return (
    `No Claude Code session with pid ${String(pid)} is running on this machine.\n\n` +
    'It may have ended since you listed - a session that exits removes its own record, and Helm drops one whose process it cannot prove is alive. Call sessions_list again for what is running now.'
  )
}
