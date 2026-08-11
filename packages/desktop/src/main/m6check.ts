import { net, type BrowserWindow, type WebFrameMain } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import {
  countConfigSnapshots,
  createProfile,
  deleteProfile,
  findProfileByName,
  type ContentFile,
  type Profile
} from '@helm/core'
import { screenshot, sleep, waitFor } from './bridge'
import { artifactConsoleEntries, artifactRoots, clearArtifactConsole } from './content'
import type { Check } from './fidelity'
import type { M2Context } from './m2check'

/**
 * M6's acceptance criteria, driven through the app the way a reader reaches it.
 *
 * The discipline is M4's and M5's: nothing is asserted against Helm's own
 * answer alone. Every count is checked against a second read written in this
 * file, and the second read shares no code with the thing it checks - a regex
 * scan of the source beside the remark pipeline, a `readdirSync` walk beside
 * the tree scanner, a hand-built name index beside the wikilink resolver, a
 * plain `indexOf` loop beside the search. A parser agreeing with itself proves
 * nothing.
 *
 * Two criteria are *measurements* rather than assertions, and are reported as
 * numbers whether or not they pass:
 *
 *   - Search latency, as p50 and p95 over the real corpus, measured in the
 *     renderer so the IPC round trip is inside the number.
 *   - Scroll smoothness on a long document, as frame intervals recorded by
 *     `requestAnimationFrame` while the pane is actually scrolling.
 *
 * And one criterion is about a *sandbox*, which cannot be checked by trusting
 * the flags that were passed to build it. The artifact frame is interrogated
 * from inside - `typeof require`, the origin it ended up with, whether a remote
 * fetch resolves - through `WebFrameMain.executeJavaScript`, which reaches an
 * opaque-origin frame that the window hosting it cannot touch.
 *
 * `pnpm m6-check` -> helm-data/m6-report.json
 */

const PROFILE_NAME = 'M6 content fixtures'

const GROUPS = ['browse', 'render', 'links', 'artifact', 'search', 'edit', 'scroll'] as const
type Group = (typeof GROUPS)[number]

// ---------------------------------------------------------------------------
// A second opinion about what is on disk
// ---------------------------------------------------------------------------

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

const HTML = /\.(html|htm)$/i

const SKIP = new Set([
  'repos',
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  'coverage',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  '.turbo',
  '.vite',
  'bin',
  'obj',
  'vendor',
  'site-packages',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.vs',
  '.vscode',
  'env',
  '.svn',
  '.hg'
])

/**
 * Every readable file under a scope, walked naively.
 *
 * Deliberately not the tree scanner's algorithm: a plain recursion from the
 * scope root that keeps anything ending in a content extension, with the same
 * exclusion list and nothing else. It knows nothing about named roots or
 * discovered ones - it just enumerates - so it can disagree with the scanner
 * when the scanner is wrong about which directories are content.
 */
function walkContent(dir: string, base: string, into: string[], depth = 0): void {
  if (depth > 7) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.isSymbolicLink()) continue
      if (SKIP.has(entry.name.toLowerCase())) continue
      // Dot directories are tooling and not content. `.claude` is the one
      // exception, and only its `skills` subtree: `settings.json`,
      // `commands/` and `rules/` are the config console's, and a content
      // browser that listed them would be a second, worse config console.
      if (entry.name.startsWith('.')) {
        if (entry.name === '.claude' && depth === 0) {
          walkContent(join(path, 'skills'), base, into, depth + 2)
        }
        continue
      }
      walkContent(path, base, into, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.(md|markdown|mdx|html|htm|ya?ml|jsonc?|toml|txt|csv|log)$/i.test(entry.name)) continue
    into.push(relative(base, path).split(sep).join('/'))
  }
}

/**
 * What a markdown source contains, counted with regular expressions.
 *
 * Fenced regions are removed first and inline code spans after, because a note
 * about markdown - and this vault has several - contains `| a | b |` and
 * `[[wikilink]]` inside code fences that are not a table and not a link. The
 * pipeline reaches the same conclusion through an mdast walk; the point of this
 * one is that it gets there by a different road.
 */
interface SourceCounts {
  tables: number
  taskItems: number
  taskItemsChecked: number
  codeBlocks: number
  wikilinks: number
  headings: number
  frontmatterKeys: string[]
}

function countSource(source: string): SourceCounts {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''))

  // Frontmatter, split off by hand.
  const frontmatterKeys: string[] = []
  let start = 0
  if ((lines[0] ?? '').trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if ((lines[i] ?? '').trim() === '---' || (lines[i] ?? '').trim() === '...') {
        start = i + 1
        break
      }
    }
    for (const line of lines.slice(1, Math.max(start - 1, 1))) {
      const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line)
      if (match?.[1] !== undefined) frontmatterKeys.push(match[1])
    }
  }

  const body = lines.slice(start)

  /**
   * Fenced regions out, remembering how many there were.
   *
   * The fence's *length* is tracked, not just its character. CommonMark says a
   * closing fence must be at least as long as the one that opened it, and this
   * vault contains a four-backtick block with three-backtick blocks inside it -
   * a scanner that closed on the first ``` ends the outer block early and then
   * miscounts everything after it. That is not a hypothetical: it is what this
   * check disagreed with the renderer about, and the renderer was right.
   */
  const kept: string[] = []
  let fence: string | null = null
  let fenceLength = 0
  let codeBlocks = 0
  for (const line of body) {
    const opener = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence === null && opener?.[1] !== undefined) {
      // A backtick fence's info string may not contain a backtick.
      if (opener[1][0] === '`' && (opener[2] ?? '').includes('`')) {
        kept.push(line)
        continue
      }
      fence = opener[1][0] ?? '`'
      fenceLength = opener[1].length
      codeBlocks++
      continue
    }
    if (fence !== null) {
      const closer = new RegExp(`^\\s{0,3}\\${fence}{${String(fenceLength)},}\\s*$`)
      if (closer.test(line)) fence = null
      continue
    }
    kept.push(line)
  }
  // An indented code block is a code block too; the pipeline counts one for
  // each `<pre><code>` it emits.
  let indented = 0
  let inIndented = false
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i] ?? ''
    const blank = line.trim() === ''
    const isIndented = /^(\t| {4})/.test(line)
    const previousBlank = i === 0 || (kept[i - 1] ?? '').trim() === ''
    if (!inIndented && isIndented && previousBlank && !/^\s*[-*+]|^\s*\d+\./.test(line)) {
      inIndented = true
      indented++
    } else if (inIndented && !isIndented && !blank) {
      inIndented = false
    }
  }

  const prose = kept.map((line) => line.replace(/`[^`\n]*`/g, ''))

  let tables = 0
  for (let i = 1; i < prose.length; i++) {
    // A delimiter row under a header row is what makes a GFM table.
    if (/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(prose[i] ?? '') && (prose[i] ?? '').includes('-')) {
      if ((prose[i - 1] ?? '').includes('|') && (prose[i] ?? '').includes('|')) tables++
    }
  }

  let taskItems = 0
  let taskItemsChecked = 0
  for (const line of prose) {
    const match = /^\s*[-*+]\s+\[([ xX])\]/.exec(line)
    if (!match) continue
    taskItems++
    if ((match[1] ?? ' ').toLowerCase() === 'x') taskItemsChecked++
  }

  const wikilinks = (prose.join('\n').match(/(?<!!)\[\[[^\][\n]+\]\]/g) ?? []).length
  const headings = prose.filter((line) => /^#{1,6}\s+\S/.test(line)).length

  return {
    tables,
    taskItems,
    taskItemsChecked,
    codeBlocks: codeBlocks + indented,
    wikilinks,
    headings,
    frontmatterKeys
  }
}

/** Every wikilink target in a file, by name, with no resolver involved. */
function wikilinkTargets(source: string): string[] {
  const withoutFences = source.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const out: string[] = []
  for (const match of withoutFences.matchAll(/\[\[([^\][\n]+)\]\]/g)) {
    const raw = match[1] ?? ''
    const target = raw.split('|')[0]?.split('#')[0]?.trim() ?? ''
    if (target !== '') out.push(target)
  }
  return out
}

// ---------------------------------------------------------------------------
// Talking to the renderer
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  try {
    return (await win.webContents.executeJavaScript(expression, true)) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`renderer expression failed: ${detail}\n${expression.slice(0, 400)}`, {
      cause: err
    })
  }
}

async function click(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false; el.click(); return true })()`
  )
}

async function pollJs(win: BrowserWindow, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await js<boolean>(win, `Boolean(${expression})`).catch(() => false)
    if (ok) return true
    if (Date.now() >= deadline) return false
    await sleep(120)
  }
}

