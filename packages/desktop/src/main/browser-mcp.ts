import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  agentReach,
  browserReachAllows,
  cleanStaleMcpConfigs,
  isLoopbackUrl,
  removeSessionMcpConfig,
  resolveBrowserAddress,
  type AppSettings,
  type SessionMcpServer
} from '@helm/core'
import type { BrowserHost, BrowserOpener } from './browser'
import type { PluginToolProvider, ToolServer } from './plugins/tools'
import {
  createSessionTools,
  SESSION_TOOLS_INSTRUCTIONS,
  SESSION_TOOLS_PATH,
  SESSION_TOOLS_SERVER_NAME,
  type SessionToolsWorld
} from './session-tools'
import type { BrowserConsoleEntry } from '../shared/ipc'

/**
 * Helm's tools, served to the sessions it hosts.
 *
 * **This is the first inbound listener in the entire app**, and the rules that
 * make that acceptable are in CLAUDE.md beside the credential rules rather than
 * only here. In one place, so they can be read together:
 *
 * - **Loopback, always.** `listen(0, '127.0.0.1')`. Never `0.0.0.0`, never a
 *   port anybody chose - the port is whatever the kernel hands out, for this
 *   run only, and it is never written anywhere but the per-session config files
 *   below.
 * - **Token, always.** Every request carries `Authorization: Bearer <token>` or
 *   it is 401 before anything is parsed. A token is 32 random bytes, it is
 *   minted per *session*, and it dies with the session. There is no
 *   unauthenticated path, not even a health endpoint - a route that answered
 *   without a token would be a route that told a local process what port to
 *   start guessing at.
 * - **The token is the identity.** Attribution is not a claim the caller makes;
 *   it is which token arrived. That is what makes "only a tab this session
 *   opened" a comparison rather than an honour system, and it is why the tools
 *   need no session id parameter for anything.
 * - **Off is off.** With every tool setting unticked, nothing here binds, no
 *   token exists, and no `--mcp-config` reaches any argv. The app is then
 *   exactly what it was before any of this: a process with no listener.
 * - **Origin is checked**, because a page in a browser on this machine can
 *   reach a loopback port. Anything that arrives carrying a non-loopback
 *   `Origin` is refused - the token already stops it, and this stops it a step
 *   earlier and without a timing side channel.
 *
 * **Named servers, one listener.** The browser tools are one family, the
 * session-awareness tools (`session-tools.ts`) another, and each plugin that
 * declares tools (`plugins/tools.ts`) one more: one route each, one name each,
 * one `instructions` block each - and one port, one token, one process. A
 * switch per family decides whether its route exists at all - a setting for
 * Helm's own two, the plugin being on and its tools not turned off in Settings
 * for a plugin's - which is what makes each family's "off" three separate facts
 * rather than a promise: the route answers 404, the name is absent from the
 * `--mcp-config` document, and the tools are in no list. Folding them into one
 * server would have made a family's off unassertable in the argv, because the
 * others' `--mcp-config` is there either way.
 *
 * A plugin's route only carries the call: Helm checks the token, then hands
 * the plugin the call and who made it - an id minted for the session, its name
 * and its working directory, never the token - and passes back whatever the
 * plugin's background page answers.
 *
 * Nothing about the six rules moves. Another route is not another listener,
 * it is not unauthenticated - the token gate is in front of every route and the
 * route table is consulted first only so that a switched-off family is a 404
 * rather than a 401 - and both families are identified by the same token.
 *
 * **Why an HTTP listener and not a named pipe.** A stdio MCP shim over a
 * Windows named pipe would avoid the listener entirely, which sounds strictly
 * better for an app this careful. It is not: a named pipe's default ACL admits
 * any process running as the same user, which is precisely the reach a loopback
 * port plus a token file already has - and it costs a shim process per session.
 * The isolation is illusory and the price is real. Recorded so it is not
 * re-derived.
 *
 * **Why `--mcp-config` and not `claude mcp add-json`.** See
 * `core/launch/mcp.ts`: the alternative writes into the user's `~/.claude.json`
 * on every launch and leaves the entry behind.
 *
 * **What this is not.** It is not a client. Nothing here reads a session's
 * output, renders a message, or answers a prompt - a session calls a tool
 * exactly the way it calls any other MCP tool, and the whole of Helm's part is
 * to be at the other end of it. See "Helm renders nothing for a live session"
 * in CLAUDE.md: this is Helm exposing what it already owns, on request, to a
 * client that is still entirely Claude Code's.
 */

// ---------------------------------------------------------------------------
// The protocol, minimally and completely
// ---------------------------------------------------------------------------

/**
 * The MCP revision this endpoint speaks.
 *
 * Written out rather than echoed blindly: the negotiated version is the
 * client's if this server knows it and this constant otherwise, which is what
 * the specification asks for and what stops a future client being told its own
 * unknown version is supported.
 */
const PROTOCOL_VERSION = '2025-06-18'
const KNOWN_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])

/** The name the browser tools appear under in a session. One server, one name. */
export const MCP_SERVER_NAME = 'helm-browser'

/** Its route. One per family, and nothing answers on any other. */
const MCP_PATH = '/mcp'

/** Past this a request body is refused unread. A tool call is a few hundred bytes. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** How many nodes a snapshot may carry before it says it was cut short. */
const SNAPSHOT_MAX_NODES = 600
/** What `browser_text` answers with at most, unless asked for more. */
const TEXT_MAX_CHARS = 20_000
/** `browser_wait_for`: how long by default, the longest it will, and how often it looks. */
const WAIT_DEFAULT_S = 10
const WAIT_MAX_S = 60
const WAIT_POLL_MS = 150

interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

interface ToolContent {
  type: 'text' | 'image'
  text?: string
  data?: string
  mimeType?: string
}

interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

/** One live session's identity and the tab it is working in. */
interface AgentSession {
  opener: BrowserOpener
  /**
   * What a plugin knows the session by (`McpSessionIdentity.id`). Nothing like
   * the token: the token is a credential for this endpoint, and a plugin is
   * handed only what it needs to tell one session from another.
   */
  id: string
  /** Where the session runs, for a plugin's tools. */
  cwd: string
  /** The last tab this session opened or acted on. What `tab` defaults to. */
  lastTab: number | null
  /** The ephemeral config file, so `stop()` can take it away. */
  file: string | null
  /** Requests being answered, by JSON-RPC id, so `notifications/cancelled` can abort the one it names. */
  inFlight: Map<string, AbortController>
}

/** The session a registration is for. */
export interface McpSessionIdentity {
  /**
   * What a plugin knows the session by, in a tool call and in its session
   * list. Minted by the session host at launch, and nothing like the token.
   */
  id: string
  /** What the tab strip shows against every tab the session opens, and what a plugin is told. */
  name: string
  /** Its working directory, for a plugin's tools. */
  cwd: string
}

export interface BrowserMcpRegistration {
  /**
   * Exactly what `prepareLaunch` wants for its `mcp` field.
   *
   * One entry per family that is switched on. A registration is never made at
   * all when none of them is, so this list is never empty.
   */
  launch: { dir: string; servers: SessionMcpServer[] }
  /** The bearer token, which is also this session's identity in both families. */
  token: string
}

export interface BrowserMcpHost {
  /** Binds, if any tool family is on. Idempotent; answers what happened. */
  start(): Promise<{ started: boolean; problem: string | null }>
  /**
   * Binds when any family is on and lets go when none is, after whatever
   * `sync` was already doing. What a switch calls: a setting, or a plugin's
   * tools coming or going.
   */
  sync(): Promise<void>
  /** Revokes every token, removes every ephemeral file, closes the listener. */
  stop(): Promise<void>
  running(): boolean
  /**
   * What Node says the socket is bound to, unedited.
   *
   * The check asserts the **address**, not the intent: "we call listen with
   * 127.0.0.1" is a statement about this file, and `server.address()` is a
   * statement about the socket.
   */
  address(): { address: string; port: number; family: string } | null
  /**
   * A registration for one session, or null when the endpoint is off.
   *
   * `name` is the session's own name, and it is what the tab strip will show
   * against every tab this session opens.
   */
  register(session: McpSessionIdentity): BrowserMcpRegistration | null
  /**
   * The families a session would be given right now, by name.
   *
   * For a check, and for the launch disclosure: "which tools does this session
   * have" is otherwise only answerable by reading the ephemeral config file
   * back, which is the file that carries the token.
   */
  servedNames(): string[]
  /**
   * Tell the endpoint which file `prepareLaunch` wrote for a token.
   *
   * Two calls rather than one because the file's *name* is core's to choose -
   * it carries the pid the sweep reasons about - and core is handed the
   * registration rather than the other way round. This is what lets `stop()`
   * take away a file whose session never got as far as exiting.
   */
  attach(token: string, file: string | null): void
  /** Forget a session: revoke the token, drop the file. Safe to call twice. */
  release(token: string | null): void
}

