import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { screenshot, sleep, stripAnsi, waitFor } from './bridge'
import { answerStartupGates, atPrompt, type Collector, type CheckContext } from './sessionscheck'
import type { Check } from './fidelity'
import { CLAUDE_TESTED_RANGE } from './setup'

/**
 * The packaging criteria: packaging, first run, and the claim that anyone
 * other than the person who wrote it can use this.
 *
 * The discipline is the other drivers' - every computed value is checked
 * against a second read written here that shares no code with the thing it
 * checks. A
 * hand-written `readdirSync` recursion beside the scaffolder, a hand-written
 * YAML line parser beside the manifest writer, a hand-written semver comparison
 * beside the version guard, a direct `execFileSync` of the CLI beside Helm's
 * own detection.
 *
 * Two of the criteria cannot be settled that way and are handled differently:
 *
 *   "A machine with a fresh `~/.claude` and no harness at all" is not a state
 *   this process can enter. So it is a **second process**, started by
 *   `run-packaging.mjs` with `PORTABLE_EXECUTABLE_DIR` pointed at a temporary
 *   directory. That is not a test hook - it is the app's own portable-mode
 *   mechanism, which redirects `userData` beside the exe. The child therefore
 *   opens an empty database in a temp directory, is pointed away from the real
 *   `~/.claude` with `--claude-home=`, and the user's own `%APPDATA%\Helm` is
 *   never opened. Nothing is backed up because nothing is touched.
 *
 *   "The portable exe runs from any path" and "NSIS installs per-user" are
 *   claims about artefacts, not about this process. `run-packaging.mjs` builds them,
 *   copies the portable exe to a path with spaces, installs the NSIS package
 *   silently, and runs `--selftest` out of each.
 *
 * One check is an *audit* rather than an assertion, and CLAUDE.md's rule about
 * checks that can pass with no evidence applies to it hardest: a grep that
 * finds nothing is indistinguishable from a grep that is looking for nothing.
 * So the auditor is made to fail first - a file carrying a personal path is
 * planted, caught, and removed - before its clean result is believed.
 *
 * `pnpm packaging-check` -> helm-data/packaging-report.json + helm-data/packaging-firstrun-report.json
 */

const GROUPS = ['audit', 'cli', 'firstrun', 'harness', 'scan', 'version'] as const
type Group = (typeof GROUPS)[number]

const MACHINE_GROUPS: Group[] = ['audit', 'cli']
const FIRSTRUN_GROUPS: Group[] = ['firstrun', 'harness', 'scan', 'version']

export interface PackagingOptions {
  phase: 'machine' | 'firstrun'
  /** A scratch directory the first-run phase owns entirely. */
  fixtures?: string | undefined
  /** The `.claude` tree the first-run phase is pointed at. Deliberately absent. */
  claudeHome?: string | undefined
  only?: string[] | undefined
}

// ---------------------------------------------------------------------------
// The native pickers, answered by the driver
// ---------------------------------------------------------------------------

let nextDirectory: string | null = null
let nextFile: string | null = null
const pickerCalls: Array<{ kind: string; title: string; answer: string | null }> = []

/** Sets what the next directory or file picker returns. */
export function answerPicker(kind: 'directory' | 'file', path: string | null): void {
  if (kind === 'directory') nextDirectory = path
  else nextFile = path
}

/** Called by the IPC handlers in place of `dialog.showOpenDialog`. */
export function pickerAnswer(kind: 'directory' | 'file', title: string): string | null {
  const answer = kind === 'directory' ? nextDirectory : nextFile
  pickerCalls.push({ kind, title, answer })
  // One answer per question: a picker that kept returning the same path would
  // let a step that never opened one appear to have succeeded.
  if (kind === 'directory') nextDirectory = null
  else nextFile = null
  return answer
}

// ---------------------------------------------------------------------------
// Talking to the renderer
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  return win.webContents.executeJavaScript(expression, true) as Promise<T>
}

/** Clicks the first element matching a selector; false if there was none. */
async function click(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false; el.click(); return true })()`
  )
}

async function exists(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(win, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)
}

async function text(win: BrowserWindow, selector: string): Promise<string> {
  return js<string>(
    win,
    `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '')`
  )
}

/** Every `title` on a sidebar project row - the paths the tree is showing. */
async function sidebarPaths(win: BrowserWindow): Promise<string[]> {
  return js<string[]>(
    win,
    `[...document.querySelectorAll('aside button[title]')].map((b) => b.title)`
  )
}

/**
 * Sets a React-controlled field. Assigning `.value` updates the DOM node and
 * nothing else - React tracks the previous value on the element and skips a
 * change it did not see happen.
 */
async function fill(win: BrowserWindow, selector: string, value: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true })()`
  )
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

/** Clicks the sidebar's "add a folder" with the picker already answered. */
async function addRootThroughUi(win: BrowserWindow, path: string): Promise<void> {
  answerPicker('directory', path)
  await click(win, '[data-add-root]')
  await pollJs(
    win,
    `[...document.querySelectorAll('aside button[title]')].some((b) =>
      b.title.toLowerCase().startsWith(${JSON.stringify(path.toLowerCase())}))`,
    30_000
  )
}

// ---------------------------------------------------------------------------
// Second opinions about what is on disk
// ---------------------------------------------------------------------------

/**
 * Every path under a directory, relative and sorted. A plain recursion with no
 * knowledge of what a harness is, so it can disagree with the scaffolder.
 */
function walk(dir: string, base = dir, into: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return into
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    into.push(relative(base, path).split(sep).join('/'))
    if (entry.isDirectory()) walk(path, base, into)
  }
  return into.sort()
}

/**
 * A YAML manifest read as lines rather than through a parser.
 *
 * The point is to disagree with the writer if it ever produces something a
 * parser would forgive - a duplicated key, a stray blank, a comment - so this
 * keeps the keys *in order and with repeats*, which `yaml` would not.
 */
function readManifestLines(file: string): { keys: string[]; values: Record<string, string>; raw: string } {
  const raw = readFileSync(file, 'utf8')
  const keys: string[] = []
  const values: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1] as string
    keys.push(key)
    values[key] = (match[2] ?? '').trim().replace(/^"(.*)"$/, '$1')
  }
  return { keys, values, raw }
}

