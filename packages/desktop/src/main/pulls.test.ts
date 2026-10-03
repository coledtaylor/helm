import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, PullDetail, PullsSnapshot, Store } from '@helm/core'
import {
  argOf,
  callsOf,
  createGhFixture,
  ghPull,
  ghThread,
  ghView,
  hoursAgo,
  pathWithoutGh,
  setOrigin,
  type GhFixture
} from '../../test/gh-fixture'
import { createWorld, disposeWorld, type World } from '../../test/world'
import type * as CoreModule from '@helm/core'
import type * as GhCli from './gh-cli'
import type { createPullsService as CreatePullsService, PullsService } from './pulls'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * The pull-request service against a fake `gh` that answers from fixtures and
 * logs every call, with real `git` reading the origin of real repositories in
 * a path with a space in it. Each test gets its own database and service.
 */
describe('pull requests service', () => {
  let world: World
  let fx: GhFixture
  // Imported once the world is in place: `gh-cli` reads where gh installs to
  // when it loads.
  let core: typeof CoreModule
  let createPullsService: typeof CreatePullsService
  let sentences: typeof GhCli

  /** The slugs the two projects' origins parse to. Alpha's is mixed case on purpose. */
  const ALPHA = 'Acme/Alpha'
  const BETA = 'acme/beta'

  let store: Store
  let service: PullsService
  let dbCount = 0

  beforeAll(async () => {
    world = createWorld()
    // Discovery may only find what a test puts in front of it, never the
    // machine's own gh.
    Object.assign(process.env, {
      PATH: pathWithoutGh(process.env['PATH'] ?? ''),
      ProgramFiles: join(world.root, 'program files'),
      'ProgramFiles(x86)': join(world.root, 'program files x86'),
      LOCALAPPDATA: join(world.root, 'local'),
      USERPROFILE: world.home,
      HOME: world.home
    })
    fx = createGhFixture(join(world.root, 'gh fixture'))
    // A token embedded in a remote is a credential; it must not be stored.
    setOrigin(world.projects.alpha, 'https://x-access-token:s3cret@github.com/Acme/Alpha.git')
    setOrigin(world.projects.beta, 'git@github.com:acme/beta.git')

    core = await import('@helm/core')
    createPullsService = (await import('./pulls')).createPullsService
    sentences = await import('./gh-cli')
  })

  afterAll(() => {
    disposeWorld(world)
  })

  beforeEach(() => {
    fx.reset()
    mkdirSync(join(world.root, 'db'), { recursive: true })
    store = core.openStore({ file: join(world.root, 'db', `pulls ${String(++dbCount)}.db`) })
    core.writeSettings(store, { ghPath: fx.gh })
    service = createPullsService({
      store,
      settings: () => core.readSettings(store),
      projects: () => [
        { path: world.projects.alpha, name: 'alpha' },
        { path: world.projects.beta, name: 'beta' }
      ],
      onChange: () => undefined
    })
  })

  afterEach(() => {
    service.stop()
    store.close()
  })

  const configure = (patch: Partial<AppSettings>): void => {
    core.writeSettings(store, patch)
  }
  const repoOf = (snapshot: PullsSnapshot, slug: string) =>
    snapshot.repos.find((repo) => repo.slug?.toLowerCase() === slug.toLowerCase())
  const numbersOf = (snapshot: PullsSnapshot, slug: string): number[] =>
    (repoOf(snapshot, slug)?.pulls ?? []).map((pull) => pull.number)

  /** Both repositories with something open: alpha #7 and #9, beta #3. */
  const plantBoth = (): void => {
    fx.list(ALPHA, [ghPull(ALPHA, 7, { title: 'Seven' }), ghPull(ALPHA, 9, { title: 'Nine' })])
    fx.list(BETA, [ghPull(BETA, 3, { title: 'Three' })])
  }

  describe('fetch and remote mapping', () => {
    it('reads each origin with git, stores the slug without its credential, and paints every open pull request', async () => {
      expect(world.projects.alpha).toContain(' ')
      plantBoth()

      // Nothing has read a remote yet, which is "checking", not "no GitHub".
      const before = service.snapshot()
      expect(before.repos).toEqual([])
      expect(before.unmapped).toBe(2)

      const after = await service.refresh()
      expect(after.unmapped).toBe(0)
      expect(numbersOf(after, ALPHA)).toEqual([7, 9])
      expect(numbersOf(after, BETA)).toEqual([3])
      expect(repoOf(after, ALPHA)?.pulls.map((pull) => pull.title)).toEqual(['Seven', 'Nine'])
      expect(after.open).toBe(3)
      expect(after.fetchedAtMs).not.toBeNull()

      const rows = core.readPrRepos(store)
      const alpha = rows.find((row) => row.path === world.projects.alpha)
      expect(alpha?.slug).toBe(ALPHA)
      expect(alpha?.url).not.toContain('s3cret')
      expect(alpha?.url).not.toContain('x-access-token')
      expect(rows.find((row) => row.path === world.projects.beta)?.slug).toBe(BETA)
      expect([...(core.readPullsBySlug(store).get(ALPHA) ?? [])].map((pull) => pull.number)).toEqual([7, 9])
    })

    it('lists by --repo and --state open, never by working directory, and asks gh its version and sign-in', async () => {
      plantBoth()
      const snapshot = await service.refresh()

      const lists = callsOf(fx.calls(), 'pr', 'list')
      expect(lists.map((call) => argOf(call, '--repo')).sort()).toEqual([ALPHA, BETA].sort())
      for (const call of lists) {
        expect(argOf(call, '--state')).toBe('open')
        expect([world.projects.alpha, world.projects.beta].map((p) => p.toLowerCase())).not.toContain(
          call.cwd.toLowerCase()
        )
      }
      expect(callsOf(fx.calls(), '--version')).toHaveLength(1)
      expect(callsOf(fx.calls(), 'auth', 'status')).toHaveLength(1)

      // A `.cmd` shim, the scoop and npm shape, resolved and run.
      expect(snapshot.gh.path).toBe(fx.gh)
      expect(snapshot.gh.source).toBe('setting')
      expect(snapshot.gh.version).toBe('gh version 2.86.0 (fixture)')
    })

    it('drops a pull request gh stopped returning and rewrites a changed title, in snapshot and cache', async () => {
      plantBoth()
      await service.refresh()

      fx.list(ALPHA, [ghPull(ALPHA, 9, { title: 'Nine, renamed' })])
      const after = await service.refresh()

      expect(numbersOf(after, ALPHA)).toEqual([9])
      expect(repoOf(after, ALPHA)?.pulls[0]?.title).toBe('Nine, renamed')
      expect(core.readPull(store, ALPHA, 7)).toBeNull()
      expect(core.readPull(store, ALPHA, 9)?.summary.title).toBe('Nine, renamed')
      expect(after.open).toBe(2)
    })
  })

  describe('the ignore list', () => {
    it('skips an ignored repository before the fetch, lists it as ignored, keeps its cache, and brings it back from the cache', async () => {
      plantBoth()
      await service.refresh()
      const listsFor = (slug: string): number =>
        callsOf(fx.calls(), 'pr', 'list').filter((call) => argOf(call, '--repo') === slug).length
      expect(listsFor(ALPHA)).toBe(1)

      // Matched by slug, whatever the casing.
      configure({ prIgnoredRepos: ['acme/ALPHA'] })
      const hidden = await service.refresh()
      expect(listsFor(ALPHA)).toBe(1)
      expect(listsFor(BETA)).toBe(2)
      expect(hidden.repos.map((repo) => repo.slug)).toEqual([BETA])
      expect(hidden.ignored).toEqual([
        { slug: 'acme/ALPHA', name: 'alpha', present: true, paths: [world.projects.alpha] }
      ])
      expect(hidden.open).toBe(1)
      expect([...(core.readPullsBySlug(store).get(ALPHA) ?? [])].map((pull) => pull.number)).toEqual([7, 9])

      // Un-ignored, the rows come back from the cache before any fetch.
      configure({ prIgnoredRepos: [] })
      const back = service.republish()
      expect(numbersOf(back, ALPHA)).toEqual([7, 9])
      expect(back.ignored).toEqual([])
      expect(listsFor(ALPHA)).toBe(1)

      await service.refresh()
      expect(listsFor(ALPHA)).toBe(2)
    })
  })

  describe('degradation', () => {
    it('names a repository that failed on its own row and raises no machine-wide problem when another succeeded', async () => {
      // Beta has no fixture, so gh cannot resolve it.
      fx.list(ALPHA, [ghPull(ALPHA, 7)])
      const snapshot = await service.refresh()

      expect(repoOf(snapshot, BETA)?.error).toMatch(/could not resolve to a Repository/)
      expect(repoOf(snapshot, ALPHA)?.error).toBeNull()
      expect(numbersOf(snapshot, ALPHA)).toEqual([7])
      expect(snapshot.gh.problem).toBeNull()
    })

    it('gives a targeted refresh of a failing repository a row error, never a banner', async () => {
      plantBoth()
      await service.refresh()

      fx.behave({ list: 'error', listError: 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host' })
      const snapshot = await service.refresh({ repoPath: world.projects.alpha })

      expect(repoOf(snapshot, ALPHA)?.error).toMatch(/no such host/)
      expect(numbersOf(snapshot, ALPHA)).toEqual([7, 9])
      expect(repoOf(snapshot, BETA)?.error).toBeNull()
      expect(snapshot.gh.problem).toBeNull()
    })

    it('reads a refused token from the fetch as unauthenticated, and keeps the rows, the cache and their age', async () => {
      plantBoth()
      const good = await service.refresh()

      // `gh auth status` still says signed in: the verdict comes from the fetch.
      fx.behave({ list: 'error', listError: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' })
      const refused = await service.refresh()

      expect(refused.gh.problem?.kind).toBe('unauthenticated')
      expect(refused.gh.problem?.message).toBe(sentences.GH_UNAUTHENTICATED_SENTENCE)
      expect(refused.gh.problem?.message).toContain('gh auth login')
      expect(refused.gh.authenticated).toBe(false)
      expect(numbersOf(refused, ALPHA)).toEqual([7, 9])
      expect(repoOf(refused, ALPHA)?.error).toMatch(/401/)
      expect(refused.fetchedAtMs).toBe(good.fetchedAtMs)
      expect(core.readPull(store, ALPHA, 7)).not.toBeNull()
    })

    it('calls an unreachable GitHub offline, never a sign-in problem, and the next good sweep clears it', async () => {
      plantBoth()
      const good = await service.refresh()

      // What a real gh prints with no route: auth status blames the token too.
      fx.behave({
        auth: 'offline',
        list: 'error',
        listError: 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host'
      })
      const offline = await service.refresh()
      expect(offline.gh.problem?.kind).toBe('offline')
      expect(offline.gh.problem?.message).not.toMatch(/gh auth login|not signed in/i)
      expect(numbersOf(offline, ALPHA)).toEqual([7, 9])
      expect(offline.fetchedAtMs).toBe(good.fetchedAtMs)

      fx.behave({})
      const listsBefore = callsOf(fx.calls(), 'pr', 'list').length
      const back = await service.refresh()
      expect(back.gh.problem).toBeNull()
      expect(repoOf(back, ALPHA)?.error).toBeNull()
      expect(callsOf(fx.calls(), 'pr', 'list').length).toBe(listsBefore + 2)
      expect(back.fetchedAtMs).toBeGreaterThan(good.fetchedAtMs ?? 0)
    })

    it('lets nothing but a missing gh stop a pass: a signed-out auth status still fetches', async () => {
      plantBoth()
      fx.behave({ auth: 'unauthenticated' })
      const snapshot = await service.refresh()

      expect(callsOf(fx.calls(), 'auth', 'status')).toHaveLength(1)
      expect(callsOf(fx.calls(), 'pr', 'list')).toHaveLength(2)
      expect(numbersOf(snapshot, ALPHA)).toEqual([7, 9])
      expect(snapshot.gh.problem).toBeNull()
      expect(snapshot.gh.authenticated).toBe(true)
    })

    it('reports no gh binary as missing, naming cli.github.com and Settings', async () => {
      configure({ ghPath: join(world.root, 'nowhere', 'gh.exe') })
      const snapshot = await service.refresh()

      expect(snapshot.gh.problem?.kind).toBe('missing')
      expect(snapshot.gh.problem?.message).toContain('cli.github.com')
      expect(snapshot.gh.problem?.message).toContain('Settings')
      expect(fx.calls()).toEqual([])
    })

    it('reports output that is not JSON on each repository, keeps the rows, and recovers on the next pass', async () => {
      plantBoth()
      await service.refresh()

      fx.behave({ list: 'invalid-json' })
      const broken = await service.refresh()
      expect(repoOf(broken, ALPHA)?.error).toMatch(/not JSON/)
      expect(repoOf(broken, BETA)?.error).toMatch(/not JSON/)
      expect(numbersOf(broken, ALPHA)).toEqual([7, 9])
      expect(service.passes().failed).toBe(0)

      fx.behave({})
      const back = await service.refresh()
      expect(repoOf(back, ALPHA)?.error).toBeNull()
      expect(back.gh.problem).toBeNull()
    })
  })

  describe('one pull request', () => {
    const PATCH = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const a = 1',
      '+export const b = 2',
      'diff --git a/src/old.ts b/src/old.ts',
      'index 2222222..3333333 100644',
      '--- a/src/old.ts',
      '+++ b/src/old.ts',
      '@@ -1,3 +1,3 @@ function compute()',
      ' const keep = 1',
      '-const gone = 2',
      '+const here = 3',
      ' const tail = 4',
      ''
    ].join('\n')

    const VIEW = ghView({
      body: '**bold** words <script>alert(1)</script>',
      comments: [
        {
          id: 'IC_1',
          author: { login: 'mona', is_bot: false },
          authorAssociation: 'MEMBER',
          body: 'Looks **fine**',
          createdAt: hoursAgo(3),
          url: 'https://github.com/Acme/Alpha/pull/7#issuecomment-1'
        }
      ],
      reviews: [
        {
          id: 'PRR_1',
          author: { login: 'hubot', is_bot: false },
          authorAssociation: 'COLLABORATOR',
          state: 'APPROVED',
          body: 'Ship it',
          submittedAt: hoursAgo(2)
        }
      ],
      commits: [
        {
          oid: 'a'.repeat(40),
          messageHeadline: 'Add new.ts',
          authors: [{ login: 'octocat', name: 'Octo Cat' }],
          committedDate: hoursAgo(5),
          authoredDate: hoursAgo(5)
        },
        {
          oid: 'b'.repeat(40),
          messageHeadline: 'Change old.ts',
          authors: [{ login: 'octocat', name: 'Octo Cat' }],
          committedDate: hoursAgo(4),
          authoredDate: hoursAgo(4)
        }
      ],
      files: [
        { path: 'src/new.ts', additions: 2, deletions: 0 },
        { path: 'src/old.ts', additions: 1, deletions: 1 },
        { path: 'assets/logo.png', additions: 0, deletions: 0 }
      ]
    })

    it('paints the header, commits and files gh has, lays the patch over the file list by path, and caches the patch', async () => {
      fx.list(ALPHA, [ghPull(ALPHA, 7, { title: 'Seven', changedFiles: 3, additions: 3, deletions: 1 })])
      fx.view(ALPHA, 7, VIEW)
      fx.diff(ALPHA, 7, PATCH)
      await service.refresh()

      const view = await service.detail({ repoPath: world.projects.alpha, number: 7 })
      expect(view.cached).toBe(false)
      expect(view.slug).toBe(ALPHA)
      expect(view.summary).toMatchObject({ number: 7, title: 'Seven', changedFiles: 3, additions: 3, deletions: 1 })
      expect(view.detail.commits.map((commit) => commit.oid)).toEqual(['a'.repeat(40), 'b'.repeat(40)])

      const [added, modified, unpatched] = view.files
      expect(view.files.map((file) => file.path)).toEqual(['src/new.ts', 'src/old.ts', 'assets/logo.png'])
      expect(added?.status).toBe('added')
      expect(added?.hunks[0]?.lines.map((line) => line.kind)).toEqual(['add', 'add'])
      expect(modified?.status).toBe('modified')
      expect(modified?.hunks[0]?.header).toBe('@@ -1,3 +1,3 @@ function compute()')
      expect(modified?.hunks[0]?.lines.map((line) => [line.kind, line.text])).toEqual([
        ['context', 'const keep = 1'],
        ['del', 'const gone = 2'],
        ['add', 'const here = 3'],
        ['context', 'const tail = 4']
      ])
      // On GitHub's list and not in the patch: still a row, with nothing to expand.
      expect(unpatched?.hunks).toEqual([])
      expect(view.diffNote).toBeNull()

      expect(core.readPull(store, ALPHA, 7)?.diff?.text).toBe(PATCH)

      // The second open is the cache, with no gh behind it.
      const views = callsOf(fx.calls(), 'pr', 'view').length
      const again = await service.detail({ repoPath: world.projects.alpha, number: 7 })
      expect(again.cached).toBe(true)
      expect(callsOf(fx.calls(), 'pr', 'view')).toHaveLength(views)
      expect(again.files.map((file) => file.status)).toEqual(['added', 'modified', 'modified'])
    })

    it('renders markdown to sanitised HTML in main', async () => {
      fx.list(ALPHA, [ghPull(ALPHA, 7)])
      fx.view(ALPHA, 7, VIEW)
      fx.diff(ALPHA, 7, PATCH)
      await service.refresh()

      const view = await service.detail({ repoPath: world.projects.alpha, number: 7 })
      expect(view.bodyHtml).toContain('<strong>bold</strong>')
      expect(view.bodyHtml).not.toContain('<script')
      const comment = view.conversation.find((item) => item.kind === 'comment')
      expect(comment?.kind === 'comment' && comment.html).toContain('<strong>fine</strong>')
    })

    it('counts what each ceiling cut: lines past a file’s limit, and a patch past the size Helm fetches', async () => {
      const lines = 1_250
      const long = [
        'diff --git a/gen/long.ts b/gen/long.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/gen/long.ts',
        `@@ -0,0 +1,${String(lines)} @@`,
        ...Array.from({ length: lines }, (_, at) => `+line ${String(at)}`),
        ''
      ].join('\n')
      fx.list(ALPHA, [ghPull(ALPHA, 7), ghPull(ALPHA, 9)])
      fx.view(ALPHA, 7, ghView({ files: [{ path: 'gen/long.ts', additions: lines, deletions: 0 }] }))
      fx.diff(ALPHA, 7, long)
      await service.refresh()

      const view = await service.detail({ repoPath: world.projects.alpha, number: 7 })
      const file = view.files[0]
      const kept = (file?.hunks ?? []).reduce((sum, hunk) => sum + hunk.lines.length, 0)
      expect(file?.droppedLines).toBeGreaterThan(0)
      expect(kept + (file?.droppedLines ?? 0)).toBe(lines)

      // Past 2MB: cut, and said so.
      const huge = [
        'diff --git a/gen/huge.ts b/gen/huge.ts',
        '--- a/gen/huge.ts',
        '+++ b/gen/huge.ts',
        '@@ -1,40000 +1,40000 @@',
        ...Array.from({ length: 40_000 }, (_, at) => `+${'x'.repeat(60)} ${String(at)}`),
        ''
      ].join('\n')
      expect(huge.length).toBeGreaterThan(2 * 1024 * 1024)
      fx.view(ALPHA, 9, ghView({ files: [{ path: 'gen/huge.ts', additions: 40_000, deletions: 40_000 }] }))
      fx.diff(ALPHA, 9, huge)
      const capped = await service.detail({ repoPath: world.projects.alpha, number: 9 })
      expect(capped.diffNote).toMatch(/larger than the 2MB Helm fetches/)
    })
  })

  describe('review threads', () => {
    const plantNine = (threads: Parameters<GhFixture['threads']>[2] | null, body = 'A description.'): void => {
      fx.view(ALPHA, 9, ghView({ body, files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }] }))
      fx.diff(ALPHA, 9, '')
      if (threads !== null) fx.threads(ALPHA, 9, threads)
    }

    it('walks every page of threads and of a long thread’s replies, in order', async () => {
      fx.list(ALPHA, [ghPull(ALPHA, 9)])
      const start = Date.now() - 10 * 3_600_000
      const threads = Array.from({ length: 120 }, (_, at) =>
        ghThread(`T${String(at).padStart(3, '0')}`, 'src/a.ts', 1, {
          firstAt: start + at * 120_000,
          count: at === 5 ? 130 : 1
        })
      )
      plantNine(threads)
      await service.refresh()

      const view = await service.detail({ repoPath: world.projects.alpha, number: 9 })
      const painted = view.conversation.filter((item) => item.kind === 'thread')
      expect(painted.map((thread) => thread.id)).toEqual(threads.map((thread) => thread.id))
      const long = painted.find((thread) => thread.id === 'T005')
      expect(long?.kind === 'thread' && long.comments.map((comment) => comment.id)).toEqual(
        threads[5]?.comments.map((comment) => comment.id)
      )

      // Each page after the first was asked for from where the last one ended.
      const pages = callsOf(fx.calls(), 'api', 'graphql').filter((call) =>
        call.argv.some((arg) => arg.startsWith('number='))
      )
      const cursors = pages.map((call) => call.argv.find((arg) => arg.startsWith('cursor='))?.slice(7))
      expect(cursors[0]).toBeUndefined()
      expect(pages.length).toBeGreaterThan(1)
      const numeric = cursors.slice(1).map(Number)
      expect(numeric).toEqual([...numeric].sort((a, b) => a - b))
      expect(new Set(numeric).size).toBe(numeric.length)
    })

    it('says threads were never fetched for a detail cached before Helm read them, and one refresh settles it', async () => {
      fx.list(ALPHA, [ghPull(ALPHA, 9)])
      plantNine(null)
      await service.refresh()
      const cached: PullDetail = {
        body: 'Cached long ago.',
        comments: [],
        reviews: [],
        commits: [],
        files: [],
        checks: null,
        mergeStateStatus: 'CLEAN'
      }
      expect(core.writePullDetail(store, ALPHA, 9, cached)).toBe(true)

      const old = await service.detail({ repoPath: world.projects.alpha, number: 9 })
      expect(old.cached).toBe(true)
      expect(old.threadsNote).toMatch(/have not been fetched.*Refresh/)

      const fresh = await service.detail({ repoPath: world.projects.alpha, number: 9, refresh: true })
      expect(fresh.threadsNote).toBeNull()
      expect(core.readPull(store, ALPHA, 9)?.detail?.reviewThreads).toEqual([])
    })

    it('keeps everything it had when the thread query fails, says so with the reason, and clears on the next good fetch', async () => {
      fx.list(ALPHA, [ghPull(ALPHA, 9)])
      plantNine([ghThread('T1', 'src/a.ts', 1), ghThread('T2', 'src/a.ts', 1)])
      await service.refresh()
      const first = await service.detail({ repoPath: world.projects.alpha, number: 9 })
      expect(first.threadsNote).toBeNull()
      const threadsAt = first.threadsFetchedAtMs
      expect(threadsAt).not.toBeNull()

      plantNine(null, 'An edited description.')
      fx.behave({ threads: 'error', threadsError: 'HTTP 502: the fixture is unwell' })
      const failed = await service.detail({ repoPath: world.projects.alpha, number: 9, refresh: true })
      expect(failed.detail.body).toBe('An edited description.')
      expect(failed.conversation.filter((item) => item.kind === 'thread').map((thread) => thread.id)).toEqual([
        'T1',
        'T2'
      ])
      expect(failed.threadsNote).toMatch(/could not be re-read - HTTP 502: the fixture is unwell\. The 2 shown/)
      expect(failed.threadsFetchedAtMs).toBe(threadsAt)

      fx.behave({})
      const back = await service.detail({ repoPath: world.projects.alpha, number: 9, refresh: true })
      expect(back.threadsNote).toBeNull()
    })
  })
})