export interface BrowserMcpOptions {
  browsers: BrowserHost
  /** Read through a function: both reach settings can change while a tab is open. */
  settings: () => AppSettings
  /** Where the ephemeral per-session config files live. Under the data dir. */
  dir: string
  /**
   * What the session-awareness tools read, or absent for an endpoint without
   * them.
   *
   * A function answering null because this endpoint is constructed before the
   * session host, the activity poller and the resource service exist - see
   * `session-tools.ts`. Absent entirely is how a check builds an endpoint that
   * is only ever the browser's.
   */
  sessions?: (() => SessionToolsWorld | null) | undefined
  /** The plugins offering tools, and a way to call one; absent for an endpoint without them. */
  plugins?: PluginToolProvider | undefined
}

/** A plugin's route: `/mcp/plugin/<id>`. An id is lower-case letters, digits and dashes, so it needs no escaping. */
const PLUGIN_PATH_PREFIX = '/mcp/plugin/'

/** What a session is told about a plugin's tools before the plugin's own words. */
function pluginInstructions(server: ToolServer): string {
  const provenance = `These tools come from "${server.name}", a plugin the user added to Helm, the app hosting this session. The plugin answers every call; Helm passes it on.`
  return server.instructions === null ? provenance : `${provenance}\n\n${server.instructions}`
}

// ---------------------------------------------------------------------------

