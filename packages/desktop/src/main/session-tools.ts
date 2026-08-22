import {
  describeSessionDetail,
  describeSessionGone,
  describeSessionListing,
  heldBy,
  type HostedSessionFacts,
  type LiveSession,
  type SessionResources,
  type SessionsOverview
} from '@helm/core'

/**
 * Helm's session-awareness tools: what the other sessions are doing.
 *
 * The second family served by the endpoint in `browser-mcp.ts`, on the same
 * listener, the same port and the same token. Nothing here binds a socket,
 * parses a request or knows what HTTP is - it is a table of tools and a shaping
 * call into `@helm/core`, and everything that makes an inbound listener
 * acceptable lives next door where it always did.
 *
 * ## What this is, and the thing it must never become
 *
 * **Read-only situational awareness, so a session can get out of another's
 * way.** Two agents in one working tree is the failure this exists to prevent,
 * and it is prevented by *looking*, not by talking. Nothing here sends a
 * session anything, waits on one, hands one work, or lets one address another.
 * That is coordination, it is explicitly out of scope, and Claude Code already
 * has its own channel for it - `messagingSocketPath` and
 * `peerFeatures: ["notify_idle"]`, measured on 2.1.238. A tool here that grew
 * into that would be a second, worse copy of something that exists.
 *
 * **No tool returns any part of another session's conversation.** Not its
 * transcript, not its prompts, not its output. The mechanism for that is in
 * `core/registry/describe.ts`, in the shape of what may be handed to it - argv
 * and the conversation id are absent from the input type, and the comment there
 * says why each one is a trap rather than an omission.
 *
 * ## Three decisions, and why they went the way they did
 *
 * **A second named server rather than more tools on `helm-browser`.** Same
 * port, same token, one extra route. The legibility argument is real - a model
 * reading `mcp__helm-browser__sessions_list` would reasonably wonder what the
 * browser had to do with it - but the deciding argument is that the second
 * setting needs somewhere to be off. With two servers, `sessionMcp` off means
 * the route answers 404, the name is absent from the `--mcp-config` document,
 * and the tools are in no list: three independent facts a check can assert.
 * Folded into one server, "nothing in argv" could not be asserted at all,
 * because the browser's `--mcp-config` is in the argv either way. A server also
 * carries its own `instructions` block, which is the one place a model reliably
 * reads, and the sentence that has to be read here is "this is awareness, not
 * coordination".
 *
 * **Its own setting.** See `AppSettings.sessionMcp`.
 *
 * **A session sees the sessions Helm does not host.** The listing is
 * machine-wide, exactly as the sessions pane's is, and the reasoning is in
 * `describeSessionListing`. The short of it: any session with a shell can read
 * `~/.claude/sessions` for itself, so withholding would buy nothing and would
 * leave this answer disagreeing with the pane about what is running.
 *
 * ## Attribution
 *
 * "This session" is **which bearer token arrived**, resolved against the map
 * that owns that token's lifetime (`SessionHost.tokenHolder`). No tool takes a
 * session id of any kind, so there is nothing to spoof: a caller that names
 * another session in an argument this schema does not declare is answered for
 * itself, because the answer never consulted the argument. What a pid *does*
 * select is `session_detail`'s subject, and that is a fact about the machine
 * rather than an identity claim - the detail of a hosted session is the same
 * for whoever asks, which is what makes "have one session report on another"
 * work at all.
 */

/** The name the tools appear under in a session. */
export const SESSION_TOOLS_SERVER_NAME = 'helm-sessions'

/** Its own route on the one listener. Nothing answers here with the tick off. */
export const SESSION_TOOLS_PATH = '/mcp/sessions'

/** What a client is told the moment it connects. */
export const SESSION_TOOLS_INSTRUCTIONS =
  'These tools tell you what other Claude Code sessions are running on this machine, so you can stay out of their way - two agents in one working tree is the thing they exist to prevent. They are read-only and there is no way to send another session anything through them: nothing here starts, stops, waits on, or messages a session, and no tool will ever return any part of another session’s conversation. Check sessions_list before starting long work in a directory.'

/**
 * What a session tool answers with.
 *
 * Text, and only text. Narrower than the browser tools' result on purpose:
 * these tools have no business producing an image, and a type that cannot carry
 * one is a smaller thing to keep true than a rule that says it must not.
 */
export interface SessionToolAnswer {
  text: string
  isError?: boolean
}

export interface SessionTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: false
  }
  run: (
    caller: { token: string },
    args: Record<string, unknown>
  ) => Promise<SessionToolAnswer>
}

/**
 * Everything these tools need from the rest of the app, injected.
 *
 * A function per fact rather than the services themselves, for the reason the
 * browser endpoint takes `settings: () => AppSettings`: this file is
 * constructed before the session host, the activity poller and the resource
 * service exist, and none of them may be captured by value anyway - the answer
 * has to be about the machine now.
 *
 * **There is deliberately no third reader here.** Every one of these is served
 * by something that already existed: the registry pass is the activity
 * poller's, the process pass is the resource service's, and Helm's own facts
 * are the session host's rows. A tool family that read the registry itself
 * would be a second answer to "what is running", free to disagree with the pane.
 */
