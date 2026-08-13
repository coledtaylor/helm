// A `gh` that answers from a directory of fixtures and writes down every
// question it was asked.
//
// `pnpm pr-check` needs a GitHub whose answers it wrote itself. Not because
// the real one is unavailable - the live phase uses it - but because the
// things this milestone has to prove are things a real repository cannot be
// made to do on demand: a pull request whose title changes between two passes,
// an authentication that fails, a payload that is not JSON, and a `pr checkout`
// whose invocation can be read back argument by argument.
//
// It is reached the way a real one would be: through a `.cmd` shim, because
// scoop and npm both install gh as a batch file on Windows and
// `resolveGhCommand` has a branch for exactly that. The driver aims the pulls
// service at the shim with `pointGh`, which is a method on the service and
// deliberately not a channel on the IPC contract - which binary the pull
// requests come from is not the window's to choose.
//
// Everything it does is real except the network. `pr checkout` really runs
// `git`, in the directory it was invoked from, and moves the tree - so the
// branch the driver reads back afterwards is one git reports rather than one
// this script claimed.
//
//   $HELM_FAKE_GH_HOME/
//     behaviour.json   what to do this time; re-read per invocation
//     list/<owner>__<name>.json          `gh pr list --json ...` output
//     view/<owner>__<name>__<n>.json     `gh pr view <n> --json ...` output
//     diff/<owner>__<name>__<n>.patch    `gh pr diff <n>` output
//     threads/<owner>__<name>__<n>.json  the review threads, as GraphQL nodes
//     invocations.jsonl                  every call: argv, cwd, exit code
//
// The threads fixture is the one that is **paged rather than handed over**. It
// holds every thread as one array, and this script cuts it into pages at
// whatever `first:` the shipped query asks for - so a driver that wants to
// prove the pagination loop writes 120 threads and lets the page size come
// from the code under test rather than from an agreement with it.
//
// The second mode, `HELM_FAKE_GH_SYNTHETIC=1`, has no fixture directory and is
// what `pnpm dev` runs against. See `synthesise` at the bottom of this file for
// why it derives its answers from the slug rather than reading them.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.HELM_FAKE_GH_HOME ?? ''
const synthetic = process.env.HELM_FAKE_GH_SYNTHETIC === '1'
const args = process.argv.slice(2)

if (home === '' && !synthetic) {
  writeSync(2, 'fake-gh: HELM_FAKE_GH_HOME is not set\n')
  process.exit(90)
}