export function createBrowserMcp(options: BrowserMcpOptions): BrowserMcpHost {
  const sessions = new Map<string, AgentSession>()
  let server: Server | null = null

  const { browsers } = options

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  /**
   * The tab a call is about, or the sentence saying why there is not one.
   *
   * **Every tool that acts on a tab goes through this**, and the rule it
   * enforces is explicit sharing: a session drives the tabs it opened, and a
   * tab of the user's only once the user has shared it with that session. A
   * tab the user opened is a page they chose to be on, in a partition that
   * holds their cookies and their logins, and a tool that could screenshot or
   * script it unasked would be the feature CLAUDE.md's credential rule exists
   * to prevent - reached sideways, through a picture instead of a cookie jar.
   * The Share button is the asking, one page and one session at a time.
   *
   * **And only while the page is somewhere the tools may reach.** An agent's
   * own tab is held to `agentReach` by `will-navigate`, but a shared tab
   * navigates as the user's, and going back through history is not a
   * navigation `will-navigate` sees at all. So the page's address is put
   * through the same rule here, on every call, and "Only this machine" for
   * the tools stays true of whatever page a tool is pointed at.
   *
   * `browser_tabs` is the one exception and it is not a hole: listing is not
   * driving, and a session that cannot see the cap being reached cannot explain
   * why its next `browser_open` failed.
   */
  const drivenTab = (session: AgentSession, args: Args): { id: number } | { problem: string } => {
    const id = num(args.tab) ?? session.lastTab ?? newestShared(session)
    if (id === null) {
      return {
        problem:
          'This session has no browser tab yet. Call browser_open with a URL, then pass the id it gives you. A tab the user shares with you is listed by browser_tabs.'
      }
    }
    const current = browsers.states(id)[0]
    if (current === undefined) {
      return {
        problem: `There is no browser tab ${String(
          id
        )} in Helm - it may have been closed. Call browser_tabs to see what is open.`
      }
    }
    const opener = browsers.openerOf(id)
    const shared = browsers.sharedWith(id)
    const mine = opener?.key === session.opener.key
    const sharedWithMe = opener === null && shared?.key === session.opener.key
    if (!mine && !sharedWithMe) {
      return {
        problem:
          opener !== null
            ? `Browser tab ${String(id)} belongs to the session "${
                opener.name
              }". A session may only drive the tabs it opened itself and the ones the user shares with it.`
            : shared !== null
              ? `Browser tab ${String(id)} was opened by the user and is shared with the session "${
                  shared.name
                }", not this one.`
              : `Browser tab ${String(
                  id
                )} was opened by the user and is not shared with this session. Open your own with browser_open, or ask the user to share this one from the Share button in Helm's browser bar.`
      }
    }
    const reach = toolsReach(current.url)
    if (reach !== null) return { problem: `Browser tab ${String(id)} is at ${current.url}. ${reach}` }
    session.lastTab = id
    return { id }
  }

  /** The tab the user shared with this session most recently opened, or null. */
  const newestShared = (session: AgentSession): number | null =>
    browsers
      .states()
      .filter((state) => browsers.sharedWith(state.id)?.key === session.opener.key)
      .at(-1)?.id ?? null

  /**
   * Why the tools may not act on a page at this address, or null when they may.
   *
   * The one rule, `browserReachAllows` composed by `agentReach`, for a page
   * that is already somewhere. Only a web address is put to it: an empty tab,
   * `about:blank` and an error page are nowhere a request goes.
   */
  const toolsReach = (url: string): string | null => {
    if (!/^(https?|wss?):/i.test(url)) return null
    const settings = options.settings()
    const decision = browserReachAllows(url, ...agentReach(settings.browserReach, settings.browserMcpLocalOnly))
    if (decision.allowed) return null
    // The rule's own sentence is about the pane and a fetch. When the pane may
    // be there and only the tools may not, the setting to name is the tools'.
    return settings.browserMcpLocalOnly && browserReachAllows(url, settings.browserReach).allowed
      ? "Helm's browser tools are held to this machine in Settings > Browser, so this session may not read or drive a page anywhere else."
      : (decision.problem ?? "That is outside what Helm's browser tools may reach.")
  }

  /**
   * A URL a tool asked for, resolved and put through the reach rule.
   *
   * **The intersection, at the tool entry point**, and it is the same
   * `browserReachAllows` the pane's `will-navigate` calls with the same
   * restrictions composed by the same `agentReach`. There is deliberately no
   * second copy of a URL rule here: two copies is how the pane and the tools
   * would drift, and the drift would be silent because both would go on saying
   * yes to every URL anybody tested with.
   */
  const allowedUrl = (input: unknown, tool: string): { url: string } | { problem: string } => {
    if (typeof input !== 'string' || input.trim() === '') {
      return { problem: `${tool} needs a url, for example "http://localhost:3000/".` }
    }
    // The same resolver the address bar uses, so `3000` means the same thing to
    // an agent as it does to a person typing into the pane.
    const resolved = resolveBrowserAddress(input)
    if (resolved.url === null) {
      return { problem: resolved.problem ?? `${input} is not an address Helm can open.` }
    }
    const settings = options.settings()
    const decision = browserReachAllows(
      resolved.url,
      ...agentReach(settings.browserReach, settings.browserMcpLocalOnly)
    )
    if (!decision.allowed) {
      return {
        problem:
          decision.problem ??
          `${resolved.url} is outside what Helm's browser is allowed to reach right now.`
      }
    }
    return { url: resolved.url }
  }

  // -------------------------------------------------------------------------
  // The tools
  // -------------------------------------------------------------------------

  interface Tool {
    name: string
    description: string
    inputSchema: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
      additionalProperties: false
    }
    run: (session: AgentSession, args: Args) => Promise<ToolResult>
  }

  const TAB_ARG = {
    tab: {
      type: 'number',
      description:
        'The tab id from browser_open or browser_tabs. Defaults to the last tab this session used.'
    }
  }

  const TOOLS: Tool[] = [
    {
      name: 'browser_open',
      description:
        "Open a URL in a new tab of Helm's browser. Returns the tab id, the URL it landed on and the page title. A bare port number means a dev server on this machine. To move a tab you already have, use browser_navigate.",
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'An http or https URL, or a bare port number.' },
          tab: {
            type: 'number',
            description: 'Navigate this tab instead of opening a new one. The same as browser_navigate.'
          }
        },
        required: ['url'],
        additionalProperties: false
      },
      async run(session, args) {
        const wanted = allowedUrl(args.url, 'browser_open')
        if ('problem' in wanted) return fail(wanted.problem)

        if (num(args.tab) !== null) {
          const tab = drivenTab(session, args)
          if ('problem' in tab) return fail(tab.problem)
          const answer = browsers.navigateFor(session.opener, tab.id, wanted.url)
          if (answer.state === null) return fail(answer.problem ?? 'That tab is gone.')
          const settled = await settleTab(tab.id)
          return ok(describeTab(settled ?? answer.state))
        }

        const answer = await browsers.openFor(session.opener, wanted.url)
        if (answer.state === null) return fail(answer.problem ?? 'Helm could not open that tab.')
        session.lastTab = answer.state.id
        const settled = await settleTab(answer.state.id)
        return ok(describeTab(settled ?? answer.state))
      }
    },

    {
      name: 'browser_navigate',
      description:
        'Send a tab you may drive to a URL, or go back, forward or reload it. Answers with where it landed and the page title. A new tab is browser_open.',
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          url: { type: 'string', description: 'An http or https URL, or a bare port number.' },
          go: { type: 'string', enum: ['back', 'forward', 'reload'], description: 'Instead of a url.' }
        },
        additionalProperties: false
      },
      async run(session, args) {
        const go = str(args.go)
        if ((args.url === undefined) === (go === null)) {
          return fail('browser_navigate needs a url, or go: "back", "forward" or "reload" - one of the two.')
        }
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)

        if (go === null) {
          const wanted = allowedUrl(args.url, 'browser_navigate')
          if ('problem' in wanted) return fail(wanted.problem)
          const answer = browsers.navigateFor(session.opener, tab.id, wanted.url)
          if (answer.state === null) return fail(answer.problem ?? 'That tab is gone.')
          return ok(describeTab((await settleTab(tab.id)) ?? answer.state))
        }

        const before = browsers.states(tab.id)[0]
        if (before === undefined) return fail('That tab is gone.')
        if (go === 'back' && !before.canGoBack) return fail(`Tab #${String(tab.id)} has nothing to go back to.`)
        if (go === 'forward' && !before.canGoForward) {
          return fail(`Tab #${String(tab.id)} has nothing to go forward to.`)
        }
        if (go === 'back') browsers.back(tab.id)
        else if (go === 'forward') browsers.forward(tab.id)
        else if (go === 'reload') browsers.reload(tab.id, false)
        else return fail(`browser_navigate cannot go "${go}". It goes "back", "forward" or "reload".`)
        return ok(describeTab((await settleMove(tab.id, before.url)) ?? before))
      }
    },

    {
      name: 'browser_tabs',
      description:
        "Every tab open in Helm's browser: id, URL, title, whether it is loading, and whose it is. You may drive your own tabs and the ones the user shares with you; the rest are listed so you can see them, not drive them.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(session) {
        const states = browsers.states()
        if (states.length === 0) {
          return ok('No browser tabs are open. browser_open makes one.')
        }
        const lines = states.map((state) => {
          const opener = browsers.openerOf(state.id)
          const shared = browsers.sharedWith(state.id)
          const whose =
            opener !== null
              ? opener.key === session.opener.key
                ? 'yours'
                : `opened by the session "${opener.name}"`
              : shared === null
                ? 'opened by the user'
                : shared.key === session.opener.key
                  ? 'opened by the user, shared with you: read and drive it, but it is theirs to close'
                  : `opened by the user, shared with the session "${shared.name}"`
          return `#${String(state.id)}  ${state.url === '' ? '(blank)' : state.url}\n    title: ${
            state.title === '' ? '(none)' : state.title
          }\n    loading: ${String(state.loading)}   ${whose}${
            state.problem === null ? '' : `\n    problem: ${state.problem}`
          }`
        })
        return ok(lines.join('\n'))
      }
    },

    {
      name: 'browser_snapshot',
      description:
        'A trimmed structural view of the page: its landmarks, headings, links, controls and text, each with a [ref=...] you can pass to browser_click or browser_type. Read this rather than taking a screenshot - it is cheaper and far more reliable for finding an element.',
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          maxNodes: {
            type: 'number',
            description: `How many nodes at most. Default ${String(SNAPSHOT_MAX_NODES)}.`
          }
        },
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        const max = Math.max(20, Math.min(4000, num(args.maxNodes) ?? SNAPSHOT_MAX_NODES))
        const answer = await browsers.evaluate(tab.id, snapshotScript(max))
        if (!answer.ok) return fail(`Helm could not read that page: ${answer.error ?? 'unknown'}`)
        let parsed: SnapshotResult
        try {
          parsed = JSON.parse(answer.value) as SnapshotResult
        } catch {
          return fail(`Helm could not read that page; it answered: ${answer.value.slice(0, 200)}`)
        }
        return ok(renderSnapshot(tab.id, parsed))
      }
    },

    {
      name: 'browser_text',
      description:
        "The page's text as a person reads it - what is rendered, without the markup - or one element's, named by ref or selector. Long text comes in pieces, and the answer says where the next one starts.",
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          ref: { type: 'string', description: 'A [ref=...] from browser_snapshot.' },
          selector: { type: 'string', description: 'A CSS selector, if you have no ref.' },
          offset: { type: 'number', description: 'Where to start, from the previous answer. Default 0.' },
          maxChars: { type: 'number', description: `How much at most. Default ${String(TEXT_MAX_CHARS)}.` }
        },
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        const answer = await browsers.evaluate(
          tab.id,
          onTarget(
            args,
            `const el = __helmTarget(); if (!el) return JSON.stringify({ missing: true });
             return JSON.stringify({ text: el.innerText ?? el.textContent ?? '', url: location.href })`
          )
        )
        if (!answer.ok) return fail(`Helm could not read that page: ${answer.error ?? 'unknown'}`)
        let read: { missing?: boolean; text?: string; url?: string }
        try {
          read = JSON.parse(answer.value) as typeof read
        } catch {
          return fail(`Helm could not read that page; it answered: ${answer.value.slice(0, 200)}`)
        }
        if (read.missing === true) return fail(missingElement(args))
        const text = tidyText(read.text ?? '')
        const max = Math.max(200, Math.min(100_000, num(args.maxChars) ?? TEXT_MAX_CHARS))
        const from = Math.max(0, Math.min(text.length, num(args.offset) ?? 0))
        const to = Math.min(text.length, from + max)
        return ok(
          [
            `tab: ${String(tab.id)}`,
            `url: ${read.url ?? ''}`,
            text.length === 0
              ? 'characters: none'
              : `characters: ${String(from)}-${String(to)} of ${String(text.length)}`,
            '',
            text.length === 0 ? '(no text is rendered there)' : text.slice(from, to),
            ...(to < text.length ? ['', `(more: pass offset ${String(to)})`] : [])
          ].join('\n')
        )
      }
    },

    {
      name: 'browser_screenshot',
      description:
        'A PNG of the page as it is rendered right now. Prefer browser_snapshot for finding elements; use this when the question is about what something looks like.',
      inputSchema: { type: 'object', properties: { ...TAB_ARG }, additionalProperties: false },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        const shot = await browsers.capturePng(tab.id)
        if (shot === null) return fail('That browser tab is gone.')
        if (shot.width < 2 || shot.height < 2) {
          return fail(
            `Helm captured a ${String(shot.width)}x${String(
              shot.height
            )} image, which means that tab has no rectangle to paint into. This is a bug in Helm rather than something to work around.`
          )
        }
        return {
          content: [
            {
              type: 'text',
              text: `Tab #${String(tab.id)}, ${String(shot.width)}x${String(shot.height)}.`
            },
            { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' }
          ]
        }
      }
    },

    {
      name: 'browser_console',
      description:
        "What the page has written to its console, and any load errors, since the cursor you pass. Answers with a new cursor - pass it back to see only what is new.",
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          cursor: {
            type: 'number',
            description: 'The cursor from a previous call. Omit for everything Helm still holds.'
          }
        },
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        const entries = browsers.entries(tab.id)
        const from = Math.max(0, Math.min(entries.length, num(args.cursor) ?? 0))
        const slice = entries.slice(from)
        const head = `cursor: ${String(entries.length)}${
          slice.length === 0 ? '\n(nothing new)' : ''
        }`
        return ok([head, ...slice.map(consoleLine)].join('\n'))
      }
    },

    {
      name: 'browser_click',
      description:
        'Click an element with a real mouse event - the same sequence a person produces, which pages sometimes react to when a scripted click does nothing. Name the element with ref (from browser_snapshot) or a CSS selector, or give x and y in the page.',
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          ref: { type: 'string', description: 'A [ref=...] from browser_snapshot.' },
          selector: { type: 'string', description: 'A CSS selector, if you have no ref.' },
          x: { type: 'number', description: 'Page x, when there is no element to name.' },
          y: { type: 'number', description: 'Page y.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          clickCount: { type: 'number', description: '2 for a double click.' }
        },
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        const at = await pointFor(tab.id, args, 'browser_click', 'click')
        if ('problem' in at) return fail(at.problem)
        const button = str(args.button)
        const clickCount = num(args.clickCount)
        await browsers.pointer(tab.id, at.x, at.y, {
          ...(button === 'right' || button === 'middle' ? { button } : {}),
          ...(clickCount === null ? {} : { clickCount })
        })
        return ok(`Clicked ${at.what} at (${String(Math.round(at.x))}, ${String(Math.round(at.y))}).`)
      }
    },

    {
      name: 'browser_hover',
      description:
        'Move a real mouse pointer over an element and leave it there, pressing nothing - for menus, tooltips and anything else that opens on hover. Name the element with ref or selector, or give x and y in the page.',
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          ref: { type: 'string', description: 'A [ref=...] from browser_snapshot.' },
          selector: { type: 'string', description: 'A CSS selector, if you have no ref.' },
          x: { type: 'number', description: 'Page x, when there is no element to name.' },
          y: { type: 'number', description: 'Page y.' }
        },
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        const at = await pointFor(tab.id, args, 'browser_hover', 'point at')
        if ('problem' in at) return fail(at.problem)
        await browsers.hover(tab.id, at.x, at.y)
        return ok(
          `The pointer is over ${at.what} at (${String(Math.round(at.x))}, ${String(Math.round(at.y))}).`
        )
      }
    },

    {
      name: 'browser_type',
      description:
        'Type text with real key events. Name an element with ref or selector to put the caret in it first, or omit both to type into whatever the page has focused.',
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          text: { type: 'string' },
          ref: { type: 'string', description: 'A [ref=...] from browser_snapshot.' },
          selector: { type: 'string' },
          clear: { type: 'boolean', description: 'Select what is there first, so typing replaces it.' },
          submit: { type: 'boolean', description: 'Press Enter afterwards.' }
        },
        required: ['text'],
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        const text = str(args.text)
        if (text === null) return fail('browser_type needs text.')

        let into = 'the focused element'
        if (str(args.ref) !== null || str(args.selector) !== null) {
          const focused = await browsers.evaluate(
            tab.id,
            inPage(
              args,
              `const el = __helmTarget(); if (!el) return 'missing';
               el.scrollIntoView({ block: 'center', inline: 'center' });
               el.focus();
               ${args.clear === true ? 'if (typeof el.select === "function") el.select();' : ''}
               return document.activeElement === el ? 'focused' : 'not-focusable'`
            )
          )
          if (!focused.ok) return fail(`Helm could not reach that element: ${focused.error ?? ''}`)
          if (focused.value === 'missing') return fail(missingElement(args))
          if (focused.value === 'not-focusable') {
            return fail(
              'That element cannot take the caret, so there is nothing to type into. Click it first, or name the field itself.'
            )
          }
          into = describeTarget(args)
        } else if (args.clear === true) {
          await browsers.evaluate(
            tab.id,
            `(() => { const el = document.activeElement;
               if (el && typeof el.select === 'function') el.select(); return true })()`
          )
        }

        await browsers.typeInto(tab.id, text)
        if (args.submit === true) await browsers.press(tab.id, 'Enter')
        return ok(
          `Typed ${JSON.stringify(text)} into ${into}${args.submit === true ? ' and pressed Enter' : ''}.`
        )
      }
    },

    {
      name: 'browser_press',
      description:
        'Press one key, with modifiers. Key names are Chromium\'s: "Enter", "Tab", "Escape", "ArrowDown", "a". Modifiers are "shift", "control", "alt", "meta".',
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          key: { type: 'string' },
          modifiers: { type: 'array', items: { type: 'string' } }
        },
        required: ['key'],
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        const key = str(args.key)
        if (key === null) return fail('browser_press needs a key.')
        const modifiers = Array.isArray(args.modifiers)
          ? args.modifiers.filter(
              (m): m is 'shift' | 'control' | 'alt' | 'meta' =>
                m === 'shift' || m === 'control' || m === 'alt' || m === 'meta'
            )
          : []
        await browsers.press(tab.id, key, modifiers)
        return ok(
          `Pressed ${modifiers.length === 0 ? key : `${modifiers.join('+')}+${key}`} in tab #${String(
            tab.id
          )}.`
        )
      }
    },

    {
      name: 'browser_select',
      description:
        'Choose options in a <select>, by value or by the text shown, and fire the input and change events a person choosing them fires. Name the select with ref or selector. More than one value only for a select that takes several.',
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          ref: { type: 'string', description: 'A [ref=...] from browser_snapshot.' },
          selector: { type: 'string', description: 'A CSS selector, if you have no ref.' },
          values: { type: 'array', items: { type: 'string' }, description: 'Option values or the text they show.' }
        },
        required: ['values'],
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        if (str(args.ref) === null && str(args.selector) === null) {
          return fail('browser_select needs the select: a ref from browser_snapshot, or a CSS selector.')
        }
        const values = Array.isArray(args.values)
          ? args.values.filter((value): value is string => typeof value === 'string')
          : []
        if (values.length === 0) return fail('browser_select needs at least one value.')
        const answer = await browsers.evaluate(tab.id, inPage(args, selectBody(values)))
        if (!answer.ok) return fail(`Helm could not reach that element: ${answer.error ?? ''}`)
        let picked: SelectResult
        try {
          picked = JSON.parse(answer.value) as SelectResult
        } catch {
          return fail(`Helm could not read that select; the page answered: ${answer.value.slice(0, 200)}`)
        }
        return picked.chosen === undefined ? fail(selectRefusal(args, picked)) : ok(
          `Chose ${picked.chosen.map((label) => JSON.stringify(label)).join(', ')} in ${describeTarget(args)}.`
        )
      }
    },

    {
      name: 'browser_scroll',
      description:
        "Scroll with a real mouse wheel: dy pixels down and dx right (negative for up and left), at x and y in the page or its middle by default - whatever is under that point scrolls, as under a person's wheel. Or name an element with ref or selector to bring it into view.",
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          dy: { type: 'number', description: 'Pixels down; negative is up.' },
          dx: { type: 'number', description: 'Pixels right; negative is left.' },
          x: { type: 'number', description: 'Where the wheel turns, in the page. Default the middle.' },
          y: { type: 'number' },
          ref: { type: 'string', description: 'Bring this [ref=...] into view instead.' },
          selector: { type: 'string', description: 'Or this CSS selector.' }
        },
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)

        if (str(args.ref) !== null || str(args.selector) !== null) {
          const answer = await browsers.evaluate(
            tab.id,
            inPage(
              args,
              `const el = __helmTarget(); if (!el) return 'missing';
               el.scrollIntoView({ block: 'center', inline: 'nearest' });
               return JSON.stringify([Math.round(window.scrollX), Math.round(window.scrollY)])`
            )
          )
          if (!answer.ok) return fail(`Helm could not reach that element: ${answer.error ?? ''}`)
          if (answer.value === 'missing') return fail(missingElement(args))
          return ok(`Brought ${describeTarget(args)} into view; the page is scrolled to (${answer.value.slice(1, -1).replace(',', ', ')}).`)
        }

        const dy = num(args.dy) ?? 0
        const dx = num(args.dx) ?? 0
        if (dy === 0 && dx === 0) {
          return fail('browser_scroll needs dy or dx in pixels, or an element to bring into view.')
        }
        const view = browsers.viewport(tab.id)
        if (view === null) return fail('That tab is gone.')
        // The point in the page's pixels, for the page; in the view's for the
        // wheel. The same conversion `pointFor` makes.
        const page = {
          x: num(args.x) ?? view.width / view.zoom / 2,
          y: num(args.y) ?? view.height / view.zoom / 2
        }
        const before = await scrolled(tab.id, page)
        await browsers.scroll(tab.id, page.x * view.zoom, page.y * view.zoom, dx * view.zoom, dy * view.zoom)
        const after = await scrolled(tab.id, page)
        if (before === null || after === null) return fail('Helm could not read where that page is scrolled to.')
        return ok(describeScroll(before, after, dx, dy, page))
      }
    },

    {
      name: 'browser_wait_for',
      description:
        'Wait until text appears in the page, text goes away, or a CSS selector matches something visible - or, given none of those, until the page has finished loading. Or just wait some seconds. Answers when it happens, or says that it never did.',
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          text: { type: 'string', description: 'Wait for this text to appear.' },
          textGone: { type: 'string', description: 'Wait for this text to go away.' },
          selector: { type: 'string', description: 'Wait for something visible to match this.' },
          seconds: { type: 'number', description: `Just wait this long, up to ${String(WAIT_MAX_S)}.` },
          timeout: {
            type: 'number',
            description: `Give up after this many seconds. Default ${String(WAIT_DEFAULT_S)}, at most ${String(WAIT_MAX_S)}.`
          }
        },
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        const asked = (['text', 'textGone', 'selector'] as const).filter((key) => str(args[key]) !== null)
        const seconds = num(args.seconds)
        if (asked.length > 1 || (asked.length === 1 && seconds !== null)) {
          return fail(
            'browser_wait_for waits for one thing: text, textGone or selector - or seconds on its own. To wait at most so long for something, pass timeout.'
          )
        }
        if (seconds !== null) {
          const ms = Math.max(0, Math.min(WAIT_MAX_S, seconds)) * 1000
          await pause(ms)
          return ok(`Waited ${String(ms / 1000)}s.`)
        }

        const limit = Math.max(0.1, Math.min(WAIT_MAX_S, num(args.timeout) ?? WAIT_DEFAULT_S))
        const started = Date.now()
        const condition = asked[0]
        const target = condition === undefined ? '' : String(args[condition])
        const looking = condition === undefined ? null : { condition, script: waitScript(condition, target) }
        const took = (): string => `${(Math.round((Date.now() - started) / 100) / 10).toFixed(1)}s`
        for (;;) {
          const state = browsers.states(tab.id)[0]
          if (state === undefined) return fail(`Tab #${String(tab.id)} closed while this was waiting.`)
          if (looking === null) {
            if (!state.loading) return ok(`Loaded after ${took()}.\n${describeTab(state)}`)
          } else {
            const answer = await browsers.evaluate(tab.id, looking.script)
            // A page between documents cannot be asked anything; that is "not
            // yet", and the next look is in a moment.
            if (answer.ok && answer.value.startsWith('bad:')) {
              return fail(`${JSON.stringify(target)} is not a selector the page accepts: ${answer.value.slice(4)}`)
            }
            if (answer.ok && answer.value === 'yes') return ok(`${waited(looking.condition, target)} after ${took()}.`)
          }
          if (Date.now() - started >= limit * 1000) {
            return fail(
              `Waited ${String(limit)}s, and ${
                looking === null ? 'the page was still loading' : notYet(looking.condition, target)
              } in tab #${String(tab.id)}.`
            )
          }
          await pause(WAIT_POLL_MS)
        }
      }
    },

    {
      name: 'browser_evaluate',
      description:
        'Run JavaScript in the page and answer with what it evaluated to. The escape hatch: prefer browser_snapshot, browser_click and browser_type, which are more legible in a transcript and do not depend on the page internals staying put.',
      inputSchema: {
        type: 'object',
        properties: {
          ...TAB_ARG,
          expression: { type: 'string', description: 'A JavaScript expression.' }
        },
        required: ['expression'],
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        const source = str(args.expression)
        if (source === null) return fail('browser_evaluate needs an expression.')
        const answer = await browsers.evaluate(tab.id, source)
        if (!answer.ok) return fail(`The page raised: ${answer.error ?? 'an error with no message'}`)
        return ok(answer.value === '' ? '(empty string)' : answer.value)
      }
    },

    {
      name: 'browser_close',
      description:
        "Close a tab this session opened. Tabs the user opened are theirs to close, shared with you or not. Your own tabs also stay when this session ends - the page is the user's then.",
      inputSchema: {
        type: 'object',
        properties: { tab: { type: 'number' } },
        required: ['tab'],
        additionalProperties: false
      },
      async run(session, args) {
        const tab = drivenTab(session, args)
        if ('problem' in tab) return fail(tab.problem)
        const answer = browsers.closeFor(session.opener, tab.id)
        if (!answer.closed) return fail(answer.problem ?? 'That tab could not be closed.')
        if (session.lastTab === tab.id) session.lastTab = null
        return ok(`Closed tab #${String(tab.id)}.`)
      }
    }
  ]

  // -------------------------------------------------------------------------
  // The route table: one entry per family of tools
  // -------------------------------------------------------------------------

  /**
   * A named MCP server on this one listener.
   *
   * `enabled` is read **per request** rather than captured, so unticking a
   * setting takes a family away from a session that is already running: the
   * route stops existing and its client sees a server that has gone. That is
   * the same posture `browserMcp` already had through `stop()`, one family at a
   * time.
   */
  interface Route {
    name: string
    path: string
    instructions: string
    enabled: () => boolean
    listed: () => Array<{ name: string; description: string; inputSchema: unknown }>
    /** `signal` is aborted when nobody is waiting for the answer any more. */
    call: (session: AgentSession, name: string, args: Args, signal: AbortSignal) => Promise<ToolResult>
  }

  const sessionTools = createSessionTools(() => options.sessions?.() ?? null)

  const ROUTES: Route[] = [
    {
      name: MCP_SERVER_NAME,
      path: MCP_PATH,
      instructions:
        "These tools drive the browser pane inside Helm, the app hosting this session. Tabs you open appear in the user's Browser tab, behind the page they are looking at, labelled with this session's name, and stay there when the session ends. The user can also share one of their own tabs with this session: browser_tabs lists it as shared with you, and you may read and drive it but not close it. Read a page with browser_snapshot or browser_text before clicking anything.",
      enabled: () => options.settings().browserMcp,
      listed: () =>
        TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        })),
      async call(session, name, args) {
        const tool = TOOLS.find((entry) => entry.name === name)
        if (tool === undefined) {
          return fail(
            `Helm's browser server has no tool called "${name}". It has: ${TOOLS.map((t) => t.name).join(', ')}.`
          )
        }
        return tool.run(session, args)
      }
    },
    {
      name: SESSION_TOOLS_SERVER_NAME,
      path: SESSION_TOOLS_PATH,
      instructions: SESSION_TOOLS_INSTRUCTIONS,
      // Absent deps is a family that does not exist, which is what a check
      // building a browser-only endpoint gets.
      enabled: () => options.sessions !== undefined && options.settings().sessionMcp,
      listed: () =>
        sessionTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        })),
      async call(session, name, args) {
        const tool = sessionTools.find((entry) => entry.name === name)
        if (tool === undefined) {
          return fail(
            `Helm's session server has no tool called "${name}". It has: ${sessionTools.map((t) => t.name).join(', ')}.`
          )
        }
        // The token, and nothing else, is what the answer is attributed to.
        const answer = await tool.run({ token: session.opener.key }, args)
        return { content: [{ type: 'text', text: answer.text }], ...(answer.isError === true ? { isError: true } : {}) }
      }
    }
  ]

  /**
   * A route per plugin offering tools, read from the plugin host at every
   * request rather than kept: a plugin turned off, or its tools switched off,
   * is a route that no longer exists for the next request.
   */
  const pluginRoutes = (): Route[] => {
    const provider = options.plugins
    if (provider === undefined) return []
    return provider.servers().map((server) => ({
      name: server.server,
      path: `${PLUGIN_PATH_PREFIX}${server.plugin}`,
      instructions: pluginInstructions(server),
      enabled: () => true,
      listed: () =>
        server.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      async call(session, name, args, signal) {
        const answer = await provider.call(
          {
            plugin: server.plugin,
            tool: name,
            args,
            session: { id: session.id, name: session.opener.name, cwd: session.cwd }
          },
          signal
        )
        return answer.ok ? ok(answer.text) : fail(answer.message)
      }
    }))
  }

  /** Every family, Helm's own first. */
  const routes = (): Route[] => [...ROUTES, ...pluginRoutes()]

  // -------------------------------------------------------------------------
  // Small helpers the tools share
  // -------------------------------------------------------------------------

  const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
  const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

  const describeTab = (state: { id: number; url: string; title: string; problem: string | null }): string =>
    [
      `tab: ${String(state.id)}`,
      `url: ${state.url === '' ? '(blank)' : state.url}`,
      `title: ${state.title === '' ? '(none)' : state.title}`,
      ...(state.problem === null ? [] : [`problem: ${state.problem}`])
    ].join('\n')

  /**
   * Wait for a navigation to stop, briefly.
   *
   * Returning the moment `loadURL` was called would answer with the *old*
   * title, and a model that then reported what it opened would be reporting the
   * previous page. Bounded rather than open-ended: a page that never finishes
   * loading is a real page, and the answer for one is its address plus whatever
   * title it has so far.
   */
  const settleTab = async (
    id: number
  ): Promise<{ id: number; url: string; title: string; problem: string | null } | null> => {
    const deadline = Date.now() + 15_000
    for (;;) {
      const state = browsers.states(id)[0]
      if (state === undefined) return null
      if (!state.loading && (state.url !== '' || state.problem !== null)) return state
      if (Date.now() > deadline) return state
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }

  /**
   * The answer to a history move, once it has started and stopped.
   *
   * `settleTab` alone would answer before a back or a reload had begun - the
   * tab is not loading yet, so it looks settled - and report the page being
   * left. So this waits, briefly, for the move to show (the address changes or
   * a load starts), and a move that never shows is a same-document one that has
   * already happened.
   */
  const settleMove = async (
    id: number,
    from: string
  ): Promise<{ id: number; url: string; title: string; problem: string | null } | null> => {
    const deadline = Date.now() + 1500
    for (;;) {
      const state = browsers.states(id)[0]
      if (state === undefined) return null
      if (state.loading || state.url !== from || Date.now() > deadline) return settleTab(id)
      await pause(60)
    }
  }

  /** Where a scroll stands: what scrolls under a point, and how far it has gone. */
  const scrolled = async (id: number, at: { x: number; y: number }): Promise<ScrollPlace | null> => {
    const answer = await browsers.evaluate(id, scrollPlaceScript(at))
    if (!answer.ok) return null
    try {
      return JSON.parse(answer.value) as ScrollPlace
    } catch {
      return null
    }
  }

  /** Where a click lands, in the view's own coordinates. */
  const pointFor = async (
    id: number,
    args: Args,
    tool: string,
    verb: string
  ): Promise<{ x: number; y: number; what: string } | { problem: string }> => {
    const x = num(args.x)
    const y = num(args.y)
    if (str(args.ref) === null && str(args.selector) === null) {
      if (x === null || y === null) {
        return {
          problem: `${tool} needs somewhere to ${verb}: a ref from browser_snapshot, a CSS selector, or both x and y.`
        }
      }
      return { x, y, what: 'that point' }
    }

    const answer = await browsers.evaluate(
      id,
      inPage(
        args,
        `const el = __helmTarget(); if (!el) return JSON.stringify({ missing: true });
         el.scrollIntoView({ block: 'center', inline: 'center' });
         const b = el.getBoundingClientRect();
         return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2,
           width: b.width, height: b.height })`
      )
    )
    if (!answer.ok) return { problem: `Helm could not reach that element: ${answer.error ?? ''}` }
    let box: { missing?: boolean; x?: number; y?: number; width?: number; height?: number }
    try {
      box = JSON.parse(answer.value) as typeof box
    } catch {
      return { problem: `Helm could not measure that element; the page answered: ${answer.value}` }
    }
    if (box.missing === true) return { problem: missingElement(args) }
    if ((box.width ?? 0) <= 0 || (box.height ?? 0) <= 0) {
      return {
        problem: `${describeTarget(
          args
        )} is in the page but has no size on screen, so there is nowhere to ${verb}. It may be hidden, or its container may be collapsed.`
      }
    }
    // CSS pixels to the view's device-independent pixels, the same conversion
    // `bounds()` makes in the other direction. They are equal at zoom 1, which
    // is where a tab starts and where nothing but a person changes it.
    const zoom = browsers.viewport(id)?.zoom ?? 1
    return { x: (box.x ?? 0) * zoom, y: (box.y ?? 0) * zoom, what: describeTarget(args) }
  }

  // -------------------------------------------------------------------------
  // The HTTP half
  // -------------------------------------------------------------------------

  const tokenFor = (req: IncomingMessage): AgentSession | null => {
    const header = req.headers['authorization']
    if (typeof header !== 'string') return null
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    const offered = match?.[1]
    if (offered === undefined) return null
    /*
     * Constant time, and over the whole map rather than a lookup.
     *
     * A `Map.get` on a secret is a hash lookup, which is fine; the comparison
     * that follows it is not, and this is the one place in Helm where a caller
     * gets to ask the same question a few thousand times a second. The cost is
     * a handful of 32-byte comparisons per request.
     */
    const offeredBytes = Buffer.from(offered, 'utf8')
    for (const [token, session] of sessions) {
      const known = Buffer.from(token, 'utf8')
      if (known.length !== offeredBytes.length) continue
      if (timingSafeEqual(known, offeredBytes)) return session
    }
    return null
  }

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      // Nothing here is for a browser and none of it may be cached anywhere.
      'cache-control': 'no-store'
    })
    res.end(text)
  }

  const rpcError = (
    res: ServerResponse,
    id: unknown,
    code: number,
    message: string
  ): void => {
    send(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  }

  const readBody = (req: IncomingMessage): Promise<string | null> =>
    new Promise((resolve) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          resolve(null)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(null))
    })

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    /*
     * Origin first, before the token is even looked at.
     *
     * A page in the user's real browser can reach a loopback port, and the
     * defence that matters is the token - but a request that announces itself
     * as coming from a web page has no business here whatever it carries, and
     * refusing it before the comparison keeps the token out of a timing loop
     * driven by something that is not Claude Code.
     */
    const origin = req.headers['origin']
    if (typeof origin === 'string' && origin !== 'null' && !isLoopbackUrl(origin)) {
      send(res, 403, { error: 'Helm serves this endpoint to local processes, not to web pages.' })
      return
    }

    /*
     * The token before the route, and that order is deliberate.
     *
     * It used to be the other way round, which meant a process with no token
     * could still learn which paths existed by telling a 404 from a 401 - the
     * exact thing "no unauthenticated route at all" is written to prevent, one
     * step removed. Now nothing without a token learns anything about this
     * server but that it is there, and *that* it cannot help learning: it
     * connected to it.
     *
     * It also makes a switched-off family a clean 404 to an authenticated
     * caller, which is one of the three facts "off is off" is asserted with.
     */
    const session = tokenFor(req)
    if (session === null) {
      res.setHeader('www-authenticate', 'Bearer')
      send(res, 401, {
        error: "Helm's endpoint needs the bearer token from the session's own --mcp-config file."
      })
      return
    }

    const path = (req.url ?? '/').split('?')[0]
    const route = routes().find((entry) => entry.path === path && entry.enabled()) ?? null
    if (route === null) {
      send(res, 404, { error: 'Not found.' })
      return
    }

    if (req.method !== 'POST') {
      // The specification's answer for a server that offers no SSE stream on
      // this route. Helm has nothing to push: every tool answers its own call.
      res.setHeader('allow', 'POST')
      send(res, 405, { error: 'This endpoint takes POST only.' })
      return
    }

    const body = await readBody(req)
    if (body === null) {
      send(res, 413, { error: 'That request was too large for a tool call.' })
      return
    }

    let message: JsonRpcRequest
    try {
      message = JSON.parse(body) as JsonRpcRequest
    } catch {
      rpcError(res, null, -32700, 'Parse error: that was not JSON.')
      return
    }
    if (Array.isArray(message)) {
      rpcError(res, null, -32600, 'Helm does not take batched requests.')
      return
    }

    const method = typeof message.method === 'string' ? message.method : ''
    const id = message.id

    // A notification has no id and gets no body - `202 Accepted` is what the
    // transport asks for, and answering one with a JSON-RPC result is what
    // makes a client hang waiting for a reply to something it did not ask
    // about.
    if (id === undefined || id === null) {
      // The one notification acted on: a client that stopped waiting for a
      // request it sent (the user interrupted the session). It names its own
      // request only - the map is the session's.
      if (method === 'notifications/cancelled') {
        const params = message.params as { requestId?: unknown } | null | undefined
        session.inFlight.get(JSON.stringify(params?.requestId ?? null))?.abort()
      }
      res.writeHead(202)
      res.end()
      return
    }

    // Aborted when nobody is waiting for the answer: the client hung up, or
    // said it no longer wants it. Only a plugin's tools act on it.
    const controller = new AbortController()
    const key = JSON.stringify(id)
    session.inFlight.set(key, controller)
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    try {
      const result = await dispatch(route, session, method, message.params, controller.signal)
      if (result === undefined) {
        rpcError(res, id, -32601, `Helm's ${route.name} server has no method "${method}".`)
        return
      }
      send(res, 200, { jsonrpc: '2.0', id, result })
    } catch (err) {
      rpcError(res, id, -32603, err instanceof Error ? err.message : String(err))
    } finally {
      if (session.inFlight.get(key) === controller) session.inFlight.delete(key)
    }
  }

  const dispatch = async (
    route: Route,
    session: AgentSession,
    method: string,
    params: unknown,
    signal: AbortSignal
  ): Promise<unknown> => {
    if (method === 'initialize') {
      const asked =
        typeof params === 'object' && params !== null
          ? (params as { protocolVersion?: unknown }).protocolVersion
          : undefined
      return {
        protocolVersion:
          typeof asked === 'string' && KNOWN_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: route.name, version: '1.0.0' },
        instructions: route.instructions
      }
    }
    if (method === 'ping') return {}
    if (method === 'tools/list') return { tools: route.listed() }
    if (method === 'tools/call') {
      const call = (params ?? {}) as { name?: unknown; arguments?: unknown }
      const name = typeof call.name === 'string' ? call.name : ''
      const args =
        typeof call.arguments === 'object' && call.arguments !== null && !Array.isArray(call.arguments)
          ? (call.arguments as Args)
          : {}
      try {
        return await route.call(session, name, args, signal)
      } catch (err) {
        // A thrown tool is still an answer to the model, not a transport
        // failure: it can read the sentence and try something else.
        return fail(
          `${name} failed inside Helm: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    return undefined
  }

  // -------------------------------------------------------------------------

  /** Revokes a session: its token, its file, its requests in flight and the pages shared with it. */
  const forget = (token: string, session: AgentSession): void => {
    removeSessionMcpConfig(session.file)
    sessions.delete(token)
    for (const controller of session.inFlight.values()) controller.abort()
    session.inFlight.clear()
    // The token is the session's identity, and a page shared with that
    // identity is shared with nobody once it is gone.
    browsers.revoke(token)
  }

  /** `sync` calls, one after another: a start still binding is not a stopped endpoint. */
  let syncing: Promise<void> = Promise.resolve()

  const host: BrowserMcpHost = {
    async start() {
      if (server !== null) return { started: true, problem: null }
      // Every family off is no listener at all, which is the state the app was
      // in before any of this existed. One family on is one route.
      if (!routes().some((route) => route.enabled())) {
        return {
          started: false,
          problem:
            'browserMcp and sessionMcp are both off and no plugin offers tools, so Helm binds no port and passes no --mcp-config.'
        }
      }
      // Whatever a run that ended without tidying up left behind, and only what
      // is provably dead. See `core/launch/mcp.ts`.
      cleanStaleMcpConfigs(options.dir)

      const next = createServer((req, res) => {
        void handle(req, res).catch(() => {
          if (!res.headersSent) send(res, 500, { error: 'Helm failed to answer that.' })
        })
      })
      // A client that goes away should not hold a socket open past the app.
      next.keepAliveTimeout = 5_000

      try {
        await new Promise<void>((resolve, reject) => {
          // `listen` reports a taken port on the 'error' event rather than to
          // the callback, so the obvious one-liner never settles.
          next.once('error', reject)
          next.listen(0, '127.0.0.1', () => {
            next.removeListener('error', reject)
            resolve()
          })
        })
      } catch (err) {
        return { started: false, problem: err instanceof Error ? err.message : String(err) }
      }
      server = next
      return { started: true, problem: null }
    },

    sync() {
      syncing = syncing.then(async () => {
        if (routes().some((route) => route.enabled())) await host.start()
        else await host.stop()
      })
      return syncing
    },

    async stop() {
      // Tokens first. From this point nothing that arrives is authenticated,
      // whatever is still in flight.
      for (const [token, session] of [...sessions]) forget(token, session)
      const current = server
      server = null
      if (current === null) return
      await new Promise<void>((resolve) => {
        // Keep-alive sockets hold `close()` open forever otherwise, and the
        // app's quit would wait on a client that never hangs up.
        current.closeAllConnections()
        current.close(() => resolve())
      })
    },

    running: () => server !== null,

    address() {
      const info = server?.address()
      if (info === null || info === undefined || typeof info === 'string') return null
      return { address: info.address, port: info.port, family: info.family }
    },

    servedNames: () => routes().filter((route) => route.enabled()).map((route) => route.name),

    register({ id, name, cwd }) {
      const info = server?.address()
      if (server === null || info === null || info === undefined || typeof info === 'string') {
        return null
      }
      const on = routes().filter((route) => route.enabled())
      // No family is on: no token is minted at all. A registration that handed
      // back a token and an empty list would be a live credential for nothing.
      if (on.length === 0) return null

      const token = randomBytes(32).toString('hex')
      const opener: BrowserOpener = { key: token, name }
      const session: AgentSession = {
        opener,
        id,
        cwd,
        lastTab: null,
        file: null,
        inFlight: new Map()
      }
      sessions.set(token, session)
      return {
        token,
        launch: {
          dir: options.dir,
          // One entry per family, all on the same port and carrying the same
          // token: it is one session's identity, not one server's key.
          servers: on.map((route) => ({
            name: route.name,
            url: `http://127.0.0.1:${String(info.port)}${route.path}`,
            headers: { Authorization: `Bearer ${token}` }
          }))
        }
      }
    },

    attach(token, file) {
      const session = sessions.get(token)
      if (session !== undefined) session.file = file
    },

    release(token) {
      if (token === null) return
      const session = sessions.get(token)
      if (session !== undefined) forget(token, session)
    }
  }
  return host
}

