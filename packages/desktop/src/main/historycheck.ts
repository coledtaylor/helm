import { type BrowserWindow } from 'electron'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  claudeHome,
  historyFileIn,
  projectsDirIn,
  readHistorySessions,
  type HistorySession
} from '@helm/core'
import { screenshot, sendKey, sleep, squash, stripAnsi, typeText, waitFor } from './bridge'
import { resolveClaudeCommand } from './claude-cli'
import type { Check } from './fidelity'
import { answerStartupGates, atPrompt, processAlive, type Collector, type CheckContext } from './sessionscheck'
import { killSession, spawnSession } from './pty'

/**
 * The session-history criteria, driven through the app the way a user reaches
 * them.
 *
 * The discipline that matters here is that nothing is asserted against Helm's
 * own index alone. Every count is checked against a second, independent read of
 * `~/.claude/history.jsonl` and `~/.claude/projects/` done by this file - a
 * parser agreeing with itself proves nothing about whether it read the file
 * correctly.
 *
 * `pnpm history-check` -> helm-data/history-report.json
 */

const SEARCH_BUDGET_MS = 100

// ---------------------------------------------------------------------------
// A second opinion about what is on disk
// ---------------------------------------------------------------------------

interface Truth {
  historyFile: string
  prompts: Array<{ sessionId: string; project: string; display: string; timestamp: number }>
  /** Session id -> the project it recorded, in first-seen order. */
  sessions: Map<string, string>
  /** Distinct working directories, case-folded the way the launcher groups them. */
  projects: Set<string>
  /** Session ids with a transcript still on disk, by a separate directory walk. */
  transcripts: Map<string, number>
}

/**
 * Reads the same two sources the index does, with none of its code.
 *
 * Deliberately naive - `readFileSync`, `split`, `JSON.parse` - because the
 * point is to disagree with the incremental reader if the incremental reader is
 * wrong.
 */
function readTruth(): Truth {
  const home = claudeHome()
  const historyFile = historyFileIn(home)
  const prompts: Truth['prompts'] = []
  const sessions = new Map<string, string>()
  const projects = new Set<string>()

  for (const line of readFileSync(historyFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const row = parsed as Record<string, unknown>
    if (typeof row['sessionId'] !== 'string' || typeof row['project'] !== 'string') continue
    const sessionId = row['sessionId']
    const project = row['project']
    prompts.push({
      sessionId,
      project,
      display: typeof row['display'] === 'string' ? row['display'] : '',
      timestamp: typeof row['timestamp'] === 'number' ? row['timestamp'] : 0
    })
    if (!sessions.has(sessionId)) sessions.set(sessionId, project)
    projects.add(project.toLowerCase())
  }

  const transcripts = new Map<string, number>()
  const projectsDir = projectsDirIn(home)
  let dirs: string[]
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    dirs = []
  }
  for (const dir of dirs) {
    for (const name of readdirSync(join(projectsDir, dir))) {
      if (!/^[0-9a-f-]{36}\.jsonl$/i.test(name)) continue
      const id = name.slice(0, -6).toLowerCase()
      const size = statSync(join(projectsDir, dir, name)).size
      if ((transcripts.get(id) ?? -1) < size) transcripts.set(id, size)
    }
  }

  return { historyFile, prompts, sessions, projects, transcripts }
}

