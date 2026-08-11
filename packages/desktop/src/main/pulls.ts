import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  fetchOpenPulls,
  forgetPrRepos,
  parseGitHubRemote,
  readGhAuth,
  readGhVersion,
  readPrRepos,
  readPullsBySlug,
  recordPrFetch,
  replaceRepoPulls,
  upsertPrRepo,
  type AppSettings,
  type GhCommand,
  type GhProblem,
  type GhStatus,
  type PullRepo,
  type PullsSnapshot,
  type PullSummary,
  type Store
} from '@helm/core'
import {
  findGhExecutable,
  GH_MISSING_SENTENCE,
  GH_UNAUTHENTICATED_SENTENCE,
  resolveGhCommand
} from './gh-cli'

const run = promisify(execFile)

/**
 * Keeping the Pulls pane level with what GitHub says.
 *
 * Modelled on `usage.ts`, and different from it in the two ways that matter.
 * There is no `fs.watch` here and there cannot be: nothing on this machine
 * changes when somebody opens a pull request, so the triggers are a timer, the
 * window regaining focus, and the refresh button - and the timer is the reason
 * this service exists at all.
 *
 * The other difference is what a stale answer is worth. Usage degrades to
 * nothing, because a plan percentage from two hours ago is a wrong number. A
 * pull request from two hours ago is a true fact about two hours ago, so this
 * degrades to *stale with its age on it*: cached rows stay, the error goes on
 * the repository that failed, and the snapshot always carries the moment the
 * oldest of them was fetched.
 *
 * Three things it inherits from `usage.ts` unchanged: a pass that throws is
 * caught so it cannot take the interval with it, a snapshot is pushed only when
 * its signature differs, and the fixture hooks (`pointGh`, `pointRemotes`,
 * `pointPollMs`) are methods on the service rather than channels on the IPC
 * contract - the renderer has no business choosing which binary the pull
 * requests come from.
 */

/** `git remote get-url origin` is local and instant, or it is broken. */
const GIT_TIMEOUT_MS = 10_000

/** One `git` per repository; a root holding fifty must not spawn fifty at once. */
const REMOTE_CONCURRENCY = 8

/** One `gh` per distinct remote, held down harder - these are network calls. */
const FETCH_CONCURRENCY = 4

/**
 * How long a mapped remote is believed.
 *
 * Remotes are changed by hand, once in a while, and re-reading every one of
 * them on every five-minute tick would spawn a `git` per repository for an
 * answer that has not moved since the app started. New directories are mapped
 * immediately regardless - this only governs re-reading a directory already
 * known.
 */
const REMOTE_TTL_MS = 10 * 60_000

/**
 * The floor under the focus refresh.
 *
 * Alt-tabbing between an editor and Helm is not a request for a network call.
 * The same guard the git refresh uses, at the interval this surface can afford.
 */
const FOCUS_MIN_INTERVAL_MS = 5 * 60_000

/** A discovered project, as this service needs it. */
export interface PullsProject {
  path: string
  name: string
}

export interface PullsService {
  /** The cache, without touching gh. What `pr:snapshot` answers with. */
  snapshot: () => PullsSnapshot
  /** Fetches now - one repository, or all of them. */
  refresh: (request?: { repoPath?: string }) => Promise<PullsSnapshot>
  /**
   * The window came forward. Guarded rather than debounced, and additionally
   * rate-limited: returns false when it decided not to.
   */
  refreshOnFocus: () => boolean
  /** Re-reads the interval and the gh override out of settings. */
  rearm: () => void
  start: () => void
  stop: () => void

  /**
   * Fixture hooks. Deliberately not on the IPC contract - see the file comment.
   */
  pointGh: (path: string | null) => void
  pointRemotes: (remotes: Record<string, string> | null) => void
  pointPollMs: (ms: number | null) => void
  /** Passes attempted and passes that threw. The poller's own vital signs. */
  passes: () => { started: number; failed: number; lastError: string | null }
}

export interface PullsServiceDeps {
  store: Store
  /** Read through a function: the interval has to be able to change at runtime. */
  settings: () => AppSettings
  /** The directories to consider, from the last scan or the project cache. */
  projects: () => PullsProject[]
  /** Called after any pass whose snapshot differs from the one before it. */
  onChange: (snapshot: PullsSnapshot) => void
}