// ---------------------------------------------------------------------------
// Reading arguments without trusting them
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

const describeTarget = (args: Args): string =>
  str(args.ref) !== null ? `[ref=${String(args.ref)}]` : `"${String(args.selector)}"`

const missingElement = (args: Args): string =>
  str(args.ref) !== null
    ? `Nothing is at [ref=${String(
        args.ref
      )}] any more. A ref describes where an element sat when the snapshot was taken, so take a fresh browser_snapshot after the page changes.`
    : `Nothing in the page matches ${JSON.stringify(String(args.selector))}. Take a browser_snapshot to see what is there.`

/**
 * One expression, run in the page, with `__helmTarget` in scope.
 *
 * **Everything is inside an arrow function**, and that is not style: a
 * top-level `const` in a classic script creates a binding in the *global*
 * lexical environment that outlives the call, so the second
 * `executeJavaScript` carrying the same declaration throws "Identifier
 * '__helmTarget' has already been declared" - and the model would read that as
 * the page being broken rather than as Helm having declared a variable twice.
 *
 * A `ref` is an index path from `documentElement` - `"1.3.0"` is
 * `documentElement.children[1].children[3].children[0]` - resolved by walking,
 * at the moment of the click, rather than by anything left behind in the page.
 * Playwright's equivalent stamps an attribute on every element it lists; that
 * would mean Helm writing into somebody's page in order to read it, and this is
 * already the milestone that has to be careful about what it does to a page
 * nobody is looking at. A walk leaves nothing at all.
 *
 * The cost is that a ref is only true while the structure around it holds -
 * which is what the sentence in `missingElement` says, in as many words.
 */