/** Re-read per invocation, so the driver can change the answer between passes. */
function behaviour() {
  if (home === '') return {}
  const file = join(home, 'behaviour.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

const slugFile = (dir, slug, suffix = '') =>
  join(home, dir, `${slug.replace('/', '__')}${suffix}.json`)

/** What was asked, before what was answered - a call that crashes still logged. */
function log(entry) {
  if (home === '') return
  appendFileSync(
    join(home, 'invocations.jsonl'),
    `${JSON.stringify({ at: Date.now(), argv: args, cwd: process.cwd(), ...entry })}\n`
  )
}

function out(text, code = 0) {
  // `writeSync` rather than `console.log`: stdout to a pipe is asynchronous on
  // Windows, and `process.exit` immediately after a `console.log` truncates it.
  if (text !== '') writeSync(1, text)
  log({ exit: code, bytes: text.length })
  process.exit(code)
}

function fail(text, code = 1) {
  writeSync(2, text.endsWith('\n') ? text : `${text}\n`)
  log({ exit: code, stderr: text.trim() })
  process.exit(code)
}

/** `--repo owner/name` out of an argv, wherever gh put it. */
function flag(name) {
  const at = args.indexOf(name)
  return at >= 0 ? (args[at + 1] ?? '') : ''
}

/**
 * Every `-f key=value` / `-F key=value` on the line, as a map.
 *
 * `flag()` cannot do this: `gh api graphql` repeats `-f` once per variable and
 * `indexOf` finds only the first, which would read every query's variables as
 * whatever the query string happened to be called.
 */
function fields() {
  const found = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-f' && args[i] !== '-F') continue
    const pair = args[i + 1] ?? ''
    const at = pair.indexOf('=')
    if (at > 0) found[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return found
}

/**
 * The page size the **query** asked for, read out of the query text.
 *
 * Read rather than agreed, so a fixture proves the pagination loop that ships
 * rather than one written to match it: if the query is changed to ask for a
 * hundred at a time, this fake starts handing over a hundred at a time and the
 * driver's count still has to come out right.
 */
function firstOf(query, connection, fallback) {
  const found = new RegExp(`${connection}\\(first:\\s*(\\d+)`).exec(query ?? '')
  return found === null ? fallback : Number(found[1])
}

/** One `nodes`/`pageInfo` slice of an array, cut at `after`. */
function connectionOf(all, size, after) {
  const from = after === '' || after === undefined ? 0 : Number(after)
  const start = Number.isFinite(from) ? from : 0
  const nodes = all.slice(start, start + size)
  const next = start + nodes.length
  return {
    pageInfo: {
      hasNextPage: next < all.length,
      // The cursor is an offset written as a string. GitHub's is an opaque
      // base64 blob and Helm treats it as opaque, which is exactly what makes
      // any stable string do here.
      endCursor: all.length === 0 ? null : String(next)
    },
    nodes
  }
}

const how = behaviour()

if (synthetic) synthesise()

if (args[0] === '--version') {
  out(`${how.version ?? 'gh version 2.86.0 (fixture)'}\nhttps://github.com/cli/cli\n`)
}

if (args[0] === 'auth' && args[1] === 'status') {
  // Helm reads this command's exit code and never a token. Nothing here writes
  // one and nothing in Helm reads one.
  if (how.auth === 'unauthenticated') {
    fail('You are not logged into any GitHub hosts. To log in, run: gh auth login')
  }
  // What a real `gh` prints with **no route to github.com**, captured verbatim
  // from 2.86 on Windows with the proxy pointed at a closed port. It exits 1,
  // like the case above it, and blames a token that is in fact perfectly good -
  // which is the entire reason Helm classifies fetch failures rather than this.
  // A fixture that only ever modelled the honest signed-out case would let a
  // Helm that trusted this exit code pass.
  if (how.auth === 'offline') {
    fail(
      [
        'github.com',
        '  X Failed to log in to github.com account fixture (keyring)',
        '  - Active account: true',
        '  - The token in keyring is invalid.',
        '  - To re-authenticate, run: gh auth login -h github.com'
      ].join('\n')
    )
  }
  out('github.com\n  - Logged in to github.com account fixture (keyring)\n')
}

if (args[0] === 'pr' && args[1] === 'list') {
  const slug = flag('--repo')
  if (how.list === 'error') fail(how.listError ?? 'HTTP 503: the fixture is unwell')
  if (how.list === 'invalid-json') out('<!DOCTYPE html>\n<html>a login page, not JSON</html>\n')

  const file = slugFile('list', slug)
  if (!existsSync(file)) {
    fail(`could not resolve to a Repository with the name '${slug}'`)
  }
  out(readFileSync(file, 'utf8'))
}

if (args[0] === 'pr' && args[1] === 'view') {
  const slug = flag('--repo')
  const number = args[2] ?? ''
  if (how.view === 'error') fail(how.viewError ?? 'HTTP 503: the fixture is unwell')

  const file = slugFile('view', slug, `__${number}`)
  if (!existsSync(file)) fail(`no pull requests found for ${slug}#${number}`)
  out(readFileSync(file, 'utf8'))
}

if (args[0] === 'pr' && args[1] === 'diff') {
  const slug = flag('--repo')
  const number = args[2] ?? ''
  if (how.diff === 'error') fail(how.diffError ?? 'HTTP 503: the fixture is unwell')

  // A `.patch` and not a `.json`: what gh prints here is the text git wrote,
  // and a fixture that stored it as anything else would be proving the parser
  // against a shape the real command never emits.
  const file = join(home, 'diff', `${slug.replace('/', '__')}__${number}.patch`)
  if (!existsSync(file)) fail(`no pull requests found for ${slug}#${number}`)
  out(readFileSync(file, 'utf8'))
}

if (args[0] === 'api' && args[1] === 'graphql') {
  const vars = fields()
  if (how.threads === 'error') fail(how.threadsError ?? 'HTTP 502: the fixture is unwell')
  // A `data` with the connection missing from it - the shape GitHub returns
  // for a pull request it will not resolve, which Helm must read as "the query
  // did not run" rather than as "there are no threads".
  if (how.threads === 'absent') {
    out(`${JSON.stringify({ data: { repository: { pullRequest: null } } })}\n`)
  }

  // The continuation query names a thread by node id; the page query names a
  // repository and a number. Which one this is, is which variables arrived.
  if (vars.id !== undefined) {
    const all = threadById(vars.id)
    if (all === null) fail(`Could not resolve to a node with the global id of '${vars.id}'`)
    out(
      `${JSON.stringify({
        data: {
          node: {
            comments: connectionOf(all, firstOf(vars.query, 'comments', 50), vars.cursor ?? '')
          }
        }
      })}\n`
    )
  }

  const slug = `${vars.owner ?? ''}/${vars.name ?? ''}`
  const file = join(home, 'threads', `${slug.replace('/', '__')}__${vars.number ?? ''}.json`)
  // Absent is "no threads", not an error: most pull requests have none, and a
  // fixture that had to write an empty file per pull request would make the
  // commonest case the one most easily got wrong.
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  const size = firstOf(vars.query, 'reviewThreads', 50)
  const commentSize = firstOf(vars.query, 'comments', 50)
  const page = connectionOf(all, size, vars.cursor ?? '')

  out(
    `${JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: page.pageInfo,
              // Each thread's comments are a connection too, cut at the same
              // page size the query asked for - so a thread with more replies
              // than fit really does report `hasNextPage` and really does have
              // to be continued by node id.
              nodes: page.nodes.map((thread) => ({
                ...thread,
                comments: connectionOf(thread.comments ?? [], commentSize, '')
              }))
            }
          }
        }
      }
    })}\n`
  )
}

/**
 * Every thread of every fixture pull request, so a node id can be resolved
 * without knowing which pull request it came from.
 *
 * GitHub's node ids are global and the continuation query carries nothing else,
 * so this is the same lookup a real API does - and it is a scan of a handful of
 * files rather than an index, because a fixture directory is a handful of files.
 */
function threadById(id) {
  const dir = join(home, 'threads')
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const threads = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    const found = threads.find((thread) => thread.id === id)
    if (found !== undefined) return found.comments ?? []
  }
  return null
}

if (args[0] === 'pr' && args[1] === 'checkout') {
  const slug = flag('--repo')
  const number = args[2] ?? ''
  if (how.checkout === 'error') fail(how.checkoutError ?? 'failed to run git: exit status 128')

  // The branch comes out of the same list fixture the pane was painted from,
  // so the name the driver expects and the name the tree ends up on have one
  // source rather than two.
  const file = slugFile('list', slug)
  if (!existsSync(file)) fail(`could not resolve to a Repository with the name '${slug}'`)
  const pulls = JSON.parse(readFileSync(file, 'utf8'))
  const pull = pulls.find((entry) => String(entry.number) === String(number))
  if (pull === undefined) fail(`no pull request found for ${slug}#${number}`)

  // `-B` rather than `-b`: a second checkout of the same pull request is the
  // normal case in a driver, and gh's own behaviour there is to end up on the
  // branch either way.
  const git = spawnSync('git', ['checkout', '-B', pull.headRefName], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true
  })
  if (git.status !== 0) {
    fail(`failed to run git: ${(git.stderr ?? '').trim() || String(git.error ?? 'unknown')}`, 1)
  }
  out(`Switched to branch '${pull.headRefName}'\n`)
}

fail(`unknown command\n\nUsage: gh <command> <subcommand> [flags]\n`, 2)

// ---------------------------------------------------------------------------
// Synthetic mode
// ---------------------------------------------------------------------------

/**
 * A GitHub derived from the slug, with no fixture directory behind it.
 *
 * `pnpm dev` runs against a **copy of the real database**, so the repositories
 * it knows about are the developer's own - and a fixture keyed
 * `owner__name.json` would answer for none of them. The alternative considered
 * and rejected was rebuilding fixtures out of the cached `pull_requests` rows,
 * which means un-parsing `PullDetail` back into `gh --json` shape: a second
 * reversed mapping, maintained beside the real one, drifting from it.
 *
 * So the slug is hashed and the answer computed. Every repository on the
 * machine gets plausible pull requests, the same ones on every run, with no
 * network - and the pane's states are reachable because they are assigned from
 * bits of the hash rather than left to whatever the developer's repositories
 * happen to have open.
 *
 * Three bits per pull request, so a machine with a handful of repositories
 * reaches all of them: draft, checks failing, and a patch over the 2MB ceiling
 * `fetchPullDiff` cuts at. `HELM_FAKE_GH_STATES` overrides them for a repository
 * whose hash is unlucky - see the header `writeDevGh` prints.
 */
function synthesise() {
  if (args[0] === '--version') out('gh version 2.86.0 (synthetic)\nhttps://github.com/cli/cli\n')
  if (args[0] === 'auth' && args[1] === 'status') {
    out('github.com\n  - Logged in to github.com account synthetic (keyring)\n')
  }

  // The one command that changes something. `fake-gh` really runs `git` for the
  // fixture drivers, on purpose - but dev's projects are the developer's actual
  // repositories on disk, and a checkout here would move a real working tree
  // onto a branch that does not exist, for a pull request that does not either.
  if (args[0] === 'pr' && args[1] === 'checkout') {
    fail(
      'This is Helm\'s development mode, whose pull requests are synthetic - there is no ' +
        'branch to fetch, and checking one out would move a real working tree. Run `pnpm dev:live` ' +
        'against the real gh to exercise checkout.'
    )
  }

  // The threads, derived like everything else here. Answered before the
  // `--repo` guard below, because a GraphQL call names its repository in
  // variables rather than in a flag.
  if (args[0] === 'api' && args[1] === 'graphql') {
    const vars = fields()
    if (vars.id !== undefined) {
      // Synthetic threads are short enough to fit one page, so a continuation
      // is a question about a page that does not exist. Answering with an empty
      // one is the honest reply and keeps the loop terminating.
      out(
        `${JSON.stringify({
          data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }
        })}\n`
      )
    }
    const named = `${vars.owner ?? ''}/${vars.name ?? ''}`
    const pull = pullsFor(named).find((entry) => String(entry.number) === String(vars.number ?? ''))
    const threads = pull === undefined ? [] : threadsFor(named, pull)
    out(
      `${JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: threads.length === 0 ? null : '1' },
                nodes: threads.map((thread) => ({
                  ...thread,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: '1' },
                    nodes: thread.comments
                  }
                }))
              }
            }
          }
        }
      })}\n`
    )
  }

  const slug = flag('--repo')
  if (slug === '') fail('no --repo was given')
  const pulls = pullsFor(slug)

  if (args[0] === 'pr' && args[1] === 'list') {
    out(`${JSON.stringify(pulls.map(published), null, 2)}\n`)
  }

  if (args[0] === 'pr' && args[1] === 'view') {
    const pull = pulls.find((entry) => String(entry.number) === String(args[2] ?? ''))
    if (pull === undefined) fail(`no pull requests found for ${slug}#${String(args[2] ?? '')}`)
    out(`${JSON.stringify(detailFor(slug, pull), null, 2)}\n`)
  }

  if (args[0] === 'pr' && args[1] === 'diff') {
    const pull = pulls.find((entry) => String(entry.number) === String(args[2] ?? ''))
    if (pull === undefined) fail(`no pull requests found for ${slug}#${String(args[2] ?? '')}`)
    out(diffFor(pull))
  }

  fail(`unknown command\n\nUsage: gh <command> <subcommand> [flags]\n`, 2)
}

/** Stable across runs and across machines: the slug is the only input. */
function hashOf(text) {
  return parseInt(createHash('sha256').update(text).digest('hex').slice(0, 12), 16)
}

/**
 * Something to draw from that is the same on every run.
 *
 * `Math.abs` and a floor because the seeds here are 48-bit: a caller reaching
 * for variety with `seed >> 3` gets a *32-bit* result, which goes negative, and
 * a negative index returns `undefined` - a field quietly missing from the JSON
 * rather than an error. That happened to `reviewDecision`.
 */
function pick(list, n) {
  return list[Math.abs(Math.floor(n)) % list.length]
}

/**
 * The words the synthetic pull requests are built out of.
 *
 * A function rather than four `const`s because this whole section sits below
 * the dispatch that calls into it - a declaration hoists and an initialiser
 * does not, and a `const` down here is a temporal-dead-zone crash the first
 * time anything asks for a list.
 */
function catalogue() {
  return {
    titles: [
      'Cache the discovery walk between focus events',
      'Drop the second read of the settings row',
      'Bump the pinned toolchain and re-lock',
      'Fix the empty state on a repository with no remote',
      'Split the poller out of the service',
      'Add the missing index on session.started_at',
      'Handle a patch that arrives with CRLF endings'
    ],
    authors: ['octocat', 'app/dependabot', 'hubot', 'mona'],
    branches: ['fix/empty-state', 'chore/bump-toolchain', 'feat/split-poller', 'fix/crlf']
  }
}

/**
 * A repository's open pull requests: 0 to 3, derived from the slug.
 *
 * Zero is one of the four outcomes on purpose. A repository with nothing open is
 * the commonest state on a real machine and the pane has a row for it, so a
 * synthetic GitHub where every repository has something open would hide the
 * empty case entirely.
 */
function pullsFor(slug) {
  const { titles, authors, branches } = catalogue()
  const base = hashOf(slug)
  const forced = (process.env.HELM_FAKE_GH_STATES ?? '').split(',').filter(Boolean)
  const count = forced.length > 0 ? forced.length : base % 4

  const pulls = []
  for (let i = 0; i < count; i++) {
    const seed = hashOf(`${slug}#${String(i)}`)
    const state = forced[i] ?? ''
    const draft = state === 'draft' || (state === '' && (seed & 1) === 1)
    const failing = state === 'failing' || (state === '' && (seed & 2) === 2)
    const bigDiff = state === 'big-diff' || (state === '' && (seed & 4) === 4)
    const number = 100 + (seed % 800)
    const author = pick(authors, seed)

    // The files first, and the three counts summed from them. A real `gh`
    // answers with a header that agrees with its own file list, and a fixture
    // whose header claimed 127 files over a list of 12 puts the pane into a
    // state the thing it stands in for cannot produce.
    const files = filesFor(seed, bigDiff)
    pulls.push({
      number,
      title: pick(titles, seed),
      url: `https://github.com/${slug}/pull/${String(number)}`,
      author: { login: author, is_bot: author.startsWith('app/') },
      state: 'OPEN',
      isDraft: draft,
      headRefName: `${pick(branches, seed)}-${String(number)}`,
      baseRefName: 'main',
      // Fixed offsets from a fixed epoch rather than from now: a list whose
      // timestamps moved between two passes would make the pane's "changed
      // since last fetch" logic fire on every sweep.
      createdAt: at(-72 - i * 19),
      updatedAt: at(-2 - i * 7),
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      changedFiles: files.length,
      reviewDecision: pick(['', 'APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED'], seed / 8),
      statusCheckRollup: rollup(seed, failing),
      labels: draft ? [{ name: 'wip' }] : [],
      // Not a field `gh` prints. Stripped before anything is written out; it is
      // here so the detail and the patch are built from the same file list
      // rather than from two that agree by coincidence.
      __files: files
    })
  }
  return pulls
}

/**
 * The files one pull request touches.
 *
 * A big-diff pull request is a moderate number of files with a great many lines
 * in each, rather than hundreds of files: what has to go over `MAX_DIFF_BYTES`
 * is the patch, and a list of five hundred one-line changes makes the Files
 * view unreadable for a reason that has nothing to do with the ceiling.
 */
function filesFor(seed, bigDiff) {
  const areas = ['core', 'ui', 'desktop']
  const names = ['index', 'store', 'view', 'poll', 'parse', 'session']
  const count = bigDiff ? 14 + (seed % 6) : 1 + (seed % 9)
  const files = []
  for (let i = 0; i < count; i++) {
    files.push({
      path: `packages/${pick(areas, seed + i)}/src/${pick(names, seed + i)}${String(i)}.ts`,
      additions: bigDiff ? 2_400 + ((seed + i * 37) % 900) : 4 + ((seed + i) % 90),
      deletions: bigDiff ? 400 + ((seed + i * 11) % 300) : 1 + ((seed + i) % 30)
    })
  }
  return files
}

/** What `gh` would actually print, without the field this script threads. */
function published(pull) {
  const { __files, ...rest } = pull
  void __files
  return rest
}

/** An hour offset from a fixed moment, so nothing here moves between runs. */
function at(hours) {
  return new Date(Date.parse('2026-08-01T09:00:00Z') + hours * 3_600_000).toISOString()
}

/**
 * `statusCheckRollup`, in the union shape gh actually prints.
 *
 * Both members, deliberately: `reduceChecks` reads a `CheckRun` through
 * `status`/`conclusion` and a legacy `StatusContext` through `state`, and a
 * fixture that only ever produced one of them would leave half of it
 * unexercised in the app somebody is looking at.
 */
function rollup(seed, failing) {
  const runs = [
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' }
  ]
  if (failing) {
    runs[1] = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }
  }
  if ((seed & 8) === 8) {
    runs.push({ __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' })
  }
  return runs
}

function detailFor(slug, pull) {
  const seed = hashOf(`${slug}#${String(pull.number)}`)
  const files = pull.__files

  return {
    body:
      `Synthetic pull request, produced by Helm's development \`gh\`. There is no such ` +
      `pull request on ${slug} - the contents are derived from the repository's name so ` +
      `that the pane has something to paint with no network.\n\n` +
      `- state: ${pull.isDraft ? 'draft' : 'open'}\n` +
      `- checks: ${pull.statusCheckRollup.some((c) => c.conclusion === 'FAILURE') ? 'one failing' : 'green'}\n`,
    comments: [
      {
        id: `IC_${String(seed)}`,
        author: { login: 'mona', is_bot: false },
        authorAssociation: 'MEMBER',
        body: 'Left a note on the second hunk.',
        createdAt: at(-6),
        url: `${pull.url}#issuecomment-${String(seed)}`
      }
    ],
    reviews:
      pull.reviewDecision === ''
        ? []
        : [
            {
              id: `PRR_${String(seed)}`,
              author: { login: 'hubot', is_bot: false },
              authorAssociation: 'COLLABORATOR',
              state: pull.reviewDecision === 'APPROVED' ? 'APPROVED' : 'CHANGES_REQUESTED',
              body: pull.reviewDecision === 'APPROVED' ? 'Looks right to me.' : 'One thing below.',
              submittedAt: at(-4)
            }
          ],
    commits: [
      {
        oid: createHash('sha1').update(`${slug}#${String(pull.number)}`).digest('hex'),
        messageHeadline: pull.title,
        authors: [{ login: pull.author.login, name: pull.author.login }],
        committedDate: at(-8),
        authoredDate: at(-8)
      }
    ],
    files,
    statusCheckRollup: pull.statusCheckRollup,
    mergeStateStatus: (seed & 16) === 16 ? 'BLOCKED' : 'CLEAN'
  }
}

/**
 * The threads left on lines of a synthetic pull request's diff.
 *
 * Here for the same reason the comments and the rollup are: `pnpm dev` has to
 * be able to reach every state the pane can paint without arranging one on a
 * real repository. Three threads per pull request, and they are deliberately
 * not three of the same thing - an open one with a reply chain, a resolved one
 * (which the pane starts collapsed) and an outdated one whose current `line` is
 * null, which is the case a pane that assumed a number would paint as `:null`.
 *
 * The paths and the hunks come from `pull.__files`, so a thread names a file the
 * pull request actually changed. A thread anchored to a path the detail does
 * not list is a state a real GitHub cannot produce.
 */
function threadsFor(slug, pull) {
  const seed = hashOf(`${slug}#${String(pull.number)}#threads`)
  const files = pull.__files
  const at = (hours) =>
    new Date(Date.parse('2026-08-01T09:00:00Z') + hours * 3_600_000).toISOString()

  const shapes = [
    { resolved: false, outdated: false, replies: 2 },
    { resolved: true, outdated: false, replies: 0 },
    { resolved: false, outdated: true, replies: 1 }
  ]

  return shapes.slice(0, Math.max(1, Math.min(files.length, 3))).map((shape, i) => {
    const file = files[i % files.length]
    const line = 4 + ((seed + i) % 20)
    const authors = ['mona', 'hubot', 'app/claude-review']
    const comments = [
      {
        id: `PRRC_${String(seed)}_${String(i)}_0`,
        author: { login: pick(authors, seed + i), __typename: 'User' },
        authorAssociation: 'MEMBER',
        body: `This is a **synthetic** note on line ${String(line)} of \`${file.path}\`. Helm derived it from the repository's name so the Conversation view has a thread to paint with no network.`,
        createdAt: at(-5 - i),
        url: `${pull.url}#discussion_r${String(seed + i)}`,
        // The `@@` header and a few lines, as GitHub sends it: leading context
        // with the commented line last. Painted as text and never as HTML,
        // which is why one of them carries a tag.
        diffHunk: [
          `@@ -${String(line - 2)},4 +${String(line - 2)},5 @@ function compute()`,
          ' const before = 1',
          ' // <b>not markup</b>, and the pane must not make it any',
          `+  const step = compute(${String(line)})`
        ].join('\n')
      }
    ]
    for (let r = 0; r < shape.replies; r++) {
      comments.push({
        id: `PRRC_${String(seed)}_${String(i)}_${String(r + 1)}`,
        author: { login: pick(authors, seed + i + r + 1), __typename: 'User' },
        authorAssociation: r === 0 ? 'OWNER' : 'CONTRIBUTOR',
        body: r === 0 ? 'Good catch - pushed a fix.' : 'Confirmed on my side too.',
        createdAt: at(-4 - i + r),
        url: `${pull.url}#discussion_r${String(seed + i + r + 1)}`,
        diffHunk: comments[0].diffHunk
      })
    }

    return {
      id: `PRRT_${String(seed)}_${String(i)}`,
      path: file.path,
      // Null on the outdated one, which is what GitHub answers when the lines a
      // thread was written against have moved out from under it.
      line: shape.outdated ? null : line,
      originalLine: line,
      isResolved: shape.resolved,
      isOutdated: shape.outdated,
      comments
    }
  })
}

/**
 * The patch, one hunk per file the detail lists.
 *
 * Built from `pull.__files` rather than invented, because the Files view pairs
 * each row with the hunk whose header names it: a patch for a path the detail
 * does not carry paints "No patch for this file in what was fetched" on every
 * row - which is a real degradation of Helm's, reached here for a reason a real
 * `gh` could not produce.
 *
 * A big-diff pull request goes past `MAX_DIFF_BYTES` (2MB) on the strength of
 * its own line counts, so "cut at a line boundary and said so" is a state
 * somebody can look at in dev rather than only in `pr-check`.
 */
function diffFor(pull) {
  const parts = []
  for (const file of pull.__files) {
    parts.push(
      `diff --git a/${file.path} b/${file.path}\n`,
      `index 1a2b3c4..5d6e7f8 100644\n`,
      `--- a/${file.path}\n`,
      `+++ b/${file.path}\n`,
      `@@ -1,${String(file.deletions + 3)} +1,${String(file.additions + 3)} @@ function compute()\n`,
      ` const before = 1\n`
    )
    for (let line = 0; line < file.deletions; line++) {
      parts.push(`-  const old${String(line)} = ${String(line)}\n`)
    }
    for (let line = 0; line < file.additions; line++) {
      parts.push(`+  const step${String(line)} = compute(${String(line)}) // synthetic patch line\n`)
    }
    parts.push(` const after = 2\n`)
  }
  return parts.join('')
}
