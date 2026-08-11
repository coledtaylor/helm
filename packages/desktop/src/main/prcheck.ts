import { ipcMain, type BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fetchOpenPulls,
  forgetPrRepos,
  parseGitHubRemote,
  readSettings,
  replaceRepoPulls,
  type AppSettings,
  type PullSummary
} from '@helm/core'
import { screenshot, sleep } from './bridge'
import type { Check } from './fidelity'
import type { M2Context } from './m2check'
import type { Collector } from './m2check'
import { resolveGhCommand } from './gh-cli'

/**
 * The pull-request surface, driven through the real window.
 *
 * Five phases and one rule running through all of them: nothing GitHub says is
 * taken on Helm's word. Four of the phases answer from a `gh` this file wrote -
 * `scripts/fake-gh.mjs` behind a `.cmd` shim, aimed at the service with
 * `pointGh` - because the facts this milestone has to establish are facts a
 * real repository cannot be made to produce on demand: a pull request whose
 * title changes between two passes, an authentication that fails, a payload
 * that is not JSON, and a `pr checkout` whose invocation can be read back
 * argument by argument. The fifth phase runs the real one, and skips out loud
 * when the machine has no gh, no sign-in or no qualifying repository.
 *
 * The fixture is proved to **discriminate before its pass is believed**, which
 * is CLAUDE.md's hard rule and the reason M3-4 reported green for weeks: the
 * comparator is run against the pull requests as written, then the file on disk
 * is mutated underneath it and the *same* comparison must fail, and only then
 * is the clean result worth anything. Beside every claim about the pane there
 * is a read this file makes for itself - its own `JSON.parse` of the fixture,
 * its own read-only connection to `helm.db`, its own `git` and its own `gh`.
 *
 * Three things need saying about what it borrows. It runs against the user's
 * real database and real settings, because the claim is about the real ones, so
 * the settings it changes are written down before anything moves and put back
 * at the end - `scripts/run-prcheck.mjs` puts them back too if this process
 * dies first. It adds a scan root of fixture repositories and removes it again.
 * And the review phase spawns real `claude` sessions, which it closes.
 *
 * `pnpm pr-check` -> helm-data/pr-report.json
 */

const GROUPS = ['fixture', 'detail', 'review', 'degrade', 'live'] as const
type Group = (typeof GROUPS)[number]

/**
 * The fields this driver expects on the wire, written out rather than imported.
 *
 * `PR_LIST_FIELDS` exists and is exported for exactly this, and importing it
 * would make the assertion "the code agrees with itself". A field silently
 * dropped from the fetch is a column the pane paints from a default, which is
 * the failure this string is here to catch.
 */
const EXPECTED_LIST_FIELDS =
  'number,title,url,author,state,isDraft,headRefName,baseRefName,createdAt,updatedAt,additions,deletions,changedFiles,reviewDecision,labels'

const EXPECTED_VIEW_FIELDS = 'body,comments,reviews,commits,files,statusCheckRollup,mergeStateStatus'

/** The slugs the fixture answers for. Two hooked remotes and one real one. */
const SLUG_A = 'helm-fixture/alpha'
const SLUG_B = 'helm-fixture/beta'
const SLUG_REAL = 'helm-fixture/carto'

/** The pull request the detail and review phases work on. */
const PR_A = 42

/** Substituted into a comment body so the render pipeline has to have run. */
const BOLD_MARKER = 'ELEVENTEEN'

// ---------------------------------------------------------------------------
// The driver's own reads
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  try {
    return (await win.webContents.executeJavaScript(expression, true)) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`renderer expression failed: ${detail}\n${expression}`, { cause: err })
  }
}

const q = (selector: string): string => JSON.stringify(selector)

async function click(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return false; el.click(); return true })()`
  )
}

async function text(win: BrowserWindow, selector: string): Promise<string> {
  return js<string>(win, `(document.querySelector(${q(selector)})?.textContent ?? '').trim()`)
}

async function exists(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(win, `Boolean(document.querySelector(${q(selector)}))`)
}

async function attr(win: BrowserWindow, selector: string, name: string): Promise<string | null> {
  return js<string | null>(
    win,
    `(document.querySelector(${q(selector)})?.getAttribute(${q(name)}) ?? null)`
  )
}

/** Every value of a `data-` attribute currently in the document. */
async function dataValues(win: BrowserWindow, name: string): Promise<string[]> {
  return js<string[]>(
    win,
    `[...document.querySelectorAll('[data-${name}]')].map((el) => el.getAttribute('data-${name}') ?? '')`
  )
}

/**
 * A fetch pass this driver asked for, rather than one it happened to join.
 *
 * `refresh` returns the pass already in flight when there is one - which is
 * right for the app, where two clicks on the refresh arrow are one fetch, and
 * wrong here: the app starts its own sweep as soon as the renderer is ready,
 * and a driver that awaited that one would be asserting on the answers of a
 * pass that ran before the fixtures existed. This cost an hour, so it is worth
 * the paragraph.
 */
async function refreshNow(
  pulls: M2Context['pulls'],
  request?: { repoPath: string }
): Promise<void> {
  const settled = async (): Promise<void> => {
    const deadline = Date.now() + 90_000
    while (pulls.snapshot().fetching && Date.now() < deadline) await sleep(200)
  }
  await settled()
  await pulls.refresh(request)
  await settled()
}

/**
 * Waits until the service is considering exactly `want` projects, and stays.
 *
 * "And stays" is the whole point: a scan started before the roots changed
 * overwrites `lastScan` when it finishes, so a count that is right once may be
 * wrong a second later. Five consecutive agreeing reads is what makes it a
 * settled state rather than a moment.
 */
async function stableProjectCount(
  pulls: M2Context['pulls'],
  want: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let agreed = 0
  for (;;) {
    agreed = pulls.snapshot().checked === want ? agreed + 1 : 0
    if (agreed >= 5) return true
    if (Date.now() > deadline) return false
    await sleep(500)
  }
}

async function pollJs(win: BrowserWindow, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await js<boolean>(win, `Boolean(${expression})`).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(200)
  }
}

/**
 * A settings write sent through the real channel.
 *
 * The route the pane's own controls take - preload, contract, handler - so a
 * rejection here is the rejection a caller would get. Resolved either way.
 */
async function sendWrite(
  win: BrowserWindow,
  patch: Record<string, unknown>
): Promise<{ accepted: boolean; error: string }> {
  return js<{ accepted: boolean; error: string }>(
    win,
    `window.helm.invoke('settings:write', ${JSON.stringify(patch)})
       .then(() => ({ accepted: true, error: '' }))
       .catch((err) => ({ accepted: false, error: String(err && err.message ? err.message : err) }))`
  )
}

/** `pr:review` invoked by hand, with whatever payload this driver wants to try. */
async function sendReview(
  win: BrowserWindow,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; prompt: string; checkedOut: string | null; name: string; error: string }> {
  return js(
    win,
    `window.helm.invoke('pr:review', ${JSON.stringify(payload)})
       .then((r) => ({ ok: true, prompt: r.prompt, checkedOut: r.checkedOut, name: r.session.name, error: '' }))
       .catch((err) => ({ ok: false, prompt: '', checkedOut: null, name: '',
                          error: String(err && err.message ? err.message : err) }))`
  )
}

/** Focus a field, replace what is in it, and commit with Enter. */
async function typeInto(win: BrowserWindow, selector: string, value: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true })()`
  )
}