function inPage(args: Args, body: string): string {
  const ref = str(args.ref)
  const resolver =
    ref !== null
      ? `const __helmTarget = () => {
           const parts = ${JSON.stringify(ref)}.split('.').filter((p) => p !== '');
           let el = document.documentElement;
           for (const part of parts) { el = el && el.children[Number(part)]; if (!el) return null }
           return el ?? null };`
      : `const __helmTarget = () => document.querySelector(${JSON.stringify(
          String(args.selector ?? '')
        )});`
  return `(() => { ${resolver}\n${body} })()`
}

/**
 * `inPage` with the whole document as the target when nothing is named, for a
 * tool where the page itself is the default.
 */
function onTarget(args: Args, body: string): string {
  if (str(args.ref) !== null || str(args.selector) !== null) return inPage(args, body)
  return `(() => { const __helmTarget = () => document.body ?? document.documentElement;\n${body} })()`
}

/** Rendered text, with the runs of blank lines a layout leaves cut to one. */
const tidyText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface SelectResult {
  chosen?: string[]
  missing?: boolean
  notSelect?: string
  unknown?: string
  options?: Array<{ value: string; label: string }>
  more?: number
  disabled?: string
  single?: boolean
}

/**
 * Choosing options the way a person's choice reaches the page: the options
 * marked, then `input` and `change`, bubbling, which is what a framework's
 * listener is waiting for. A value is matched as the option's value first and
 * its shown text second, so either thing a snapshot shows works.
 */
