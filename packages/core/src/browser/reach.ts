/**
 * Where the browser pane may go, and what a person typing into an address bar
 * meant.
 *
 * In `core/` rather than in `main/browser.ts` because it is the rule two
 * different callers have to agree on, and because it has to be **one
 * function**. The setting decides how far the pane may reach; an agent driving
 * a tab is narrower still, and the two intersect - `browserReachAllows` takes
 * as many restrictions as the caller has and allows a URL only where every one
 * of them does. A second copy of a URL rule written for the agent case is how
 * the two would drift, and the drift would be silent: both would keep saying
 * yes to the ordinary URLs anybody tested with.
 *
 * Nothing here reaches the network, the filesystem or Electron. It is a
 * decision about a string.
 */

/**
 * How far the browser pane may reach.
 *
 * `web` is the default because the pane is framed as a dev-server viewport but
 * a dev server that pulls a font, an API or a docs page is the ordinary case,
 * and a viewport that could not load them would be one people turned off.
 * `local` is for the run where nothing should leave the machine.
 */
export const BROWSER_REACH_MODES = ['web', 'local'] as const

export type BrowserReach = (typeof BROWSER_REACH_MODES)[number]

/** Allowed, or a whole sentence saying why not. */
export interface ReachDecision {
  allowed: boolean
  /** Null when allowed; otherwise something a pane can paint as it is. */
  problem: string | null
}

const ALLOW: ReachDecision = { allowed: true, problem: null }

/**
 * The hosts a self-signed certificate is accepted for and `local` confines the
 * pane to. One list, because "is this loopback" is asked by the reach rule and
 * by the certificate rule and they must not disagree.
 *
 * `[::1]` is how a URL spells the IPv6 loopback, brackets included -
 * `new URL('http://[::1]:3000').hostname` is `[::1]`.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Whether `url` names this machine.
 *
 * Hostname only, and deliberately not a DNS lookup: this is a question about
 * what was typed, asked before anything is fetched, and a rule that resolved
 * names would be a rule that made a network request in order to decide whether
 * a network request is allowed. `127.0.0.2` and the rest of `127/8` are left
 * out for the same reason the set is a literal - the three spellings above are
 * the ones a dev server prints, and a wider rule is a wider hole.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * May the browser go here?
 *
 * The **one** function. `restrictions` is every rule that applies to this
 * navigation, and a URL is allowed only where all of them allow it - so M17's
 * agent control composes by passing its own mode alongside the setting rather
 * than by writing a second rule.
 *
 * The scheme test is here rather than beside it because it is the same
 * question: `file:` is not a place the pane may go, whatever the mode is. A
 * pane that refused `file:` in one function and refused non-loopback in another
 * would have two places to add a scheme to, and one of them would be missed.
 */
export function browserReachAllows(
  url: string,
  ...restrictions: readonly BrowserReach[]
): ReachDecision {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, problem: `${url} is not an address Helm can open.` }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      problem: `Helm's browser opens http and https pages only, and this is ${parsed.protocol.replace(
        ':',
        ''
      )}. Nothing was fetched.`
    }
  }

  if (restrictions.includes('local') && !isLoopbackUrl(url)) {
    return {
      allowed: false,
      problem: `Browser reach is set to "This machine only", so ${parsed.host} was not fetched. Change it in Settings → Browser, or open the page in your own browser.`
    }
  }

  return ALLOW
}

/**
 * The restrictions that apply to a navigation **an agent asked for**.
 *
 * The intersection, expressed once. `browserReach` says how far the pane may
 * go and `browserMcpLocalOnly` says how far a tool may go, and the rule has no
 * special cases: the narrower wins, always, because both are handed to
 * `browserReachAllows` and it allows a URL only where every restriction does.
 *
 * A function rather than an inline array at two call sites, because there are
 * two call sites - `browser-mcp.ts`'s tool entry and `browser.ts`'s
 * `will-navigate` for a session-opened tab - and "the agent's rule" drifting
 * between them is the failure `browserReachAllows` was written as one function
 * to prevent, one level up.
 */
export function agentReach(reach: BrowserReach, mcpLocalOnly: boolean): BrowserReach[] {
  return mcpLocalOnly ? [reach, 'local'] : [reach]
}

/**
 * What somebody typed into the address bar, as a URL - or a refusal.
 *
 * **This never searches, and that is the decision rather than an omission.**
 * Handing an unrecognised string to a search engine is a network request the
 * user did not ask for, made out of a typo, to a third party, from an app whose
 * whole network posture is "nothing on its own initiative". Going to Google is
 * something you do by typing its address.
 *
 * So there are three answers and no fourth: it is already a URL, it is a bare
 * port and therefore a dev server on this machine, or it is not an address and
 * the pane says so.
 */
export function resolveBrowserAddress(input: string): { url: string | null; problem: string | null } {
  const typed = input.trim()
  if (typed === '') return { url: null, problem: 'Type an address, or a port number.' }

  /*
   * A bare port. The papercut this pane exists for is `pnpm dev` on 3000, and
   * typing five characters instead of twenty-two is most of what makes an
   * address bar worth having here.
   */
  if (/^\d{1,5}$/.test(typed)) {
    const port = Number(typed)
    if (port >= 1 && port <= 65535) return { url: `http://localhost:${typed}/`, problem: null }
    return { url: null, problem: `${typed} is not a port number.` }
  }

  /*
   * A scheme, but `localhost:3000` is not one.
   *
   * `new URL` reads `localhost:3000/app` as the scheme `localhost:` with an
   * opaque path, which is technically right and is the single most common thing
   * anybody types into this bar. So a name followed by digits is a host and a
   * port, and only what is left is a scheme.
   */
  const looksLikeHostPort = /^[a-z][a-z0-9.-]*:\d{1,5}(?:[/?#]|$)/i.test(typed)
  if (!looksLikeHostPort && /^[a-z][a-z0-9+.-]*:/i.test(typed)) {
    try {
      const parsed = new URL(typed)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { url: parsed.href, problem: null }
      }
      return {
        url: null,
        problem: `Helm's browser opens http and https pages only, and this is ${parsed.protocol.replace(':', '')}.`
      }
    } catch {
      return { url: null, problem: `${typed} is not an address Helm can open.` }
    }
  }

  // No scheme. `http://` rather than `https://`, because the case this is for
  // is a dev server, and a dev server that is on https will have been typed
  // with the scheme.
  let parsed: URL
  try {
    parsed = new URL(`http://${typed}`)
  } catch {
    return { url: null, problem: notAnAddress(typed) }
  }

  const host = parsed.hostname.toLowerCase()
  // A dot, a port, or one of the loopback spellings. Anything else is a word,
  // and a word is what a search box would have taken - so this is where the
  // refusal lives.
  const addressLike = host.includes('.') || LOOPBACK_HOSTS.has(host) || parsed.port !== ''
  if (!addressLike) return { url: null, problem: notAnAddress(typed) }

  return { url: parsed.href, problem: null }
}

const notAnAddress = (typed: string): string =>
  `"${typed}" is not an address. Helm's browser never searches - type a URL, or a port number for a dev server on this machine.`
