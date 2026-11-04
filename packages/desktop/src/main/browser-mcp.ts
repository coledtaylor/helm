import { agentReach, browserReachAllows, resolveBrowserAddress, type AppSettings } from '@helm/core'
import type { BrowserHost, BrowserOpener } from './browser'
import type { ToolAnswer as PluginToolAnswer, ToolServer } from './plugins/tools'
import { pairTools, type ToolSpec, type ToolTable } from './tool-table'
import type { BrowserConsoleEntry } from '../shared/ipc'
import browserToolTable from '../../../../crates/host/src/server/browser_tools.json'

/**
 * Helm's browser tools, run for the sessions the local host runs.
 *
 * The host serves its sessions' agent tools on its own listener
 * (`crates/host/src/agent_tools`). It has no browser, so each browser call goes
 * over `agentBrowser:call` to the client that declared one, and this is that
 * client's answer (`host/browser-tools.ts`): the tool run against the browser
 * pane for the session's identity, under the same tab rule and reach rule the
 * host's route names. Helm itself binds no port, mints no token and writes no
 * `--mcp-config`.
 *
 * - **A session drives only its own tabs**, and a tab of the user's only once
 *   the user has shared it with that session (`drivenTab`).
 * - **The reach rule is the pane's**, `browserReachAllows` composed by
 *   `agentReach`, checked at the tool entry point and again on every call that
 *   acts on a page that is already somewhere.
 * - **Off is off.** With the browser tools switched off every call is refused
 *   and nothing reaches a page.
 *
 * Nothing here reads a session's output, renders a message, or answers a
 * prompt: a session calls a tool exactly the way it calls any other MCP tool.
 */

/** One browser tool as a session is told about it: everything but what it does. */
export type BrowserToolSpec = ToolSpec

/**
 * The browser tools' table: the server's name and route, its instructions,
 * and each tool's name, description and input schema. It lives once, in
 * `crates/host/src/server/browser_tools.json`, because the host serves the same
 * family to the sessions it runs and a session must be told the same thing by
 * either: the user's `mcp__helm-browser__*` permission rules name these tools.
 */
export const BROWSER_TOOL_TABLE: ToolTable = browserToolTable

/** Each browser tool in the table with what it does (`pairTools`). */
export function pairBrowserTools<R>(
  specs: readonly BrowserToolSpec[],
  runs: Readonly<Record<string, R>>
): Array<BrowserToolSpec & { run: R }> {
  return pairTools('browser', specs, runs)
}

/**
 * How many nodes a snapshot may carry before it says it was cut short. This
 * and the limits below are stated in the table's descriptions too.
 */
export const SNAPSHOT_MAX_NODES = 600
/** What `browser_text` answers with at most, unless asked for more. */
export const TEXT_MAX_CHARS = 20_000
/** `browser_wait_for`: how long by default, the longest it will, and how often it looks. */
export const WAIT_DEFAULT_S = 10
export const WAIT_MAX_S = 60
const WAIT_POLL_MS = 150

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

/** What a browser tool answers: MCP's `tools/call` result, as a session reads it. */
export type BrowserToolResult = ToolResult

/** One session's identity and the tab it is working in. */
interface AgentSession {
  opener: BrowserOpener
  /** The last tab this session opened or acted on. What `tab` defaults to. */
  lastTab: number | null
}

export interface BrowserMcpHost {
  /**
   * Runs one browser tool for the session `opener` names: how a session in the
   * local host has its calls answered, relayed by the host
   * (`host/browser-tools.ts`). Refused while the browser tools are switched
   * off.
   */
  runBrowserTool(opener: BrowserOpener, tool: string, args: unknown): Promise<BrowserToolResult>
  /** Forget an identity `runBrowserTool` ran for: the tab it last used, and every page shared with it. */
  forgetOpener(key: string): void
}

export interface BrowserMcpOptions {
  browsers: BrowserHost
  /** Read through a function: both reach settings can change while a tab is open. */
  settings: () => AppSettings
}

/**
 * What a session is told about a plugin's tools before the plugin's own words,
 * offered to the local host as it is.
 */
export function pluginInstructions(server: ToolServer): string {
  const provenance = `These tools come from "${server.name}", a plugin the user added to Helm, the app hosting this session. The plugin answers every call; Helm passes it on.`
  return server.instructions === null ? provenance : `${provenance}\n\n${server.instructions}`
}

/**
 * The tool result a session reads for a plugin's answer: its text, or why
 * there is none as an error, for a call the local host relays.
 */