function selectBody(values: string[]): string {
  return `const el = __helmTarget(); if (!el) return JSON.stringify({ missing: true });
    if (el.tagName !== 'SELECT') return JSON.stringify({ notSelect: el.tagName.toLowerCase() });
    const options = Array.from(el.options);
    const label = (o) => (o.label || o.text || '').trim();
    const picked = [];
    for (const wanted of ${JSON.stringify(values)}) {
      const o = options.find((o) => o.value === wanted) || options.find((o) => label(o) === wanted.trim());
      if (!o) return JSON.stringify({ unknown: wanted, more: Math.max(0, options.length - 40),
        options: options.slice(0, 40).map((o) => ({ value: o.value, label: label(o) })) });
      if (o.disabled) return JSON.stringify({ disabled: label(o) || o.value });
      if (!picked.includes(o)) picked.push(o);
    }
    if (el.disabled) return JSON.stringify({ disabled: 'the select' });
    if (picked.length > 1 && !el.multiple) return JSON.stringify({ single: true });
    el.focus();
    for (const o of options) o.selected = picked.includes(o);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ chosen: picked.map((o) => label(o) || o.value) });`
}

/** Why `browser_select` chose nothing, as a sentence. */
function selectRefusal(args: Args, result: SelectResult): string {
  if (result.missing === true) return missingElement(args)
  if (result.notSelect !== undefined) {
    return `${describeTarget(args)} is a <${result.notSelect}>, not a <select>. A custom dropdown is clicked open with browser_click, and its option clicked the same way.`
  }
  if (result.single === true) return `${describeTarget(args)} takes one option at a time, so pass one value.`
  if (result.disabled !== undefined) return `${JSON.stringify(result.disabled)} is disabled, so it cannot be chosen.`
  const listed = (result.options ?? [])
    .map((option) =>
      option.label === option.value || option.label === ''
        ? JSON.stringify(option.value)
        : `${JSON.stringify(option.label)} (value ${JSON.stringify(option.value)})`
    )
    .join(', ')
  return `${describeTarget(args)} has no option ${JSON.stringify(result.unknown ?? '')}. It has: ${
    listed === '' ? 'no options at all' : listed
  }${(result.more ?? 0) > 0 ? `, and ${String(result.more)} more` : ''}.`
}