/** Set a `<select>` and let React hear about it. See `settingscheck.ts`. */
async function chooseOption(
  win: BrowserWindow,
  selector: string,
  value: string
): Promise<{ found: boolean; offered: boolean }> {
  return js<{ found: boolean; offered: boolean }>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return { found: false, offered: false };
      const wanted = ${JSON.stringify(value)};
      const offered = [...el.options].some((o) => o.value === wanted);
      const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      set.call(el, wanted);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, offered } })()`
  )
}

/** One session row, out of this driver's own read-only connection to the file. */
interface SessionRow {
  id: number
  name: string
  cwd: string
  projectPath: string | null
  argv: string[]
  startedAt: string
  startedAtMs: number
}

function sessionRows(dbFile: string): SessionRow[] {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(
        'SELECT id, name, cwd, project_path AS projectPath, argv, started_at AS startedAt FROM sessions ORDER BY id'
      )
      .all() as Array<{
      id: number
      name: string
      cwd: string
      projectPath: string | null
      argv: string
      startedAt: string
    }>
    return rows.map((row) => ({
      ...row,
      argv: JSON.parse(row.argv) as string[],
      startedAtMs: Date.parse(row.startedAt)
    }))
  } finally {
    db.close()
  }
}

/** The cached pull requests for one slug, read out of the database file. */
function pullRowsFor(dbFile: string, slug: string): Array<{ number: number; title: string }> {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare('SELECT number, summary FROM pull_requests WHERE slug = ? ORDER BY number')
      .all(slug) as Array<{ number: number; summary: string }>
    return rows.map((row) => ({
      number: row.number,
      title: (JSON.parse(row.summary) as { title: string }).title
    }))
  } finally {
    db.close()
  }
}

/** The `pr_repos` row for one directory, the same way. */
function repoRowFor(dbFile: string, path: string): { url: string | null; slug: string | null } | null {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare('SELECT path, url, slug FROM pr_repos').all() as Array<{
      path: string
      url: string | null
      slug: string | null
    }>
    const found = rows.find((row) => row.path.toLowerCase() === path.toLowerCase())
    return found === undefined ? null : { url: found.url, slug: found.slug }
  } finally {
    db.close()
  }
}

/**
 * This driver's own template substitution.
 *
 * Deliberately not `renderPullPrompt`. The claim under test is that the argv a
 * session was launched with matches the prompt the template describes, and
 * comparing Helm's rendering against Helm's rendering would be an assertion
 * that the function is deterministic.
 */
function renderHere(template: string, facts: Record<string, string>): string {
  let out = ''
  let at = 0
  for (;;) {
    const open = template.indexOf('{', at)
    if (open < 0) break
    const close = template.indexOf('}', open)
    if (close < 0) break
    const name = template.slice(open + 1, close)
    const value = facts[name]
    out += template.slice(at, open) + (value === undefined ? `{${name}}` : value)
    at = close + 1
  }
  return out + template.slice(at)
}

/** `git`, run by this driver, in a directory of its own making. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
}

/** The branch git says the tree is on, asked of git rather than of Helm. */
function branchOf(cwd: string): string | null {
  try {
    return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  dir: string
  /** The fake gh's directory: behaviour, payloads and the invocation log. */
  home: string
  /** The `.cmd` shim `pointGh` is aimed at. */
  shim: string
  /** A scan root holding the three fixture projects. Added, then removed. */
  scanRoot: string
  alpha: string
  beta: string
  /** A real git repository with a real `origin`, in a path with a space. */
  real: string
}

/** One pull request, as `gh pr list --json` prints it. */
function listEntry(options: {
  number: number
  title: string
  slug: string
  head: string
  author?: string
  isDraft?: boolean
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
  reviewDecision?: string
}): Record<string, unknown> {
  return {
    number: options.number,
    title: options.title,
    url: `https://github.com/${options.slug}/pull/${String(options.number)}`,
    author: { login: options.author ?? 'fixture-author', is_bot: false },
    state: 'OPEN',
    isDraft: options.isDraft ?? false,
    headRefName: options.head,
    baseRefName: 'main',
    createdAt: '2026-08-01T09:00:00Z',
    updatedAt: options.updatedAt,
    additions: options.additions,
    deletions: options.deletions,
    changedFiles: options.changedFiles,
    reviewDecision: options.reviewDecision ?? '',
    labels: [{ name: 'fixture' }]
  }
}

/**
 * The last run's fixtures, including the git repository in them.
 *
 * `rmSync` with `force` is not enough here and the reason is git's: everything
 * under `.git/objects` is written read-only, and `unlink` of a read-only file
 * on Windows is EPERM rather than a deletion. So the attribute comes off first.
 * Without this the second run of this driver fails before its first check.
 */