function msOf(iso: string | null): number | null {
  if (iso === null) return null
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function mapLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++]
      if (item === undefined) return
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * What makes one snapshot different from another.
 *
 * A string rather than a field-by-field comparison, for the reason `usage.ts`
 * gives: a repository appearing, a pull request closing or a review landing all
 * count as a change without this function having to know which fields exist.
 * `fetchedAtMs` is *in* it, unlike the usage signature - a refresh that found
 * exactly the same pull requests still moved the age caption, and the caption is
 * the honesty this surface degrades through.
 */
function signature(snapshot: PullsSnapshot): string {
  return JSON.stringify([
    snapshot.gh.path,
    snapshot.gh.authenticated,
    snapshot.gh.problem?.kind ?? null,
    snapshot.open,
    snapshot.checked,
    snapshot.fetchedAtMs,
    snapshot.repos.map((repo) => [
      repo.path,
      repo.slug,
      repo.fetchedAtMs,
      repo.error,
      repo.pulls.map((pull) => [
        pull.number,
        pull.updatedAt,
        pull.title,
        pull.isDraft,
        pull.reviewDecision,
        pull.additions,
        pull.deletions
      ])
    ])
  ])
}

export function createPullsService({
  store,
  settings,
  projects,
  onChange
}: PullsServiceDeps): PullsService {
  /** Set by `pointGh`; overrides both the setting and discovery. */
  let ghFixture: string | null = null
  /** Set by `pointRemotes`; stands in for `git remote get-url origin`. */
  let remoteFixture: Record<string, string> | null = null
  /** Set by `pointPollMs`; a driver cannot wait five minutes for a tick. */
  let pollFixtureMs: number | null = null

  let ghStatus: GhStatus | null = null
  let poll: NodeJS.Timeout | null = null
  let inFlight: Promise<PullsSnapshot> | null = null
  let lastPassAtMs = 0
  let everFetched = false
  let lastSignature = ''
  let started = 0
  let failed = 0
  let lastError: string | null = null

  // ---------------------------------------------------------------------
  // gh
  // ---------------------------------------------------------------------

  /**
   * What `gh` is on this machine, cached until something could have changed it.
   *
   * `gh auth status` is a real request against GitHub - it validates the token
   * rather than merely finding one - so it is asked once and then only when the
   * answer might have moved: the binary changed, or a fetch has just failed and
   * the pane owes the user a reason.
   */
  async function ensureGh(force = false): Promise<GhStatus> {
    if (ghStatus !== null && !force) return ghStatus

    const override = ghFixture ?? settings().ghPath
    const command = resolveGhCommand(override ?? undefined)
    if (command === null) {
      // An override that does not resolve is worth saying so: falling back to
      // discovery silently would make a wrong setting invisible.
      const discovered = override !== null ? findGhExecutable() : null
      ghStatus = {
        path: discovered,
        source: null,
        version: null,
        authenticated: false,
        problem: { kind: 'missing', message: GH_MISSING_SENTENCE }
      }
      return ghStatus
    }

    const version = await readGhVersion(command)
    const auth = await readGhAuth(command)
    ghStatus = {
      path: command.resolved,
      source: override !== null ? 'setting' : 'discovered',
      version,
      authenticated: auth.authenticated,
      problem: auth.authenticated
        ? null
        : { kind: 'unauthenticated', message: GH_UNAUTHENTICATED_SENTENCE }
    }
    return ghStatus
  }

  function ghCommand(): GhCommand | null {
    return resolveGhCommand((ghFixture ?? settings().ghPath) ?? undefined)
  }

  // ---------------------------------------------------------------------
  // Remotes
  // ---------------------------------------------------------------------

  /**
   * A project's `origin`, read where the project is.
   *
   * Here rather than in `discovery/`, deliberately. The focus git refresh is one
   * `execFile` per project and is on the path between alt-tabbing and seeing a
   * branch chip; adding a second spawn to it would double that cost for every
   * project on the machine, GitHub or not. This runs on the PR surface's own
   * schedule instead, and caches its answer in `pr_repos`.
   */
  async function readOrigin(path: string): Promise<string | null> {
    if (remoteFixture !== null) return remoteFixture[path] ?? null
    try {
      const { stdout } = await run('git', ['--no-optional-locks', 'remote', 'get-url', 'origin'], {
        cwd: path,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true
      })
      const url = stdout.trim()
      return url === '' ? null : url
    } catch {
      // Not a repository, no `origin`, or git is not installed. All three mean
      // the same thing here: nothing to fetch pull requests for.
      return null
    }
  }

  /** Maps the remotes of every project that has not been looked at recently. */
  async function mapRemotes(only: string | null): Promise<void> {
    const rows = new Map(readPrRepos(store).map((row) => [row.path.toLowerCase(), row]))
    const now = Date.now()
    const due = projects().filter((project) => {
      if (only !== null && project.path.toLowerCase() !== only.toLowerCase()) return false
      const row = rows.get(project.path.toLowerCase())
      if (row === undefined) return true
      const checked = msOf(row.checkedAt)
      // A manual refresh of one repository re-reads its remote unconditionally:
      // the button exists for the case where something changed.
      return only !== null || checked === null || now - checked > REMOTE_TTL_MS
    })

    await mapLimit(due, REMOTE_CONCURRENCY, async (project) => {
      const url = await readOrigin(project.path)
      const remote = url === null ? null : parseGitHubRemote(url)
      // `remote.url` rather than the raw one: a remote carrying an embedded
      // token is a credential, and the parse is what strips it.
      upsertPrRepo(store, {
        path: project.path,
        url: remote?.url ?? url,
        slug: remote?.slug ?? null
      })
    })
  }

  // ---------------------------------------------------------------------
  // The pass
  // ---------------------------------------------------------------------

  async function pass(only: string | null): Promise<void> {
    const known = projects()
    forgetPrRepos(
      store,
      known.map((project) => project.path)
    )

    await mapRemotes(only)

    const status = await ensureGh()
    const command = ghCommand()
    if (command === null || !status.authenticated) return

    // One fetch per distinct remote, not per directory: two checkouts of the
    // same repository are two rows in the pane and one call to GitHub.
    const wanted = readPrRepos(store).filter((row) => {
      if (row.slug === null) return false
      return only === null || row.path.toLowerCase() === only.toLowerCase()
    })
    const bySlug = new Map<string, string[]>()
    for (const row of wanted) {
      const slug = row.slug as string
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), row.path])
    }

    let attempted = 0
    let failures = 0
    let firstFailure: string | null = null

    await mapLimit([...bySlug.entries()], FETCH_CONCURRENCY, async ([slug, paths]) => {
      attempted += 1
      const at = new Date().toISOString()
      let pulls: PullSummary[]
      try {
        pulls = await fetchOpenPulls(command, slug)
      } catch (err) {
        failures += 1
        const message = err instanceof Error ? err.message : String(err)
        firstFailure ??= `${slug}: ${message}`
        // The rows already cached stay exactly where they are; only the reason
        // is recorded. That is the whole of stale-with-age.
        recordPrFetch(store, paths, { error: message })
        return
      }
      replaceRepoPulls(store, slug, pulls, at)
      recordPrFetch(store, paths, { error: null, fetchedAt: at })
    })

    if (failures > 0) {
      // Re-asked because a failure is usually a token that expired between two
      // passes, and "run gh auth login" is a better sentence than an HTTP code.
      const rechecked = await ensureGh(true)
      if (rechecked.problem === null && failures === attempted) {
        ghStatus = { ...rechecked, problem: failedProblem(firstFailure) }
      }
    }
    if (failures < attempted) everFetched = true
  }

  function failedProblem(detail: string | null): GhProblem {
    return {
      kind: 'failed',
      message:
        detail === null
          ? 'GitHub CLI could not list pull requests.'
          : `GitHub CLI could not list pull requests - ${detail}`
    }
  }

  // ---------------------------------------------------------------------
  // The snapshot
  // ---------------------------------------------------------------------

  function build(): PullsSnapshot {
    const rows = new Map(readPrRepos(store).map((row) => [row.path.toLowerCase(), row]))
    const pullsBySlug = readPullsBySlug(store)
    const known = projects()

    const repos: PullRepo[] = []
    for (const project of known) {
      const row = rows.get(project.path.toLowerCase())
      // Only repositories with a github.com origin are listed. The rest are
      // counted - `checked` is what lets the pane say "nothing here is on
      // GitHub" rather than showing an empty list with no explanation.
      if (row === undefined || row.slug === null) continue
      repos.push({
        path: project.path,
        name: project.name,
        url: row.url,
        slug: row.slug,
        fetchedAtMs: msOf(row.fetchedAt),
        error: row.error,
        pulls: pullsBySlug.get(row.slug) ?? []
      })
    }

    // Busiest first, then alphabetical, so the order is stable between passes
    // for the repositories that have nothing.
    repos.sort((a, b) => {
      const activity = (repo: PullRepo): number => repo.pulls[0]?.updatedAt ?? 0
      return activity(b) - activity(a) || a.name.localeCompare(b.name)
    })

    // Distinct (slug, number): two checkouts of one repository are two rows and
    // one set of pull requests, and counting them twice would overstate the
    // sidebar.
    const distinct = new Set<string>()
    for (const repo of repos) {
      for (const pull of repo.pulls) distinct.add(`${repo.slug ?? ''}#${String(pull.number)}`)
    }

    const ages = repos
      .map((repo) => repo.fetchedAtMs)
      .filter((at): at is number => at !== null)

    return {
      repos,
      open: distinct.size,
      checked: known.length,
      gh: ghStatus ?? {
        path: null,
        source: null,
        version: null,
        authenticated: false,
        problem: null
      },
      // The oldest, not the newest: see `PullsSnapshot`.
      fetchedAtMs: ages.length === 0 ? null : Math.min(...ages),
      fetching: inFlight !== null
    }
  }

  function publish(): PullsSnapshot {
    const next = build()
    const nextSignature = signature(next)
    if (nextSignature !== lastSignature) {
      lastSignature = nextSignature
      onChange(next)
    }
    return next
  }

  // ---------------------------------------------------------------------
  // Driving it
  // ---------------------------------------------------------------------

  function refresh(request?: { repoPath?: string }): Promise<PullsSnapshot> {
    if (inFlight !== null) return inFlight
    started += 1
    const only = request?.repoPath ?? null
    const attempt = pass(only)
      .catch((err: unknown) => {
        // A pass that threw - a database that would not take a write, a bug in
        // here - is recorded and swallowed. The next tick is the next chance,
        // and an interval that dies on the first bad pass is an interval that
        // stops silently.
        failed += 1
        lastError = err instanceof Error ? err.message : String(err)
        console.warn(`pull request refresh failed: ${lastError}`)
      })
      .then(() => {
        lastPassAtMs = Date.now()
        inFlight = null
        return publish()
      })
    inFlight = attempt
    // Painted immediately as "fetching" so the refresh control can spin without
    // waiting for the network.
    onChange(build())
    return attempt
  }

  function pollMs(): number {
    if (pollFixtureMs !== null) return pollFixtureMs
    const minutes = settings().prPollMinutes
    return minutes <= 0 ? 0 : minutes * 60_000
  }

  function arm(): void {
    if (poll !== null) {
      clearInterval(poll)
      poll = null
    }
    const ms = pollMs()
    if (ms <= 0) return
    poll = setInterval(() => {
      void refresh()
    }, ms)
    poll.unref()
  }

  return {
    snapshot: () => build(),
    refresh,

    refreshOnFocus() {
      if (inFlight !== null) return false
      // Never the *first* fetch: a window coming forward before anything has
      // been fetched at all is a cold start, and that pass is started
      // deliberately from `rendererReady` rather than by whoever clicked.
      if (!everFetched) return false
      if (Date.now() - lastPassAtMs < FOCUS_MIN_INTERVAL_MS) return false
      void refresh()
      return true
    },

    rearm() {
      // The gh status too: `ghPath` and the interval are written through the
      // same channel, and a cached status would keep naming the old executable.
      ghStatus = null
      arm()
    },

    start: arm,

    stop() {
      if (poll !== null) clearInterval(poll)
      poll = null
    },

    pointGh(path) {
      ghFixture = path
      ghStatus = null
    },

    pointRemotes(remotes) {
      remoteFixture = remotes
    },

    pointPollMs(ms) {
      pollFixtureMs = ms
      arm()
    },

    passes: () => ({ started, failed, lastError })
  }
}