/** A hand-written semver comparison, beside the guard's own. */
function outsideRange(version: string, min: string, max: string): boolean {
  const parts = (text: string): number[] => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1]
  }
  const [a, b, c] = parts(version)
  const lo = parts(min)
  const hi = parts(max)
  const cmp = (x: number[], y: number[]): number =>
    x[0] !== y[0] ? (x[0] as number) - (y[0] as number)
      : x[1] !== y[1] ? (x[1] as number) - (y[1] as number)
        : (x[2] as number) - (y[2] as number)
  const found = [a as number, b as number, c as number]
  return cmp(found, lo) < 0 || cmp(found, hi) >= 0
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * What counts as a personal path or name.
 *
 * **Discovered, not written down.** A hardcoded list of names protects exactly
 * one person - anybody else who clones this repository gets a check that looks
 * thorough and tests nothing about them. And this file is public, so a literal
 * list of "names that must never be published" would itself publish them.
 *
 * The first three are structural: a path shaped like that breaks another
 * machine whoever it belongs to. The rest are found at runtime - the account
 * this process runs as, and the repositories sitting beside this one, which is
 * what somebody else's private work looks like from in here.
 *
 * They stay separate patterns rather than one alternation so the report can say
 * *which* kind of thing was found, and so the planted probe can prove that more
 * than one of them fires.
 */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildPersonal(root: string | null): Array<{ id: string; re: RegExp }> {
  const patterns: Array<{ id: string; re: RegExp }> = [
    { id: 'windows-profile', re: /[A-Za-z]:[\\/]{1,2}Users[\\/]/i },
    { id: 'posix-home', re: /\/home\/[a-z0-9_.-]+\//i },
    { id: 'harness-path', re: /\.harness[\\/]/i }
  ]

  // Short names are skipped: an account called `dev` would match half the tree,
  // and a false positive that fails the build teaches people to ignore it.
  let account: string
  try {
    account = userInfo().username
  } catch {
    account = ''
  }
  if (account.length >= 3) {
    patterns.push({ id: 'account', re: new RegExp(`\\b${escapeForRegExp(account)}\\b`, 'i') })
  }

  // Anchored to `repos/<name>` rather than matched bare. The leak this exists
  // to stop is a path or an inventory, and a bare name would fire on any repo
  // that happens to be called something ordinary.
  for (const name of neighbourRepoNames(root)) {
    patterns.push({
      id: 'neighbour-repo',
      re: new RegExp(`repos[\\\\/]${escapeForRegExp(name)}\\b`, 'i')
    })
  }

  return patterns
}

/** Sibling directories of `root`, which in a harness are the other repos. */
function neighbourRepoNames(root: string | null): string[] {
  if (root === null) return []
  try {
    const self = root.split(sep).filter(Boolean).at(-1)?.toLowerCase()
    return readdirSync(dirname(root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .filter((name) => name.toLowerCase() !== self)
  } catch {
    return []
  }
}

let personalCache: Array<{ id: string; re: RegExp }> | null = null

/** Memoised: the sibling scan is a readdir, and the report prints the list. */
function personal(): Array<{ id: string; re: RegExp }> {
  personalCache ??= buildPersonal(repoRoot())
  return personalCache
}

/**
 * Occurrences that are the project's own identity rather than an assumption
 * about who is running it.
 *
 * Three, and the audit asserts there are exactly three: an application id, a
 * release address, and an authorship field. None of them is a path, none is
 * read at runtime to find anything on disk, and every one of them would be
 * equally true on a stranger's machine.
 */
const IDENTITY_ALLOWED: Array<{ needle: string; why: string }> = [
  { needle: 'dev.coletaylor.helm', why: 'the Windows AppUserModelID / electron-builder appId' },
  { needle: 'coledtaylor/helm', why: "the project's release address" },
  { needle: '"author": "Cole Taylor"', why: 'the authorship field in package.json' }
]

/**
 * Paths that are shaped like somebody's machine but belong to nobody.
 *
 * The structural patterns above cannot tell a Windows profile path whose
 * account segment reads `user` - a captured terminal transcript, kept as
 * evidence - from one naming a real account, which is a leak. Both are things
 * this repository legitimately contains. The difference is the segment after
 * the profile root, so it is enumerated here rather than inferred: short,
 * countable, and each entry has to earn its line.
 *
 * The harness root is the suggested-roots convention the product itself ships,
 * so its `~`-relative form is the project speaking. An *absolute* harness path
 * is not covered and still fails: that one names a machine.
 *
 * Written to be unspellable by its own patterns, for the reason the probe's
 * baits are assembled from pieces: the alternative is a driver that has to
 * excuse itself, and an audit with one exemption for its author's convenience
 * has already conceded the argument. Hence a lookahead rather than `\b` on the
 * last one - `\b` puts a backslash directly after the directory name, which is
 * the shape being forbidden.
 */
const PLACEHOLDER_ALLOWED: Array<{ id: string; re: RegExp; why: string }> = [
  {
    id: 'neutral-profile',
    re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?:user|x)\b/i,
    why: 'a Windows profile path whose account segment is a placeholder'
  },
  {
    id: 'neutral-posix-home',
    re: /\/home\/x\//i,
    why: 'a POSIX home whose account segment is a placeholder'
  },
  {
    id: 'harness-convention',
    re: /~[\\/]\.harness(?![A-Za-z0-9_])/i,
    why: "the `~`-relative suggested-roots convention, which is the product's own"
  }
]

/**
 * The private names, read from a file that is not in the repository.
 *
 * The discovered patterns above catch a private repository written as a *path*
 * - `repos/<name>` - because a bare name would fire on any repository called
 * something ordinary. That anchor is right for a check that must not cry wolf,
 * and it is also exactly the hole a name mentioned in prose goes through: a
 * comment reading "every session in <a private project>" is not a path and no
 * discovered pattern can see it.
 *
 * So the bare names live in `.audit-private.local`, which `.gitignore` covers,
 * and the audit reads them at runtime. The list polices the repository without
 * being published by it - which is the whole reason the audit stopped holding a
 * hardcoded list in the first place. `.audit-private.local.example` documents
 * the format.
 *
 * Absent, the check does not quietly pass as though it had one: it says the
 * class went unexercised, and the probe reports the same.
 */
const PRIVATE_LOCAL_FILE = '.audit-private.local'

/** Below this a name matches too much to be worth a build failure. */
const PRIVATE_LOCAL_MIN_LENGTH = 4

interface PrivateLocal {
  present: boolean
  patterns: Array<{ id: string; re: RegExp }>
  /**
   * The names as written. The probe plants one, and it has to plant the name
   * rather than the pattern's `source` - those differ the moment a name
   * contains a character `escapeForRegExp` escapes, and the bait would then be
   * a string the pattern does not match.
   */
  names: string[]
  /** Entries too short to be discriminating, reported rather than dropped. */
  rejected: string[]
}

function readPrivateLocal(root: string | null): PrivateLocal {
  const empty: PrivateLocal = { present: false, patterns: [], names: [], rejected: [] }
  if (root === null) return empty
  let raw: string
  try {
    raw = readFileSync(join(root, PRIVATE_LOCAL_FILE), 'utf8')
  } catch {
    return empty
  }
  const patterns: Array<{ id: string; re: RegExp }> = []
  const names: string[] = []
  const rejected: string[] = []
  for (const line of raw.split('\n')) {
    const name = line.trim()
    if (name === '' || name.startsWith('#')) continue
    if (name.length < PRIVATE_LOCAL_MIN_LENGTH) {
      rejected.push(name)
      continue
    }
    // No word boundaries. `\b<name>\b` cannot match inside `"running<name>"`,
    // and a name concatenated into a string is still a published name.
    patterns.push({ id: 'private-name', re: new RegExp(escapeForRegExp(name), 'i') })
    names.push(name)
  }
  return { present: true, patterns, names, rejected }
}

let privateLocalCache: PrivateLocal | null = null

function privateLocal(): PrivateLocal {
  privateLocalCache ??= readPrivateLocal(repoRoot())
  return privateLocalCache
}

/** Directories the audit never descends into. */
const AUDIT_SKIP = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'dist-app',
  'coverage',
  '.turbo',
  '.vite'
])

const AUDIT_EXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|css|html)$/i

/**
 * Files that are the development harness rather than the product: the check
 * drivers, the spike harnesses, the unit tests, and the measured evidence they
 * wrote. "Outside test fixtures" is the criterion's own wording, and this is
 * where that boundary is drawn so it is visible rather than assumed.
 */
function isHarnessFile(rel: string): boolean {
  return (
    /(^|\/)(sessionscheck|profilescheck|historycheck|configcheck|contentcheck|packagingcheck|usagecheck|claudecheck|fidelity|selftest)\.ts$/.test(rel) ||
    /\.test\.tsx?$/.test(rel) ||
    rel.startsWith('packages/desktop/scripts/') ||
    rel.startsWith('docs/') ||
    // Both halves of the agent instructions, for one reason: the local half is
    // where a machine's paths are *supposed* to be written down, which is why
    // it is gitignored. PKG-4b, which asks what is publishable rather than what
    // ships, does not see it at all.
    /^CLAUDE(\.local)?\.md$/.test(rel)
  )
}