function hardRemove(dir: string): void {
  if (!existsSync(dir)) return
  try {
    execFileSync(
      process.env['COMSPEC'] ?? 'cmd.exe',
      ['/c', 'attrib', '-R', join(dir, '*'), '/S', '/D'],
      { windowsHide: true, stdio: 'ignore', timeout: 60_000 }
    )
  } catch {
    // Nothing to clear, or no attrib - the removal below reports either way.
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

function buildFixtures(dataDir: string): Fixtures {
  const dir = join(dataDir, 'pr-fixtures')
  hardRemove(dir)

  const home = join(dir, 'gh-home')
  mkdirSync(join(home, 'list'), { recursive: true })
  mkdirSync(join(home, 'view'), { recursive: true })

  // Spaces on purpose, in the scan root and in a project under it: Windows
  // first, and every path Helm stores has to survive one.
  const scanRoot = join(dir, 'scan root')
  const alpha = join(scanRoot, 'alpha one')
  const beta = join(scanRoot, 'beta-two')
  const real = join(scanRoot, 'carto graph')
  for (const path of [alpha, beta, real]) mkdirSync(join(path, '.claude'), { recursive: true })

  writeFileSync(
    join(home, 'list', `${SLUG_A.replace('/', '__')}.json`),
    JSON.stringify(
      [
        listEntry({
          number: PR_A,
          title: 'Teach the sweeper about forks',
          slug: SLUG_A,
          head: 'feature/forks',
          updatedAt: '2026-08-10T18:30:00Z',
          additions: 412,
          deletions: 96,
          changedFiles: 7,
          reviewDecision: 'CHANGES_REQUESTED'
        }),
        listEntry({
          number: 41,
          title: 'A draft nobody has finished',
          slug: SLUG_A,
          head: 'wip/draft',
          isDraft: true,
          updatedAt: '2026-08-09T11:00:00Z',
          additions: 12,
          deletions: 3,
          changedFiles: 2
        }),
        listEntry({
          number: 7,
          title: 'Bump the fixture dependency',
          slug: SLUG_A,
          head: 'deps/bump',
          author: 'app/dependabot',
          updatedAt: '2026-08-08T04:15:00Z',
          additions: 4,
          deletions: 4,
          changedFiles: 1,
          reviewDecision: 'APPROVED'
        })
      ],
      null,
      2
    )
  )

  writeFileSync(
    join(home, 'list', `${SLUG_B.replace('/', '__')}.json`),
    JSON.stringify(
      [
        listEntry({
          number: 3,
          title: 'One pull request, in a second repository',
          slug: SLUG_B,
          head: 'beta/one',
          updatedAt: '2026-08-07T08:00:00Z',
          additions: 30,
          deletions: 1,
          changedFiles: 3
        })
      ],
      null,
      2
    )
  )

  writeFileSync(
    join(home, 'list', `${SLUG_REAL.replace('/', '__')}.json`),
    JSON.stringify(
      [
        listEntry({
          number: 9,
          title: 'Something to check out',
          slug: SLUG_REAL,
          head: 'review/checkout-me',
          updatedAt: '2026-08-11T07:45:00Z',
          additions: 5,
          deletions: 0,
          changedFiles: 1
        })
      ],
      null,
      2
    )
  )

  // The detail. The bold marker in a comment is what proves the markdown
  // pipeline ran: `**ELEVENTEEN**` in the fixture has to be a `<strong>` in the
  // DOM, and no amount of passing the string through would produce one.
  writeFileSync(
    join(home, 'view', `${SLUG_A.replace('/', '__')}__${String(PR_A)}.json`),
    JSON.stringify(
      {
        body: '## What this does\n\nIt teaches the sweeper about forks.\n',
        comments: [
          {
            id: 'IC_fixture_1',
            author: { login: 'reviewer-one', is_bot: false },
            authorAssociation: 'MEMBER',
            body: `This is **${BOLD_MARKER}** important.`,
            createdAt: '2026-08-10T12:00:00Z',
            url: `https://github.com/${SLUG_A}/pull/${String(PR_A)}#issuecomment-1`
          }
        ],
        reviews: [
          {
            id: 'PRR_fixture_1',
            author: { login: 'reviewer-two', is_bot: false },
            authorAssociation: 'COLLABORATOR',
            state: 'CHANGES_REQUESTED',
            body: 'Two things.',
            submittedAt: '2026-08-10T13:00:00Z'
          }
        ],
        commits: [
          {
            oid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            messageHeadline: 'Teach the sweeper about forks',
            authors: [{ login: 'fixture-author', name: 'Fixture Author' }],
            committedDate: '2026-08-10T10:00:00Z'
          },
          {
            oid: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890',
            messageHeadline: 'And a second commit',
            authors: [
              { login: 'fixture-author', name: 'Fixture Author' },
              { login: 'co-author', name: 'Co Author' }
            ],
            committedDate: '2026-08-10T11:00:00Z'
          }
        ],
        files: [
          { path: 'packages/core/src/github/remote.ts', additions: 210, deletions: 40 },
          { path: 'packages/core/src/github/parse.ts', additions: 180, deletions: 50 },
          { path: 'README.md', additions: 22, deletions: 6 }
        ],
        statusCheckRollup: [
          { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
          { __typename: 'StatusContext', state: 'FAILURE' }
        ],
        mergeStateStatus: 'BLOCKED'
      },
      null,
      2
    )
  )

  // The checkout repository's detail. Thin on purpose - the detail phase does
  // its assertions against alpha, and this exists so the review island's button
  // can become enabled, which it only does once the pull request has arrived.
  writeFileSync(
    join(home, 'view', `${SLUG_REAL.replace('/', '__')}__9.json`),
    JSON.stringify(
      {
        body: 'A pull request to check out.\n',
        comments: [],
        reviews: [],
        commits: [
          {
            oid: 'c3d4e5f60718293a4b5c6d7e8f90123456789012',
            messageHeadline: 'Something to check out',
            authors: [{ login: 'fixture-author', name: 'Fixture Author' }],
            committedDate: '2026-08-11T07:40:00Z'
          }
        ],
        files: [{ path: 'README.md', additions: 5, deletions: 0 }],
        statusCheckRollup: [],
        mergeStateStatus: 'CLEAN'
      },
      null,
      2
    )
  )

  writeBehaviour(home, { auth: 'ok', list: 'ok' })

  // The real repository: a real `git init`, a real commit and a real origin, so
  // the remote-mapping path can be exercised with the fixture hook switched
  // off. Identity on the command line rather than from the machine's config -
  // a driver must not need one and must not write one.
  writeFileSync(join(real, 'README.md'), '# carto graph\n\nA fixture repository.\n')
  writeFileSync(join(real, '.claude', 'settings.json'), '{}\n')
  git(real, ['init', '-b', 'main'])
  git(real, ['add', '-A'])
  git(real, [
    '-c',
    'user.email=pr-check@helm.invalid',
    '-c',
    'user.name=pr-check',
    'commit',
    '-m',
    'The fixture, as committed'
  ])
  git(real, ['remote', 'add', 'origin', `https://github.com/${SLUG_REAL}.git`])

  const shim = writeShim(dir, home)
  return { dir, home, shim, scanRoot, alpha, beta, real }
}

/** What the fake gh should do next time. Re-read by it per invocation. */
function writeBehaviour(home: string, how: Record<string, string>): void {
  writeFileSync(join(home, 'behaviour.json'), JSON.stringify(how, null, 2))
}

/**
 * The `.cmd` in front of the fake gh.
 *
 * A batch shim and not the script directly, because that is the shape a real
 * one has on Windows: scoop and npm both install `gh` as a `.cmd`,
 * `CreateProcess` cannot execute one, and `resolveGhCommand` has a branch that
 * routes it through `cmd.exe /c`. Pointing the service straight at a `.exe`
 * would leave that branch - the one that actually breaks - unexercised.
 *
 * Electron's own binary is the interpreter, under `ELECTRON_RUN_AS_NODE`: it is
 * the one node this process can be certain exists.
 */
function writeShim(dir: string, home: string): string {
  const script = join(dir, 'fake-gh.mjs')
  writeFileSync(script, readFileSync(fakeGhSource(), 'utf8'))

  const shim = join(dir, 'gh.cmd')
  writeFileSync(
    shim,
    [
      '@echo off',
      'setlocal',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `set "HELM_FAKE_GH_HOME=${home}"`,
      `"${process.execPath}" "${script}" %*`,
      'exit /b %ERRORLEVEL%',
      ''
    ].join('\r\n')
  )
  return shim
}

/**
 * `scripts/fake-gh.mjs`, wherever this build is running from.
 *
 * Copied into the fixture directory rather than run in place, so the shim
 * carries one absolute path that cannot move: a packaged build has no
 * `scripts/` beside it, and the checkout's layout is not something a driver
 * should assume twice.
 */
function fakeGhSource(): string {
  const candidates = [
    join(process.cwd(), 'scripts', 'fake-gh.mjs'),
    join(process.cwd(), 'packages', 'desktop', 'scripts', 'fake-gh.mjs'),
    join(__dirname, '..', '..', 'scripts', 'fake-gh.mjs')
  ]
  const found = candidates.find((path) => existsSync(path))
  if (found === undefined) {
    throw new Error(`fake-gh.mjs is not beside this build - looked in ${candidates.join(', ')}`)
  }
  return found
}

/** Every call the fake gh has been given, as it wrote them down. */
interface Invocation {
  at: number
  argv: string[]
  cwd: string
  exit?: number
}

function invocations(home: string): Invocation[] {
  const file = join(home, 'invocations.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Invocation)
}

function forgetInvocations(home: string): void {
  rmSync(join(home, 'invocations.jsonl'), { force: true })
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runPrChecks(
  ctx: M2Context,
  collector: Collector,
  shotDir: string,
  dataDir: string,
  only?: readonly string[]
): Promise<Check[]> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const run = (group: Group): boolean => wanted.has(group)
  const checks: Check[] = []
  const { win, services, pulls, sessions } = ctx
  const dbFile = services.store.file

  const fixtures = buildFixtures(dataDir)

  /**
   * The settings as found, written down before anything is touched.
   *
   * This borrows the real database, so the restore is not optional and is not
   * conditional on the run passing. Anything of this driver's own is scrubbed
   * out first: a run killed before its restore must not leave a fixture root to
   * be carried forward into the next one.
   */
  const asFound = readSettings(services.store)
  const mine = (path: string): boolean =>
    path.toLowerCase().startsWith(fixtures.dir.toLowerCase())
  const original: AppSettings = {
    ...asFound,
    scanRoots: asFound.scanRoots.filter((root) => !mine(root))
  }
  writeFileSync(join(dataDir, 'pr-original.json'), JSON.stringify(original, null, 2))

  /** Sessions this driver started, ended before it reports. */
  const started: number[] = []
  collector.answerWith(true)

  try {
    await sleep(800)

    // ---------------------------------------------------------------------
    // Fixtures on the machine: a scan root of three repositories, and a gh
    // ---------------------------------------------------------------------
    const rootsWritten = await sendWrite(win, {
      // The fixture root and nothing else, deliberately. Leaving the real roots
      // in would put a dozen of the user's own repositories in front of a `gh`
      // that has never heard of them, and every one of them would carry an
      // error row - which is noise in the pane the fixture phase is counting
      // and a false positive in the degrade phase, which counts error rows on
      // purpose. Put back in the `finally`.
      scanRoots: [fixtures.scanRoot],
      // Off: a tick landing in the middle of a phase would refresh underneath
      // an assertion. Every fetch in this run is one this driver asked for.
      prPollMinutes: 0,
      prReviewPrompt: '/code-review {number}',
      prCheckout: 'none'
    })
    if (!rootsWritten.accepted) {
      // Loudly, and before any check runs: everything below is about fixture
      // repositories that discovery has to be able to see, and a run against an
      // empty pane would report a wall of failures with one cause.
      throw new Error(`the fixture scan root was refused: ${rootsWritten.error}`)
    }
    const scan = `window.helm.invoke('discovery:scan', { includeGit: true })`
    await js(win, scan)
    await pollJs(
      win,
      `[...document.querySelectorAll('aside button[title]')].some((b) => b.title === ${JSON.stringify(fixtures.alpha)})`,
      20_000
    )
    // A second scan, after any scan that was already running with the *old*
    // roots has had time to land. The app starts one as soon as the renderer is
    // ready and `services.lastScan` is last-writer-wins, so without this the
    // fixture root can be replaced by the user's own roots a second after it
    // was set - and every fetch below would go to a repository the fake gh has
    // never heard of. The wait after it is for the same reason and is what
    // actually settles it.
    await sleep(1500)
    await js(win, scan)
    const projectsSettled = await stableProjectCount(pulls, 3, 60_000)
    if (!projectsSettled) {
      throw new Error(
        `discovery did not settle on the three fixture projects - it is considering ${String(pulls.snapshot().checked)}`
      )
    }

    /**
     * The pull-request cache, emptied now that discovery is settled.
     *
     * The fixture directory is rebuilt on every run and the database is not, so
     * a second run would start with the previous run's repositories still
     * mapped and their pull requests still cached - and the sidebar total,
     * which the fixture phase checks against its own count of the fixture
     * files, would be right on a cold machine and wrong on a warm one. A check
     * whose answer depends on whether it has been run before is not a check.
     * Both tables are caches with a fetch behind them.
     */
    forgetPrRepos(services.store, [])
    for (const slug of [SLUG_A, SLUG_B, SLUG_REAL]) {
      replaceRepoPulls(services.store, slug, [], new Date().toISOString())
    }

    pulls.pointGh(fixtures.shim)
    pulls.pointPollMs(0)
    // Two of the three remotes come from the hook and the third does not - see
    // the F-4 check, which turns the hook off and makes git answer for itself.
    pulls.pointRemotes({
      [fixtures.alpha]: `https://github.com/${SLUG_A}.git`,
      [fixtures.beta]: `git@github.com:${SLUG_B}.git`
    })

    if (run('fixture')) {
      checks.push(...(await fixtureChecks({ win, pulls, dbFile, fixtures, shotDir })))
    }

    // From here on every repository is mapped, the real one included, so a
    // whole-machine refresh keeps all three.
    pulls.pointRemotes({
      [fixtures.alpha]: `https://github.com/${SLUG_A}.git`,
      [fixtures.beta]: `git@github.com:${SLUG_B}.git`,
      [fixtures.real]: `https://github.com/${SLUG_REAL}.git`
    })
    await refreshNow(pulls)

    if (run('detail')) {
      checks.push(...(await detailChecks({ win, fixtures, shotDir })))
    }

    if (run('review')) {
      checks.push(
        ...(await reviewChecks({ ctx, win, sessions, dbFile, fixtures, shotDir, started }))
      )
    }

    if (run('degrade')) {
      checks.push(...(await degradeChecks({ win, pulls, dbFile, fixtures, shotDir })))
    }

    if (run('live')) {
      checks.push(...(await liveChecks({ roots: original.scanRoots })))
    }
  } finally {
    // -------------------------------------------------------------------
    // Put the machine back
    // -------------------------------------------------------------------
    for (const id of started) {
      await sessions.close({ id, force: true }).catch(() => ({ closed: false }))
    }
    pulls.pointGh(null)
    pulls.pointRemotes(null)
    pulls.pointPollMs(null)
    // The fixture repositories' cached pull requests, dropped by the same
    // delete-then-insert the sweep uses. `pr_repos` rows go with the scan root.
    for (const slug of [SLUG_A, SLUG_B, SLUG_REAL]) {
      try {
        replaceRepoPulls(services.store, slug, [], new Date().toISOString())
      } catch {
        // A database already closed is not a reason to fail a restore.
      }
    }
    await sendWrite(win, original as unknown as Record<string, unknown>).catch(() => null)
    await js(win, `window.helm.invoke('discovery:scan', { includeGit: false })`).catch(() => null)
  }

  return checks
}

// ---------------------------------------------------------------------------
// fixture - the comparator has to fail before its pass is worth anything
// ---------------------------------------------------------------------------

async function fixtureChecks({
  win,
  pulls,
  dbFile,
  fixtures,
  shotDir
}: {
  win: BrowserWindow
  pulls: M2Context['pulls']
  dbFile: string
  fixtures: Fixtures
  shotDir: string
}): Promise<Check[]> {
  const checks: Check[] = []
  const listFile = join(fixtures.home, 'list', `${SLUG_A.replace('/', '__')}.json`)

  /** The fixture as this driver reads it, not as Helm reports it. */
  const readFixture = (): Array<{ number: number; title: string }> =>
    (JSON.parse(readFileSync(listFile, 'utf8')) as Array<{ number: number; title: string }>).map(
      (entry) => ({ number: entry.number, title: entry.title })
    )

  /**
   * The comparator, run against an expectation handed to it.
   *
   * Passing the expectation in rather than re-reading the file is what makes
   * the mutation test possible: the same function is asked twice about the same
   * expected rows, once when the fixture agrees with them and once when it does
   * not, and a comparator that cannot fail the second time is a comparator that
   * proves nothing the first.
   */
  const compare = async (
    expected: Array<{ number: number; title: string }>
  ): Promise<{
    ok: boolean
    dom: string[]
    db: Array<{ number: number; title: string }>
    sidebar: string
    expected: Array<{ number: number; title: string }>
  }> => {
    const dom = await dataValues(win, 'pull')
    const db = pullRowsFor(dbFile, SLUG_A)
    const sidebar = await text(win, '[data-open-pulls]')

    const wantedRows = expected.map((pull) => `${SLUG_A}#${String(pull.number)}`).sort()
    const domForA = dom.filter((value) => value.startsWith(`${SLUG_A}#`)).sort()
    const sameDom = JSON.stringify(domForA) === JSON.stringify(wantedRows)
    const sameDb =
      JSON.stringify([...db].sort((a, b) => a.number - b.number)) ===
      JSON.stringify([...expected].sort((a, b) => a.number - b.number))
    // One repository has one pull request and the other has three, so the
    // sidebar's total is a fact about both fetches rather than about one.
    const sameCount = sidebar.includes(`${String(expected.length + 1)} open`)

    return { ok: sameDom && sameDb && sameCount, dom: domForA, db, sidebar, expected }
  }

  const written = readFixture()
  /** The bytes as built, kept so the mutation can be undone exactly. */
  const asBuilt = readFileSync(listFile, 'utf8')
  await refreshNow(pulls)
  await click(win, '[data-open-pulls]')
  await pollJs(win, `document.querySelector('[data-pulls-caption]')`, 10_000)
  await sleep(400)
  const clean = await compare(written)

  // The mutation. Two different kinds of difference, because a comparator can
  // be blind to one and not the other: a row that disappears and a row whose
  // title moved.
  const mutated = JSON.parse(readFileSync(listFile, 'utf8')) as Array<Record<string, unknown>>
  const dropped = mutated.filter((entry) => entry['number'] !== 41)
  const first = dropped[0]
  if (first !== undefined) first['title'] = 'A title the driver never wrote down'
  writeFileSync(listFile, JSON.stringify(dropped, null, 2))

  await refreshNow(pulls)
  await sleep(400)
  const againstMutation = await compare(written)

  // And back, byte for byte, so everything after this phase is looking at the
  // fixture as it was built rather than at a re-serialisation of it.
  writeFileSync(listFile, asBuilt)
  await refreshNow(pulls)
  await sleep(400)
  const restored = await compare(written)

  const shot = await screenshot(win, shotDir, 'pr-fixture-pane.png')

  checks.push({
    id: 'PR-1',
    criterion: '`pnpm pr-check` green, including the mutated-fixture failure proving the fixture discriminates',
    title: 'The comparator fails against a mutated fixture, and only then is its pass believed',
    ok: clean.ok && !againstMutation.ok && restored.ok,
    detail: {
      expected: written,
      clean: { ok: clean.ok, dom: clean.dom, db: clean.db, sidebar: clean.sidebar },
      afterMutation: {
        ok: againstMutation.ok,
        dom: againstMutation.dom,
        db: againstMutation.db,
        sidebar: againstMutation.sidebar
      },
      restored: { ok: restored.ok, dom: restored.dom, db: restored.db },
      mutation: 'pull request 41 removed and the first title rewritten',
      screenshot: shot.file
    },
    notes: [
      'CLAUDE.md: a check that can pass with no evidence behind it is worse than no check.',
      'M3-4 compared a session\'s answer against a fixture heading, the fixture went missing,',
      'the expected token became the empty string, and every answer matched for weeks.',
      'So the fixture is mutated underneath the same comparison first: one pull request',
      'removed and one title rewritten. That comparison must fail, and it is the same',
      'function with the same expectation - not a second, more careful one.',
      'Three independent reads stand behind each pass: this driver\'s own JSON.parse of the',
      'fixture file, the DOM rows the pane painted, and the `pull_requests` table read',
      'through a separate read-only connection to helm.db.'
    ]
  })

  // -----------------------------------------------------------------------
  // PR-2: the argv gh was actually given
  // -----------------------------------------------------------------------
  const calls = invocations(fixtures.home)
  const listCalls = calls.filter((call) => call.argv[0] === 'pr' && call.argv[1] === 'list')
  const forA = listCalls.find((call) => call.argv.includes(SLUG_A))
  const argv = forA?.argv ?? []
  const jsonAt = argv.indexOf('--json')
  const fields = jsonAt >= 0 ? (argv[jsonAt + 1] ?? '') : ''

  checks.push({
    id: 'PR-2',
    criterion: 'Fetches use `--repo <slug>` and ask for every field the surface paints',
    title: `gh was given ${String(fields.split(',').length)} fields and a --repo, not a working directory`,
    ok:
      forA !== undefined &&
      argv.includes('--repo') &&
      argv[argv.indexOf('--repo') + 1] === SLUG_A &&
      argv.includes('--state') &&
      argv[argv.indexOf('--state') + 1] === 'open' &&
      fields === EXPECTED_LIST_FIELDS &&
      calls.some((call) => call.argv[0] === 'auth' && call.argv[1] === 'status') &&
      calls.some((call) => call.argv[0] === '--version'),
    detail: {
      listCallArgv: argv,
      fieldsAsked: fields,
      fieldsExpected: EXPECTED_LIST_FIELDS,
      distinctListCalls: listCalls.length,
      askedAuth: calls.filter((c) => c.argv[0] === 'auth').length,
      askedVersion: calls.filter((c) => c.argv[0] === '--version').length
    },
    notes: [
      'The field list is written out in this driver rather than imported from',
      '`PR_LIST_FIELDS`, which would make the assertion "the code agrees with itself".',
      'A field quietly dropped from the fetch is a column the pane paints from a default.',
      '`--repo <slug>` rather than a working directory is what makes a fetch independent of',
      'where the process is standing; the invocation log is how that is checked rather than',
      'assumed.',
      'gh reached this driver through a .cmd shim, which is the shape scoop and npm install',
      'it in and the branch of `resolveGhCommand` that CreateProcess cannot run directly.'
    ]
  })

  // -----------------------------------------------------------------------
  // PR-3: a real remote, mapped without the hook
  // -----------------------------------------------------------------------
  pulls.pointRemotes(null)
  await refreshNow(pulls, { repoPath: fixtures.real })
  await sleep(400)

  const realRow = repoRowFor(dbFile, fixtures.real)
  const gitSaid = git(fixtures.real, ['remote', 'get-url', 'origin']).trim()
  const parsedHere = parseGitHubRemote(gitSaid)
  const rowsAfter = await dataValues(win, 'pull')

  checks.push({
    id: 'PR-3',
    criterion: 'The remote mapping is a real `git remote get-url origin`, in a path with spaces',
    title: `${gitSaid} mapped to ${realRow?.slug ?? 'nothing'} with the fixture hook off`,
    ok:
      realRow !== null &&
      realRow.slug === SLUG_REAL &&
      parsedHere?.slug === SLUG_REAL &&
      fixtures.real.includes(' ') &&
      rowsAfter.some((value) => value.startsWith(`${SLUG_REAL}#`)),
    detail: {
      repoPath: fixtures.real,
      gitReported: gitSaid,
      driverParsedTo: parsedHere?.slug ?? null,
      storedRow: realRow,
      domRows: rowsAfter.filter((value) => value.startsWith(`${SLUG_REAL}#`))
    },
    notes: [
      'The other two repositories are mapped through `pointRemotes`, which is a fixture hook.',
      'This one is not: `git init`, a real commit and a real `git remote add origin` in a',
      'directory whose path contains a space, with the hook switched off - so the path that',
      'spawns git, reads its answer and parses it is the path under test.',
      'The parse is checked against this driver\'s own `parseGitHubRemote` of the same string',
      'as well as against the stored row, because a row that agrees with itself proves only',
      'that something was written.'
    ]
  })

  // Everything after this phase wants the hook back; the caller re-points it.
  return checks
}

// ---------------------------------------------------------------------------
// detail - the tab, and proof the markdown pipeline ran
// ---------------------------------------------------------------------------

async function detailChecks({
  win,
  fixtures,
  shotDir
}: {
  win: BrowserWindow
  fixtures: Fixtures
  shotDir: string
}): Promise<Check[]> {
  const checks: Check[] = []

  const list = JSON.parse(
    readFileSync(join(fixtures.home, 'list', `${SLUG_A.replace('/', '__')}.json`), 'utf8')
  ) as Array<Record<string, unknown>>
  const view = JSON.parse(
    readFileSync(
      join(fixtures.home, 'view', `${SLUG_A.replace('/', '__')}__${String(PR_A)}.json`),
      'utf8'
    )
  ) as {
    commits: Array<{ oid: string }>
    files: Array<{ path: string }>
    comments: Array<{ id: string }>
  }
  const summary = list.find((entry) => entry['number'] === PR_A) ?? {}

  await click(win, '[data-open-pulls]')
  await pollJs(win, `document.querySelector('[data-pull]')`, 10_000)
  await click(win, `[data-pull="${SLUG_A}#${String(PR_A)}"]`)
  const opened = await pollJs(win, `document.querySelector('[data-pr-title]')`, 20_000)
  await sleep(800)

  const header = await js<Record<string, string | null>>(
    win,
    `({
       number: document.querySelector('[data-pr-number]')?.getAttribute('data-pr-number') ?? null,
       title: (document.querySelector('[data-pr-title]')?.textContent ?? '').trim(),
       state: document.querySelector('[data-pr-state]')?.getAttribute('data-pr-state') ?? null,
       branch: (document.querySelector('[data-pr-branch]')?.textContent ?? '').trim(),
       adds: (document.querySelector('[data-pr-adds]')?.textContent ?? '').trim(),
       dels: (document.querySelector('[data-pr-dels]')?.textContent ?? '').trim(),
       files: (document.querySelector('[data-pr-files]')?.textContent ?? '').trim(),
       checks: document.querySelector('[data-pr-checks]')?.getAttribute('data-pr-checks') ?? null
     })`
  )

  await click(win, '[data-pr-view="commits"]')
  await sleep(300)
  const commitsInDom = await dataValues(win, 'pr-commit')

  await click(win, '[data-pr-view="files"]')
  await sleep(300)
  const filesInDom = await dataValues(win, 'pr-file')
  const totals = await text(win, '[data-pr-file-total]')

  await click(win, '[data-pr-view="conversation"]')
  await sleep(400)

  const commentId = view.comments[0]?.id ?? ''
  const rendered = await js<{ strong: string | null; raw: boolean }>(
    win,
    `(() => { const el = document.querySelector('[data-pr-body=${JSON.stringify(commentId)}]');
      return { strong: el?.querySelector('strong')?.textContent ?? null,
               raw: (el?.textContent ?? '').includes('**') } })()`
  )

  const shot = await screenshot(win, shotDir, 'pr-detail.png')

  const expectedAdds = `+${String(summary['additions'] ?? '')}`
  const expectedDels = `−${String(summary['deletions'] ?? '')}`
  const expectedBranch = `${String(summary['headRefName'] ?? '')}→${String(summary['baseRefName'] ?? '')}`

  checks.push({
    id: 'PR-4',
    criterion: 'A pull request opens in a tab whose header, commits and files match the fixture',
    title: `#${String(PR_A)} painted ${String(commitsInDom.length)} commits and ${String(filesInDom.length)} files`,
    ok:
      opened &&
      header['number'] === String(PR_A) &&
      header['title'] === String(summary['title'] ?? '') &&
      header['state'] === 'open' &&
      header['branch'] === expectedBranch &&
      header['adds'] === expectedAdds &&
      header['dels'] === expectedDels &&
      header['files'] === `${String(summary['changedFiles'] ?? '')} files` &&
      // Three rollup entries: one passed, one still running, one legacy status
      // context that failed. Reduced to total/failing/pending, which is the
      // only claim this surface is allowed to make about a heterogeneous union.
      header['checks'] === '3/1/1' &&
      JSON.stringify(commitsInDom) === JSON.stringify(view.commits.map((c) => c.oid)) &&
      JSON.stringify(filesInDom) === JSON.stringify(view.files.map((f) => f.path)) &&
      totals === `${String(view.files.length)} files`,
    detail: {
      header,
      expected: {
        number: PR_A,
        title: summary['title'],
        branch: expectedBranch,
        adds: expectedAdds,
        dels: expectedDels,
        files: `${String(summary['changedFiles'] ?? '')} files`,
        checks: '3/1/1'
      },
      commitsInDom,
      commitsInFixture: view.commits.map((c) => c.oid),
      filesInDom,
      filesInFixture: view.files.map((f) => f.path),
      fileTotals: totals,
      viewFieldsExpected: EXPECTED_VIEW_FIELDS,
      screenshot: shot.file
    },
    notes: [
      'Every expected value is read out of the fixture file by this driver, not out of',
      'anything Helm holds - the header line is checked character for character, arrow and',
      'minus sign included, because those are the characters a pane composes rather than',
      'copies.',
      'The checks tally is the interesting one: `statusCheckRollup` is a GraphQL union whose',
      'members disagree about everything, and the fixture holds one CheckRun that passed, one',
      'still running and one legacy StatusContext that failed. 3/1/1 is the only claim that',
      'can be made about all three.'
    ]
  })

  checks.push({
    id: 'PR-5',
    criterion: 'Comment markdown is rendered in main and arrives as sanitised HTML',
    title: `A **${BOLD_MARKER}** in the fixture became a <strong> in the DOM`,
    ok: rendered.strong === BOLD_MARKER && !rendered.raw,
    detail: { rendered, commentId, marker: BOLD_MARKER },
    notes: [
      'The marker is a nonsense word so a coincidental match is not possible.',
      'A `<strong>` cannot be produced by passing the string through: the asterisks are gone',
      'and an element is there, which means remark, rehype and GitHub\'s sanitize schema all',
      'ran - in the main process, which is the whole arrangement (the grammars are megabytes',
      'the browser bundle must not carry, and one sanitiser on one side of the wire is easier',
      'to be sure of than two).'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// review - a real claude, with argv this driver rendered itself
// ---------------------------------------------------------------------------

async function reviewChecks({
  ctx,
  win,
  sessions,
  dbFile,
  fixtures,
  shotDir,
  started
}: {
  ctx: M2Context
  win: BrowserWindow
  sessions: M2Context['sessions']
  dbFile: string
  fixtures: Fixtures
  shotDir: string
  started: number[]
}): Promise<Check[]> {
  const checks: Check[] = []

  const list = JSON.parse(
    readFileSync(join(fixtures.home, 'list', `${SLUG_A.replace('/', '__')}.json`), 'utf8')
  ) as Array<Record<string, unknown>>
  const summary = list.find((entry) => entry['number'] === PR_A) ?? {}
  const factsA = {
    number: String(PR_A),
    url: String(summary['url'] ?? ''),
    branch: String(summary['headRefName'] ?? ''),
    title: String(summary['title'] ?? ''),
    slug: SLUG_A
  }

  /**
   * Opens the tab for one pull request and waits for the button to be usable.
   *
   * Not merely present - **enabled**. The island renders before the fetch lands
   * and its button is disabled until then, because the working directory and
   * the prompt are both read off the pull request and a launch before then
   * would be a launch on a guess. A driver that clicked the moment the element
   * existed would click nothing and then blame the launch.
   */
  const openTab = async (slug: string, number: number): Promise<boolean> => {
    await click(win, '[data-open-pulls]')
    await pollJs(win, `document.querySelector('[data-pull="${slug}#${String(number)}"]')`, 10_000)
    await click(win, `[data-pull="${slug}#${String(number)}"]`)
    return pollJs(win, `document.querySelector('[data-pr-review]:not([disabled])')`, 30_000)
  }

  /**
   * Clicks the button and waits for a session row that was not there before.
   *
   * Waits on the row rather than on the pane, because the pane is not a
   * reliable signal the second time: a tab that has already launched one review
   * is still showing the note from it, so "the note appeared" is true before
   * the click. The `sessions` table is the fact.
   */
  const clickReview = async (before: number[]): Promise<SessionRow | null> => {
    await click(win, '[data-pr-review]')
    const deadline = Date.now() + 60_000
    for (;;) {
      const rows = sessionRows(dbFile).filter((row) => !before.includes(row.id))
      const row = rows.at(-1)
      if (row !== undefined) {
        started.push(row.id)
        return row
      }
      if (await exists(win, '[data-pr-review-error]')) return null
      if (Date.now() > deadline) return null
      await sleep(250)
    }
  }

  // -----------------------------------------------------------------------
  // PR-6: the default template
  // -----------------------------------------------------------------------
  const beforeDefault = sessionRows(dbFile).map((row) => row.id)
  await openTab(SLUG_A, PR_A)
  const disclosure = await text(win, '[data-pr-review-disclosure]')
  const defaultRow = await clickReview(beforeDefault)
  await sleep(1200)

  const expectedDefault = renderHere('/code-review {number}', factsA)
  const stripHasIt =
    defaultRow === null
      ? false
      : await pollJs(
          win,
          `document.querySelector('[data-tab="session:${String(defaultRow.id)}"]')`,
          20_000
        )
  const pid = defaultRow === null ? null : sessions.pid(defaultRow.id)
  const shotDefault = await screenshot(win, shotDir, 'pr-review-launched.png')

  checks.push({
    id: 'PR-6',
    criterion:
      'Default launch: session spawns in the repo cwd with trailing positional `/code-review <n>`, visible in the strip, argv recorded',
    title: `A real claude started in ${fixtures.alpha} with ${JSON.stringify(expectedDefault)} last on its argv`,
    ok:
      defaultRow !== null &&
      defaultRow.argv.at(-1) === expectedDefault &&
      defaultRow.cwd.toLowerCase() === fixtures.alpha.toLowerCase() &&
      defaultRow.projectPath?.toLowerCase() === fixtures.alpha.toLowerCase() &&
      defaultRow.name.startsWith(`PR #${String(PR_A)} review`) &&
      stripHasIt &&
      pid !== null &&
      // Nothing between `-n <name>` and the prompt: the prompt is the trailing
      // positional and not a flag's value.
      defaultRow.argv[defaultRow.argv.length - 3] === '-n',
    detail: {
      row: defaultRow,
      promptRenderedByDriver: expectedDefault,
      disclosureSentence: disclosure,
      inTabStrip: stripHasIt,
      pid,
      screenshot: shotDefault.file
    },
    notes: [
      'The expected prompt is rendered by this driver\'s own substitution, not by',
      '`renderPullPrompt` - comparing Helm\'s rendering against Helm\'s rendering would assert',
      'only that the function is deterministic.',
      'The argv comes out of the `sessions` table through a separate read-only connection to',
      'helm.db rather than out of the launch\'s answer, so it is what a restart would find.',
      'The pty really opened: the pid is a live process, and the row was written before the',
      'spawn so a session that died in its first second would still be a session that happened.',
      'The pane said what it would run before the button was pressed; the disclosure sentence',
      'is recorded above.'
    ]
  })

  // -----------------------------------------------------------------------
  // PR-7: a custom template, set through the Settings pane
  // -----------------------------------------------------------------------
  const custom = 'Review {slug}#{number} - "{title}" from {branch}, see {url}'
  await click(win, '[data-open-settings]')
  await pollJs(win, `document.querySelector('[data-settings-pr-prompt]')`, 10_000)
  const typed = await typeInto(win, '[data-settings-pr-prompt]', custom)
  await sleep(600)
  const storedTemplate = readSettings(ctx.services.store).prReviewPrompt

  const beforeCustom = sessionRows(dbFile).map((row) => row.id)
  await openTab(SLUG_A, PR_A)
  await sleep(400)
  const customDisclosure = await text(win, '[data-pr-review-disclosure]')
  const customRow = await clickReview(beforeCustom)
  await sleep(1200)

  const expectedCustom = renderHere(custom, factsA)
  const substitutedAll =
    !expectedCustom.includes('{') &&
    expectedCustom.includes(SLUG_A) &&
    expectedCustom.includes(String(PR_A)) &&
    expectedCustom.includes(factsA.title) &&
    expectedCustom.includes(factsA.branch) &&
    expectedCustom.includes(factsA.url)

  checks.push({
    id: 'PR-7',
    criterion:
      'A custom `prReviewPrompt` set in the Settings pane changes the launched argv, all five placeholders substituted',
    title: `The pane's field rewrote the argv to ${String(expectedCustom.length)} characters with no placeholder left`,
    ok:
      typed &&
      storedTemplate === custom &&
      customRow !== null &&
      customRow.argv.at(-1) === expectedCustom &&
      substitutedAll &&
      customRow.argv.at(-1) !== defaultRow?.argv.at(-1),
    detail: {
      typedIntoPane: typed,
      storedTemplate,
      expected: expectedCustom,
      argvTail: customRow?.argv.at(-1) ?? null,
      disclosureSentence: customDisclosure,
      allFivePlaceholdersSubstituted: substitutedAll,
      row: customRow
    },
    notes: [
      'Set through the pane\'s own field with a real value change and a real Enter, not by',
      'writing the row - the criterion is about the surface, and a setting that persists but',
      'never reaches the launch is a broken setting.',
      'All five placeholders are in the template, and the rendered result contains no brace at',
      'all: an unsubstituted one would still be in there, because `renderPullPrompt` leaves a',
      'name it does not know exactly as written.',
      'Compared against the default launch\'s argv as well as against the expectation, so a',
      'template that changed nothing cannot pass.'
    ]
  })

  // -----------------------------------------------------------------------
  // PR-8: checkout mode - refused dirty, and the log ordered before the spawn
  // -----------------------------------------------------------------------
  await click(win, '[data-open-settings]')
  await pollJs(win, `document.querySelector('[data-settings-pr-prompt]')`, 10_000)
  await typeInto(win, '[data-settings-pr-prompt]', '/code-review {number}')
  await sleep(400)
  const chose = await chooseOption(win, '[data-settings-pr-checkout]', 'checkout')
  await sleep(600)
  const checkoutStored = readSettings(ctx.services.store).prCheckout

  // Dirty first. A file git can see, and a count the sentence has to carry.
  const dirtyFile = join(fixtures.real, 'uncommitted.txt')
  writeFileSync(dirtyFile, 'something nobody has committed\n')
  const openedRealTab = await openTab(SLUG_REAL, 9)
  await sleep(400)
  const detailProblem = await text(win, '[data-pr-error]')
  const beforeDirty = sessionRows(dbFile).map((row) => row.id)
  await click(win, '[data-pr-review]')
  await pollJs(win, `document.querySelector('[data-pr-review-error]')`, 30_000)
  const refusal = await text(win, '[data-pr-review-error]')
  const spawnedAnyway = sessionRows(dbFile).filter((row) => !beforeDirty.includes(row.id))
  rmSync(dirtyFile, { force: true })

  // Clean. The invocation log is emptied first so the ordering assertion below
  // is about this launch and not about a `pr list` from an earlier phase.
  const branchBefore = branchOf(fixtures.real)
  forgetInvocations(fixtures.home)
  await click(win, '[data-pr-review-dismiss]').catch(() => false)
  const beforeCheckout = sessionRows(dbFile).map((row) => row.id)
  const checkoutRow = await clickReview(beforeCheckout)
  // The row is written before the spawn and the note is painted after the whole
  // launch resolves, so the pane is behind the database here by design.
  await pollJs(win, `document.querySelector('[data-pr-reviewed-branch]')`, 30_000)

  const branchAfter = branchOf(fixtures.real)
  const reported = await attr(win, '[data-pr-reviewed-branch]', 'data-pr-reviewed-branch')
  const checkoutCalls = invocations(fixtures.home).filter(
    (call) => call.argv[0] === 'pr' && call.argv[1] === 'checkout'
  )
  const checkoutCall = checkoutCalls[0] ?? null
  const shotCheckout = await screenshot(win, shotDir, 'pr-review-checkout.png')

  checks.push({
    id: 'PR-8',
    criterion:
      'Checkout mode: a dirty tree is refused with a count; a clean one runs `gh pr checkout` before the spawn and reports the branch',
    title: `A dirty tree was refused by the count and spawned ${String(spawnedAnyway.length)}; a clean one moved ${branchBefore ?? '?'} to ${branchAfter ?? '?'}`,
    ok:
      chose.found &&
      chose.offered &&
      checkoutStored === 'checkout' &&
      openedRealTab &&
      // The refusal names the count, so the sentence is about this tree.
      /\b1 uncommitted change\b/.test(refusal) &&
      spawnedAnyway.length === 0 &&
      checkoutRow !== null &&
      checkoutCall !== null &&
      checkoutCall.argv[2] === '9' &&
      checkoutCall.cwd.toLowerCase() === fixtures.real.toLowerCase() &&
      // Before the spawn, not merely present: a checkout that landed after the
      // session started would have moved the tree underneath a running review.
      checkoutCall.at <= checkoutRow.startedAtMs &&
      branchAfter === 'review/checkout-me' &&
      branchAfter !== branchBefore &&
      reported === branchAfter,
    detail: {
      settingChosenInPane: chose,
      storedCheckoutMode: checkoutStored,
      openedTheRepositoryTab: openedRealTab,
      detailPaneError: detailProblem,
      refusalSentence: refusal,
      sessionsSpawnedWhileDirty: spawnedAnyway.length,
      checkoutInvocation: checkoutCall,
      sessionStartedAt: checkoutRow?.startedAt ?? null,
      checkoutBeforeSpawnMs:
        checkoutCall !== null && checkoutRow !== null ? checkoutRow.startedAtMs - checkoutCall.at : null,
      branchBefore,
      branchAfter,
      branchReportedByPane: reported,
      screenshot: shotCheckout.file
    },
    notes: [
      'The dirty tree is a real uncommitted file and the refusal has to carry its count, which',
      'is what makes the sentence a statement about this tree rather than a generic warning.',
      'Nothing was spawned while it was refused - checked against the sessions table, because',
      '"the button showed an error" and "no process started" are different facts.',
      'The branch is read from `git rev-parse --abbrev-ref HEAD` by this driver both before and',
      'after, so the move is git\'s account of itself; the pane\'s reported branch is compared',
      'against that rather than against what gh printed.',
      'The ordering is the point of the timestamps: gh checked out at least one millisecond',
      'before the session row was written, and the row is written before the pty opens.'
    ]
  })

  // -----------------------------------------------------------------------
  // PR-9: the window cannot supply a prompt
  // -----------------------------------------------------------------------
  await sendWrite(win, { prCheckout: 'none' })
  await sleep(400)

  const planted = 'PLANTED PROMPT - rm -rf everything'
  const beforePlant = sessionRows(dbFile).map((row) => row.id)
  const injected = await sendReview(win, {
    repoPath: fixtures.alpha,
    number: PR_A,
    cols: 100,
    rows: 30,
    prompt: planted,
    openingPrompt: planted
  })
  await sleep(1000)
  const plantedRow = sessionRows(dbFile)
    .filter((row) => !beforePlant.includes(row.id))
    .at(-1)
  if (plantedRow !== undefined) started.push(plantedRow.id)

  /**
   * What the pane's own button actually put on the wire.
   *
   * The renderer's bridge is a frozen `contextBridge` object captured at module
   * load, so it cannot be wrapped from outside. What can be observed is the
   * other end: this replaces the `pr:review` handler with one that records the
   * payload and then refuses, clicks the real button, and reads back the keys
   * that arrived. It is installed only after every check above has gone through
   * the app's own handler, and nothing after this phase uses the channel.
   */
  const arrived: Array<Record<string, unknown>> = []
  ipcMain.removeHandler('pr:review')
  ipcMain.handle('pr:review', (_event, payload: Record<string, unknown>) => {
    arrived.push(payload)
    throw new Error('pr-check observed this call and stopped it here.')
  })

  await openTab(SLUG_A, PR_A)
  await sleep(400)
  await click(win, '[data-pr-review]')
  await pollJs(win, `document.querySelector('[data-pr-review-error]')`, 30_000)
  const observed = arrived.at(-1) ?? {}
  const keys = Object.keys(observed).sort()

  checks.push({
    id: 'PR-9',
    criterion: 'The renderer never transmits prompt text - `pr:review` carries only {repoPath, number, grid}',
    title: `The button sent ${keys.join(', ')}; a planted prompt on the wire reached no argv`,
    ok:
      injected.ok &&
      plantedRow !== undefined &&
      plantedRow.argv.at(-1) === renderHere('/code-review {number}', factsA) &&
      !plantedRow.argv.some((arg) => arg.includes('PLANTED')) &&
      injected.prompt === renderHere('/code-review {number}', factsA) &&
      JSON.stringify(keys) === JSON.stringify(['cols', 'number', 'repoPath', 'rows']),
    detail: {
      plantedPrompt: planted,
      launchedArgv: plantedRow?.argv ?? null,
      promptMainReported: injected.prompt,
      payloadObservedFromTheButton: observed,
      payloadKeys: keys
    },
    notes: [
      'Two halves, because either alone would be weaker than it looks.',
      'The first plants a prompt: `pr:review` is invoked from the window with `prompt` and',
      '`openingPrompt` fields carrying a string no template would produce, and the argv the',
      'session was launched with is the stored template\'s rendering with no trace of it. Main',
      'composes the prompt from its own cache and its own settings, so a window that sends one',
      'is a window that is ignored.',
      'The second reads what the pane\'s own button puts on the wire. The renderer\'s bridge is',
      'a frozen contextBridge object captured at module load and cannot be wrapped from',
      'outside, so the observation is made at the receiving end: the handler is replaced with',
      'one that records the payload and refuses, which is why the pane shows an error for that',
      'click. Four keys arrived and none of them is a prompt.',
      'Installed last on purpose - every other check in this phase went through the app\'s own',
      'handler, and nothing after this phase uses the channel.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// degrade - stale with an age on it, not nothing
// ---------------------------------------------------------------------------

async function degradeChecks({
  win,
  pulls,
  dbFile,
  fixtures,
  shotDir
}: {
  win: BrowserWindow
  pulls: M2Context['pulls']
  dbFile: string
  fixtures: Fixtures
  shotDir: string
}): Promise<Check[]> {
  const checks: Check[] = []

  await click(win, '[data-open-pulls]')
  await pollJs(win, `document.querySelector('[data-pull]')`, 10_000)
  const rowsWhenHealthy = await dataValues(win, 'pull')
  const dbWhenHealthy = pullRowsFor(dbFile, SLUG_A)

  // -----------------------------------------------------------------------
  // PR-11: not signed in
  // -----------------------------------------------------------------------
  writeBehaviour(fixtures.home, { auth: 'unauthenticated', list: 'ok' })
  pulls.pointGh(fixtures.shim)
  await refreshNow(pulls)
  await sleep(500)

  const unauthKind = await attr(win, '[data-pulls-problem]', 'data-pulls-problem')
  const unauthSentence = await text(win, '[data-pulls-problem]')
  const rowsWhenUnauth = await dataValues(win, 'pull')
  const dbWhenUnauth = pullRowsFor(dbFile, SLUG_A)
  const shotUnauth = await screenshot(win, shotDir, 'pr-degrade-unauthenticated.png')

  checks.push({
    id: 'PR-10',
    criterion: 'An unauthenticated gh degrades to stale-with-age, not to nothing',
    title: 'The "run gh auth login" sentence appears and every cached row stays',
    ok:
      unauthKind === 'unauthenticated' &&
      unauthSentence.includes('gh auth login') &&
      JSON.stringify(rowsWhenUnauth) === JSON.stringify(rowsWhenHealthy) &&
      JSON.stringify(dbWhenUnauth) === JSON.stringify(dbWhenHealthy) &&
      (await text(win, '[data-pulls-caption]')).includes('fetched'),
    detail: {
      problemKind: unauthKind,
      sentence: unauthSentence,
      rowsBefore: rowsWhenHealthy.length,
      rowsAfter: rowsWhenUnauth.length,
      dbRowsAfter: dbWhenUnauth,
      caption: await text(win, '[data-pulls-caption]'),
      screenshot: shotUnauth.file
    },
    notes: [
      'The whole remedy for "not signed in" is a sentence telling the user to run gh auth',
      'login - Helm holds no GitHub credential and this is decided from an exit code alone.',
      'This is the opposite of the usage figures, deliberately: a plan percentage from two',
      'hours ago is a wrong number, and a pull request that was open two hours ago is a true',
      'fact about two hours ago. So the rows stay and the caption carries their age.'
    ]
  })

  // -----------------------------------------------------------------------
  // PR-13: no gh at all
  // -----------------------------------------------------------------------
  pulls.pointGh(join(fixtures.dir, 'there-is-no-gh-here.exe'))
  await refreshNow(pulls)
  await sleep(500)
  const missingKind = await attr(win, '[data-pulls-problem]', 'data-pulls-problem')
  const missingSentence = await text(win, '[data-pulls-problem]')

  checks.push({
    id: 'PR-11',
    criterion: 'A machine with no gh gets an install sentence rather than an empty pane',
    title: 'A gh that is not there paints the "not installed" sentence',
    ok:
      missingKind === 'missing' &&
      missingSentence.includes('cli.github.com') &&
      missingSentence.includes('Settings'),
    detail: { problemKind: missingKind, sentence: missingSentence },
    notes: [
      'The sentence names the remedy - where to get it, and that Helm can be pointed at one -',
      'rather than the failure. Same shape the Claude CLI takes when it is missing.'
    ]
  })

  // -----------------------------------------------------------------------
  // PR-15: a payload that is not JSON, and a service that recovers
  // -----------------------------------------------------------------------
  writeBehaviour(fixtures.home, { auth: 'ok', list: 'invalid-json' })
  pulls.pointGh(fixtures.shim)
  const passesBefore = pulls.passes()
  await refreshNow(pulls)
  await sleep(500)

  const errorShown = await js<string[]>(
    win,
    `[...document.querySelectorAll('[data-pulls-repo-error]')].map((el) => (el.textContent ?? '').trim())`
  )
  const rowsWhenBroken = await dataValues(win, 'pull')
  const passesAfterBreak = pulls.passes()

  writeBehaviour(fixtures.home, { auth: 'ok', list: 'ok' })
  await refreshNow(pulls)
  await sleep(500)
  const errorsAfterRecovery = await dataValues(win, 'pulls-repo-error')
  const rowsAfterRecovery = await dataValues(win, 'pull')
  const passesAfterRecovery = pulls.passes()

  checks.push({
    id: 'PR-12',
    criterion: 'A malformed payload is surfaced, the cache survives it, and the next pass still runs',
    title: `${String(errorShown.length)} repositories reported the parse failure; the pass after it fetched normally`,
    ok:
      errorShown.length > 0 &&
      errorShown.every((line) => line.includes('not JSON')) &&
      JSON.stringify(rowsWhenBroken) === JSON.stringify(rowsWhenHealthy) &&
      errorsAfterRecovery.length === 0 &&
      JSON.stringify(rowsAfterRecovery) === JSON.stringify(rowsWhenHealthy) &&
      // The pass that failed did not take the poller with it: attempts went up,
      // and the count of passes that *threw* did not.
      passesAfterRecovery.started > passesBefore.started &&
      passesAfterRecovery.failed === passesBefore.failed &&
      passesAfterBreak.failed === passesBefore.failed,
    detail: {
      errorsShown: errorShown,
      rowsWhileBroken: rowsWhenBroken.length,
      rowsAfterRecovery: rowsAfterRecovery.length,
      errorsAfterRecovery,
      passesBefore,
      passesAfterBreak,
      passesAfterRecovery
    },
    notes: [
      'gh printed an HTML login page where a JSON array was expected, which is what a proxy',
      'or an expired session actually produces. The parse refuses it by name rather than',
      'showing an empty list, and the rows already cached do not move.',
      '`passes()` is the poller\'s own vital signs: a pass that throws is caught and counted so',
      'that it cannot take the interval with it, and an interval that dies on the first bad',
      'pass is an interval that stops silently. The failure count did not move, and the pass',
      'after the broken one fetched normally.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// live - the real gh, against a real repository, shape only
// ---------------------------------------------------------------------------

async function liveChecks({ roots }: { roots: string[] }): Promise<Check[]> {
  const skip = (why: string): Check[] => [
    {
      id: 'PR-13',
      criterion: 'One real `gh pr list` against a qualifying repository, shape assertions only',
      title: `SKIPPED - ${why}`,
      ok: true,
      detail: { skipped: true, reason: why, roots },
      notes: [
        'Skipped out loud rather than passed quietly. This phase is the only one that touches',
        'the network, and a machine without gh, without a sign-in or without a github.com',
        'repository holding an open pull request cannot run it - which is a fact about the',
        'machine and not about Helm.'
      ]
    }
  ]

  const command = resolveGhCommand()
  if (command === null) return skip('there is no gh on this machine')

  const runGhHere = (args: string[]): { ok: boolean; stdout: string; stderr: string } => {
    try {
      const stdout = execFileSync(command.file, [...command.prefixArgs, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GH_PAGER: 'cat', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }
      })
      return { ok: true, stdout, stderr: '' }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) }
    }
  }

  if (!runGhHere(['auth', 'status']).ok) return skip('gh is installed and not signed in')

  /**
   * A repository to ask about, found by this driver walking the user's own scan
   * roots with git - not by asking Helm, whose answer is the thing under test
   * everywhere else in this file.
   */
  const candidates: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (existsSync(join(path, '.git'))) candidates.push(path)
      else walk(path, depth + 1)
    }
  }
  for (const root of roots) walk(root, 0)

  let slug: string | null = null
  let from: string | null = null
  for (const path of candidates) {
    let url: string
    try {
      url = git(path, ['remote', 'get-url', 'origin']).trim()
    } catch {
      continue
    }
    const remote = parseGitHubRemote(url)
    if (remote === null) continue
    const probe = runGhHere(['pr', 'list', '--repo', remote.slug, '--state', 'open', '--limit', '1', '--json', 'number'])
    if (!probe.ok) continue
    let found: unknown
    try {
      found = JSON.parse(probe.stdout.trim() === '' ? '[]' : probe.stdout)
    } catch {
      continue
    }
    if (Array.isArray(found) && found.length > 0) {
      slug = remote.slug
      from = path
      break
    }
  }

  // A public fallback so the phase is meaningful on a machine whose own
  // repositories happen to have nothing open. Named in the title, because a
  // check that quietly asked a stranger's repository would be a surprise.
  const usedFallback = slug === null
  if (slug === null) slug = 'cli/cli'

  // This driver's own call, parsed by this driver.
  const mine = runGhHere([
    'pr',
    'list',
    '--repo',
    slug,
    '--state',
    'open',
    '--limit',
    '5',
    '--json',
    'number,title,url,state,isDraft,headRefName,baseRefName,additions,deletions,changedFiles'
  ])
  if (!mine.ok) return skip(`gh could not list pull requests for ${slug}: ${mine.stderr.trim()}`)

  let raw: Array<Record<string, unknown>>
  try {
    raw = JSON.parse(mine.stdout.trim() === '' ? '[]' : mine.stdout) as Array<
      Record<string, unknown>
    >
  } catch {
    return skip(`gh printed something that is not JSON for ${slug}`)
  }
  if (raw.length === 0) return skip(`${slug} has no open pull requests right now`)

  // And Helm's, through the code the app uses.
  let theirs: PullSummary[] = []
  let fetchError: string | null = null
  try {
    theirs = await fetchOpenPulls(command, slug, { limit: 5 })
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
  }

  const byNumber = new Map(theirs.map((pull) => [pull.number, pull]))
  const shaped = raw.every((entry) => {
    const number = entry['number']
    if (typeof number !== 'number' || !Number.isInteger(number)) return false
    const pull = byNumber.get(number)
    if (pull === undefined) return false
    return (
      pull.title === entry['title'] &&
      pull.url === entry['url'] &&
      pull.url === `https://github.com/${slug}/pull/${String(number)}` &&
      pull.state === 'OPEN' &&
      pull.headRefName === entry['headRefName'] &&
      pull.baseRefName === entry['baseRefName'] &&
      pull.additions === entry['additions'] &&
      pull.deletions === entry['deletions'] &&
      pull.changedFiles === entry['changedFiles']
    )
  })

  return [
    {
      id: 'PR-13',
      criterion: 'One real `gh pr list` against a qualifying repository, shape assertions only',
      title: `${String(raw.length)} real open pull requests from ${slug}${usedFallback ? ' (no repository of this machine\'s had one open)' : ''}`,
      ok: fetchError === null && shaped && theirs.length >= raw.length,
      detail: {
        slug,
        discoveredFrom: from,
        usedPublicFallback: usedFallback,
        candidatesWalked: candidates.length,
        driverParsed: raw.map((entry) => ({ number: entry['number'], title: entry['title'] })),
        helmParsed: theirs.map((pull) => ({ number: pull.number, title: pull.title })),
        fetchError
      },
      notes: [
        'The only phase that touches the network. gh runs twice against the same repository -',
        'once by this driver with its own execFileSync and its own JSON.parse, once through the',
        'code path the app uses - and the two answers are compared field by field.',
        'Shape only, deliberately: what is open on a real repository changes between two runs,',
        'so the assertion is that the fields arrive and mean what the types say, not that any',
        'particular pull request exists.',
        'The repository is found by walking the user\'s own scan roots with git, not by asking',
        'Helm, whose mapping is the thing under test elsewhere in this file.'
      ]
    }
  ]
}