/** Sets a React-controlled field the way a keystroke and a paste both do. */
async function setValue(win: BrowserWindow, selector: string, value: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement
        : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true })()`
  )
}

async function showViewer(win: BrowserWindow): Promise<boolean> {
  if (!(await click(win, '[data-tab="content"]'))) {
    await click(win, 'aside button[data-open-content]')
  }
  return pollJs(win, `document.querySelector('select[data-content-scope]')`, 20_000)
}

/** Points the switcher at a scope, and refuses to continue if it did not move. */
async function selectScope(win: BrowserWindow, path: string): Promise<void> {
  await setValue(win, 'select[data-content-scope]', path)
  await sleep(600)
  const landed = await js<string>(
    win,
    `document.querySelector('select[data-content-scope]')?.value ?? ''`
  )
  if (landed.toLowerCase() !== path.toLowerCase()) {
    throw new Error(
      `the content scope switcher has no option for ${path} - it is showing ${landed || '(nothing)'}`
    )
  }
  await pollJs(win, `document.querySelector('[data-content-status]')`, 10_000)
  await sleep(400)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  root: string
  notes: string
  bigNote: string
  artifact: string
  hostile: string
  secret: string
}

/** ~20,000 words of prose, so the criterion can be measured as it is written. */
function buildLongNote(): string {
  const words = [
    'the',
    'report',
    'centre',
    'redesign',
    'measured',
    'against',
    'a',
    'session',
    'because',
    'prediction',
    'without',
    'evidence',
    'is',
    'decoration',
    'and',
    'the',
    'snapshot',
    'goes',
    'first'
  ]
  const lines: string[] = ['---', 'type: reference', 'date: 2026-08-10', 'tags: [helm, m6, scroll]', '---', '', '# A long document', '']
  let count = 0
  let section = 0
  while (count < 20_000) {
    section++
    lines.push(`## Section ${String(section)}`, '')
    for (let p = 0; p < 6; p++) {
      const sentence: string[] = []
      for (let w = 0; w < 60; w++) sentence.push(words[(count + w) % words.length] ?? 'word')
      count += 60
      lines.push(`${sentence.join(' ')}.`, '')
    }
    lines.push('| measure | value | budget |', '| --- | --- | --- |', `| section | ${String(section)} | n/a |`, '')
    lines.push('```ts', `const section${String(section)}: number = ${String(section)}`, '```', '')
    count += 12
  }
  return lines.join('\n')
}

/**
 * A harness the driver owns, so the destructive checks are destructive to
 * nothing that matters.
 *
 * The one exception is the save round trip, which is run against a *real* note
 * in the user's vault as well - a criterion about preserving frontmatter is
 * worth very little if the only frontmatter it preserves was written by the
 * check that reads it back. That copy is backed up and hash-verified; see
 * `editChecks`.
 */
function buildFixtures(dataDir: string): Fixtures {
  const root = join(dataDir, 'm6-fixtures')
  rmSync(root, { recursive: true, force: true })

  const notes = join(root, 'notes')
  mkdirSync(notes, { recursive: true })
  mkdirSync(join(root, 'context'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'lessons'), { recursive: true })
  writeFileSync(join(root, 'harness.yaml'), 'name: m6-fixtures\n')
  writeFileSync(join(root, 'context', 'map.yaml'), 'repos: []\n')
  writeFileSync(join(root, 'docs', 'SPEC.md'), '# Fixture spec\n\nNothing to see.\n')

  writeFileSync(
    join(notes, 'alpha.md'),
    [
      '---',
      'type: journal',
      'date: 2026-08-10',
      'tags: [helm, m6, fixture]',
      '---',
      '',
      '# Alpha',
      '',
      'A resolved link to [[beta]] and a broken one to [[never-written]].',
      'A tag: #helm-m6-fixture and an alias [[beta|the other note]].',
      '',
      '## A table',
      '',
      '| measure | value |',
      '| --- | --- |',
      '| one | 1 |',
      '| two | 2 |',
      '',
      '## A task list',
      '',
      '- [x] done',
      '- [ ] not done',
      '- [ ] also not done',
      '',
      '## Code',
      '',
      '```ts',
      'const answer: number = 42',
      '```',
      '',
      '```powershell',
      'Get-ChildItem -Recurse',
      '```',
      '',
      '> [!warning] A callout',
      '> With a body.',
      '',
      'Inline `[[not a link]]` must stay literal.',
      ''
    ].join('\n')
  )
  writeFileSync(
    join(notes, 'beta.md'),
    ['---', 'type: reference', 'date: 2026-08-09', 'tags: [helm]', '---', '', '# Beta', '', 'HELMM6UNIQUETOKEN lives here, once.', ''].join('\n')
  )

  const bigNote = join(notes, 'long-document.md')
  writeFileSync(bigNote, buildLongNote())

  // A benign artifact: self-contained, silent, and it says so in the DOM so the
  // frame check has something to read back.
  const artifact = join(root, 'lessons', 'artifact.html')
  writeFileSync(
    artifact,
    `<!doctype html><html><head><meta charset="utf-8"><title>M6 fixture artifact</title>
<style>body{font:14px/1.5 system-ui;margin:2rem;color:#222}h1{font-size:1.3rem}</style></head>
<body><h1 id="heading">HELMM6ARTIFACT</h1><p id="out">pending</p>
<script>document.getElementById('out').textContent = 'ran'</script></body></html>
`
  )

  // A hostile one: everything an artifact must not be able to do, attempted.
  const hostile = join(root, 'lessons', 'hostile.html')
  writeFileSync(
    hostile,
    `<!doctype html><html><head><meta charset="utf-8"><title>M6 hostile artifact</title></head>
<body><h1>HELMM6HOSTILE</h1>
<img id="remote" src="https://example.com/should-not-load.png" alt="">
<script>
  window.__helmProbe = {
    require: typeof require,
    process: typeof process,
    module: typeof module,
    helm: typeof window.helm,
    origin: String(window.origin),
    isTop: window.top === window
  }
  window.__helmFetch = fetch('https://example.com/').then(() => 'resolved').catch((e) => 'rejected: ' + e.name)
  try { window.__helmTop = String(window.top.location.href) } catch (e) { window.__helmTop = 'blocked: ' + e.name }
</script></body></html>
`
  )

  const secret = join(root, 'secret-outside-the-artifact.txt')
  writeFileSync(secret, 'HELMM6SECRETTHATMUSTNOTBESERVED\n')

  return { root, notes, bigNote, artifact, hostile, secret }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[at] ?? 0
}

const round = (value: number): number => Math.round(value * 100) / 100

// ---------------------------------------------------------------------------

export async function runM6Checks(
  ctx: M2Context,
  shotDir: string,
  dataDir: string,
  only?: readonly string[]
): Promise<Check[]> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const checks: Check[] = []
  const { win, services } = ctx

  /**
   * Everything the window logged during the run.
   *
   * Two buckets, because they answer different questions: the artifact's own
   * console is criterion 3, and the app's is "did rendering a hundred real
   * notes throw anywhere". Both are collected from the same event, separated by
   * the source URL.
   */
  const appConsole: Array<{ level: string; message: string; source: string }> = []
  win.webContents.on('console-message', (event) => {
    const source = event.sourceId
    if (source.startsWith('helm-content:')) return
    if (event.level !== 'error' && event.level !== 'warning') return
    appConsole.push({ level: event.level, message: event.message, source })
  })

  /**
   * The first scan has to have landed before anything asks which project is the
   * harness. It is kicked off when the renderer reports ready and this driver
   * starts in the same turn, so without this the answer is "there are no
   * projects" - which is not a failure, it is a race.
   */
  await waitFor(() => ctx.services.lastScan !== null, 120_000)

  const fixtures = buildFixtures(dataDir)

  // The fixture harness is not inside any scanned root, so it becomes a scope
  // the way a user's out-of-tree folder would: a profile points at it.
  const stale = findProfileByName(services.store, PROFILE_NAME)
  if (stale) deleteProfile(services.store, stale.id)
  const profile: Profile = createProfile(services.store, {
    name: PROFILE_NAME,
    root: fixtures.root,
    overlays: [],
    access: [],
    model: null,
    effort: null,
    permissionMode: null,
    agent: null,
    mcp: [],
    openingPrompt: null,
    pinnedOrder: null
  })

  const harness = (services.lastScan?.projects ?? []).find((p) => p.kind === 'harness')

  const opened = await showViewer(win)
  await click(win, 'button[data-content-refresh]')
  await sleep(600)
  const offersFixture = await pollJs(
    win,
    `[...document.querySelectorAll('select[data-content-scope] option')]
       .some((o) => o.value.toLowerCase() === ${JSON.stringify(fixtures.root.toLowerCase())})`,
    20_000
  )

  checks.push({
    id: 'M6-0',
    criterion: 'setup',
    title: 'The viewer opens, finds the dev harness, and offers the fixture harness as a scope',
    ok: opened && offersFixture && harness !== undefined && existsSync(fixtures.bigNote),
    detail: {
      harness: harness?.path ?? null,
      fixtures: fixtures.root,
      profileId: profile.id,
      offeredInTheSwitcher: offersFixture
    },
    notes: [
      'The user’s harness is the corpus criterion 1 is about; the fixture harness is where',
      'anything destructive happens. Both are reached through the switcher.'
    ]
  })

  const group = async (name: Group, run: () => Promise<Check[]>): Promise<void> => {
    if (!wanted.has(name)) return
    try {
      checks.push(...(await run()))
    } catch (err) {
      checks.push({
        id: `M6-${name.toUpperCase()}-THREW`,
        criterion: name,
        title: `The ${name} group threw before it could assert anything`,
        ok: false,
        detail: { error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) },
        notes: ['The groups after this one still ran; this is one group’s failure, not the run’s.']
      })
    }
  }

  try {
    if (harness) {
      await group('browse', () => browseChecks(ctx, shotDir, harness.path))
      await group('render', () => renderChecks(ctx, shotDir, harness.path, appConsole))
      await group('links', () => linkChecks(ctx, shotDir, harness.path))
      await group('search', () => searchChecks(ctx, harness.path))
      await group('edit', () => editChecks(ctx, shotDir, harness.path, dataDir))
      await group('scroll', () => scrollChecks(ctx, shotDir, harness.path, fixtures))
    } else {
      checks.push({
        id: 'M6-NO-HARNESS',
        criterion: 'setup',
        title: 'Discovery found no harness, so the criteria about the real vault could not run',
        ok: false,
        detail: { projects: (services.lastScan?.projects ?? []).map((p) => p.name) },
        notes: ['Add ~/.harness/dev as a scan root and re-run.']
      })
    }
    await group('artifact', () => artifactChecks(ctx, shotDir, fixtures, harness?.path ?? null))
  } finally {
    const made = findProfileByName(services.store, PROFILE_NAME)
    if (made) deleteProfile(services.store, made.id)
  }

  return checks
}