export interface SessionToolsWorld {
  /** Re-read the registry now. 0.15ms, so a tool call may always afford it. */
  refreshOverview: () => void
  /** The listing that pass produced. */
  overview: () => SessionsOverview
  /**
   * Helm's own facts for one of its sessions - and no argv, ever.
   *
   * See `core/registry/describe.ts`: argv carries a review session's opening
   * prompt and the path to that session's own bearer token.
   */
  factsFor: (helmSessionId: number) => HostedSessionFacts | null
  /**
   * The Helm session a bearer token belongs to, or null.
   *
   * The whole of attribution. Never a parameter, never a claim.
   */
  callerOf: (token: string) => number | null
  /**
   * One process-and-ports pass, taken for this call and no longer.
   *
   * The pass costs 400-480ms of a `powershell.exe` and is therefore gated on
   * somebody looking at it (`main/resources.ts`) - a timer it hung off would
   * keep a child process alive half the time the app is open. **A tool call is
   * somebody looking**, for exactly one pass: this takes a watch, waits for the
   * pass, and drops the watch, which is the reference count doing the job it
   * was built for rather than a way around the budget.
   */
  measure: () => Promise<SessionResources[]>
}

const text = (body: string): SessionToolAnswer => ({ text: body })
const problem = (body: string): SessionToolAnswer => ({ text: body, isError: true })

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * The tools, given a way to reach the app.
 *
 * `world` is a function answering null while the app is still being assembled,
 * which is the same shape `sessions.ts` takes the endpoint itself as. A null
 * answer is a sentence rather than a crash: a tool that threw during startup
 * would be a session told its tools are broken for the rest of its life.
 */
export function createSessionTools(world: () => SessionToolsWorld | null): SessionTool[] {
  const unavailable = problem(
    'Helm cannot answer that right now - it is still starting up. Try again in a moment.'
  )

  return [
    {
      name: 'sessions_list',
      description:
        'Every Claude Code session running on this machine right now - what it is called, which directory it is working in, whether it is busy, idle or waiting on the user, and how long it has been that way. Sessions started outside Helm are listed too, because one of those holds a working tree exactly as hard as a Helm tab does. Read-only: this tells you what is happening and gives you no way to affect it, and it never returns any part of another session’s conversation. Worth calling before you start long work in a directory somebody else may already be in.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async (caller) => {
        const app = world()
        if (app === null) return unavailable
        // Now rather than up to 750ms ago. The registry pass is a `readdir` and
        // a handful of 450-byte reads, so the freshest possible answer costs a
        // fraction of a millisecond and a tool call can always afford it.
        app.refreshOverview()
        const { sessions, readAtMs } = app.overview()
        return Promise.resolve(
          text(
            describeSessionListing({
              sessions,
              readAtMs,
              callerHelmSessionId: app.callerOf(caller.token)
            })
          )
        )
      }
    },

    {
      name: 'session_detail',
      description:
        'What one session is working in and what it is holding: its working directory, the branch it started on, the profile it was launched from, the processes running under it and the ports those are listening on. Pass a pid from sessions_list, or no pid at all for your own session. For a session Helm did not start there is nothing beyond what sessions_list already showed, and it says so. Read-only, and it never returns any part of another session’s conversation - not its transcript, not its prompts, not its output, and not the arguments it was launched with.',
      inputSchema: {
        type: 'object',
        properties: {
          pid: {
            type: 'number',
            description:
              'The pid from sessions_list. Omit it for your own session - which one that is comes from the token this session was given, never from anything you pass.'
          }
        },
        additionalProperties: false
      },
      run: async (caller, args) => {
        const app = world()
        if (app === null) return unavailable

        const me = app.callerOf(caller.token)
        const asked = num(args.pid)
        const find = (): LiveSession | null =>
          asked === null
            ? (app
                .overview()
                .sessions.find((session) => me !== null && session.helmSessionId === me) ?? null)
            : (app.overview().sessions.find((session) => session.pid === asked) ?? null)

        app.refreshOverview()
        let target = find()

        /*
         * The machine is asked only for a session Helm hosts, and the registry
         * is re-read **after** it.
         *
         * Both halves matter. A session Helm did not start has no tree to
         * report, so measuring for one would spend 400ms of a `powershell.exe`
         * to answer a question this tool is not going to answer anyway. And for
         * one Helm does host, the pass takes the best part of half a second -
         * long enough for the session to end inside it - so the listing is read
         * again afterwards and the target found again. That is the whole of "a
         * session that exited between the listing and this call gets an honest
         * answer rather than a stale one": what is slightly old is the *pass*,
         * and `SessionResources` already says so out loud, since `rootSeen:
         * false` is exactly what a session that has just ended looks like.
         */
        let measured: SessionResources[] = []
        if (target !== null && target.helmSessionId !== null) {
          measured = await app.measure()
          app.refreshOverview()
          target = find()
        }

        if (target === null) {
          if (asked === null) {
            return problem(
              'Helm has no live session for this token, which should not happen while your session is running. Call sessions_list to see what it does have.'
            )
          }
          return problem(describeSessionGone(asked))
        }

        const hosted =
          target.helmSessionId === null ? null : app.factsFor(target.helmSessionId)
        // No tree for a session Helm did not spawn, and that is not a refusal:
        // Helm has no pid for it that it did not read out of somebody else's
        // record, and rooting a walk at that would be enumerating a process
        // tree it has no relationship with.
        const snapshot =
          target.helmSessionId === null
            ? null
            : (measured.find((entry) => entry.id === target.helmSessionId) ?? null)
        // `heldBy` is where the command lines are dropped, and it is the only
        // way a pass reaches the shaping - see `HeldProcess` in core for the
        // three reasons a tool may not hand another session's child command
        // lines over, and why the pane may print them.
        const holding = snapshot === null ? null : heldBy(snapshot)

        return text(
          describeSessionDetail({
            session: target,
            hosted,
            holding,
            readAtMs: app.overview().readAtMs,
            isCaller: me !== null && target.helmSessionId === me
          })
        )
      }
    }
  ]
}