interface AuditHit {
  file: string
  line: number
  pattern: string
  text: string
}

function auditTree(root: string): { shipped: AuditHit[]; harness: AuditHit[]; files: number } {
  const shipped: AuditHit[] = []
  const harness: AuditHit[] = []
  let files = 0

  const visit = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (AUDIT_SKIP.has(entry.name) || entry.name.startsWith('.')) continue
        visit(path)
        continue
      }
      if (!entry.isFile() || !AUDIT_EXT.test(entry.name)) continue
      const rel = relative(root, path).split(sep).join('/')
      files++
      let content: string
      try {
        content = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string
        if (IDENTITY_ALLOWED.some((entry) => line.includes(entry.needle))) continue
        for (const { id, re } of personal()) {
          if (!re.test(line)) continue
          const hit: AuditHit = { file: rel, line: i + 1, pattern: id, text: line.trim().slice(0, 160) }
          if (isHarnessFile(rel)) harness.push(hit)
          else shipped.push(hit)
        }
      }
    }
  }

  visit(root)
  return { shipped, harness, files }
}

/**
 * The files a push would publish: everything tracked, plus everything an
 * ordinary `git add -A` would start tracking.
 *
 * Not a directory walk. The two questions differ in both directions, and each
 * difference is a bug the other framing has:
 *
 * - A walk audits `out/`, `dist-app/` and `.audit-private.local` - build output
 *   and the pattern file itself, none of which can ever reach the remote. An
 *   audit that fails on those teaches people to ignore it.
 * - A walk over *tracked files only* would miss the file sitting untracked in
 *   somebody's working copy that the next `git add -A` sweeps up. That is not
 *   hypothetical: a generated design artifact carrying a private repository
 *   name sat untracked in this checkout, one careless `add` from being public.
 *
 * `--others --exclude-standard` is exactly the second set, so the audit sees
 * what is publishable rather than what is published.
 */
function publishableFiles(root: string): string[] | null {
  let out: string
  try {
    out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
  } catch {
    return null
  }
  const files = out.split('\0').filter((rel) => rel !== '' && AUDIT_EXT.test(rel))
  return files.length === 0 ? null : files
}

interface PublicationResult {
  hits: AuditHit[]
  files: number
  allowed: Array<{ id: string; why: string; occurrences: number }>
}

/**
 * The audit's other question. PKG-4 asks whether a personal path reaches what
 * *ships*, and deliberately excuses the development harness - the drivers, the
 * unit tests, `docs/` and this repository's own instructions - because a
 * fixture path there breaks nobody's machine.
 *
 * Publishing moved that boundary. Everything PKG-4 excuses is world-readable,
 * so this one excuses none of it: same patterns, every publishable file, plus
 * the bare private names the discovered patterns cannot see.
 */
function publicationAudit(root: string, files: string[]): PublicationResult {
  const patterns = [...personal(), ...privateLocal().patterns]
  const allowedCounts = new Map<string, number>(PLACEHOLDER_ALLOWED.map((p) => [p.id, 0]))
  const hits: AuditHit[] = []
  let scanned = 0

  for (const rel of files) {
    let content: string
    try {
      content = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    scanned++
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      if (IDENTITY_ALLOWED.some((entry) => line.includes(entry.needle))) continue
      const excuse = PLACEHOLDER_ALLOWED.find((p) => p.re.test(line))
      if (excuse !== undefined) {
        allowedCounts.set(excuse.id, (allowedCounts.get(excuse.id) ?? 0) + 1)
        continue
      }
      for (const { id, re } of patterns) {
        if (!re.test(line)) continue
        hits.push({ file: rel, line: i + 1, pattern: id, text: line.trim().slice(0, 160) })
      }
    }
  }

  return {
    hits,
    files: scanned,
    allowed: PLACEHOLDER_ALLOWED.map((p) => ({
      id: p.id,
      why: p.why,
      occurrences: allowedCounts.get(p.id) ?? 0
    }))
  }
}

/**
 * The repository this build was compiled from.
 *
 * `getAppPath()` is `packages/desktop` in development. Verified by what is in
 * it rather than trusted: an audit pointed at the wrong directory finds nothing
 * and reports success, which is the exact failure mode CLAUDE.md warns about.
 */
function repoRoot(): string | null {
  const candidate = resolve(app.getAppPath(), '..', '..')
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'))
    const name = (pkg as Record<string, unknown>)['name']
    if (name === 'helm-workspace') return candidate
  } catch {
    return null
  }
  return null
}

// ---------------------------------------------------------------------------
// Fixtures for the first-run phase
// ---------------------------------------------------------------------------

interface Fixtures {
  root: string
  /** Plain project folders, no harness anywhere. */
  plain: string
  /** A folder of repositories, to be converted in place. */
  convertible: string
  /** A harness whose manifest names a different repos directory. */
  named: string
  /** A harness with no `repos:` key at all. */
  fallback: string
  /** Empty, and where the created harness goes. */
  parent: string
  /** A `claude` that reports a version outside the tested range. */
  stubCli: string
  claudeHome: string
}

function buildFixtures(root: string, claudeHome: string): Fixtures {
  const dir = (...parts: string[]): string => {
    const path = join(root, ...parts)
    mkdirSync(path, { recursive: true })
    return path
  }
  const file = (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }

  const plain = dir('plain')
  dir('plain', 'alpha')
  dir('plain', 'beta')
  file(join(plain, 'alpha', '.claude', 'skills', 'one', 'SKILL.md'), '# One\n')

  const convertible = dir('convertible')
  dir('convertible', 'first')
  dir('convertible', 'second')

  const named = dir('named')
  file(join(named, 'harness.yaml'), 'name: "named"\nrepos: "projects"\n')
  dir('named', 'projects', 'inside-projects')
  // A decoy in the default location. `repos:` names the directory; it does not
  // add one, so this must not appear.
  dir('named', 'repos', 'decoy')

  const fallback = dir('fallback')
  file(join(fallback, 'harness.yaml'), 'name: "fallback"\n')
  dir('fallback', 'repos', 'inside-repos')

  const parent = dir('parent')

  const stubDir = dir('stub')
  const stubCli = join(stubDir, 'claude.cmd')
  // Answers `--version` and nothing else. It is never launched - only asked
  // what it is, which is the whole of what the version guard does.
  file(stubCli, '@echo off\r\nif "%1"=="--version" echo 9.9.9 (Claude Code)\r\n')

  return { root, plain, convertible, named, fallback, parent, stubCli, claudeHome }
}

// ---------------------------------------------------------------------------

export async function runPackagingChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  dataDir: string,
  options: PackagingOptions
): Promise<Check[]> {
  const requested = options.only?.filter((g): g is Group => (GROUPS as readonly string[]).includes(g))
  const available = options.phase === 'machine' ? MACHINE_GROUPS : FIRSTRUN_GROUPS
  const wanted = (group: Group): boolean =>
    available.includes(group) && (requested === undefined || requested.length === 0 || requested.includes(group))

  const checks: Check[] = []
  if (options.phase === 'machine') {
    if (wanted('audit')) checks.push(...auditChecks())
    if (wanted('cli')) checks.push(...(await cliChecks(ctx)))
    return checks
  }

  return firstRunChecks(ctx, collector, shotDir, dataDir, options, wanted)
}

// ---------------------------------------------------------------------------
// PKG-4  the audit
// ---------------------------------------------------------------------------