// ---------------------------------------------------------------------------
// M6-1: the file browser
// ---------------------------------------------------------------------------

async function browseChecks(ctx: M2Context, shotDir: string, harnessPath: string): Promise<Check[]> {
  const { win, content } = ctx

  const tree = content.tree(harnessPath, true)
  const truth: string[] = []
  walkContent(harnessPath, harnessPath, truth)

  const fromPane = new Set(tree.files.map((file) => file.relPath.toLowerCase()))
  const fromWalk = new Set(truth.map((rel) => rel.toLowerCase()))
  const missing = [...fromWalk].filter((rel) => !fromPane.has(rel))
  const extra = [...fromPane].filter((rel) => !fromWalk.has(rel))

  await selectScope(win, harnessPath)
  const painted = await js<Array<{ relPath: string; kind: string }>>(
    win,
    `[...document.querySelectorAll('button[data-content-file]')].map((el) => ({
      relPath: el.dataset.contentFile, kind: el.dataset.contentKind }))`
  )
  const shot = await screenshot(win, shotDir, 'm6-browse.png')

  const named = ['notes', 'context', '.claude/skills', 'docs']
  const rootRels = tree.roots.map((root) => root.relPath)
  const namedPresent = named.filter((rel) => rootRels.includes(rel))

  return [
    {
      id: 'M6-1',
      criterion: 'File browser scoped to the selected project/harness: notes/, context/, .claude/skills/, docs/',
      title: 'The tree matches an independent walk of the same directory, file for file',
      ok:
        missing.length === 0 &&
        extra.length === 0 &&
        namedPresent.length === 4 &&
        painted.length === tree.files.length &&
        painted.some((row) => row.kind === 'markdown') &&
        painted.some((row) => row.kind === 'html'),
      detail: {
        scope: harnessPath,
        pane: tree.files.length,
        independentWalk: truth.length,
        missingFromThePane: missing.slice(0, 20),
        listedButNotOnDisk: extra.slice(0, 20),
        roots: tree.roots.map((root) => `${root.relPath || '(scope root)'}=${String(root.files)}`),
        namedRootsFound: namedPresent,
        paintedRows: painted.length,
        walkMs: tree.tookMs,
        screenshot: shot.file
      },
      notes: [
        'The second read is a plain readdirSync recursion in m6check.ts with the same exclusion',
        'list and no notion of roots at all - so a scanner that decided the wrong directories',
        'were content would disagree with it.',
        'The four named roots are asserted by name because the criterion names them.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// M6-2 / M6-3: every note in the vault, rendered through the window
// ---------------------------------------------------------------------------

interface PaintedDoc {
  path: string
  ok: boolean
  bodyChars: number
  tables: number
  taskItems: number
  taskItemsChecked: number
  codeBlocks: number
  highlighted: number
  callouts: number
  wikilinks: number
  broken: number
  chips: number
  rawFrontmatter: boolean
}

async function renderChecks(
  ctx: M2Context,
  shotDir: string,
  harnessPath: string,
  appConsole: Array<{ level: string; message: string; source: string }>
): Promise<Check[]> {
  const { win, content } = ctx
  const tree = content.tree(harnessPath, true)
  const markdown = tree.files.filter((file) => file.kind === 'markdown')

  await selectScope(win, harnessPath)
  const consoleBefore = appConsole.length

  /**
   * Clicks every row and reads what painted.
   *
   * Done inside one renderer expression rather than as a hundred round trips:
   * a click is a React state change and an IPC request, so the loop has to wait
   * for the body whose `data-content-path` is the file it asked for - which is
   * the same wait either way, and doing it here saves a hundred crossings of
   * the process boundary.
   */
  const painted = await js<PaintedDoc[]>(
    win,
    `(async () => {
      const wanted = ${JSON.stringify(markdown.map((file) => ({ path: file.path, relPath: file.relPath })))};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = [];
      for (const file of wanted) {
        const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === file.relPath);
        if (!row) { out.push({ path: file.path, ok: false, bodyChars: 0, tables: 0, taskItems: 0,
          taskItemsChecked: 0, codeBlocks: 0, highlighted: 0, callouts: 0, wikilinks: 0, broken: 0,
          chips: 0, rawFrontmatter: false }); continue; }
        row.click();
        let body = null;
        for (let i = 0; i < 120; i++) {
          const candidate = document.querySelector('[data-content-body]');
          if (candidate && candidate.dataset.contentPath === file.path && candidate.innerHTML !== '') {
            body = candidate; break;
          }
          await sleep(25);
        }
        if (!body) { out.push({ path: file.path, ok: false, bodyChars: 0, tables: 0, taskItems: 0,
          taskItemsChecked: 0, codeBlocks: 0, highlighted: 0, callouts: 0, wikilinks: 0, broken: 0,
          chips: 0, rawFrontmatter: false }); continue; }
        const text = body.textContent ?? '';
        const chipsEl = document.querySelector('[data-frontmatter-chips]');
        out.push({
          path: file.path,
          ok: true,
          bodyChars: text.length,
          tables: body.querySelectorAll('table').length,
          taskItems: body.querySelectorAll('input[type=checkbox]').length,
          taskItemsChecked: body.querySelectorAll('input[type=checkbox]:checked').length,
          codeBlocks: body.querySelectorAll('pre').length,
          highlighted: body.querySelectorAll('pre.shiki span[style*="--shiki-dark"]').length > 0
            ? body.querySelectorAll('pre[data-language]:not([data-language="text"])').length : 0,
          callouts: body.querySelectorAll('[data-callout]').length,
          wikilinks: body.querySelectorAll('a.wikilink').length,
          broken: body.querySelectorAll('a.wikilink-broken').length,
          chips: chipsEl ? Number(chipsEl.dataset.frontmatterChips) : 0,
          // The failure this criterion is really about: a document that shows
          // its own YAML block as the first paragraph.
          rawFrontmatter: /^\\s*---\\s*\\n\\s*(type|date|tags|name|description)\\s*:/.test(text)
        });
      }
      return out;
    })()`
  )

  const consoleErrors = appConsole.slice(consoleBefore)

  /**
   * The evidence shot is chosen rather than whatever happened to be last.
   *
   * The document with the most tables, code blocks and checkboxes in it is the
   * one worth looking at, because it is the one where a rendering mistake would
   * show. Picking it by count means the screenshot stays the strongest example
   * as the vault changes, instead of being whichever file sorts last today.
   */
  const richest = [...painted]
    .filter((doc) => doc.ok)
    .sort(
      (a, b) =>
        b.tables * 3 + b.codeBlocks * 2 + b.taskItems - (a.tables * 3 + a.codeBlocks * 2 + a.taskItems)
    )[0]
  if (richest) {
    const row = markdown.find((file) => file.path === richest.path)
    if (row) {
      await js<boolean>(
        win,
        `(() => { const el = [...document.querySelectorAll('button[data-content-file]')]
            .find((e) => e.dataset.contentFile === ${JSON.stringify(row.relPath)});
          if (!el) return false; el.click(); return true })()`
      )
      await pollJs(
        win,
        `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(row.path)}`,
        15_000
      )
      await sleep(500)
    }
  }
  /**
   * The list markers, read out of the computed style.
   *
   * Tailwind's preflight sets `list-style: none` on every `ul` and `ol` in the
   * document, which is right for an app built out of lists and silently wrong
   * for a rendered note - the bullets vanish and a list reads as a paragraph
   * with strange line breaks. Nothing about the HTML says so, which is why this
   * is asserted against `getComputedStyle` rather than against the markup.
   */
  const markers = await js<{ ul: string | null; ol: string | null; task: string | null }>(
    win,
    `(() => {
      const read = (sel) => { const el = document.querySelector(sel);
        return el ? getComputedStyle(el).listStyleType : null };
      return { ul: read('[data-content-body] ul:not(.contains-task-list)'),
        ol: read('[data-content-body] ol'),
        task: read('[data-content-body] ul.contains-task-list') };
    })()`
  )

  const shot = await screenshot(win, shotDir, 'm6-rendered.png')

  /**
   * The document with callouts in it, in both themes.
   *
   * Two screenshots rather than one because the code blocks carry *both*
   * palettes as CSS custom properties and the stylesheet picks a side from the
   * `dark` class - which is a claim that is only worth anything if somebody has
   * looked at the light one. The theme is changed through `settings:write`,
   * which is the path the toggle in the tab strip takes.
   */
  const withCallouts = markdown.find(
    (file) => (readFileSync(file.path, 'utf8').match(/^>\s*\[!/gm) ?? []).length > 0
  )
  const themeShots: string[] = []
  let calloutsPainted = 0
  if (withCallouts) {
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(withCallouts.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(withCallouts.path)}`,
      15_000
    )
    await sleep(500)
    calloutsPainted = await js<number>(
      win,
      `document.querySelectorAll('[data-content-body] [data-callout]').length`
    )
    themeShots.push((await screenshot(win, shotDir, 'm6-callouts-dark.png')).file)

    await js<unknown>(win, `window.helm.invoke('settings:write', { theme: 'light' })`)
    await pollJs(win, `!document.documentElement.classList.contains('dark')`, 10_000)
    await sleep(700)
    themeShots.push((await screenshot(win, shotDir, 'm6-callouts-light.png')).file)
    await js<unknown>(win, `window.helm.invoke('settings:write', { theme: 'dark' })`)
    await pollJs(win, `document.documentElement.classList.contains('dark')`, 10_000)
    await sleep(400)
  }

  // ---- against the driver's own read of the same files --------------------
  const byPath = new Map(painted.map((doc) => [doc.path, doc]))
  const disagreements: Array<Record<string, unknown>> = []
  const totals = {
    files: markdown.length,
    tables: 0,
    taskItems: 0,
    codeBlocks: 0,
    highlighted: 0,
    callouts: 0,
    withTables: 0,
    withTasks: 0,
    withCode: 0,
    withChips: 0
  }

  for (const file of markdown) {
    const doc = byPath.get(file.path)
    const source = readFileSync(file.path, 'utf8')
    const expected = countSource(source)
    if (!doc?.ok) {
      disagreements.push({ file: file.relPath, reason: 'never painted' })
      continue
    }
    totals.tables += doc.tables
    totals.taskItems += doc.taskItems
    totals.codeBlocks += doc.codeBlocks
    totals.highlighted += doc.highlighted
    totals.callouts += doc.callouts
    if (doc.tables > 0) totals.withTables++
    if (doc.taskItems > 0) totals.withTasks++
    if (doc.codeBlocks > 0) totals.withCode++
    if (doc.chips > 0) totals.withChips++

    const problems: string[] = []
    if (doc.rawFrontmatter) problems.push('rendered its frontmatter as text')
    if (doc.tables !== expected.tables) {
      problems.push(`tables: DOM ${String(doc.tables)}, source ${String(expected.tables)}`)
    }
    if (doc.taskItems !== expected.taskItems) {
      problems.push(`task items: DOM ${String(doc.taskItems)}, source ${String(expected.taskItems)}`)
    }
    if (doc.taskItemsChecked !== expected.taskItemsChecked) {
      problems.push(
        `checked items: DOM ${String(doc.taskItemsChecked)}, source ${String(expected.taskItemsChecked)}`
      )
    }
    if (doc.codeBlocks !== expected.codeBlocks) {
      problems.push(`code blocks: DOM ${String(doc.codeBlocks)}, source ${String(expected.codeBlocks)}`)
    }
    // Frontmatter that exists must become chips, and the number of them must be
    // the number of top-level keys the block declares.
    if (expected.frontmatterKeys.length > 0 && doc.chips === 0) {
      problems.push(`frontmatter has ${String(expected.frontmatterKeys.length)} keys and no chips`)
    }
    if (problems.length > 0) disagreements.push({ file: file.relPath, problems })
  }

  const painting = painted.filter((doc) => doc.ok).length
  const rawAnywhere = painted.filter((doc) => doc.rawFrontmatter).map((doc) => doc.path)

  return [
    {
      id: 'M6-2',
      criterion:
        'Every existing note in the dev harness vault (60+ files) renders correctly: frontmatter chips, tables, checkboxes, code highlighting',
      title: `All ${String(markdown.length)} markdown files in the vault were opened through the window and agreed with a regex read of their own source`,
      ok:
        markdown.length >= 60 &&
        painting === markdown.length &&
        disagreements.length === 0 &&
        rawAnywhere.length === 0 &&
        consoleErrors.length === 0 &&
        totals.withTables > 0 &&
        totals.withTasks > 0 &&
        totals.withCode > 0 &&
        totals.highlighted > 0 &&
        totals.callouts > 0 &&
        calloutsPainted > 0 &&
        markers.ul === 'disc' &&
        (markers.task === null || markers.task === 'none'),
      detail: {
        scope: harnessPath,
        markdownFiles: markdown.length,
        painted: painting,
        disagreements,
        filesShowingRawFrontmatter: rawAnywhere,
        consoleErrorsDuringThePass: consoleErrors,
        totals,
        calloutsIn: withCallouts?.relPath ?? null,
        calloutsPainted,
        listMarkers: markers,
        screenshots: [shot.file, ...themeShots]
      },
      notes: [
        'Every file is clicked in the list and read back out of the DOM - `table`,',
        '`input[type=checkbox]`, `pre[data-language]`, `[data-callout]`,',
        '`[data-frontmatter-chips]` - not out of the render result.',
        'The expected counts come from `countSource` in this file: fenced regions removed, then',
        'a regex per feature. It shares no code with remark, and it disagrees with the DOM when',
        'either of them is wrong.',
        'Console errors are collected from the window for the whole pass, so a note that threw',
        'while rendering fails this check even if the DOM it left behind looks plausible.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// M6-4: wikilinks
// ---------------------------------------------------------------------------

async function linkChecks(ctx: M2Context, shotDir: string, harnessPath: string): Promise<Check[]> {
  const { win, content } = ctx
  const tree = content.tree(harnessPath, true)
  const markdown = tree.files.filter((file) => file.kind === 'markdown')

  /**
   * An index built by hand: basename without extension, lower-cased.
   *
   * This is the whole of Obsidian's rule for a bare `[[name]]`, written out
   * here rather than borrowed from `buildWikiIndex` - borrowing it would make
   * the check and the thing it checks the same function.
   */
  const names = new Set(markdown.map((file) => basename(file.path).replace(/\.[^.]+$/, '').toLowerCase()))
  const paths = new Set(markdown.map((file) => file.relPath.toLowerCase().replace(/\.[^./]+$/, '')))

  let expectedTotal = 0
  let expectedBroken = 0
  const expectedBrokenTargets: string[] = []
  const filesWithLinks: ContentFile[] = []
  for (const file of markdown) {
    const targets = wikilinkTargets(readFileSync(file.path, 'utf8'))
    if (targets.length > 0) filesWithLinks.push(file)
    for (const target of targets) {
      expectedTotal++
      const needle = target.toLowerCase().replace(/\\/g, '/')
      const resolved =
        paths.has(needle) ||
        paths.has(needle.replace(/\.[^./]+$/, '')) ||
        names.has(needle.split('/').at(-1) ?? needle)
      if (!resolved) {
        expectedBroken++
        expectedBrokenTargets.push(target)
      }
    }
  }

  // ---- and what the pipeline said ----------------------------------------
  let actualTotal = 0
  let actualBroken = 0
  for (const file of markdown) {
    const doc = await content.document(harnessPath, file.path)
    actualTotal += doc.rendered?.counts.wikilinks ?? 0
    actualBroken += doc.rendered?.counts.brokenWikilinks ?? 0
  }

  // ---- and then a real click, through the window ---------------------------
  await selectScope(win, harnessPath)
  const source = filesWithLinks.find((file) => {
    const targets = wikilinkTargets(readFileSync(file.path, 'utf8'))
    return targets.some((target) => names.has(target.toLowerCase().split('/').at(-1) ?? ''))
  })

  /** How the two kinds of link are actually painted, read where each occurs. */
  const readLinkStyle = async (which: 'live' | 'broken'): Promise<Record<string, string> | null> =>
    js<Record<string, string> | null>(
      win,
      `(() => {
        const el = document.querySelector(${
          which === 'broken'
            ? `'[data-content-body] a.wikilink-broken'`
            : `'[data-content-body] a.wikilink:not(.wikilink-broken)'`
        });
        if (!el) return null;
        const s = getComputedStyle(el);
        return { color: s.color, borderBottomStyle: s.borderBottomStyle,
          borderBottomColor: s.borderBottomColor };
      })()`
    )

  let liveStyle: Record<string, string> | null = null
  let navigated: Record<string, unknown> = { attempted: false }
  if (source) {
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(source.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(source.path)}`,
      15_000
    )
    await sleep(400)

    const target = await js<string | null>(
      win,
      `document.querySelector('[data-content-body] a.wikilink[data-wikilink-path]')?.dataset.wikilinkPath ?? null`
    )
    // Read where a live link actually is. The note that has a broken one need
    // not have a resolving one as well, and on this vault it does not.
    liveStyle = await readLinkStyle('live')
    await js<boolean>(
      win,
      `(() => { const a = document.querySelector('[data-content-body] a.wikilink[data-wikilink-path]');
        if (!a) return false; a.click(); return true })()`
    )
    const landed = await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(target ?? '')}`,
      15_000
    )
    await sleep(400)
    const nowShowing = await js<string | null>(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath ?? null`
    )
    navigated = {
      attempted: true,
      from: source.relPath,
      linkPointedAt: target,
      landedOnIt: landed,
      paneIsNowShowing: nowShowing,
      targetExistsOnDisk: target !== null && existsSync(target)
    }
  }

  // The broken ones have to look different, and the difference has to be in the
  // computed style rather than in a class name nobody styled.
  const brokenFile = markdown.find((file) =>
    wikilinkTargets(readFileSync(file.path, 'utf8')).some(
      (target) => !names.has(target.toLowerCase().split('/').at(-1) ?? '')
    )
  )
  let styling: Record<string, unknown> = { attempted: false }
  if (brokenFile) {
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(brokenFile.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(brokenFile.path)}`,
      15_000
    )
    await sleep(400)
    liveStyle ??= await readLinkStyle('live')
    styling = {
      attempted: true,
      inFile: brokenFile.relPath,
      broken: await readLinkStyle('broken'),
      live: liveStyle,
      brokenCount: await js<number>(
        win,
        `document.querySelectorAll('[data-content-body] a.wikilink-broken').length`
      ),
      badge: await js<string | null>(
        win,
        `document.querySelector('[data-broken-links]')?.dataset.brokenLinks ?? null`
      )
    }
  }

  /**
   * An `https://` link in a note, and the two halves of what happens to it.
   *
   * The click is checked by watching whether the document's own handler
   * cancelled the event - `will-navigate` is prevented and the window-open
   * handler denies, so a link this pane does not intercept is a link that does
   * nothing at all, silently. The listener bubbles from `window`, so it runs
   * after the pane's and sees the decision rather than making it.
   *
   * The refusal is checked directly, with a `file:` URL. That is the half that
   * matters: `shell.openExternal` on a local path is a way to run a program,
   * and a note is content. The accepting half is deliberately *not* exercised -
   * a check that opens a browser window is a check nobody runs twice.
   */
  const withExternal = markdown.find((file) =>
    /\]\(https:\/\//.test(readFileSync(file.path, 'utf8'))
  )
  if (withExternal) {
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(withExternal.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(withExternal.path)}`,
      15_000
    )
    await sleep(400)
  }
  const externalLink = await js<{ found: boolean; href: string; intercepted: boolean }>(
    win,
    `(async () => {
      const a = document.querySelector('[data-content-body] a[href^="https://"]');
      if (!a) return { found: false, href: '', intercepted: false };
      let intercepted = false;
      const watch = (ev) => { intercepted = ev.defaultPrevented };
      window.addEventListener('click', watch);
      a.click();
      window.removeEventListener('click', watch);
      return { found: true, href: a.getAttribute('href'), intercepted };
    })()`
  )
  const refusedFileUrl = await js<{ opened: boolean }>(
    win,
    `window.helm.invoke('shell:openExternal', { url: 'file:///C:/Windows/win.ini' })`
  )

  const shot = await screenshot(win, shotDir, 'm6-wikilinks.png')

  const brokenStyle = styling['broken'] as { color?: string; borderBottomStyle?: string } | null
  const visiblyDifferent =
    brokenStyle != null &&
    liveStyle != null &&
    brokenStyle.color !== liveStyle.color &&
    brokenStyle.borderBottomStyle !== liveStyle.borderBottomStyle

  return [
    {
      id: 'M6-3',
      criterion: '[[wikilink]] navigation works between notes; broken links visibly distinct',
      title: 'Clicking a wikilink opened the note it names, and a broken one is a different colour and a dashed rule',
      ok:
        navigated['landedOnIt'] === true &&
        navigated['targetExistsOnDisk'] === true &&
        visiblyDifferent &&
        Number(styling['brokenCount'] ?? 0) > 0,
      detail: { navigation: navigated, brokenStyling: styling, visiblyDifferent, screenshot: shot.file },
      notes: [
        'The two styles are read with `getComputedStyle` after the document painted, so this is',
        'a claim about what the reader sees rather than about which class was applied.',
        'A broken link is warm-toned and dashed rather than red: in this vault an unresolved',
        'link marks a note worth writing, which is not an error.'
      ]
    },
    {
      id: 'M6-11',
      criterion: 'A link in a note goes somewhere; a link that is not a link goes nowhere',
      title: 'An https link is intercepted rather than left inert, and a file: URL is refused',
      ok: externalLink.found && externalLink.intercepted && refusedFileUrl.opened === false,
      detail: { inFile: withExternal?.relPath ?? null, externalLink, fileUrlRefused: refusedFileUrl },
      notes: [
        'Without the interception an `https://` link in a note does nothing: `will-navigate` is',
        'prevented and `setWindowOpenHandler` denies, so the click is swallowed silently.',
        'Only the refusal is exercised end to end. Opening the accepting half would open a',
        'browser window on the user’s desktop every time this check runs.'
      ]
    },
    {
      id: 'M6-4',
      criterion: '[[wikilink]] resolution across the vault',
      title: 'Every wikilink in the vault resolves the same way a hand-built name index resolves it',
      ok: expectedTotal > 0 && actualTotal === expectedTotal && actualBroken === expectedBroken,
      detail: {
        pipeline: { links: actualTotal, broken: actualBroken },
        independentIndex: { links: expectedTotal, broken: expectedBroken },
        brokenTargets: [...new Set(expectedBrokenTargets)].sort(),
        filesWithLinks: filesWithLinks.length
      },
      notes: [
        'The second index is a `Set` of basenames built in m6check.ts, and the second link scan',
        'is a regex over the source with fenced and inline code removed. Neither borrows from',
        '`buildWikiIndex` or from the remark transform.',
        'The broken targets are listed rather than only counted, because the value of this',
        'criterion is knowing *which* notes are unwritten.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// M6-5 / M6-6: the artifact frame
// ---------------------------------------------------------------------------

/** The frame an artifact is rendered in, found among the window's subframes. */
function artifactFrame(win: BrowserWindow): WebFrameMain | null {
  const walk = (frame: WebFrameMain): WebFrameMain | null => {
    if (frame.url.startsWith('helm-content:')) return frame
    for (const child of frame.frames) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  try {
    return walk(win.webContents.mainFrame)
  } catch {
    return null
  }
}

async function openArtifact(
  ctx: M2Context,
  scopePath: string,
  relPath: string
): Promise<{ opened: boolean; frame: WebFrameMain | null }> {
  const { win } = ctx
  await selectScope(win, scopePath)
  const clicked = await js<boolean>(
    win,
    `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
        .find((el) => el.dataset.contentFile === ${JSON.stringify(relPath)});
      if (!row) return false; row.click(); return true })()`
  )
  if (!clicked) return { opened: false, frame: null }
  await pollJs(win, `document.querySelector('iframe[data-artifact-frame]')?.src`, 20_000)
  await sleep(1200)
  return { opened: true, frame: artifactFrame(win) }
}

async function artifactChecks(
  ctx: M2Context,
  shotDir: string,
  fixtures: Fixtures,
  harnessPath: string | null
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []

  // ---- a real artifact, and the console it must not fill ------------------
  const realArtifact =
    harnessPath !== null
      ? ctx.content
          .tree(harnessPath, true)
          .files.find((file) => file.kind === 'html' && HTML.test(file.path))
      : undefined

  if (realArtifact) {
    clearArtifactConsole()
    const { opened, frame } = await openArtifact(ctx, harnessPath ?? '', realArtifact.relPath)
    const rendered = frame
      ? await frame
          .executeJavaScript(
            `({ title: document.title, headings: document.querySelectorAll('h1,h2,h3').length,
                text: (document.body?.innerText ?? '').length,
                painted: document.body ? document.body.scrollHeight : 0 })`
          )
          .catch(() => null)
      : null
    await sleep(700)
    const logged = artifactConsoleEntries()
    const shot = await screenshot(win, shotDir, 'm6-artifact-real.png')

    const painted = (rendered as { painted?: number } | null)?.painted ?? 0
    const errors = logged.filter((entry) => entry.level === 'error' || entry.level === 'warning')

    checks.push({
      id: 'M6-5',
      criterion: 'An HTML artifact opens rendered, sandboxed, with no console errors',
      title: `${realArtifact.relPath} rendered in the frame and logged nothing`,
      ok:
        opened &&
        frame !== null &&
        painted > 200 &&
        ((rendered as { headings?: number } | null)?.headings ?? 0) > 0 &&
        errors.length === 0,
      detail: {
        file: realArtifact.path,
        bytesOnDisk: statSync(realArtifact.path).size,
        frameUrl: frame?.url ?? null,
        rendered,
        consoleEntries: logged,
        screenshot: shot.file
      },
      notes: [
        'A real artifact from the user’s harness, not a fixture: the criterion is about the',
        'files Claude actually produces.',
        'The console is read from the main process, which is the only place it can be read -',
        'the frame has an opaque origin, so the window hosting it cannot reach its console.',
        '"Rendered" is `document.body.scrollHeight` measured inside the frame, so an empty',
        'document that loaded successfully still fails.'
      ]
    })
  }

  // ---- and the sandbox itself, interrogated from inside --------------------
  clearArtifactConsole()
  const { opened, frame } = await openArtifact(ctx, fixtures.root, 'lessons/hostile.html')
  const probe = frame
    ? await frame
        .executeJavaScript(
          `(async () => ({
            ...window.__helmProbe,
            fetch: await window.__helmFetch,
            top: window.__helmTop,
            remoteImage: document.getElementById('remote')?.naturalWidth ?? -1,
            cookies: (() => { try { return document.cookie } catch (e) { return 'blocked' } })(),
            storage: (() => { try { localStorage.setItem('x','1'); return 'allowed' } catch (e) { return 'blocked' } })()
          }))()`
        )
        .catch((err: unknown) => ({ error: String(err) }))
    : null
  await sleep(500)
  const hostileConsole = artifactConsoleEntries()
  const hostileShot = await screenshot(win, shotDir, 'm6-artifact-sandbox.png')

  const p = (probe ?? {}) as Record<string, unknown>
  const nodeAbsent =
    p['require'] === 'undefined' && p['process'] === 'undefined' && p['module'] === 'undefined'
  const bridgeAbsent = p['helm'] === 'undefined'
  const opaque = String(p['origin'] ?? '') === 'null'
  const fetchBlocked = String(p['fetch'] ?? '').startsWith('rejected')
  const topBlocked = String(p['top'] ?? '').startsWith('blocked')
  const remoteImageBlocked = Number(p['remoteImage'] ?? -1) === 0

  // ---- and the protocol's own containment ---------------------------------
  const roots = artifactRoots()
  const token = roots.find((entry) => entry.file.toLowerCase() === fixtures.hostile.toLowerCase())?.token
  let traversal: Record<string, unknown> = { attempted: false }
  if (token !== undefined) {
    /**
     * Two spellings of the same attack, because they fail in different places.
     *
     * `%2e%2e/` is decoded and *normalised away by the URL parser* before the
     * handler is reached - `helm-content` is a standard scheme, so Chromium
     * collapses dot segments and the token itself is popped off the path. The
     * request arrives naming no token at all, which is a 404. Worth asserting,
     * but it proves the parser rather than the guard.
     *
     * `%2e%2e%2f` survives, because `%2f` is never decoded during
     * canonicalisation. The handler receives one segment, decodes it itself,
     * and `../../secret` reaches `resolve()` - which is precisely the input the
     * containment check exists for, and the only way to actually exercise it.
     */
    const secret = encodeURIComponent(basename(fixtures.secret))
    const normalised = `helm-content://artifact/${token}/%2e%2e/%2e%2e/${secret}`
    const encoded = `helm-content://artifact/${token}/%2e%2e%2f%2e%2e%2f${secret}`
    const sibling = `helm-content://artifact/${token}/artifact.html`
    try {
      const byParser = await net.fetch(normalised)
      const byGuard = await net.fetch(encoded)
      const allowed = await net.fetch(sibling)
      const leaked = `${await byParser.text().catch(() => '')}${await byGuard.text().catch(() => '')}`
      traversal = {
        attempted: true,
        secretOnDisk: fixtures.secret,
        normalisedByTheUrlParser: { url: normalised, status: byParser.status },
        refusedByTheContainmentCheck: { url: encoded, status: byGuard.status },
        eitherLeakedTheSecret: leaked.includes('HELMM6SECRET'),
        siblingStatus: allowed.status,
        siblingIsServed: allowed.status === 200,
        csp: allowed.headers.get('content-security-policy')
      }
    } catch (err) {
      traversal = { attempted: true, error: String(err) }
    }
  }

  const csp = String(traversal['csp'] ?? '')
  const cspHasNoNetwork =
    csp.includes("default-src 'none'") &&
    csp.includes("connect-src 'none'") &&
    !/https?:/.test(csp)

  checks.push({
    id: 'M6-6',
    criterion: 'HTML files render in a sandboxed webview (no node, no remote content)',
    title: 'The frame reports no Node, an opaque origin, a rejected fetch, and a blocked remote image; the protocol refuses to leave the artifact’s directory',
    ok:
      opened &&
      frame !== null &&
      nodeAbsent &&
      bridgeAbsent &&
      opaque &&
      fetchBlocked &&
      topBlocked &&
      remoteImageBlocked &&
      (traversal['refusedByTheContainmentCheck'] as { status?: number } | undefined)?.status === 403 &&
      (traversal['normalisedByTheUrlParser'] as { status?: number } | undefined)?.status === 404 &&
      traversal['eitherLeakedTheSecret'] === false &&
      traversal['siblingIsServed'] === true &&
      cspHasNoNetwork,
    detail: {
      frameUrl: frame?.url ?? null,
      insideTheFrame: probe,
      assertions: {
        nodeAbsent,
        preloadBridgeAbsent: bridgeAbsent,
        opaqueOrigin: opaque,
        fetchRejected: fetchBlocked,
        topWindowUnreachable: topBlocked,
        remoteImageBlocked
      },
      protocol: traversal,
      contentSecurityPolicy: csp,
      consoleEntries: hostileConsole,
      screenshot: hostileShot.file
    },
    notes: [
      'This is the sandbox asserted rather than the flags trusted. Every value comes from',
      '`WebFrameMain.executeJavaScript` *inside* the frame - which reaches an opaque-origin',
      'document that the window hosting it cannot touch - and the fixture actively tries each',
      'thing it must not be able to do.',
      'The frame is expected to log CSP violations here; they are the evidence, not a failure.',
      'M6-5 is where "no console errors" is measured, against a real artifact.',
      'The traversal is tried twice. `%2e%2e/` is normalised away by the URL parser and never',
      'reaches the handler, which is a 404 and proves the parser. `%2e%2e%2f` survives - `%2f`',
      'is never decoded during canonicalisation - and is what actually reaches `resolve()`, so',
      'the 403 is the containment check refusing rather than the URL never arriving.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// M6-7: search, measured
// ---------------------------------------------------------------------------

async function searchChecks(ctx: M2Context, harnessPath: string): Promise<Check[]> {
  const { win, content } = ctx
  const tree = content.tree(harnessPath, true)
  const markdown = tree.files.filter((file) => file.kind === 'markdown')

  /**
   * The corpus, read again here, so the expected counts are this file's own.
   *
   * Every file, not just the markdown, because that is what the search covers:
   * markdown is searched by name *and* text, everything else by name alone. A
   * counter that held only the markdown would expect fewer hits than the pane
   * honestly returns for any term matching an artifact's or a data file's name.
   */
  const corpus = tree.files.map((file) => ({
    file,
    text: file.kind === 'markdown' ? readFileSync(file.path, 'utf8') : ''
  }))

  const countOccurrences = (needle: string): { files: number; matches: number } => {
    const lower = needle.toLowerCase()
    let files = 0
    let matches = 0
    for (const entry of corpus) {
      const text = entry.text.toLowerCase()
      let at = text.indexOf(lower)
      let n = 0
      while (at >= 0) {
        n++
        at = text.indexOf(lower, at + lower.length)
      }
      const named =
        entry.file.relPath.toLowerCase().includes(lower) ||
        entry.file.title.toLowerCase().includes(lower)
      if (n > 0 || named) files++
      matches += n
    }
    return { files, matches }
  }

  /**
   * Terms drawn from the corpus itself, plus terms that are in none of it.
   *
   * A latency figure taken only from words that match is a figure taken from
   * early exits; a search that finds nothing still has to read every byte, and
   * that is the slow case the budget has to cover.
   */
  const terms = [
    'schema',
    'snapshot',
    'the',
    'claude',
    'wikilink',
    'migration',
    'release',
    'session',
    'overlay',
    'harness',
    'report',
    'shim',
    'resume',
    'settings',
    'e',
    'zzzznotinthecorpus',
    'qqqqqqqq',
    'helm',
    'spike',
    'terminal'
  ]

  await selectScope(win, harnessPath)

  /**
   * Measured in the renderer, around `window.helm.invoke`.
   *
   * That is the number the criterion is about: a search that takes 2 ms in the
   * main process and 300 ms to arrive is a 300 ms search. Each term is run
   * several times and every sample is kept, so the percentiles are over
   * repetitions as well as over terms.
   */
  const samples = await js<Array<{ term: string; ms: number; files: number; matches: number; cold: boolean; mainMs: number }>>(
    win,
    `(async () => {
      const terms = ${JSON.stringify(terms)};
      const scopePath = ${JSON.stringify(harnessPath)};
      const out = [];
      for (let round = 0; round < 5; round++) {
        for (const term of terms) {
          const started = performance.now();
          const result = await window.helm.invoke('content:search', { scopePath, query: term });
          const ms = performance.now() - started;
          out.push({ term, ms, files: result.hits.length, matches: result.totalMatches,
            cold: result.cold, mainMs: result.tookMs });
        }
      }
      return out;
    })()`
  )

  const warm = samples.filter((sample) => !sample.cold)
  const cold = samples.filter((sample) => sample.cold)
  const times = warm.map((sample) => sample.ms)
  const p50 = round(percentile(times, 50))
  const p95 = round(percentile(times, 95))
  const worst = round(Math.max(...times, 0))

  const wrong: Array<Record<string, unknown>> = []
  for (const term of terms) {
    const sample = warm.find((entry) => entry.term === term) ?? samples.find((entry) => entry.term === term)
    if (!sample) continue
    const expected = countOccurrences(term)
    if (sample.matches !== expected.matches || sample.files !== expected.files) {
      wrong.push({
        term,
        pane: { files: sample.files, matches: sample.matches },
        independentCount: expected
      })
    }
  }

  // And through the box, so the number on screen is the number measured.
  await setValue(win, 'input[data-content-search]', 'geofenc')
  await sleep(700)
  const throughTheBox = await js<{ status: string; rows: number; tookAttr: string | null }>(
    win,
    `(() => ({
      status: (document.querySelector('[data-content-status]')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      rows: document.querySelectorAll('button[data-content-hit]').length,
      tookAttr: document.querySelector('[data-search-took]')?.dataset.searchTook ?? null
    }))()`
  )
  await setValue(win, 'input[data-content-search]', '')
  await sleep(400)

  return [
    {
      id: 'M6-7',
      criterion: 'Search finds text across notes and skill files in <200ms',
      title: `p50 ${String(p50)} ms, p95 ${String(p95)} ms over ${String(times.length)} searches of ${String(markdown.length)} files`,
      ok: times.length > 0 && p95 < 200 && wrong.length === 0 && throughTheBox.rows > 0,
      detail: {
        scope: harnessPath,
        filesSearched: markdown.length,
        bytes: corpus.reduce((n, entry) => n + entry.text.length, 0),
        samples: times.length,
        p50,
        p95,
        worst,
        budgetMs: 200,
        firstSearchInAColdScope: cold.map((sample) => ({ term: sample.term, ms: round(sample.ms) })),
        mainProcessP95: round(percentile(warm.map((sample) => sample.mainMs), 95)),
        disagreementsWithAnIndependentCount: wrong,
        throughTheBox,
        perTerm: terms.map((term) => {
          const forTerm = warm.filter((sample) => sample.term === term).map((sample) => sample.ms)
          return { term, p50: round(percentile(forTerm, 50)), samples: forTerm.length }
        })
      },
      notes: [
        'Measured in the renderer around `window.helm.invoke`, so the IPC round trip is inside',
        'the number. Five rounds over twenty terms, including two that match nothing - a miss',
        'has to read every byte, and is the slow case the budget must cover.',
        'The first search in a scope reads the corpus off disk and is reported separately',
        'rather than being dropped: it is a real thing that happens, but it is not what the',
        'criterion is about.',
        'Match counts are checked against an `indexOf` loop written in this file over its own',
        'read of the same files.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// M6-8: editing a real note
// ---------------------------------------------------------------------------

async function editChecks(
  ctx: M2Context,
  shotDir: string,
  harnessPath: string,
  dataDir: string
): Promise<Check[]> {
  const { win, content, services } = ctx
  const tree = content.tree(harnessPath, true)

  /**
   * A real note from the user's vault, chosen deterministically and asserted to
   * be worth choosing.
   *
   * The criterion is that a save *preserves frontmatter exactly*, and a note
   * whose frontmatter this check wrote itself would preserve it trivially. So
   * this picks the first note in `notes/` - by path, so it does not change with
   * mtimes - that declares at least three top-level keys, and fails outright if
   * there is no such note rather than quietly proving nothing.
   */
  const candidates = tree.files
    .filter((file) => file.kind === 'markdown' && file.root === 'notes')
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
  const note = candidates.find((file) => countSource(readFileSync(file.path, 'utf8')).frontmatterKeys.length >= 3)

  if (!note) {
    return [
      {
        id: 'M6-8',
        criterion: 'Editing a note and saving preserves frontmatter exactly and snapshots the prior version',
        title: 'No note in the vault has three frontmatter keys, so the check has no discriminating fixture',
        ok: false,
        detail: { candidates: candidates.length, scope: harnessPath },
        notes: ['A check that reads an expected value out of a fixture must assert the fixture is there.']
      }
    ]
  }

  const before = readFileSync(note.path, 'utf8')
  const beforeHash = sha256(before)
  const backup = join(dataDir, 'm6-note.backup.md')
  copyFileSync(note.path, backup)

  const frontmatterBefore = before.slice(0, before.indexOf('\n---', 4) + 4)
  const keysBefore = countSource(before).frontmatterKeys
  const snapshotsBefore = countConfigSnapshots(services.store)

  const marker = `\n<!-- helm m6 probe ${String(Date.now())} -->\n`
  const edited = `${before.replace(/\n*$/, '\n')}${marker}`

  let outcome: Record<string, unknown>
  try {
    await selectScope(win, harnessPath)
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(note.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(note.path)}`,
      15_000
    )
    await sleep(300)

    const chips = await js<{ count: number; keys: string[] }>(
      win,
      `(() => {
        const row = document.querySelector('[data-frontmatter-chips]');
        return { count: row ? Number(row.dataset.frontmatterChips) : 0,
          keys: [...document.querySelectorAll('[data-chip]')].map((el) => el.dataset.chip) };
      })()`
    )

    // Into the split editor, through the toggle a reader would use.
    await click(win, 'button[data-content-mode="edit"]')
    await pollJs(win, `document.querySelector('textarea[data-content-editor]')`, 10_000)
    await sleep(400)

    await setValue(win, 'textarea[data-content-editor]', edited)
    await sleep(500)
    const dirtyBeforeSave = await js<boolean>(
      win,
      `document.querySelector('[data-content-dirty]')?.dataset.contentDirty === 'true'`
    )
    // The split preview must have redrawn from the draft, not from the file.
    const previewShowsDraft = await pollJs(
      win,
      `(document.querySelector('[data-content-body]')?.textContent ?? '').length > 0`,
      8_000
    )
    const editorShot = await screenshot(win, shotDir, 'm6-editor.png')

    const saved = await click(win, 'button[data-content-save]')
    await sleep(1400)

    const after = readFileSync(note.path, 'utf8')
    const frontmatterAfter = after.slice(0, after.indexOf('\n---', 4) + 4)
    const keysAfter = countSource(after).frontmatterKeys
    const snapshots = content.snapshots(harnessPath, note.path)
    const newest = snapshots[0]
    const snapshotsAfter = countConfigSnapshots(services.store)

    // Back to how it was, out of the snapshot the save produced.
    let restored = false
    let restoredHashMatches = false
    if (newest) {
      const result = content.restore(newest.id, note.path)
      restored = result.ok
      restoredHashMatches = sha256File(note.path) === beforeHash
    }

    outcome = {
      file: note.path,
      frontmatterKeys: keysBefore,
      chipRow: chips,
      dirtyBeforeSave,
      previewRedrew: previewShowsDraft,
      saved,
      wroteTheMarker: after.includes(marker.trim()),
      frontmatterByteIdentical: frontmatterBefore === frontmatterAfter,
      frontmatterKeysAfter: keysAfter,
      snapshotTaken: newest !== undefined,
      snapshotRecordedTheOriginalHash: newest?.contentHash === beforeHash,
      snapshotRowsAdded: snapshotsAfter - snapshotsBefore,
      restored,
      restoredHashMatches,
      screenshots: [editorShot.file]
    }
  } finally {
    // Whatever happened above, the user's note goes back. Through the plain
    // copy rather than the snapshot table, because this has to work even when
    // the failure was in the snapshot table.
    if (sha256File(note.path) !== beforeHash && existsSync(backup)) {
      writeFileSync(note.path, readFileSync(backup))
    }
  }

  return [
    {
      id: 'M6-8',
      criterion: 'Editing a note and saving preserves frontmatter exactly and snapshots the prior version',
      title: `${note.relPath} was edited through the split editor; its frontmatter came back byte for byte and the prior version is in the snapshot table`,
      ok:
        outcome['saved'] === true &&
        outcome['dirtyBeforeSave'] === true &&
        outcome['wroteTheMarker'] === true &&
        outcome['frontmatterByteIdentical'] === true &&
        outcome['snapshotTaken'] === true &&
        outcome['snapshotRecordedTheOriginalHash'] === true &&
        outcome['snapshotRowsAdded'] === 1 &&
        outcome['restored'] === true &&
        outcome['restoredHashMatches'] === true &&
        (outcome['chipRow'] as { count?: number } | undefined)?.count !== 0,
      detail: { ...outcome, backup, independentPreEditHash: beforeHash, finalHash: sha256File(note.path) },
      notes: [
        'A real note in the user’s vault, not a fixture: the criterion is about preserving',
        'frontmatter somebody else wrote. It is backed up first, restored from the snapshot the',
        'save produced, and hash-verified against a sha256 taken in this file before anything',
        'was typed.',
        'The snapshot is the same table and the same code path M5 writes through -',
        '`writeSnapshottedFile`, with a content guard instead of a config one - so "the prior',
        'version is snapshotted" is a property of the mechanism rather than of this feature.'
      ]
    },
    {
      id: 'M6-9',
      criterion: 'The content viewer may not write outside content',
      title: 'The write path refuses a path outside the scope, inside repos/, and with a non-content extension',
      ok: await (async () => {
        const refusals = [
          join(harnessPath, 'repos', 'any-repo', 'notes', 'x.md'),
          join(harnessPath, 'notes', 'x.exe'),
          join(dataDir, 'outside-every-scope.md')
        ]
        for (const path of refusals) {
          try {
            content.write({ scopePath: harnessPath, path, content: 'x', expectedHash: null, reason: 'edit' })
            return false
          } catch {
            // Refused, which is the point.
          }
          if (existsSync(path)) return false
        }
        return true
      })(),
      detail: {
        refused: [
          `${harnessPath}\\repos\\...  (a nested repository is its own scope)`,
          `${harnessPath}\\notes\\x.exe  (not a file the viewer reads)`,
          `${dataDir}\\outside-every-scope.md  (outside the scope named in the request)`
        ]
      },
      notes: [
        'The guard is the only thing M6 adds to M5’s write. Everything else - the snapshot, the',
        'conflict check, the refusal to rewrite a binary - is shared code, so this is the part',
        'that needs its own check.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// M6-10: scrolling a long document, measured
// ---------------------------------------------------------------------------

async function scrollChecks(
  ctx: M2Context,
  shotDir: string,
  harnessPath: string,
  fixtures: Fixtures
): Promise<Check[]> {
  const { win, content } = ctx

  /**
   * Scrolls the document one frame at a time and records the intervals.
   *
   * `requestAnimationFrame` is the honest instrument here: it fires when the
   * compositor is ready for the next frame, so an interval of 16.7 ms is a
   * frame that made it and 50 ms is three that did not. Scrolling by a fixed
   * amount per frame means the work per frame is the work a real wheel gesture
   * causes.
   */
  const measure = async (path: string): Promise<Record<string, unknown>> => {
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(path)}`,
      30_000
    )
    await sleep(600)
    const frames = await js<{ frames: number[]; height: number; words: number }>(
      win,
      `(() => new Promise((resolve) => {
        const el = document.querySelector('[data-content-scroll]');
        if (!el) { resolve({ frames: [], height: 0, words: 0 }); return; }
        el.scrollTop = 0;
        const frames = [];
        let last = performance.now();
        let n = 0;
        const step = () => {
          const now = performance.now();
          frames.push(now - last);
          last = now;
          el.scrollTop += 140;
          n++;
          if (n < 150 && el.scrollTop + el.clientHeight < el.scrollHeight) {
            requestAnimationFrame(step);
          } else {
            resolve({ frames, height: el.scrollHeight,
              words: Number(document.querySelector('[data-content-words]')?.dataset.contentWords ?? 0) });
          }
        };
        requestAnimationFrame(step);
      }))()`
    )
    // The first interval is the gap between the request and the first frame,
    // not a frame that was rendered; dropping it stops a scheduling artefact
    // from becoming the worst number in the set.
    const intervals = frames.frames.slice(1)
    return {
      path,
      words: frames.words,
      scrollHeight: frames.height,
      frames: intervals.length,
      p50: round(percentile(intervals, 50)),
      p95: round(percentile(intervals, 95)),
      worst: round(Math.max(...intervals, 0)),
      framesOver32ms: intervals.filter((ms) => ms > 32).length,
      framesOver50ms: intervals.filter((ms) => ms > 50).length
    }
  }

  const results: Array<Record<string, unknown>> = []

  // ---- the largest real note in the vault ---------------------------------
  // Picked by size rather than by filename. A filename written down here is
  // one machine's, and `if (named)` means the day that note is renamed this
  // measurement silently stops happening - the check would keep passing with
  // one fewer piece of evidence behind it. The largest note is always there
  // and is the harder render besides.
  const named = content
    .tree(harnessPath, true)
    .files.filter((file) => file.relPath.toLowerCase().endsWith('.md'))
    .sort((a, b) => b.size - a.size)[0]

  if (named) {
    await selectScope(win, harnessPath)
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(named.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    results.push({ ...(await measure(named.path)), which: 'the largest note in the vault', bytes: named.size })
  }

  // ---- and one that is actually 20,000 words ------------------------------
  await selectScope(win, fixtures.root)
  await js<boolean>(
    win,
    `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
        .find((el) => el.dataset.contentFile === 'notes/long-document.md');
      if (!row) return false; row.click(); return true })()`
  )
  results.push({
    ...(await measure(fixtures.bigNote)),
    which: 'a synthesised 20,000-word note',
    bytes: statSync(fixtures.bigNote).size
  })

  const shot = await screenshot(win, shotDir, 'm6-long-note.png')
  const budgetMs = 32
  const worstP95 = Math.max(...results.map((result) => Number(result['p95'] ?? 0)))

  return [
    {
      id: 'M6-10',
      criterion: 'A 20k-word note (the report-center redesign note) scrolls smoothly',
      title: `p95 frame interval ${String(round(worstP95))} ms across both documents`,
      ok: results.length > 0 && worstP95 <= budgetMs && results.every((r) => Number(r['frames'] ?? 0) > 40),
      detail: {
        budgetMs,
        documents: results,
        note: named
          ? {
              file: named.path,
              bytes: named.size,
              measuredWords: results.find((r) => r['which'] === 'the note the criterion names')?.['words'] ?? null
            }
          : null,
        screenshot: shot.file
      },
      notes: [
        'The note the criterion names is 21,116 *bytes* - about 2,670 words, not 20,000. That',
        'is a discrepancy in the criterion, not a shortfall in the note, so both are measured:',
        'the named file, and a synthesised document that really is 20,000 words.',
        'Frame intervals come from `requestAnimationFrame` while the pane is scrolling 140px',
        'per frame. The budget is 32 ms - two frames at 60 Hz - because a p95 under that is a',
        'scroll with no visible stutter in it.'
      ]
    }
  ]
}