/** One look at whether what `browser_wait_for` is waiting for has happened: `yes`, `no`, or `bad:` and why. */
function waitScript(condition: 'text' | 'textGone' | 'selector', target: string): string {
  const wanted = JSON.stringify(target)
  if (condition === 'selector') {
    return `(() => { let el; try { el = document.querySelector(${wanted}) } catch (e) { return 'bad:' + e.message }
      if (!el) return 'no';
      const box = el.getBoundingClientRect(); const style = getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' ? 'yes' : 'no' })()`
  }
  const present = `(document.body ? document.body.innerText : '').includes(${wanted})`
  return `(() => ${condition === 'text' ? present : `!${present}`} ? 'yes' : 'no')()`
}

const waited = (condition: 'text' | 'textGone' | 'selector', target: string): string =>
  condition === 'text'
    ? `${JSON.stringify(target)} appeared`
    : condition === 'textGone'
      ? `${JSON.stringify(target)} went away`
      : `${JSON.stringify(target)} matched something visible`

const notYet = (condition: 'text' | 'textGone' | 'selector', target: string): string =>
  condition === 'text'
    ? `${JSON.stringify(target)} never appeared`
    : condition === 'textGone'
      ? `${JSON.stringify(target)} was still there`
      : `nothing visible matched ${JSON.stringify(target)}`