/** Sessions the file knows about that could actually be reopened right now. */
function trulyResumable(truth: Truth): Set<string> {
  const out = new Set<string>()
  for (const [id, project] of truth.sessions) {
    if (!truth.transcripts.has(id.toLowerCase())) continue
    try {
      if (statSync(project).isDirectory()) out.add(id)
    } catch {
      // The folder is gone, so `--resume` has nowhere to resolve the id.
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Talking to the renderer
// ---------------------------------------------------------------------------

/**
 * Electron reports a renderer-side throw as "Script failed to execute" with no
 * indication of which script, which is unhelpful in a file with a dozen of
 * them. The expression goes into the message.
 */
async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  try {
    return (await win.webContents.executeJavaScript(expression, true)) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`renderer expression failed: ${detail}\n${expression}`, { cause: err })
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
    await sleep(150)
  }
}

/** What the list is currently showing, read off the rendered rows. */
interface PaintedRow {
  sessionId: string
  resumable: boolean
  /** Whole row text, whitespace collapsed - project, age, prompt count, badge. */
  text: string
  /**
   * The meta line's fields, one per element.
   *
   * Read separately rather than sliced out of `text`, because `textContent`
   * concatenates adjacent elements with no separator - a row rendering
   * "<project> 25m 11 prompts" with flex gaps reads back as
   * "<project>25m11 prompts". Asserting on the fields is also the stronger
   * claim: that the row *has* a project and an age, not that its text happens
   * to contain something shaped like one.
   */
  fields: string[]
}

async function paintedRows(win: BrowserWindow): Promise<PaintedRow[]> {
  return js<PaintedRow[]>(
    win,
    `[...document.querySelectorAll('button[data-session]')].map((el) => ({
      sessionId: el.dataset.session,
      resumable: el.dataset.resumable === 'true',
      text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      fields: [...(el.lastElementChild?.children ?? [])]
        .map((child) => (child.textContent ?? '').replace(/\\s+/g, ' ').trim())
        .filter((value) => value !== '')
    }))`
  )
}

async function groupHeaders(win: BrowserWindow): Promise<string[]> {
  return js<string[]>(
    win,
    `[...document.querySelectorAll('[aria-label="Sessions"] > button:not([data-session])')]
      .map((el) => (el.textContent ?? '').trim())`
  )
}

/**
 * Brings the history pane back to the front and waits for it to paint.
 *
 * Needed between groups because the pane is only mounted while its tab is
 * active - resuming a session puts a terminal in front of it, and the next
 * group would otherwise be driving a surface that is not on screen.
 */
async function showHistory(win: BrowserWindow): Promise<boolean> {
  if (!(await click(win, '[data-tab="history"]'))) {
    await click(win, 'aside button[data-open-history]')
  }
  return pollJs(win, `document.querySelector('input[data-history-search]')`, 10_000)
}

/** The close button beside a session's tab, which is how a user ends one. */
async function closeSessionTab(win: BrowserWindow, id: number): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const tab = document.querySelector('[data-tab="session:${String(id)}"]');
      const el = tab?.parentElement?.querySelector('button[aria-label^="Close"]');
      if (!el) return false; el.click(); return true })()`
  )
}

/**
 * Replaces the search box's contents with real keystrokes.
 *
 * The term is reduced to printable ASCII first. `sendInputEvent` takes a
 * keyCode, and a prompt copied out of `history.jsonl` can contain a newline or
 * a character that is not one - the point of typing rather than assigning is
 * that the input's own handler runs, which it does just as well for a subset of
 * the text.
 */
async function typeSearch(win: BrowserWindow, term: string): Promise<string> {
  const typeable = term.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim()
  const clicked = await click(win, 'input[data-history-search]')
  if (!clicked) throw new Error('the search box is not on screen')
  await js<boolean>(
    win,
    `(() => { const el = document.querySelector('input[data-history-search]');
      el.focus(); el.select(); return true })()`
  )
  await sendKey(win, 'Backspace')
  if (typeable !== '') await typeText(win, typeable, 8)

  /*
   * Wait for the painted list to be the answer to the text now in the box.
   *
   * Clearing the box and typing are two edits, so two queries are in flight and
   * the pane shows the whole index until the second lands. This was a flat
   * 450 ms sleep, which is a guess, and the guess lost often enough to matter:
   * the reader arrived early and counted all 886 sessions as the answer to a
   * search for `geofenc`, then reported the pane as broken.
   *
   * Waiting for the count to *stop changing* does not fix it either, and that
   * is the part worth remembering - the count is unchanging on both sides of
   * the update, so stability cannot tell "not yet" from "final". The signal has
   * to be positive, so the DOM is compared against what the query for that
   * exact text returns. What the answer should *be* is still settled against
   * `history.jsonl` by the caller; this only decides when to look.
   *
   * The comparison is over the **session ids**, and it used to be over the row
   * count. That was the same mistake one level down: two different searches
   * returning the same number of rows agree on the count while showing entirely
   * different sessions, and this machine has a term matching four sessions and
   * a project matching four others. The check reported the pane as returning
   * the wrong rows for a search it had not run yet. Ids, in order, cannot do
   * that.
   */
  for (let attempt = 0; attempt < 30; attempt++) {
    const agreed = await js<boolean>(
      win,
      `(async () => {
        const box = document.querySelector('input[data-history-search]');
        // The scope the pane is actually on, not an assumption about it: this
        // comparison decides *when* to look, and asking the wrong question
        // would answer "not yet" for ever.
        const on = document.querySelector('[data-history-scope][aria-pressed="true"]');
        const page = await window.helm.invoke('history:sessions', {
          search: box.value,
          scope: on ? on.dataset.historyScope : 'prompts'
        });
        const painted = [...document.querySelectorAll('button[data-session]')]
          .map((el) => el.dataset.session);
        return page.sessions.length === painted.length &&
          page.sessions.every((s, i) => s.sessionId === painted[i]);
      })()`
    ).catch(() => false)
    if (agreed) return typeable
    await sleep(50)
  }
  // Fell through: let the caller's assertion fail on the numbers rather than
  // hang here. Other filters being on is the honest reason this can happen.
  return typeable
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * Groups a run can be narrowed to with `--only=`.
 *
 * `resume` and `outside` each spawn a real `claude` and account for most of
 * the wall clock, so being able to re-run the pane checks without them is the
 * difference between a ten-second loop and a five-minute one.
 */
const GROUPS = ['list', 'search', 'resume', 'reaped', 'outside'] as const
type Group = (typeof GROUPS)[number]

export async function runHistoryChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  only?: readonly string[]
): Promise<Check[]> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const running = (group: Group): boolean => wanted.has(group)

  const checks: Check[] = []
  const { win, services } = ctx
  const truth = readTruth()
  const resumableTruth = trulyResumable(truth)

  // -------------------------------------------------------------------------
  // HIST-0: the index agrees with the file
  // -------------------------------------------------------------------------
  const built = await waitFor(() => ctx.history.summary().sessions > 0, 60_000)
  const summary = ctx.history.refresh()

  const indexAgrees =
    built &&
    summary.sessions === truth.sessions.size &&
    summary.prompts === truth.prompts.length &&
    summary.projects === truth.projects.size &&
    summary.resumable === resumableTruth.size

  checks.push({
    id: 'HIST-0',
    criterion: 'setup',
    title: 'The index matches an independent read of history.jsonl and projects/',
    ok: indexAgrees,
    detail: {
      index: {
        sessions: summary.sessions,
        prompts: summary.prompts,
        projects: summary.projects,
        resumable: summary.resumable,
        indexedBytes: summary.indexedBytes
      },
      file: {
        path: truth.historyFile,
        sessions: truth.sessions.size,
        prompts: truth.prompts.length,
        projects: truth.projects.size,
        transcriptsOnDisk: truth.transcripts.size,
        resumable: resumableTruth.size
      }
    },
    notes: [
      'The second read is a plain readFileSync + JSON.parse in historycheck.ts, sharing no',
      'code with the incremental reader it is checking.'
    ]
  })

  if (!indexAgrees) {
    checks.push({
      id: 'HIST-SKIP',
      criterion: 'setup',
      title: 'Nothing else can be trusted while the index disagrees with the file',
      ok: false,
      detail: {},
      notes: []
    })
    return checks
  }

  // -------------------------------------------------------------------------
  // HIST-1: every session visible, grouped, with project and age
  // -------------------------------------------------------------------------
  const opened = await click(win, 'aside button[data-open-history]')
  const painted = await pollJs(
    win,
    `document.querySelectorAll('button[data-session]').length > 0`,
    20_000
  )
  await sleep(600)

  const rows = await paintedRows(win)
  // A row has to carry the two things the criterion names, each as its own
  // field: an age the formatter produced, and the project the file recorded
  // for that exact session.
  const AGE = /^(now|\d+[mhdwy])$/
  const projectOf = new Map(
    [...truth.sessions].map(([id, project]) => [id, basename(project).toLowerCase()])
  )
  const rowsWithAge = rows.filter((row) => row.fields.some((f) => AGE.test(f))).length
  const rowsWithProject = rows.filter((row) => {
    const expected = projectOf.get(row.sessionId)
    return expected !== undefined && row.fields.some((f) => f.toLowerCase() === expected)
  }).length

  const shotRecent = await screenshot(win, shotDir, 'history-recent.png')

  if (running('list')) checks.push({
    id: 'HIST-1',
    criterion: 'All sessions from history.jsonl visible, grouped and searchable, with project and age',
    title: 'The pane lists every session in the file, each with its project and its age',
    ok:
      opened &&
      painted &&
      rows.length === truth.sessions.size &&
      rowsWithAge === rows.length &&
      rowsWithProject === rows.length,
    detail: {
      painted: rows.length,
      inFile: truth.sessions.size,
      rowsWithAge,
      rowsWithProject,
      sample: rows.slice(0, 4),
      screenshot: shotRecent.file
    },
    notes: [
      '`/resume` can only ever show the sessions of the directory it was started in;',
      `this is ${String(truth.projects.size)} directories at once.`
    ]
  })

  // -------------------------------------------------------------------------
  // HIST-2: grouped by project
  // -------------------------------------------------------------------------
  // Named rather than "the first unpressed button": this pane now holds two
  // segmented groups - grouping, and what the search box searches - and the
  // positional selector started clicking the wrong one the moment the second
  // arrived. It reported zero group headers and then a search over the wrong
  // scope, which looked like two unrelated regressions.
  await click(win, '[data-history-grouping="project"]')
  await sleep(500)
  const headers = await groupHeaders(win)
  const groupedRows = await paintedRows(win)
  const shotGrouped = await screenshot(win, shotDir, 'history-by-project.png')

  if (running('list')) checks.push({
    id: 'HIST-2',
    criterion: 'All sessions from history.jsonl visible, grouped and searchable, with project and age',
    title: 'Grouping by project yields one header per recorded working directory',
    ok:
      headers.length === truth.projects.size &&
      groupedRows.length === truth.sessions.size &&
      headers.every((h) => /\d/.test(h)),
    detail: {
      headers: headers.length,
      distinctProjectsInFile: truth.projects.size,
      rowsStillShown: groupedRows.length,
      sample: headers.slice(0, 5),
      screenshot: shotGrouped.file
    },
    notes: [
      'Case-folded on both sides: the same folder is recorded under more than one casing',
      'and two groups for one directory would be a wrong answer, not a cosmetic one.'
    ]
  })

  // Back to the flat list for everything that follows.
  await click(win, '[data-history-grouping="recent"]')
  await sleep(400)

  // -------------------------------------------------------------------------
  // HIST-3: resumable and reaped are told apart
  // -------------------------------------------------------------------------
  const resumableRows = rows.filter((row) => row.resumable)
  const reapedRows = rows.filter((row) => !row.resumable)
  // Four words now, not two. The transcript archive gave the pane a third and a
  // fourth state - `archived` for a conversation Helm kept before Claude Code
  // deleted it, `dropped` for one the storage ceiling later took - and they are
  // sub-kinds of "cannot be reopened" rather than a second vocabulary beside it.
  // `pnpm transcript-check` is what asserts the *right* one is on each row; this
  // one still asserts that every unreopenable row carries one at all.
  const BADGES = /history only|folder gone|archived|dropped/i
  const badged = reapedRows.filter((row) => BADGES.test(row.text)).length
  const wronglyMarked = rows.filter(
    (row) => row.resumable !== resumableTruth.has(row.sessionId)
  ).length

  if (running('list')) checks.push({
    id: 'HIST-3',
    criterion: 'Sessions with surviving transcripts are visually distinct from reaped ones',
    title: 'Every row is marked, correctly, and the mark is a word as well as a shape',
    ok: wronglyMarked === 0 && resumableRows.length === resumableTruth.size && badged === reapedRows.length,
    detail: {
      resumable: resumableRows.length,
      reaped: reapedRows.length,
      resumableOnDisk: resumableTruth.size,
      wronglyMarked,
      reapedRowsCarryingABadge: badged,
      badgeVocabulary: BADGES.source.split('|'),
      retention: `${String(Math.round((resumableTruth.size / truth.sessions.size) * 1000) / 10)}%`
    },
    notes: [
      'The badge matters as much as the dot: a difference only in colour is not a',
      'difference for everyone reading it.',
      'Resumability is still the thing the *dot* answers. What the badge says has grown with',
      'the archive, so the words are listed here rather than left in a regex nobody reads.'
    ]
  })

  // -------------------------------------------------------------------------
  // HIST-4: search, and what it costs
  // -------------------------------------------------------------------------
  const TERMS = ['the', 'schema', 'resume', 'release', 'spec', 'test', 'fix', 'claude']
  const timings: Array<{ term: string; tookMs: number; total: number }> = []
  for (const term of TERMS) {
    for (let run = 0; run < 5; run++) {
      const page = readHistorySessions(services.store, { search: term })
      timings.push({ term, tookMs: page.tookMs, total: page.total })
    }
  }
  const sorted = timings.map((t) => t.tookMs).sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0

  // And the same question through the surface, which is where the criterion
  // actually binds: keystrokes into the box, rows out of the DOM.
  const TYPED = 'geofenc'
  await typeSearch(win, TYPED)
  const searched = await paintedRows(win)
  // The box searches prompts *and* project paths, so the independent count has
  // to do both. Prompt-only was right until it wasn't, and it kept passing on
  // this machine for the uninteresting reason that no directory here is called
  // anything like `geofenc`.
  const matchesTyped = (needle: string) => (p: Truth['prompts'][number]): boolean =>
    p.display.toLowerCase().includes(needle) || p.project.toLowerCase().includes(needle)
  const expectedIds = new Set(truth.prompts.filter(matchesTyped(TYPED)).map((p) => p.sessionId))
  const shotSearch = await screenshot(win, shotDir, 'history-search.png')

  /**
   * A term that appears in a project path and in no prompt, so that the project
   * half of the search is actually exercised rather than merely allowed for.
   *
   * Derived from what this machine has rather than written down - which
   * directories exist here is not this file's business - and null when nothing
   * discriminating turns up, in which case the criterion says so instead of
   * quietly claiming coverage it did not get.
   */
  const projectTerm = (() => {
    for (const project of truth.projects) {
      const segment = project.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase()
      if (segment === undefined || segment.length < 4) continue
      if (truth.prompts.some((p) => p.display.toLowerCase().includes(segment))) continue
      return segment
    }
    return null
  })()

  let projectSearchOk = true
  let projectSearch: Record<string, unknown> = { term: null, note: 'no discriminating term here' }
  if (projectTerm !== null) {
    await typeSearch(win, projectTerm)
    const rows = await paintedRows(win)
    const expected = new Set(truth.prompts.filter(matchesTyped(projectTerm)).map((p) => p.sessionId))
    projectSearchOk =
      expected.size > 0 &&
      rows.length === expected.size &&
      rows.every((row) => expected.has(row.sessionId))
    projectSearch = {
      term: projectTerm,
      painted: rows.length,
      expected: expected.size,
      paintedNotExpected: rows.filter((row) => !expected.has(row.sessionId)).map((r) => r.sessionId),
      expectedNotPainted: [...expected].filter((id) => !rows.some((row) => row.sessionId === id))
    }
    await typeSearch(win, TYPED)
    await sleep(300)
  }

  if (running('search')) checks.push({
    id: 'HIST-4',
    criterion: 'Search over 3k+ prompts returns in <100ms (SQLite FTS or LIKE with index - measure)',
    title: `Substring search over ${String(truth.prompts.length)} prompts, measured`,
    ok:
      truth.prompts.length >= 3000 &&
      p95 < SEARCH_BUDGET_MS &&
      searched.length === expectedIds.size &&
      searched.every((row) => expectedIds.has(row.sessionId)) &&
      projectSearchOk,
    detail: {
      promptsIndexed: truth.prompts.length,
      projectSearch,
      budgetMs: SEARCH_BUDGET_MS,
      p95Ms: Math.round(p95 * 1000) / 1000,
      slowestMs: Math.round((sorted.at(-1) ?? 0) * 1000) / 1000,
      perTerm: TERMS.map((term) => {
        const runs = timings.filter((t) => t.term === term)
        return {
          term,
          matches: runs[0]?.total ?? 0,
          medianMs: Math.round((runs[Math.floor(runs.length / 2)]?.tookMs ?? 0) * 1000) / 1000
        }
      }),
      throughTheUi: {
        typed: TYPED,
        rows: searched.length,
        expected: expectedIds.size,
        // The ids, not only the counts. Two sets of four that do not overlap
        // report as "4 and 4" and fail on the `every` below, which is a
        // failure with nothing in the report to explain it.
        paintedNotExpected: searched
          .filter((row) => !expectedIds.has(row.sessionId))
          .map((row) => row.sessionId),
        expectedNotPainted: [...expectedIds].filter(
          (id) => !searched.some((row) => row.sessionId === id)
        )
      },
      screenshot: shotSearch.file
    },
    notes: [
      'LIKE, not FTS5. A filter box has to match `geofenc` inside `geofencing` and',
      '`--resume` as itself; a tokenising index matches whole words and would find',
      'neither. The cost is a table scan, which is what the number above is.'
    ]
  })

  // -------------------------------------------------------------------------
  // HIST-5: resuming a session that still has a transcript
  // -------------------------------------------------------------------------
  //
  // The smallest surviving transcript with a short opening prompt: small so the
  // TUI finishes replaying it quickly, short so the prompt is not elided when
  // it is redrawn - and the redrawn prompt is the evidence that the
  // conversation came back rather than a new one starting.
  const candidates = readHistorySessions(services.store, { resumableOnly: true })
    .sessions.filter((s) => s.firstPrompt.trim().length >= 12 && s.firstPrompt.length <= 120)
    .sort((a, b) => (a.transcriptBytes ?? 0) - (b.transcriptBytes ?? 0))

  const before = ctx.sessions.list().length
  let resumed: {
    target: HistorySession
    id: number
    argv: string[]
    cwd: string
    pid: number | null
    restored: boolean
    notFound: boolean
    reachedPrompt: boolean
    needle: string
  } | null = null

  for (const target of running('resume') ? candidates.slice(0, 2) : []) {
    await showHistory(win)
    await typeSearch(win, target.firstPrompt.slice(0, 24))
    const clickedRow = await click(win, `button[data-session="${target.sessionId}"]`)
    await sleep(400)
    const clickedResume = await click(win, `button[data-resume="${target.sessionId}"]`)
    if (!clickedRow || !clickedResume) continue

    const started = await waitFor(() => ctx.sessions.list().length > before, 20_000)
    if (!started) continue
    const record = ctx.sessions.list().at(-1)
    if (!record) continue

    const stopGates = answerStartupGates(ctx, collector, [record.id])
    // The needle is the opening prompt as the TUI would redraw it, with the
    // whitespace taken out - a replayed prompt is wrapped to the pane width,
    // which puts line breaks inside it.
    const needle = squash(target.firstPrompt).slice(0, 24)
    const restored = await waitFor(() => squash(collector.output(record.id)).includes(needle), 60_000)
    stopGates()
    await sleep(1500)

    const text = stripAnsi(collector.output(record.id))
    resumed = {
      target,
      id: record.id,
      argv: record.argv,
      cwd: record.cwd,
      pid: ctx.sessions.pid(record.id),
      restored,
      notFound: /No conversation found/i.test(text),
      reachedPrompt: atPrompt(text),
      needle
    }
    if (restored) break
  }

  const shotResumed = await screenshot(win, shotDir, 'history-resumed.png')

  if (running('resume')) checks.push({
    id: 'HIST-5',
    criterion: 'Clicking a resumable session opens a tab with that conversation restored in the real TUI',
    title: 'A resumed session runs `claude --resume` in its own project and redraws the conversation',
    ok:
      resumed !== null &&
      resumed.argv.includes('--resume') &&
      resumed.argv.includes(resumed.target.sessionId) &&
      resumed.cwd.toLowerCase() === resumed.target.project.toLowerCase() &&
      resumed.pid !== null &&
      processAlive(resumed.pid) &&
      !resumed.notFound &&
      resumed.restored,
    detail: {
      candidates: candidates.length,
      chosen: resumed && {
        sessionId: resumed.target.sessionId,
        project: resumed.target.project,
        transcriptBytes: resumed.target.transcriptBytes,
        prompts: resumed.target.promptCount,
        openingPrompt: resumed.target.firstPrompt
      },
      session: resumed && {
        id: resumed.id,
        argv: resumed.argv,
        cwd: resumed.cwd,
        pid: resumed.pid,
        alive: resumed.pid !== null && processAlive(resumed.pid)
      },
      evidence: resumed && {
        needle: resumed.needle,
        conversationRedrawn: resumed.restored,
        sawNoConversationFound: resumed.notFound,
        reachedPrompt: resumed.reachedPrompt
      },
      screenshot: shotResumed.file
    },
    notes: [
      'No `-n` on the argv: resuming continues a session that already has a name, and',
      'passing one would rename it as a side effect of Helm opening it.',
      'The cwd assertion is the load-bearing one - `--resume` resolves the id against',
      'the working directory, and from anywhere else it finds nothing.'
    ]
  })

  if (resumed) {
    // Through the tab's own close button, not the session host directly: main
    // ending a process does not remove the renderer's tab, and the pane behind
    // it is what the next group needs on screen.
    await closeSessionTab(win, resumed.id)
    await waitFor(() => !ctx.sessions.list().some((s) => s.id === resumed?.id), 15_000)
    await sleep(800)
  }
  await showHistory(win)

  // -------------------------------------------------------------------------
  // HIST-6: a reaped session explains itself
  // -------------------------------------------------------------------------
  const reapedTarget = readHistorySessions(services.store)
    .sessions.filter((s) => s.transcriptFile === null && s.promptCount >= 2)
    .at(0)

  let reapedView: {
    hasResumeButton: boolean
    explanation: string
    promptsShown: number
    spawned: number
  } | null = null
  let refusal: string | null = null

  if (reapedTarget && running('reaped')) {
    await showHistory(win)
    const sessionsBefore = ctx.sessions.list().length
    await typeSearch(win, reapedTarget.firstPrompt.slice(0, 24) || 'e')
    await click(win, `button[data-session="${reapedTarget.sessionId}"]`)
    await pollJs(win, `document.querySelector('[data-unavailable]')`, 8000)
    await sleep(600)

    reapedView = await js<{
      hasResumeButton: boolean
      explanation: string
      promptsShown: number
      spawned: number
    }>(
      win,
      `(() => ({
        hasResumeButton: Boolean(document.querySelector('button[data-resume]')),
        explanation: (document.querySelector('[data-unavailable]')?.textContent ?? '')
          .replace(/\\s+/g, ' ').trim(),
        promptsShown: document.querySelectorAll('ol li').length,
        spawned: 0
      }))()`
    )
    reapedView.spawned = ctx.sessions.list().length - sessionsBefore

    // The pane will not offer it, but the main process is what actually spawns
    // - so it has to refuse on its own rather than trust the window.
    try {
      ctx.sessions.resume({ sessionId: reapedTarget.sessionId, cols: 100, rows: 30 })
      refusal = null
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err)
    }
  }

  const shotReaped = await screenshot(win, shotDir, 'history-reaped.png')

  if (running('reaped')) checks.push({
    id: 'HIST-6',
    criterion: 'Attempting a reaped session shows a graceful explanation, not a broken terminal',
    title: 'A reaped session offers no resume, explains why, and still shows its prompts',
    ok:
      reapedTarget !== undefined &&
      reapedView !== null &&
      !reapedView.hasResumeButton &&
      reapedView.spawned === 0 &&
      reapedView.promptsShown === reapedTarget.promptCount &&
      /transcript/i.test(reapedView.explanation) &&
      refusal !== null &&
      /transcript/i.test(refusal),
    detail: {
      target: reapedTarget && {
        sessionId: reapedTarget.sessionId,
        project: reapedTarget.project,
        prompts: reapedTarget.promptCount
      },
      pane: reapedView,
      mainProcessRefusal: refusal,
      screenshot: shotReaped.file
    },
    notes: [
      'No process is started at all. `claude --resume <reaped id>` prints "No conversation',
      'found with session ID" and exits 1 (measured on 2.1.225) - a tab that dies in front',
      'of the user is the failure this criterion is about.'
    ]
  })

  // -------------------------------------------------------------------------
  // HIST-7: a session started outside the app turns up on its own
  // -------------------------------------------------------------------------
  if (!running('outside')) return checks

  await showHistory(win)
  await typeSearch(win, '')
  const knownBefore = new Set(
    readHistorySessions(services.store).sessions.map((s) => s.sessionId)
  )

  const marker = `helm history external ${String(Date.now())}`
  const outsideCwd = process.cwd()
  let outsideOutput = ''
  let outsideExit: number | null = null
  const OUTSIDE_ID = 'history-outside'

  // Resolved the same way the app resolves it, so this is the same binary a
  // person would get by typing `claude` - not an assumption about PATH inside
  // a spawned shell.
  const cli = resolveClaudeCommand()
  const outside = spawnSession({
    id: OUTSIDE_ID,
    file: cli?.file ?? 'claude',
    args: [...(cli?.prefixArgs ?? []), '--model', 'haiku'],
    cols: 100,
    rows: 30,
    cwd: outsideCwd,
    onData: (chunk) => {
      outsideOutput += chunk
    },
    onExit: (code) => {
      outsideExit = code
    }
  })

  const outsideReady = await waitFor(() => {
    const text = squash(outsideOutput)
    if (/doyoutrust|trustthisfolder|quicksafetycheck/.test(text)) outside.write('\r')
    if (/mcpservers/.test(text)) outside.write('\x1b')
    return atPrompt(stripAnsi(outsideOutput))
  }, 90_000)

  let noticedMs = -1
  let noticedInDom = false
  let newIds: string[] = []

  if (outsideReady) {
    await sleep(1500)
    outside.write(marker)
    await sleep(400)
    outside.write('\r')
    const submittedAt = Date.now()

    // No refresh is triggered from here: the watcher has to notice on its own,
    // and the row has to reach the window without anyone asking it to.
    const noticed = await waitFor(() => {
      newIds = readHistorySessions(services.store, { search: marker }).sessions.map(
        (s) => s.sessionId
      )
      return newIds.length > 0
    }, 30_000)
    if (noticed) noticedMs = Date.now() - submittedAt

    noticedInDom = await pollJs(
      win,
      `[...document.querySelectorAll('button[data-session]')]
        .some((el) => el.dataset.session === ${JSON.stringify(newIds[0] ?? '')})`,
      15_000
    )
  }

  const shotOutside = await screenshot(win, shotDir, 'history-outside.png')
  killSession(OUTSIDE_ID)
  await sleep(1500)

  checks.push({
    id: 'HIST-7',
    criterion: 'Index updates within seconds of a new session being started outside the app',
    title: 'A prompt typed into a terminal Helm did not open appears in the launcher',
    ok:
      outsideReady &&
      noticedMs >= 0 &&
      noticedMs < 10_000 &&
      noticedInDom &&
      newIds.length === 1 &&
      !knownBefore.has(newIds[0] ?? ''),
    detail: {
      cwd: outsideCwd,
      cli: cli?.resolved ?? null,
      marker,
      startedInTerminal: outsideReady,
      noticedAfterMs: noticedMs,
      appearedInTheWindow: noticedInDom,
      newSessionIds: newIds,
      alreadyKnown: newIds.filter((id) => knownBefore.has(id)),
      externalExitCode: outsideExit,
      screenshot: shotOutside.file
    },
    notes: [
      'A real `claude`, spawned on its own pty by this driver rather than through Helm\'s',
      'session host - no database row, no tab, no IPC. The only thing connecting it to the',
      'app is the history file they share.',
      'Nothing calls refresh(): the fs.watch and the stat poll are what has to notice.'
    ]
  })

  return checks
}