export function pluginToolResult(answer: PluginToolAnswer): BrowserToolResult {
  return answer.ok
    ? { content: [{ type: 'text', text: answer.text }] }
    : { content: [{ type: 'text', text: answer.message }], isError: true }
}

// ---------------------------------------------------------------------------

export function createBrowserMcp(options: BrowserMcpOptions): BrowserMcpHost {
  /** The identities `runBrowserTool` ran for, by key: sessions in the local host. */
  const relayed = new Map<string, AgentSession>()

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

  type Run = (session: AgentSession, args: Args) => Promise<ToolResult>

  /**
   * What each tool does, by name. What a session is told about it (its
   * description and input schema) is the shared table, `BROWSER_TOOL_TABLE`,
   * and `pairBrowserTools` refuses a tool that is in one and not the other.
   */
  const RUNS: Record<string, Run> = {
    async browser_open(session, args) {
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
    },

    async browser_navigate(session, args) {
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
    },

    async browser_tabs(session) {
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
    },

    async browser_snapshot(session, args) {
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
    },

    async browser_text(session, args) {
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
    },

    async browser_screenshot(session, args) {
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
    },

    async browser_console(session, args) {
      const tab = drivenTab(session, args)
      if ('problem' in tab) return fail(tab.problem)
      const entries = browsers.entries(tab.id)
      const from = Math.max(0, Math.min(entries.length, num(args.cursor) ?? 0))
      const slice = entries.slice(from)
      const head = `cursor: ${String(entries.length)}${
        slice.length === 0 ? '\n(nothing new)' : ''
      }`
      return ok([head, ...slice.map(consoleLine)].join('\n'))
    },

    async browser_click(session, args) {
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
    },

    async browser_hover(session, args) {
      const tab = drivenTab(session, args)
      if ('problem' in tab) return fail(tab.problem)
      const at = await pointFor(tab.id, args, 'browser_hover', 'point at')
      if ('problem' in at) return fail(at.problem)
      await browsers.hover(tab.id, at.x, at.y)
      return ok(
        `The pointer is over ${at.what} at (${String(Math.round(at.x))}, ${String(Math.round(at.y))}).`
      )
    },

    async browser_type(session, args) {
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
    },

    async browser_press(session, args) {
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
    },

    async browser_select(session, args) {
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
    },

    async browser_scroll(session, args) {
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
    },

    async browser_wait_for(session, args) {
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
    },

    async browser_evaluate(session, args) {
      const tab = drivenTab(session, args)
      if ('problem' in tab) return fail(tab.problem)
      const source = str(args.expression)
      if (source === null) return fail('browser_evaluate needs an expression.')
      const answer = await browsers.evaluate(tab.id, source)
      if (!answer.ok) return fail(`The page raised: ${answer.error ?? 'an error with no message'}`)
      return ok(answer.value === '' ? '(empty string)' : answer.value)
    },

    async browser_close(session, args) {
      const tab = drivenTab(session, args)
      if ('problem' in tab) return fail(tab.problem)
      const answer = browsers.closeFor(session.opener, tab.id)
      if (!answer.closed) return fail(answer.problem ?? 'That tab could not be closed.')
      if (session.lastTab === tab.id) session.lastTab = null
      return ok(`Closed tab #${String(tab.id)}.`)
    }
  }

  const TOOLS = pairBrowserTools(BROWSER_TOOL_TABLE.tools, RUNS)

  /** One tool call, its arguments read without trusting them. */
  const runTool = async (session: AgentSession, name: string, input: unknown): Promise<ToolResult> => {
    const tool = TOOLS.find((entry) => entry.name === name)
    if (tool === undefined) {
      return fail(`Helm's browser server has no tool called "${name}". It has: ${TOOLS.map((t) => t.name).join(', ')}.`)
    }
    const args = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Args) : {}
    try {
      return await tool.run(session, args)
    } catch (err) {
      // A thrown tool is still an answer to the model, not a transport
      // failure: it can read the sentence and try something else.
      return fail(`${name} failed inside Helm: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

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

  return {
    runBrowserTool(opener, tool, args) {
      if (!options.settings().browserMcp) {
        return Promise.resolve(
          fail("Helm's browser tools are switched off in Settings > Browser, so this session has none to call.")
        )
      }
      let session = relayed.get(opener.key)
      if (session === undefined) {
        session = { opener, lastTab: null }
        relayed.set(opener.key, session)
      } else {
        // The key is the identity; the name is the session's label now.
        session.opener = opener
      }
      return runTool(session, tool, args)
    },

    forgetOpener(key) {
      relayed.delete(key)
      // A page shared with an identity is shared with nobody once it is gone.
      browsers.revoke(key)
    }
  }
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