function auditChecks(): Check[] {
  const root = repoRoot()
  if (root === null) {
    return [
      {
        id: 'PKG-4',
        criterion: 'Grep audit confirms no personal paths/names in the codebase outside test fixtures',
        title: 'The repository could not be located, so nothing was audited',
        ok: false,
        detail: { tried: resolve(app.getAppPath(), '..', '..') },
        notes: [
          'An audit pointed at the wrong directory finds nothing and reports success.',
          'It fails instead.'
        ]
      }
    ]
  }

  // The probe first: a scanner that finds nothing has to be shown finding
  // something before its clean answer means anything.
  //
  // The neighbour line is built from a repository actually found beside this
  // one, so the probe exercises the *discovered* pattern rather than a literal
  // written here - which is the whole point of discovering them. On a machine
  // with no neighbours there is no such pattern to fire, so the probe asserts
  // the two structural ones and the report says the third was unavailable.
  const neighbour = neighbourRepoNames(root)[0] ?? null
  const local = privateLocal()
  const privateName = local.names[0] ?? null

  // Every bait is assembled from pieces that match nothing on their own, so
  // this file does not itself contain a line the audit would then have to be
  // taught to excuse. A probe that forces an exemption has weakened the thing
  // it was supposed to prove.
  const bait = {
    profile: ['C:', 'Users', 'someone', 'projects'].join('\\'),
    harness: ['.harness', 'dev', 'repos'].join('\\')
  }

  const probeRel = 'packages/core/src/__m7-audit-probe.ts'
  const probeFile = join(root, ...probeRel.split('/'))
  let probeCaught: AuditHit[]
  let probePublication: AuditHit[]
  let probeEnumerated: boolean
  let probeRemoved: boolean
  try {
    writeFileSync(
      probeFile,
      [
        '// Planted by packaging-check and removed in the same breath.',
        'export const PROBE = {',
        `  path: '${bait.profile}',`,
        `  harness: '${bait.harness}',`,
        ...(neighbour === null ? [] : [`  repo: 'repos/${neighbour}',`]),
        ...(privateName === null ? [] : [`  mention: 'every session in ${privateName}',`]),
        '}',
        ''
      ].join('\n'),
      'utf8'
    )
    probeCaught = auditTree(root).shipped.filter((hit) => hit.file.endsWith('__m7-audit-probe.ts'))
    // The publication audit runs over its own enumeration, not over a path
    // handed to it, because the enumeration is half of what is being proved:
    // the probe is untracked, so only `--others` puts it in scope, and an
    // enumeration that quietly stopped returning untracked files would leave a
    // scanner that still passes and no longer looks where the risk is.
    const publishable = publishableFiles(root) ?? []
    probeEnumerated = publishable.includes(probeRel)
    probePublication = publicationAudit(root, publishable).hits.filter((h) => h.file === probeRel)
  } finally {
    rmSync(probeFile, { force: true })
    probeRemoved = !existsSync(probeFile)
  }

  const probePatterns = [...new Set(probeCaught.map((h) => h.pattern))].sort()
  const probeOk =
    probeRemoved &&
    (neighbour === null || probePatterns.includes('neighbour-repo')) &&
    probePatterns.includes('windows-profile') &&
    probePatterns.includes('harness-path')

  const publicationProbePatterns = [...new Set(probePublication.map((h) => h.pattern))].sort()
  const publicationProbeOk =
    probeRemoved &&
    probeEnumerated &&
    publicationProbePatterns.includes('windows-profile') &&
    publicationProbePatterns.includes('harness-path') &&
    (neighbour === null || publicationProbePatterns.includes('neighbour-repo')) &&
    (privateName === null || publicationProbePatterns.includes('private-name'))

  const { shipped, harness, files } = auditTree(root)
  const publishable = publishableFiles(root)
  const publication = publishable === null ? null : publicationAudit(root, publishable)

  // The allowlist is only defensible if it is short and enumerated. Count what
  // each of its three entries actually excuses, so a fourth cannot be smuggled
  // in behind one of them.
  const allowed = IDENTITY_ALLOWED.map((entry) => {
    let count = 0
    const visit = (dir: string): void => {
      for (const child of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, child.name)
        if (child.isDirectory()) {
          if (AUDIT_SKIP.has(child.name) || child.name.startsWith('.')) continue
          visit(path)
          continue
        }
        if (!child.isFile() || !AUDIT_EXT.test(child.name)) continue
        try {
          for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (line.includes(entry.needle)) count++
          }
        } catch {
          continue
        }
      }
    }
    visit(root)
    return { ...entry, occurrences: count }
  })

  return [
    {
      id: 'PKG-4',
      criterion: 'Grep audit confirms no personal paths/names in the codebase outside test fixtures',
      title: `${String(files)} files audited; nothing personal in what ships`,
      ok: probeOk && shipped.length === 0,
      detail: {
        root,
        filesScanned: files,
        patterns: personal().map((p) => ({ id: p.id, re: p.re.source })),
        shippedHits: shipped,
        harnessHits: harness.length,
        harnessFiles: [...new Set(harness.map((h) => h.file))].sort(),
        identityAllowlist: allowed,
        probe: { caught: probePatterns, removed: probeRemoved }
      },
      notes: [
        `The auditor was made to fail first: a planted file carrying a Windows profile path, a harness path and a private project name was caught under ${String(probePatterns.length)} patterns and then deleted.`,
        `${String(shipped.length)} hits in what ships. ${String(harness.length)} in the development harness - the check drivers, the unit tests and the measured evidence - which is the "outside test fixtures" the criterion allows, and they are listed by file rather than waved at.`,
        'Three occurrences are identity rather than assumption and are allowlisted by their exact text: an application id, a release address, and an authorship field. None is read at runtime to find anything on disk.',
        'Two real portability bugs were found by this audit and fixed rather than excused: claudecheck.ts and selftest.ts each started their session in a literal path under one machine\'s home directory, and now derive the checkout from app.getAppPath().'
      ]
    },
    {
      id: 'PKG-4b',
      criterion:
        'The same audit repo-wide: nothing publishable names a private repository, account or machine',
      title:
        publication === null
          ? 'The publishable file set could not be enumerated, so nothing was audited'
          : `${String(publication.files)} publishable files audited; ${String(publication.hits.length)} naming something private`,
      ok: publication !== null && publicationProbeOk && publication.hits.length === 0,
      detail: {
        root,
        filesAudited: publication?.files ?? 0,
        scope: 'git ls-files --cached --others --exclude-standard',
        patterns: [...personal(), ...privateLocal().patterns].map((p) => ({
          id: p.id,
          re: p.id === 'private-name' ? '(withheld - read from ' + PRIVATE_LOCAL_FILE + ')' : p.re.source
        })),
        hits: publication?.hits ?? [],
        placeholderAllowlist: publication?.allowed ?? [],
        privateNameFile: {
          file: PRIVATE_LOCAL_FILE,
          present: local.present,
          patterns: local.names.length,
          tooShortToUse: local.rejected.length
        },
        probe: {
          enumerated: probeEnumerated,
          caught: publicationProbePatterns,
          removed: probeRemoved
        }
      },
      notes: [
        'PKG-4 asks whether a personal path reaches what ships and excuses the development harness - the drivers, the unit tests, docs/ and CLAUDE.md - because a fixture path there breaks nobody. Publishing moved that boundary: all of it is world-readable, so this check excuses none of it.',
        `Scope is what git would publish - everything tracked plus everything an ordinary \`git add -A\` would start tracking - rather than a directory walk. A walk would audit build output and the pattern file itself, and would miss the untracked file one careless \`add\` from being public. ${String(publication?.files ?? 0)} files.`,
        local.present
          ? `The bare private names come from \`${PRIVATE_LOCAL_FILE}\`, which .gitignore covers, so the audit never publishes the list it polices. ${String(local.names.length)} names loaded${local.rejected.length === 0 ? '' : `, ${String(local.rejected.length)} rejected as too short to discriminate`}. The discovered patterns anchor a repository name to \`repos/<name>\`, which is right for a path and blind to the same name in a sentence - this class is what closes that.`
          : `\`${PRIVATE_LOCAL_FILE}\` is absent, so the bare-private-name class was not exercised. The structural and discovered patterns still ran. See ${PRIVATE_LOCAL_FILE}.example for the format.`,
        `The auditor was made to fail first here too: the planted file was seen by the enumeration (${probeEnumerated ? 'yes' : 'no'}) and caught under ${String(publicationProbePatterns.length)} patterns - ${publicationProbePatterns.join(', ')} - before being deleted. Every bait is assembled at runtime from pieces that match nothing on their own, so this driver contains no line its own audit would have to excuse.`,
        'The placeholder allowlist is counted rather than waved at, the same discipline as the identity allowlist: a path is excused only where the segment after `Users` is a placeholder, and `~/.harness` only in its `~`-relative form. An absolute harness path still fails.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// PKG-0  what the CLI on this machine actually is
// ---------------------------------------------------------------------------

async function cliChecks(ctx: CheckContext): Promise<Check[]> {
  const status = await js<{
    path: string | null
    version: string | null
    semver: string | null
    tested: boolean
    testedRange: { min: string; max: string }
    configDir: string
    configDirExists: boolean
    auth: string
    authSignal: string
  }>(ctx.win, `window.helm.invoke('setup:status')`)

  // A second opinion that shares no code with `claude-cli.ts`: ask Windows
  // itself where the program is, and run the one it names.
  let wherePath: string | null
  try {
    const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true })
    wherePath = out.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? null
  } catch {
    wherePath = null
  }
  const installed = join(homedir(), '.local', 'bin', 'claude.exe')
  const independentPath = wherePath ?? (existsSync(installed) ? installed : null)

  let independentVersion: string | null = null
  if (independentPath !== null) {
    try {
      independentVersion = execFileSync(independentPath, ['--version'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20_000
      }).trim()
    } catch {
      independentVersion = null
    }
  }

  const versionsAgree =
    status.version !== null && independentVersion !== null && status.version === independentVersion

  // The range, compared by hand.
  const handTested =
    status.semver !== null &&
    !outsideRange(status.semver, CLAUDE_TESTED_RANGE.min, CLAUDE_TESTED_RANGE.max)

  // The auth signal, read independently and without opening anything.
  const credentials = join(homedir(), '.claude', '.credentials.json')
  const independentAuth = existsSync(credentials) ? 'authenticated' : 'unknown'

  return [
    {
      id: 'PKG-0',
      criterion: 'setup: the CLI Helm would launch is the one this machine has',
      title: `claude ${status.version ?? 'not found'} located and agreed with an independent read`,
      ok:
        versionsAgree &&
        status.tested === handTested &&
        (independentAuth !== 'authenticated' || status.auth === 'authenticated'),
      detail: {
        helm: status,
        independent: {
          where: wherePath,
          path: independentPath,
          version: independentVersion,
          credentialsFileExists: existsSync(credentials)
        },
        handComputedInRange: handTested
      },
      notes: [
        'Helm resolves the CLI by walking PATH itself; this asks `where.exe` and runs whatever it names, so the two answers come from different code.',
        'The tested range is re-decided here with a hand-written triple comparison rather than by calling the guard.',
        'Authentication is confirmed only by the *existence* of .credentials.json. Neither this check nor the app opens it.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// The first-run phase
// ---------------------------------------------------------------------------

async function firstRunChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  dataDir: string,
  options: PackagingOptions,
  wanted: (group: Group) => boolean
): Promise<Check[]> {
  const checks: Check[] = []
  const { win } = ctx

  if (options.fixtures === undefined || options.claudeHome === undefined) {
    checks.push({
      id: 'PKG-F0',
      criterion: 'setup',
      title: 'The first-run phase was started without a fixture directory',
      ok: false,
      detail: { fixtures: options.fixtures ?? null, claudeHome: options.claudeHome ?? null },
      notes: ['run-packaging.mjs owns the temporary directory and passes it in.']
    })
    return checks
  }

  const fixtures = buildFixtures(options.fixtures, options.claudeHome)

  // Everything below depends on this being a genuinely fresh profile, so it is
  // asserted rather than assumed.
  const settings = await js<{ scanRoots: string[]; firstRunCompletedAt: string | null }>(
    win,
    `window.helm.invoke('settings:read')`
  )
  const paneShowing = await pollJs(win, `document.querySelector('[data-setup-pane]')`, 20_000)
  const sidebarAbsent = !(await exists(win, 'aside'))

  // The data directory has to be inside the sandbox the driver made - which is
  // the parent of the fixtures, not the fixtures themselves - and must not be
  // the real one.
  const sandbox = resolve(options.fixtures, '..')
  const realAppData = join(process.env['APPDATA'] ?? '', 'Helm')
  const isolationOk =
    settings.scanRoots.length === 0 &&
    settings.firstRunCompletedAt === null &&
    !existsSync(fixtures.claudeHome) &&
    dataDir.toLowerCase().startsWith(sandbox.toLowerCase()) &&
    dataDir.toLowerCase() !== realAppData.toLowerCase()

  checks.push({
    id: 'PKG-F0',
    criterion: 'setup: a fresh profile, isolated from the real one',
    title: 'Empty settings, an absent .claude, and a data directory inside the temp folder',
    ok: isolationOk && paneShowing && sidebarAbsent,
    detail: {
      scanRoots: settings.scanRoots,
      firstRunCompletedAt: settings.firstRunCompletedAt,
      claudeHome: fixtures.claudeHome,
      claudeHomeExists: existsSync(fixtures.claudeHome),
      dataDir,
      sandbox,
      realAppData,
      setupPaneShowing: paneShowing,
      sidebarAbsent
    },
    notes: [
      'PORTABLE_EXECUTABLE_DIR is the isolation, and it is the app\'s own portable-mode mechanism rather than a test hook.',
      'The user\'s %APPDATA%\\Helm and ~/.claude are never opened by this process, so nothing needed backing up.'
    ]
  })
  if (!isolationOk) return checks

  /**
   * Always run, whatever `--only` asked for.
   *
   * Going through setup is not one group among four - it is the precondition
   * for the other three, which are all about a launcher that does not exist
   * until it has happened. `--only=harness` re-runs the harness *assertions*
   * against a real first run rather than against a pane still waiting for a
   * folder.
   */
  const arrival = await reachLauncher(ctx, shotDir, fixtures, dataDir)
  if (wanted('firstrun')) checks.push(...arrival.checks)
  if (!arrival.launcherUp) {
    checks.push({
      id: 'PKG-F2',
      criterion: 'setup: the launcher is on screen',
      title: 'Setup did not reach the launcher, so the rest could not be driven',
      ok: false,
      detail: { steps: arrival.checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })) },
      notes: []
    })
    return checks
  }

  if (wanted('harness')) {
    checks.push(...(await harnessGroup(ctx, collector, shotDir, fixtures)))
  }
  if (wanted('scan')) {
    checks.push(...(await scanGroup(ctx, shotDir, fixtures)))
  }
  if (wanted('version')) {
    checks.push(...(await versionGroup(ctx, shotDir, fixtures)))
  }
  return checks
}

// ---------------------------------------------------------------------------
// PKG-3, PKG-5  first run reaches a launcher; an unauthenticated CLI is caught
// ---------------------------------------------------------------------------

/**
 * Goes through setup the way a new user would, and reports on it.
 *
 * Runs unconditionally, because every other group needs the launcher it
 * produces. The `firstrun` flag decides whether its checks are *reported*, not
 * whether the steps happen.
 */
async function reachLauncher(
  ctx: CheckContext,
  shotDir: string,
  fixtures: Fixtures,
  dataDir: string
): Promise<{ checks: Check[]; launcherUp: boolean }> {
  const { win } = ctx
  const checks: Check[] = []

  // --- PKG-5: the machine is not signed in, and the pane says what to do -----
  const status = await js<{ auth: string; authSignal: string; configDir: string; configDirExists: boolean }>(
    win,
    `window.helm.invoke('setup:status')`
  )
  const guidance = await text(win, '[data-setup-auth-guidance]')
  const guidanceShown = await exists(win, '[data-setup-auth-guidance]')
  const authShot = await screenshot(win, shotDir, 'packaging-firstrun-unauthenticated.png')

  // Independent: nothing that looks like a credential exists anywhere the app
  // could have found one, and Helm wrote nothing into the config directory.
  const credentialsAbsent = !existsSync(join(fixtures.claudeHome, '.credentials.json'))
  const configDirStillAbsent = !existsSync(fixtures.claudeHome)

  /**
   * Files *Helm* wrote, which is a smaller set than the data directory.
   * Chromium keeps its own profile in there and one of its stores is called
   * "Trust Tokens" - a browser-platform feature with nothing to do with Claude,
   * and a false positive that would make this assertion meaningless in either
   * direction if it were left in.
   */
  const CHROMIUM_OWNED = [
    'Cache',
    'Code Cache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'GPUCache',
    'Local Storage',
    'Network',
    'Session Storage',
    'Shared Dictionary',
    'blob_storage',
    'DIPS',
    'Local State',
    'Preferences',
    'SharedStorage',
    'TransportSecurity'
  ]
  const dataFiles = walk(dataDir)
  const helmWrote = dataFiles.filter(
    (f) => !CHROMIUM_OWNED.some((name) => f === name || f.startsWith(`${name}/`))
  )
  const secretLooking = helmWrote.filter((f) => /credential|token|oauth|secret|\.key$/i.test(f))

  // And what it persisted: the settings shape has no field a credential could
  // live in, which is checked rather than asserted from the type.
  const persisted = await js<Record<string, unknown>>(win, `window.helm.invoke('settings:read')`)
  const settingsKeys = Object.keys(persisted).sort()
  const secretKeys = settingsKeys.filter((k) => /credential|token|oauth|secret|key|password/i.test(k))

  const storedNothingSecret = secretLooking.length === 0 && secretKeys.length === 0

  checks.push({
    id: 'PKG-5',
    criterion: 'Unauthenticated claude is detected and the guidance flow works end to end',
    title: 'Not signed in, said out loud, with the remedy being to run `claude` yourself',
    ok:
      status.auth === 'unauthenticated' &&
      credentialsAbsent &&
      configDirStillAbsent &&
      guidanceShown &&
      /run\s+claude/i.test(guidance.replace(/\s+/g, ' ')) &&
      storedNothingSecret,
    detail: {
      status,
      guidance: guidance.replace(/\s+/g, ' ').trim().slice(0, 400),
      credentialsAbsent,
      configDirStillAbsent,
      dataDirEntries: dataFiles.length,
      writtenByHelm: helmWrote,
      secretLookingFiles: secretLooking,
      persistedSettingKeys: settingsKeys,
      secretLookingSettingKeys: secretKeys,
      screenshot: authShot.file
    },
    notes: [
      `Helm's answer is "${status.auth}" because ${status.authSignal}.`,
      'The independent read is the absence of the file, checked here without opening it.',
      `The guidance is the whole of the remedy: a sentence telling the user to run \`claude\` once. There is no login form and no token field, none of the ${String(helmWrote.length)} entries Helm wrote is named like a credential, and none of the ${String(settingsKeys.length)} persisted settings is a field one could live in.`,
      "Chromium's own profile directories are excluded from that count and listed in the source: one of its stores is called \"Trust Tokens\", which is a browser feature and would be a false positive in both directions."
    ]
  })

  // --- PKG-3: a folder of plain project folders reaches a working launcher ---
  answerPicker('directory', fixtures.plain)
  await click(win, '[data-setup-add-folder]')
  const rootAppeared = await pollJs(win, `document.querySelector('[data-setup-root]')`, 20_000)
  await sleep(1200)

  const finished = await click(win, '[data-setup-finish]')
  const launcherUp = await pollJs(win, `document.querySelector('aside')`, 20_000)
  await pollJs(win, `document.querySelectorAll('aside button[title]').length >= 2`, 30_000)
  await sleep(500)

  const paths = await sidebarPaths(win)
  const shot = await screenshot(win, shotDir, 'packaging-firstrun-launcher.png')

  // Independent: what is actually in the folder.
  const onDisk = readdirSync(fixtures.plain, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(fixtures.plain, e.name))
    .sort()
  const shown = paths.filter((p) => p.toLowerCase().startsWith(fixtures.plain.toLowerCase())).sort()

  const after = await js<{ scanRoots: string[]; firstRunCompletedAt: string | null }>(
    win,
    `window.helm.invoke('settings:read')`
  )

  checks.push({
    id: 'PKG-3',
    criterion:
      'First run on a machine with a fresh ~/.claude (no harness at all) reaches a working launcher with plain project folders',
    title: `Two plain folders added and launched into a working tree`,
    ok:
      rootAppeared &&
      finished &&
      launcherUp &&
      after.firstRunCompletedAt !== null &&
      onDisk.length === 2 &&
      shown.length === onDisk.length &&
      onDisk.every((path) => shown.some((s) => s.toLowerCase() === path.toLowerCase())),
    detail: {
      root: fixtures.plain,
      rootListedInPane: rootAppeared,
      finishClicked: finished,
      launcherReplacedThePane: launcherUp,
      onDisk,
      sidebar: shown,
      allSidebarRows: paths,
      settingsAfter: after,
      screenshot: shot.file
    },
    notes: [
      'Added through the pane\'s own button, with the native picker answered by the driver - it has no automation surface, and the handler, the settings write and the rescan behind it are all the real ones.',
      'Checked against a `readdirSync` of the folder rather than against another scan.',
      'No harness anywhere: both rows are plain folders, which is the shape the portability requirement is about.'
    ]
  })

  return { checks, launcherUp }
}

// ---------------------------------------------------------------------------
// PKG-8, PKG-11, PKG-12  creating a harness
// ---------------------------------------------------------------------------

const HARNESS_NAME = 'Team Harness'

/** Words that would mean the scaffold had an opinion about how to work. */
const OPINION_WORDS = [
  'journal',
  'reference',
  'notes',
  'rules',
  'skill',
  'command',
  'agent',
  'workflow',
  'convention',
  'template:',
  'todo',
  'scratch'
]

async function harnessGroup(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  fixtures: Fixtures
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []

  // --- PKG-12: the action is still there, after first run finished ----------
  const reachable = await exists(win, '[data-create-harness]')
  const opened = await click(win, '[data-create-harness]')
  const dialogUp = await pollJs(win, `document.querySelector('[data-harness-dialog]')`, 10_000)

  answerPicker('directory', fixtures.parent)
  await click(win, '[data-harness-choose]')
  await pollJs(win, `document.querySelector('[data-harness-dir]')?.value`, 10_000)
  await fill(win, '[data-harness-name]', HARNESS_NAME)
  await sleep(200)
  const preview = await text(win, '[data-harness-target]')
  const dialogShot = await screenshot(win, shotDir, 'packaging-create-harness.png')
  await click(win, '[data-harness-create]')

  const created = join(fixtures.parent, HARNESS_NAME)
  const onDisk = await waitFor(() => existsSync(join(created, 'harness.yaml')), 20_000)
  await pollJs(
    win,
    `[...document.querySelectorAll('aside button[title]')].some((b) =>
      b.title.toLowerCase() === ${JSON.stringify(created.toLowerCase())})`,
    30_000
  )
  await sleep(400)
  const sidebar = await sidebarPaths(win)
  const shot = await screenshot(win, shotDir, 'packaging-harness-in-sidebar.png')

  // --- PKG-11: the scaffold, read by a walker that knows nothing about it ---
  const tree = walk(created)
  const manifest = onDisk ? readManifestLines(join(created, 'harness.yaml')) : null
  const scaffoldBytes = tree
    .map((rel) => {
      try {
        const info = statSync(join(created, rel))
        return info.isFile() ? info.size : 0
      } catch {
        return 0
      }
    })
    .reduce((a, b) => a + b, 0)

  const manifestLower = (manifest?.raw ?? '').toLowerCase()
  const opinions = OPINION_WORDS.filter(
    (word) => word !== 'template:' && manifestLower.includes(word)
  )
  const personalHits = personal().filter((p) => p.re.test(manifest?.raw ?? '')).map((p) => p.id)

  checks.push({
    id: 'PKG-11',
    criterion: 'The scaffold contains no author-specific or workflow-opinion content',
    title: 'Three entries, four keys, and nothing that presumes how anyone works',
    ok:
      onDisk &&
      tree.join(',') === '.claude,harness.yaml,repos' &&
      manifest !== null &&
      manifest.keys.join(',') === 'name,template,version,created' &&
      manifest.values['name'] === HARNESS_NAME &&
      manifest.values['template'] === 'minimal' &&
      opinions.length === 0 &&
      personalHits.length === 0 &&
      !manifest.raw.includes('#'),
    detail: {
      path: created,
      tree,
      totalBytes: scaffoldBytes,
      manifestKeys: manifest?.keys ?? [],
      manifestValues: manifest?.values ?? {},
      manifest: manifest?.raw ?? null,
      opinionWordsFound: opinions,
      personalPatternsFound: personalHits
    },
    notes: [
      'The tree is read by a plain recursion that knows nothing about harnesses, so it disagrees with the scaffolder if the scaffolder writes anything extra.',
      'The manifest is parsed line by line rather than with a YAML library, which is what makes "exactly four keys, in this order, no comments" checkable - a parser would forgive a repeat, a stray key or a comment.',
      `Nothing in it matches any of ${String(OPINION_WORDS.length - 1)} workflow words or any of ${String(personal().length)} personal-path patterns. The whole scaffold is ${String(scaffoldBytes)} bytes.`
    ]
  })

  // --- PKG-8: usable immediately - visible, and a session launches from it --
  const inSidebar = sidebar.some((p) => p.toLowerCase() === created.toLowerCase())
  // The harness row itself, found by its own `title` rather than by a CSS
  // attribute selector - a backslash inside one is an escape, not a character.
  await js<boolean>(
    win,
    `(() => { const el = [...document.querySelectorAll('aside button[title]')]
        .find((b) => b.title.toLowerCase() === ${JSON.stringify(created.toLowerCase())});
      if (!el) return false; el.click(); return true })()`
  )
  await sleep(400)
  const before = ctx.sessions.list().length
  await js<boolean>(
    win,
    `(() => { const el = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent ?? '').includes('Start session here'));
      if (!el) return false; el.click(); return true })()`
  )
  const started = await waitFor(() => ctx.sessions.list().length > before, 30_000)
  const session = ctx.sessions.list().at(-1) ?? null

  let ready = false
  if (session) {
    const stop = answerStartupGates(ctx, collector, [session.id])
    ready = await waitFor(() => atPrompt(stripAnsi(collector.output(session.id))), 120_000)
    stop()
    await sleep(1500)
  }
  const sessionShot = await screenshot(win, shotDir, 'packaging-harness-session.png')

  checks.push({
    id: 'PKG-8',
    criterion:
      'On a machine with no harness, first-run offers "Create a harness" and the result is immediately usable',
    title: 'Created through the dialog, in the sidebar, and a live session launched from its root',
    ok: reachable && opened && dialogUp && onDisk && inSidebar && started && ready && session?.cwd.toLowerCase() === created.toLowerCase(),
    detail: {
      actionReachableAfterFirstRun: reachable,
      dialogPreview: preview,
      created,
      inSidebar,
      sidebar,
      session: session
        ? { id: session.id, cwd: session.cwd, name: session.name, pid: ctx.sessions.pid(session.id) }
        : null,
      reachedPrompt: ready,
      screenshots: [dialogShot.file, shot.file, sessionShot.file]
    },
    notes: [
      'Driven entirely through the window: the sidebar action, the dialog, the folder picker and the name field, then the launcher row and its launch button.',
      'The session is a real `claude`, and "usable" means it reached its own input prompt with the harness root as its working directory.'
    ]
  })

  checks.push({
    id: 'PKG-12',
    criterion: '"Create a harness" remains reachable after first run',
    title: 'The action is in the sidebar once the setup pane is gone',
    ok: reachable && opened && dialogUp,
    detail: { selector: '[data-create-harness]', found: reachable, dialogOpened: dialogUp },
    notes: [
      'Checked after `setup:complete` was stamped and the launcher replaced the pane, which is the only state where the question means anything.'
    ]
  })

  // Close the session so the phase does not leave a process behind.
  if (session) {
    await ctx.sessions.close({ id: session.id, force: true })
    await sleep(500)
  }

  return checks
}

// ---------------------------------------------------------------------------
// PKG-9, PKG-10  the `repos:` key
// ---------------------------------------------------------------------------

async function scanGroup(ctx: CheckContext, shotDir: string, fixtures: Fixtures): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []

  // --- PKG-9: a named repos directory, and the default when there is none ---
  await addRootThroughUi(win, fixtures.named)
  await addRootThroughUi(win, fixtures.fallback)
  await sleep(800)
  const paths = (await sidebarPaths(win)).map((p) => p.toLowerCase())

  const namedExpected = readdirSync(join(fixtures.named, 'projects'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(fixtures.named, 'projects', e.name).toLowerCase())
  const decoy = join(fixtures.named, 'repos', 'decoy').toLowerCase()
  const fallbackExpected = readdirSync(join(fixtures.fallback, 'repos'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(fixtures.fallback, 'repos', e.name).toLowerCase())

  const shot = await screenshot(win, shotDir, 'packaging-repos-key.png')

  checks.push({
    id: 'PKG-9',
    criterion: 'Scanner honors `repos:` in harness.yaml; absent key falls back to `repos/`',
    title: 'The named directory is listed, the default one beside it is not, and a manifest without the key still finds repos/',
    ok:
      namedExpected.every((p) => paths.includes(p)) &&
      !paths.includes(decoy) &&
      fallbackExpected.every((p) => paths.includes(p)),
    detail: {
      named: { harness: fixtures.named, key: 'projects', expected: namedExpected, decoyShown: paths.includes(decoy), decoy },
      fallback: { harness: fixtures.fallback, key: null, expected: fallbackExpected },
      sidebar: paths,
      screenshot: shot.file
    },
    notes: [
      'The decoy matters more than the positive case: `repos:` names the directory, it does not add one. A scanner that listed both would pass a check that only looked for the named repos.',
      'Both lists come from a `readdirSync` of the fixture, not from a second scan.'
    ]
  })

  // --- PKG-10: converting a folder of repos does not hide them --------------
  await addRootThroughUi(win, fixtures.convertible)
  await sleep(600)
  const beforePaths = (await sidebarPaths(win)).map((p) => p.toLowerCase())
  const expected = readdirSync(fixtures.convertible, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(fixtures.convertible, e.name).toLowerCase())
  const visibleBefore = expected.filter((p) => beforePaths.includes(p))

  await click(win, '[data-create-harness]')
  await pollJs(win, `document.querySelector('[data-harness-dialog]')`, 10_000)
  await click(win, '[data-harness-mode="convert"]')
  await sleep(150)
  answerPicker('directory', fixtures.convertible)
  await click(win, '[data-harness-choose]')
  await pollJs(win, `document.querySelector('[data-harness-dir]')?.value`, 10_000)
  await click(win, '[data-harness-create]')

  const manifestWritten = await waitFor(
    () => existsSync(join(fixtures.convertible, 'harness.yaml')),
    20_000
  )
  await pollJs(
    win,
    `[...document.querySelectorAll('aside button[title]')].some((b) =>
      b.title.toLowerCase() === ${JSON.stringify(fixtures.convertible.toLowerCase())})`,
    30_000
  )
  await sleep(600)

  const afterPaths = (await sidebarPaths(win)).map((p) => p.toLowerCase())
  const visibleAfter = expected.filter((p) => afterPaths.includes(p))
  const manifest = manifestWritten
    ? readManifestLines(join(fixtures.convertible, 'harness.yaml'))
    : null
  const convertShot = await screenshot(win, shotDir, 'packaging-converted-folder.png')

  checks.push({
    id: 'PKG-10',
    criterion:
      'Converting an existing folder of repos into a harness does not hide its repos',
    title: `${String(visibleBefore.length)} folders before, ${String(visibleAfter.length)} after, and the harness root gained beside them`,
    ok:
      manifestWritten &&
      manifest?.values['repos'] === '.' &&
      visibleBefore.length === expected.length &&
      visibleAfter.length === expected.length &&
      afterPaths.includes(fixtures.convertible.toLowerCase()),
    detail: {
      folder: fixtures.convertible,
      expected,
      visibleBefore,
      visibleAfter,
      manifest: manifest?.raw ?? null,
      reposKey: manifest?.values['repos'] ?? null,
      harnessRootShown: afterPaths.includes(fixtures.convertible.toLowerCase()),
      screenshot: convertShot.file
    },
    notes: [
      'This is the failure the `repos:` key exists for: before it, dropping a harness.yaml into a folder whose repos sit at its top level made every one of them disappear, because a harness only ever listed `repos/*`.',
      'The before and after lists are the same `readdirSync` of the folder, compared against the sidebar on each side of the conversion.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// PKG-7  the version guard warns and does not block
// ---------------------------------------------------------------------------

async function versionGroup(ctx: CheckContext, shotDir: string, fixtures: Fixtures): Promise<Check[]> {
  const { win } = ctx

  // What the stub actually says, asked of it directly.
  let stubVersion: string | null
  try {
    stubVersion = execFileSync(process.env['COMSPEC'] ?? 'cmd.exe', ['/c', fixtures.stubCli, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000
    }).trim()
  } catch {
    stubVersion = null
  }

  const bannerBefore = await exists(win, '[data-version-banner]')

  // Written through the real settings channel, which is also what the picker
  // writes. The banner is a function of the status, and the status is a
  // function of this.
  await js<unknown>(
    win,
    `window.helm.invoke('settings:write', { claudePath: ${JSON.stringify(fixtures.stubCli)} })`
  )
  const bannerUp = await pollJs(win, `document.querySelector('[data-version-banner]')`, 20_000)
  const bannerText = (await text(win, '[data-version-banner]')).replace(/\s+/g, ' ').trim()
  const status = await js<{ version: string | null; semver: string | null; tested: boolean }>(
    win,
    `window.helm.invoke('setup:status')`
  )
  const shot = await screenshot(win, shotDir, 'packaging-version-banner.png')

  // Not blocked: the launcher underneath still works. A sidebar row opens its
  // pane and the launch button in it is enabled, with the banner on screen.
  // A *project* row, not one of the header buttons above the tree - those also
  // carry a title, and clicking one opens the history pane, which has no launch
  // button to be enabled or disabled.
  const rows = (await sidebarPaths(win)).filter((title) => title.includes(sep))
  const target = rows[0] ?? ''
  await js<boolean>(
    win,
    `(() => { const el = [...document.querySelectorAll('aside button[title]')]
        .find((b) => b.title === ${JSON.stringify(target)});
      if (!el) return false; el.click(); return true })()`
  )
  await sleep(600)
  const usable = await js<{ tabs: number; launchEnabled: boolean; overlay: boolean }>(
    win,
    `(() => {
       const launch = [...document.querySelectorAll('button')]
         .find((b) => (b.textContent ?? '').includes('Start session here'));
       return {
         tabs: document.querySelectorAll('[role="tab"]').length,
         launchEnabled: Boolean(launch) && !launch.disabled,
         overlay: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
       } })()`
  )
  const stillBanner = await exists(win, '[data-version-banner]')

  // Dismissed, and then the setting put back.
  await click(win, '[data-version-banner] button[aria-label="Dismiss"]')
  await sleep(400)
  const dismissed = !(await exists(win, '[data-version-banner]'))

  await js<unknown>(win, `window.helm.invoke('settings:write', { claudePath: null })`)
  await sleep(800)
  const bannerAfterRestore = await exists(win, '[data-version-banner]')

  const handOutside =
    stubVersion !== null &&
    outsideRange(stubVersion, CLAUDE_TESTED_RANGE.min, CLAUDE_TESTED_RANGE.max)

  return [
    {
      id: 'PKG-7',
      criterion: 'Version mismatch shows a warning banner but does not block usage',
      title: 'A 9.9.9 CLI raises the banner, the launcher underneath keeps working, and dismissing clears it',
      ok:
        !bannerBefore &&
        stubVersion !== null &&
        handOutside &&
        bannerUp &&
        status.tested === false &&
        bannerText.includes('9.9.9') &&
        bannerText.includes(CLAUDE_TESTED_RANGE.min) &&
        bannerText.includes(CLAUDE_TESTED_RANGE.max) &&
        usable.tabs > 0 &&
        usable.launchEnabled &&
        !usable.overlay &&
        stillBanner &&
        dismissed &&
        !bannerAfterRestore,
      detail: {
        stub: fixtures.stubCli,
        stubSaysDirectly: stubVersion,
        helmStatus: status,
        handComputedOutsideRange: handOutside,
        range: CLAUDE_TESTED_RANGE,
        bannerBefore,
        bannerText,
        whileWarned: usable,
        dismissed,
        bannerAfterRestore,
        screenshot: shot.file
      },
      notes: [
        'The mismatch is real rather than simulated: a stub program that answers `--version` with 9.9.9 is written to disk, and Helm is pointed at it through the same settings channel the picker writes.',
        'What the stub reports is read twice - once by Helm, once by running it here - and whether that is outside the range is decided twice, once by the guard and once by a hand-written comparison in this file.',
        '"Does not block" is checked while the banner is on screen: a project pane opens, its launch button is enabled, and no modal is covering the window.'
      ]
    }
  ]
}