/** What a wheel at a point would scroll, and where it is. */
interface ScrollPlace {
  /** `page`, or a short CSS-ish name for an element that scrolls on its own. */
  what: string
  x: number
  y: number
  width: number
  height: number
  /** How much of it shows. */
  viewWidth: number
  viewHeight: number
}

/**
 * The scroller under a point: the nearest element there that scrolls, or the
 * page. Read before and after a wheel turn, so the answer says what moved
 * rather than what the page's own scroll position happens to be - a wheel over
 * a sidebar moves the sidebar.
 */
function scrollPlaceScript(at: { x: number; y: number }): string {
  return `(() => {
    const page = document.scrollingElement || document.documentElement;
    const scrolls = (el) => {
      const style = getComputedStyle(el);
      const can = (overflow) => overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
      return (can(style.overflowY) && el.scrollHeight > el.clientHeight)
        || (can(style.overflowX) && el.scrollWidth > el.clientWidth);
    };
    let el = document.elementFromPoint(${String(Math.round(at.x))}, ${String(Math.round(at.y))});
    while (el && el !== page && el !== document.body && !scrolls(el)) el = el.parentElement;
    const scroller = el && el !== document.body && el !== page ? el : page;
    const name = scroller === page ? 'page'
      : scroller.tagName.toLowerCase() + (scroller.id ? '#' + scroller.id : '')
        + (typeof scroller.className === 'string' && scroller.className.trim() ? '.' + scroller.className.trim().split(/\\s+/)[0] : '');
    return JSON.stringify({ what: name, x: Math.round(scroller.scrollLeft), y: Math.round(scroller.scrollTop),
      width: scroller.scrollWidth, height: scroller.scrollHeight,
      viewWidth: scroller.clientWidth, viewHeight: scroller.clientHeight });
  })()`
}

/** What a wheel turn did, in a sentence. */
function describeScroll(
  before: ScrollPlace,
  after: ScrollPlace,
  dx: number,
  dy: number,
  at: { x: number; y: number }
): string {
  const name = after.what === 'page' ? 'the page' : `<${after.what}>`
  const movedY = after.y - before.y
  const movedX = after.x - before.x
  if (movedY === 0 && movedX === 0 && before.what === after.what) {
    const end = dy > 0 || dx > 0 ? 'end' : 'start'
    return `Nothing moved. ${name} is already at its ${end}, or nothing under (${String(
      Math.round(at.x)
    )}, ${String(Math.round(at.y))}) scrolls that way.`
  }
  const parts = [
    ...(movedY === 0 ? [] : [`${movedY > 0 ? 'down' : 'up'} ${String(Math.abs(movedY))}px`]),
    ...(movedX === 0 ? [] : [`${movedX > 0 ? 'right' : 'left'} ${String(Math.abs(movedX))}px`])
  ]
  return `Scrolled ${name} ${parts.join(' and ')}. It is at ${String(after.y)} of ${String(
    after.height
  )} down (${String(after.viewHeight)} showing)${
    after.width > after.viewWidth ? ` and ${String(after.x)} of ${String(after.width)} across` : ''
  }.`
}

interface SnapshotNode {
  depth: number
  role: string
  name: string
  ref: string
  note: string
}

interface SnapshotResult {
  title: string
  url: string
  viewport: { width: number; height: number }
  scroll: { x: number; y: number }
  nodes: SnapshotNode[]
  truncated: boolean
}

/** The snapshot, as the model reads it. */
function renderSnapshot(id: number, snapshot: SnapshotResult): string {
  const head = [
    `tab: ${String(id)}`,
    `title: ${snapshot.title === '' ? '(none)' : snapshot.title}`,
    `url: ${snapshot.url}`,
    `viewport: ${String(snapshot.viewport.width)}x${String(snapshot.viewport.height)}${
      snapshot.scroll.y > 0 || snapshot.scroll.x > 0
        ? `, scrolled to (${String(snapshot.scroll.x)}, ${String(snapshot.scroll.y)})`
        : ''
    }`
  ]
  if (snapshot.nodes.length === 0) {
    return [
      ...head,
      '',
      'Nothing in this page is visible. It may still be loading, or it may have rendered nothing at all - browser_console often says which.'
    ].join('\n')
  }
  const body = snapshot.nodes.map(
    (node) =>
      `${'  '.repeat(node.depth)}- ${node.role}${node.name === '' ? '' : ` ${JSON.stringify(node.name)}`}${
        node.note === '' ? '' : ` ${node.note}`
      } [ref=${node.ref}]`
  )
  return [
    ...head,
    '',
    ...body,
    ...(snapshot.truncated
      ? ['', '(cut short - pass a larger maxNodes, or narrow what you are looking for)']
      : [])
  ].join('\n')
}

const consoleLine = (entry: BrowserConsoleEntry): string =>
  `[${new Date(entry.at).toISOString().slice(11, 19)}] ${entry.level}: ${entry.message}${
    entry.source === '' || entry.source === 'helm' ? '' : `  (${entry.source}:${String(entry.line)})`
  }`

/**
 * The page walk, as one expression.
 *
 * Kept as a string rather than a bundled module because it runs in *somebody
 * else's page*: there is no preload, nothing of Helm's is loaded in there, and
 * the only route in is the same `executeJavaScript` the console panel already
 * uses. So this is written to leave no trace - no attribute, no global, no
 * listener - and to answer with JSON that crosses the process boundary.
 *
 * What it keeps is what an agent needs to act: landmarks, headings, anything
 * clickable or typable, and the text that is actually rendered. What it drops
 * is everything invisible - `display: none`, zero-sized, `aria-hidden` - which
 * is most of a modern page and all of the part that would mislead.
 */
function snapshotScript(maxNodes: number): string {
  return `(() => {
  const MAX = ${String(maxNodes)};
  const nodes = [];
  let truncated = false;

  const ROLES = { a: 'link', button: 'button', input: 'input', select: 'select',
    textarea: 'textbox', summary: 'summary', label: 'label', form: 'form', img: 'image',
    iframe: 'frame', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    aside: 'complementary', dialog: 'dialog', table: 'table', li: 'listitem' };

  const refOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.parentElement) {
      parts.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
      node = node.parentElement;
    }
    return parts.join('.');
  };

  const trim = (text) => String(text == null ? '' : text).replace(/\\s+/g, ' ').trim().slice(0, 160);

  const nameOf = (el) => {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return trim(aria);
    if (el.tagName === 'IMG') return trim(el.getAttribute('alt') || '');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return trim(el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('aria-labelledby') || '');
    }
    const own = Array.prototype.filter.call(el.childNodes, (n) => n.nodeType === 3)
      .map((n) => n.nodeValue).join(' ');
    if (trim(own) !== '') return trim(own);
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || /^H[1-6]$/.test(el.tagName)) {
      return trim(el.innerText || el.textContent || '');
    }
    return trim(el.getAttribute && el.getAttribute('title') || '');
  };

  const noteOf = (el) => {
    const bits = [];
    if (el.tagName === 'A' && el.getAttribute('href')) bits.push('href=' + trim(el.getAttribute('href')));
    if (el.tagName === 'INPUT') {
      bits.push('type=' + (el.getAttribute('type') || 'text'));
      if (el.type === 'checkbox' || el.type === 'radio') bits.push(el.checked ? 'checked' : 'unchecked');
      else if (el.value) bits.push('value=' + JSON.stringify(trim(el.value)));
    }
    if (el.tagName === 'TEXTAREA' && el.value) bits.push('value=' + JSON.stringify(trim(el.value)));
    if (el.tagName === 'SELECT') bits.push('value=' + JSON.stringify(trim(el.value)));
    if (el.disabled === true) bits.push('disabled');
    if (el.id) bits.push('#' + el.id);
    return bits.join(' ');
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return trim(explicit);
    if (/^H[1-6]$/.test(el.tagName)) return 'heading' + el.tagName.slice(1);
    return ROLES[el.tagName.toLowerCase()] || null;
  };

  const visible = (el, style) => {
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  const walk = (el, depth) => {
    if (nodes.length >= MAX) { truncated = true; return }
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
    const style = window.getComputedStyle(el);
    if (!visible(el, style)) return;

    const role = roleOf(el);
    const name = nameOf(el);
    // Text that is rendered and belongs to no control still matters - it is
    // most of what "read the page" means - so a leaf carrying its own text is
    // emitted with the role "text" when it is nothing more specific.
    const ownText = trim(Array.prototype.filter.call(el.childNodes, (n) => n.nodeType === 3)
      .map((n) => n.nodeValue).join(' '));
    const emit = role !== null
      || el.tabIndex >= 0
      || el.isContentEditable === true
      || (ownText !== '' && el.children.length === 0);

    let next = depth;
    if (emit) {
      nodes.push({ depth: depth, role: role || 'text', name: name || ownText, ref: refOf(el), note: noteOf(el) });
      next = depth + 1;
    }
    for (const child of Array.prototype.slice.call(el.children)) walk(child, next);
  };

  if (document.body) walk(document.body, 0);

  return JSON.stringify({
    title: document.title || '',
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    nodes: nodes,
    truncated: truncated
  });
})()`
}
