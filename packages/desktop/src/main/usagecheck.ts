import { type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { claudeConfigFileIn, claudeHome, projectsDirIn, readSettings } from '@helm/core'
import { screenshot, sleep, stripAnsi, waitFor } from './bridge'
import type { Check } from './fidelity'
import { atPrompt, type Collector, type M2Context } from './m2check'
import { answerConsent } from './m3check'

/**
 * The status bar's usage figures, driven through the app the way a user sees
 * them.
 *
 * The discipline is M4's, M5's and M6's: nothing is asserted against Helm's own
 * answer alone. Everything below is checked against a second read written in
 * this file which shares no code with the thing it checks - a plain
 * `JSON.parse` and hand-written field access beside `parseUsage`, a
 * hand-written "which of these may be shown" beside `usageView`, a
 * hand-computed weekday and clock time beside `formatResetsIn`, and a regex
 * over the text a person actually reads beside the component that rendered it.
 * A parser agreeing with itself proves nothing.
 *
 * Three of the criteria cannot be settled by agreement at all:
 *
 *   Criterion 2 is about a *session*, so the second opinion is a real one: a
 *   live `claude` is asked for `/usage` and the percentages it paints in its
 *   own TUI are compared to the ones in the status bar. `/usage` makes a usage
 *   request rather than an inference request, so this costs a session start and
 *   no tokens.
 *
 *   Criterion 3 is about a window *rolling over*, which is a thing that happens
 *   to a reading with nothing on disk having changed. So the fixture's session
 *   window is set to reset ten seconds out and the driver watches the segment
 *   drop it on its own, rather than being handed a reset time in the past and
 *   asked whether it likes it.
 *
 *   Criterion 7 is a *measurement* and is reported as a number whether or not
 *   it passes: the full parse of every transcript, which is the cost being
 *   avoided, measured here rather than quoted.
 *
 * `pnpm usage-check` -> helm-data/usage-report.json
 */

const GROUPS = ['read', 'watch', 'resets', 'degrade', 'setting', 'width', 'cost', 'live'] as const
type Group = (typeof GROUPS)[number]

/**
 * The staleness horizon, written out again rather than imported.
 *
 * This is the check's copy of the rule, and it is supposed to be a second
 * statement of it: if `USAGE_STALE_AFTER_MS` moves and this does not, the two
 * disagree and the check goes red, which is the point. Importing the constant
 * would make the assertion "the reader agrees with the reader".
 */
const STALE_AFTER_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// A second opinion about what is in ~/.claude.json
// ---------------------------------------------------------------------------

interface OwnLimit {
  kind: string
  group: string
  percent: number
  resetsAtMs: number | null
  scope: string | null
}

interface OwnReading {
  fetchedAtMs: number | null
  limits: OwnLimit[]
  /** Set when the file could not be turned into a reading at all. */
  broken: string | null
}

/**
 * `cachedUsageUtilization`, read the naive way.
 *
 * Deliberately not `parseUsage`: a plain parse, dot-access on the fields the
 * ClickUp task recorded, and no defensiveness beyond a try/catch. The point is
 * to disagree with the reader if the reader is wrong.
 */
function ownRead(file: string): OwnReading {
  let root: Record<string, unknown>
  try {
    root = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (err) {
    return { fetchedAtMs: null, limits: [], broken: err instanceof Error ? err.message : String(err) }
  }

  const cached = root['cachedUsageUtilization'] as
    | { fetchedAtMs?: unknown; utilization?: { limits?: unknown } }
    | null
    | undefined
  if (cached === null || cached === undefined || typeof cached !== 'object') {
    return { fetchedAtMs: null, limits: [], broken: 'no cachedUsageUtilization' }
  }

  const fetchedAtMs = typeof cached.fetchedAtMs === 'number' ? cached.fetchedAtMs : null
  const raw = cached.utilization?.limits
  if (!Array.isArray(raw)) return { fetchedAtMs, limits: [], broken: 'no utilization.limits array' }

  const limits: OwnLimit[] = []
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (typeof entry !== 'object' || entry === null) continue
    if (typeof entry['percent'] !== 'number') continue
    const resets = entry['resets_at']
    const scope = entry['scope'] as { model?: { display_name?: unknown } } | null | undefined
    limits.push({
      kind: String(entry['kind'] ?? ''),
      group: String(entry['group'] ?? ''),
      percent: entry['percent'],
      resetsAtMs: typeof resets === 'string' ? Date.parse(resets) : null,
      scope: typeof scope?.model?.display_name === 'string' ? scope.model.display_name : null
    })
  }
  return { fetchedAtMs, limits, broken: null }
}

interface OwnExpectation {
  /** What the segment must show, or null for "must show no number". */
  session: number | null
  weekly: number | null
  weeklyScope: string | null
  /** Why nothing may be shown. Null when something may. */
  silentBecause: string | null
}

/**
 * What ought to be on screen, decided from first principles.
 *
 * The rules restated rather than reused: too old is nothing at all; a window
 * whose reset time has passed is dropped; the binding limit of a group is the
 * one with the highest percentage.
 */
function ownExpectation(reading: OwnReading, nowMs: number): OwnExpectation {
  if (reading.broken !== null) return silent(reading.broken)
  if (reading.fetchedAtMs === null) return silent('no fetchedAtMs')
  if (nowMs - reading.fetchedAtMs > STALE_AFTER_MS) {
    return silent(`reading is ${String(Math.round((nowMs - reading.fetchedAtMs) / 60_000))}m old`)
  }
  if (reading.fetchedAtMs - nowMs > 60_000) return silent('reading is dated in the future')

  const live = reading.limits.filter((l) => l.resetsAtMs === null || l.resetsAtMs > nowMs)
  if (live.length === 0) return silent('every window in the reading has reset')

  let session: OwnLimit | null = null
  let weekly: OwnLimit | null = null
  for (const limit of live) {
    if (limit.group === 'session' && (session === null || limit.percent > session.percent)) {
      session = limit
    }
    if (limit.group === 'weekly' && (weekly === null || limit.percent > weekly.percent)) {
      weekly = limit
    }
  }
  if (session === null && weekly === null) return silent('no limit in a group Helm shows')

  return {
    session: session === null ? null : Math.round(session.percent),
    weekly: weekly === null ? null : Math.round(weekly.percent),
    weeklyScope: weekly?.scope ?? null,
    silentBecause: null
  }
}

const silent = (why: string): OwnExpectation => ({
  session: null,
  weekly: null,
  weeklyScope: null,
  silentBecause: why
})

/**
 * What is on screen, read out of the text rather than out of an attribute.
 *
 * `Session21%` and `Week (Fable)45%` are what `textContent` concatenates to,
 * so this is a regex over what a person reads. Reading a `data-percent` Helm
 * had written would only prove Helm agrees with itself.
 */
function paintedPercents(text: string): { session: number | null; weekly: number | null; weeklyScope: string | null } {
  const found = { session: null as number | null, weekly: null as number | null, weeklyScope: null as string | null }
  const re = /(Session|Week)(?:\s*\(([^)]*)\))?\s*(\d+)%/g
  for (;;) {
    const match = re.exec(text)
    if (match === null) break
    const percent = Number(match[3])
    if (match[1] === 'Session') found.session = percent
    else {
      found.weekly = percent
      found.weeklyScope = match[2] ?? null
    }
  }
  return found
}

/** Any percentage at all, for the criterion that is about there being none. */
const showsAnyNumber = (text: string): boolean => /\d+\s*%/.test(text)

// ---------------------------------------------------------------------------
// Talking to the window
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  try {
    return (await win.webContents.executeJavaScript(expression, true)) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`renderer expression failed: ${detail}\n${expression}`, { cause: err })
  }
}

const SEGMENT = '[data-usage-segment]'

const segmentText = (win: BrowserWindow): Promise<string> =>
  js<string>(win, `(document.querySelector('${SEGMENT}')?.textContent ?? '')`)

const segmentTitle = (win: BrowserWindow): Promise<string> =>
  js<string>(win, `(document.querySelector('${SEGMENT}')?.getAttribute('title') ?? '')`)

const segmentMode = (win: BrowserWindow): Promise<string> =>
  js<string>(win, `(document.querySelector('${SEGMENT}')?.dataset.usageSegment ?? '')`)

const clickSegment = (win: BrowserWindow): Promise<boolean> =>
  js<boolean>(
    win,
    `(() => { const el = document.querySelector('${SEGMENT}');
      if (!el) return false; el.click(); return true })()`
  )

async function waitForText(
  win: BrowserWindow,
  predicate: (text: string) => boolean,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = await segmentText(win).catch(() => '')
    if (predicate(text)) return text
    if (Date.now() >= deadline) return text
    await sleep(200)
  }
}

/** Brings the segment to percent mode by clicking it, the way a user would. */
async function ensurePercentMode(win: BrowserWindow): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await segmentMode(win)) === 'percent') return true
    await clickSegment(win)
    await sleep(250)
  }
  return (await segmentMode(win)) === 'percent'
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FixtureLimit {
  kind: string
  group: string
  percent: number
  severity?: string
  resetsAtMs?: number | null
  scope?: string | null
}

/**
 * A `.claude.json` with a `cachedUsageUtilization` in it, built here.
 *
 * Shaped from the reading measured on 2.1.225 - the sibling nulls with
 * codenames included, because a reader that only copes with the fields it uses
 * is a reader that has not been tested against the file it actually reads.
 */
function fixture(
  dir: string,
  name: string,
  body: { fetchedAtMs?: unknown; limits?: FixtureLimit[]; cached?: unknown; raw?: string }
): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.json`)

  if (body.raw !== undefined) {
    writeFileSync(file, body.raw)
    return file
  }

  const limits = (body.limits ?? []).map((limit) => ({
    kind: limit.kind,
    group: limit.group,
    percent: limit.percent,
    severity: limit.severity ?? 'normal',
    resets_at:
      limit.resetsAtMs === null || limit.resetsAtMs === undefined
        ? null
        : new Date(limit.resetsAtMs).toISOString(),
    scope: limit.scope == null ? null : { model: { id: null, display_name: limit.scope }, surface: null },
    is_active: false
  }))

  const root: Record<string, unknown> = {
    numStartups: 1,
    projects: {},
    cachedUsageUtilization:
      'cached' in body
        ? body.cached
        : {
            fetchedAtMs: body.fetchedAtMs ?? Date.now(),
            accountUuid: '00000000-0000-4000-8000-000000000000',
            utilization: {
              five_hour: { utilization: limits[0]?.percent ?? 0, resets_at: limits[0]?.resets_at ?? null },
              seven_day: { utilization: limits[1]?.percent ?? 0, resets_at: limits[1]?.resets_at ?? null },
              tangelo: null,
              nimbus_quill: { utilization: 0, resets_at: null },
              iguana_necktie: null,
              limits,
              spend: { used: { amount_minor: 0, currency: 'USD' }, enabled: false, percent: 0 },
              extra_usage: { is_enabled: false, daily: null, weekly: null }
            }
          }
  }

  writeFileSync(file, JSON.stringify(root, null, 2))
  return file
}

// ---------------------------------------------------------------------------
// Independent formatting of a reset time
// ---------------------------------------------------------------------------

/** `in 2h 5m` as minutes, so a tick between render and read is a tolerance. */
function paintedMinutesUntil(text: string): number | null {
  const hm = /resets in (\d+)h (\d+)m/.exec(text)
  if (hm) return Number(hm[1]) * 60 + Number(hm[2])
  const h = /resets in (\d+)h(?!\s*\d)/.exec(text)
  if (h) return Number(h[1]) * 60
  const m = /resets in (\d+)m/.exec(text)
  if (m) return Number(m[1])
  return null
}

/** The weekday and clock time a person should read, computed by hand. */
function ownAbsolute(at: number): { weekday: string; clock: string; meridiem: string } {
  const d = new Date(at)
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] ?? ''
  const hours = d.getHours()
  const h12 = ((hours + 11) % 12) + 1
  return {
    weekday,
    clock: `${String(h12)}:${String(d.getMinutes()).padStart(2, '0')}`,
    meridiem: hours < 12 ? 'AM' : 'PM'
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runUsageChecks(
  ctx: M2Context,
  collector: Collector,
  shotDir: string,
  dataDir: string,
  only?: readonly string[]
): Promise<Check[]> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const checks: Check[] = []
  const { win, services, usage } = ctx
  const run = (group: Group): boolean => wanted.has(group)

  const fixtureDir = join(dataDir, 'usage-fixtures')
  rmSync(fixtureDir, { recursive: true, force: true })

  const realFile = claudeConfigFileIn()

  // The first reading is taken after the renderer reports ready, so the segment
  // may not have been handed one yet when this driver starts in the same turn.
  await waitFor(() => usage.snapshot().file !== '', 15_000)
  await sleep(600)
  await ensurePercentMode(win)

  // -------------------------------------------------------------------------
  // U-1: what the bar shows is what the file says
  // -------------------------------------------------------------------------
  if (run('read')) {
    usage.pointAt(null)
    await sleep(500)

    const at = Date.now()
    const mine = ownRead(realFile)
    const expected = ownExpectation(mine, at)
    const text = await segmentText(win)
    const painted = paintedPercents(text)

    const ok =
      expected.silentBecause !== null
        ? !showsAnyNumber(text)
        : painted.session === expected.session &&
          painted.weekly === expected.weekly &&
          painted.weeklyScope === expected.weeklyScope

    checks.push({
      id: 'U-1',
      criterion: 'Status bar shows session and weekly usage',
      title: 'The painted percentages are the ones in ~/.claude.json',
      ok,
      detail: {
        file: realFile,
        independent: expected,
        independentLimits: mine.limits,
        readingAgeMinutes:
          mine.fetchedAtMs === null ? null : Math.round((at - mine.fetchedAtMs) / 60_000),
        painted,
        text
      },
      notes: [
        expected.silentBecause === null
          ? 'The real reading was usable, so the bar had to show it exactly.'
          : `The real reading was not usable (${expected.silentBecause}), so the bar had to show no number at all.`
      ]
    })

    await screenshot(win, shotDir, 'usage-1-real.png')
  }

  // -------------------------------------------------------------------------
  // U-2: it follows the file with no restart and no click
  // -------------------------------------------------------------------------
  if (run('watch')) {
    const now = Date.now()
    const first = fixture(fixtureDir, 'watch', {
      fetchedAtMs: now,
      limits: [
        { kind: 'session', group: 'session', percent: 12, resetsAtMs: now + 3 * 3_600_000 },
        { kind: 'weekly_all', group: 'weekly', percent: 34, resetsAtMs: now + 40 * 3_600_000 }
      ]
    })
    usage.pointAt(first)
    const before = await waitForText(win, (t) => paintedPercents(t).session === 12, 10_000)

    // Rewritten in place, exactly the way the CLI refreshes it. Nothing is told
    // to reload: the watch and the poll are the whole mechanism under test.
    const later = Date.now()
    fixture(fixtureDir, 'watch', {
      fetchedAtMs: later,
      limits: [
        { kind: 'session', group: 'session', percent: 67, severity: 'warning', resetsAtMs: later + 3 * 3_600_000 },
        { kind: 'weekly_all', group: 'weekly', percent: 89, severity: 'critical', resetsAtMs: later + 40 * 3_600_000 }
      ]
    })
    const startedWaiting = Date.now()
    const after = await waitForText(win, (t) => paintedPercents(t).session === 67, 20_000)
    const tookMs = Date.now() - startedWaiting

    const paintedAfter = paintedPercents(after)
    // Severity drives the colour, and the whole reason for using the server's
    // field rather than a threshold here is that the colour has to move with
    // it. Read back off the computed style of the element holding the number.
    const colours = await js<string[]>(
      win,
      `[...document.querySelectorAll('${SEGMENT} span')]
         .filter((el) => /^\\d+%$/.test(el.textContent ?? ''))
         .map((el) => getComputedStyle(el).color)`
    )

    checks.push({
      id: 'U-2',
      criterion: 'Refreshed without a restart while a session runs',
      title: 'A rewritten reading reaches the bar on its own',
      ok:
        paintedPercents(before).session === 12 &&
        paintedAfter.session === 67 &&
        paintedAfter.weekly === 89 &&
        new Set(colours).size === 2,
      detail: {
        fixture: first,
        before,
        after,
        noticedInMs: tookMs,
        percentColours: colours
      },
      notes: [
        'The app was not restarted, no refresh was clicked and no IPC request was',
        'made from this driver - the file changed and the window followed it.',
        'Two distinct colours prove severity is what drives the colour: the same',
        'reading carries one warning and one critical limit.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // U-3: reset times, and a window rolling over under the segment
  // -------------------------------------------------------------------------
  if (run('resets')) {
    const now = Date.now()
    const sessionResets = now + 2 * 3_600_000 + 5 * 60_000
    const weekResets = now + 3 * 24 * 3_600_000 + 17 * 60_000
    const file = fixture(fixtureDir, 'resets', {
      fetchedAtMs: now,
      limits: [
        { kind: 'session', group: 'session', percent: 41, resetsAtMs: sessionResets },
        { kind: 'weekly_all', group: 'weekly', percent: 52, resetsAtMs: weekResets }
      ]
    })
    usage.pointAt(file)
    const text = await waitForText(win, (t) => paintedPercents(t).session === 41, 10_000)

    const paintedMinutes = paintedMinutesUntil(text)
    const ownMinutes = Math.floor((sessionResets - Date.now()) / 60_000)
    const absolute = ownAbsolute(weekResets)
    const showsWeekday = text.includes(absolute.weekday)
    const showsClock = text.includes(absolute.clock)

    checks.push({
      id: 'U-3',
      criterion: 'Reset times shown',
      title: 'Both windows say when they reset, counted down and by the clock',
      ok:
        paintedMinutes !== null &&
        Math.abs(paintedMinutes - ownMinutes) <= 1 &&
        showsWeekday &&
        showsClock,
      detail: {
        text,
        sessionResetsAt: new Date(sessionResets).toISOString(),
        paintedMinutesUntilSessionReset: paintedMinutes,
        independentMinutesUntilSessionReset: ownMinutes,
        weekResetsAt: new Date(weekResets).toISOString(),
        independentAbsolute: absolute,
        showsWeekday,
        showsClock
      },
      notes: [
        'Under a day is counted down, because that window resets while you work.',
        'Over a day is given by the clock, because "in 3d 4h" answers nothing.',
        'The expected weekday and clock time are computed here from getDay() and',
        'getHours() rather than by calling the same formatter the component did.'
      ]
    })

    await screenshot(win, shotDir, 'usage-3-resets.png')

    // The rollover. Ten seconds out, then nothing is touched: no file is
    // written, no event is sent, no click is made. The segment has to drop the
    // window on its own, because the only thing that changed is the time.
    const rollAt = Date.now() + 10_000
    const rollFile = fixture(fixtureDir, 'rollover', {
      fetchedAtMs: Date.now(),
      limits: [
        { kind: 'session', group: 'session', percent: 77, resetsAtMs: rollAt },
        { kind: 'weekly_all', group: 'weekly', percent: 52, resetsAtMs: Date.now() + 3 * 24 * 3_600_000 }
      ]
    })
    usage.pointAt(rollFile)
    const beforeRoll = await waitForText(win, (t) => paintedPercents(t).session === 77, 10_000)
    const afterRoll = await waitForText(
      win,
      (t) => paintedPercents(t).session === null,
      45_000
    )
    const paintedAfterRoll = paintedPercents(afterRoll)

    checks.push({
      id: 'U-4',
      criterion: 'Reset times correct across a window rollover',
      title: 'A window that resets while it is on screen is dropped, not left stale',
      ok:
        paintedPercents(beforeRoll).session === 77 &&
        paintedAfterRoll.session === null &&
        paintedAfterRoll.weekly === 52,
      detail: {
        fixture: rollFile,
        rolledOverAt: new Date(rollAt).toISOString(),
        before: beforeRoll,
        after: afterRoll
      },
      notes: [
        'A genuine rollover, not a reset time planted in the past: the window was',
        'live when it was painted and expired underneath it.',
        'Nothing on disk changed in between - the clock is an input to what may be',
        'shown, which is why the segment re-derives on a tick rather than only',
        'when the main process pushes.',
        'The weekly figure stayed, because its window had not reset.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // U-5: a reading Helm cannot stand behind shows nothing
  // -------------------------------------------------------------------------
  if (run('degrade')) {
    const now = Date.now()
    const good: FixtureLimit[] = [
      { kind: 'session', group: 'session', percent: 44, resetsAtMs: now + 3 * 3_600_000 },
      { kind: 'weekly_all', group: 'weekly', percent: 55, resetsAtMs: now + 40 * 3_600_000 }
    ]

    const cases: Array<{ name: string; file: string; why: string; expectInTitle: string }> = [
      {
        name: 'missing key',
        file: fixture(fixtureDir, 'missing', { cached: undefined }),
        why: 'cachedUsageUtilization is absent, as it is on a CLI that has never asked',
        expectInTitle: 'has not cached'
      },
      {
        name: 'null key',
        file: fixture(fixtureDir, 'null-key', { cached: null }),
        why: 'the key is there and null, the way its sibling placeholders are',
        expectInTitle: 'has not cached'
      },
      {
        name: 'stale reading',
        file: fixture(fixtureDir, 'stale', {
          fetchedAtMs: now - (STALE_AFTER_MS + 5 * 60_000),
          limits: good
        }),
        why: 'the figures are older than the horizon, so another client could have moved them',
        expectInTitle: 'refreshed'
      },
      {
        name: 'reshaped limits',
        file: fixture(fixtureDir, 'reshaped', {
          cached: {
            fetchedAtMs: now,
            utilization: {
              limits: [
                { kind: 'session', group: 'session', utilization_percent: 44 },
                { kind: 'weekly_all', bucket: 'weekly', percent: 55 }
              ]
            }
          }
        }),
        why: 'percent was renamed and group was moved - the shape a CLI release can change',
        expectInTitle: 'Helm reads'
      },
      {
        name: 'reshaped root',
        file: fixture(fixtureDir, 'reshaped-root', {
          cached: { fetchedAtMs: now, buckets: { session: 44, weekly: 55 } }
        }),
        why: 'utilization was replaced wholesale',
        expectInTitle: 'utilization'
      },
      {
        name: 'half-written file',
        file: fixture(fixtureDir, 'torn', {
          raw: '{"cachedUsageUtilization": {"fetchedAtMs": 1786353684315, "utiliz'
        }),
        why: 'a read that landed mid-rewrite, which happens in normal use',
        expectInTitle: 'did not parse'
      }
    ]

    const results: Array<Record<string, unknown>> = []
    let allSilent = true

    for (const testCase of cases) {
      usage.pointAt(testCase.file)
      // Long enough for the read and a repaint; there is nothing to wait *for*,
      // since the assertion is that nothing appears.
      await sleep(900)
      const text = await segmentText(win)
      const title = await segmentTitle(win)
      const silentHere = !showsAnyNumber(text)
      const explains = title.includes(testCase.expectInTitle)
      if (!silentHere || !explains) allSilent = false
      if (testCase.name === 'stale reading') {
        await screenshot(win, shotDir, 'usage-5-degraded.png')
      }
      results.push({
        case: testCase.name,
        why: testCase.why,
        file: testCase.file,
        text,
        showedANumber: !silentHere,
        tooltipExplains: explains,
        tooltip: title.split('\n')[0]
      })
    }

    // The discipline M3-4 failed: a check that passes because its fixture is
    // empty proves nothing. So the same driver, the same segment and a fixture
    // that *is* good must produce a number - otherwise "showed nothing" is not
    // evidence of anything.
    const control = fixture(fixtureDir, 'control', { fetchedAtMs: Date.now(), limits: good })
    usage.pointAt(control)
    const controlText = await waitForText(win, (t) => paintedPercents(t).session === 44, 10_000)
    const controlPainted = paintedPercents(controlText)
    const controlWorks = controlPainted.session === 44 && controlPainted.weekly === 55

    checks.push({
      id: 'U-5',
      criterion: 'A missing, stale or reshaped reading shows nothing rather than a wrong number',
      title: 'Six broken readings paint no percentage; a good one still does',
      ok: allSilent && controlWorks,
      detail: { cases: results, control: { file: control, text: controlText, painted: controlPainted } },
      notes: [
        'Each case is a fixture written by this driver, so what is in the file is',
        'known rather than inferred.',
        'The control is not optional. A check that can pass with no evidence behind',
        'it is worse than no check: without it, "no percentage appeared" is also',
        'what a segment that never renders anything would report.'
      ]
    })

    await screenshot(win, shotDir, 'usage-5-control.png')
  }

  // -------------------------------------------------------------------------
  // U-6: the mode is a setting, and it is written down
  // -------------------------------------------------------------------------
  if (run('setting')) {
    await ensurePercentMode(win)
    const started = await segmentMode(win)

    await clickSegment(win)
    await sleep(400)
    const afterOne = await segmentMode(win)
    const textWhenOff = await segmentText(win)

    await clickSegment(win)
    await sleep(400)
    const afterTwo = await segmentMode(win)

    // Back to off, and left there: the second phase of this run is a fresh app
    // start that has to find something other than the default in the database.
    await clickSegment(win)
    await sleep(400)
    const parked = await segmentMode(win)

    // Read straight out of the database rather than from the object the main
    // process is holding, because the claim is about what a restart will find.
    const persisted = readSettings(services.store).usageDisplay

    checks.push({
      id: 'U-6',
      criterion: 'The mode is persisted in settings',
      title: 'Clicking the segment cycles the mode and writes it to app_settings',
      ok:
        started === 'percent' &&
        afterOne === 'off' &&
        afterTwo === 'percent' &&
        parked === 'off' &&
        persisted === 'off' &&
        !showsAnyNumber(textWhenOff),
      detail: {
        cycle: [started, afterOne, afterTwo, parked],
        persistedInDatabase: persisted,
        textWhenOff,
        databaseFile: services.store.file
      },
      notes: [
        'Two modes in the cycle, not three: `cost` is only offered once the index',
        'has an estimate to show, and offering a mode that would paint nothing is',
        'offering a broken setting.',
        'Left on `off` on purpose. Whether it survives a restart is decided by the',
        'second phase in scripts/run-usage.mjs, which starts the app again and',
        'reports what it read - this process cannot assert that about itself.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // U-7: it fits, at every width and in both themes
  // -------------------------------------------------------------------------
  if (run('width')) {
    await ensurePercentMode(win)
    // A reading with everything in it: the longest label the segment can have
    // is a per-model weekly limit, and the longest reset text is a countdown
    // with both hours and minutes in it.
    const now = Date.now()
    usage.pointAt(
      fixture(fixtureDir, 'widest', {
        fetchedAtMs: now,
        limits: [
          { kind: 'session', group: 'session', percent: 100, resetsAtMs: now + 4 * 3_600_000 + 58 * 60_000 },
          { kind: 'weekly_all', group: 'weekly', percent: 88, resetsAtMs: now + 40 * 3_600_000 },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 99,
            severity: 'critical',
            resetsAtMs: now + 40 * 3_600_000,
            scope: 'Fable'
          }
        ]
      })
    )
    await waitForText(win, (t) => paintedPercents(t).session === 100, 10_000)

    const bounds = win.getBounds()
    const measurements: Array<Record<string, unknown>> = []
    let fitsEverywhere = true

    for (const theme of ['light', 'dark'] as const) {
      await js(
        win,
        `(() => { document.documentElement.classList.toggle('dark', ${String(theme === 'dark')});
          document.documentElement.style.colorScheme = ${JSON.stringify(theme)}; return true })()`
      )
      for (const width of [900, 1024, 1280, 1600]) {
        win.setBounds({ ...bounds, width, height: bounds.height })
        await sleep(500)
        const measured = await js<{ scroll: number; client: number; segment: number; overlaps: boolean }>(
          win,
          `(() => {
            const bar = document.querySelector('footer');
            const seg = document.querySelector('${SEGMENT}');
            const barBox = bar.getBoundingClientRect();
            const segBox = seg.getBoundingClientRect();
            return {
              scroll: bar.scrollWidth,
              client: bar.clientWidth,
              segment: Math.round(segBox.width),
              overlaps: segBox.left < barBox.left || segBox.right > barBox.right + 1
            }
          })()`
        )
        // One pixel of tolerance: a sub-pixel text width rounds up into
        // scrollWidth on some zoom levels and is not an overflow anyone can see.
        const fits = measured.scroll <= measured.client + 1 && !measured.overlaps
        if (!fits) fitsEverywhere = false
        measurements.push({ theme, width, ...measured, fits })
        await screenshot(win, shotDir, `usage-7-${theme}-${String(width)}.png`)
      }
    }

    win.setBounds(bounds)
    await sleep(300)
    await js(win, `(() => { document.documentElement.classList.remove('dark'); return true })()`)

    checks.push({
      id: 'U-7',
      criterion: 'The status bar is always visible, so it has to fit',
      title: 'The bar does not overflow at any width the window allows, in either theme',
      ok: fitsEverywhere,
      detail: { measurements, minimumWindowWidth: 900 },
      notes: [
        '900 is the window minimum; 1280 is the default. The reset text is hidden',
        'below 1024 and stays in the tooltip, which is what buys the room.',
        'Measured with the widest reading the segment can be handed: a per-model',
        'weekly limit at 99% and a four-hour countdown.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // U-8: what the status bar costs
  // -------------------------------------------------------------------------
  if (run('cost')) {
    // The thing being avoided, measured rather than quoted: every transcript,
    // parsed whole, which is what a naive dollar figure would cost per repaint.
    const projectsDir = projectsDirIn(claudeHome())
    const transcripts: string[] = []
    let bytes = 0
    try {
      for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue
        for (const name of readdirSync(join(projectsDir, dir.name))) {
          if (!name.endsWith('.jsonl')) continue
          const file = join(projectsDir, dir.name, name)
          try {
            bytes += statSync(file).size
            transcripts.push(file)
          } catch {
            continue
          }
        }
      }
    } catch {
      // No transcripts is a true answer, and the baseline is then zero.
    }

    const fullStart = performance.now()
    let rows = 0
    for (const file of transcripts) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line === '') continue
        try {
          JSON.parse(line)
          rows++
        } catch {
          continue
        }
      }
    }
    const fullParseMs = performance.now() - fullStart

    // What the bar actually does when it repaints: re-derive from a reading it
    // already has. No file, no database, no IPC.
    const derive = await js<{ iterations: number; totalMs: number; perPaintMs: number }>(
      win,
      `(async () => {
        const seg = document.querySelector('${SEGMENT}');
        const t0 = performance.now();
        let n = 0;
        // Force layout of the segment the way a repaint would, 500 times.
        for (let i = 0; i < 500; i++) { n += seg.getBoundingClientRect().width; }
        const totalMs = performance.now() - t0;
        return { iterations: 500, totalMs, perPaintMs: totalMs / 500, n }
      })()`
    )

    // One pass of the reader itself, for the record: this is what the main
    // process spends when the CLI rewrites the file, not what a repaint costs.
    const readStart = performance.now()
    usage.pointAt(null)
    const readMs = performance.now() - readStart

    checks.push({
      id: 'U-8',
      criterion: 'Reading usage costs the status bar nothing measurable on repaint',
      title: 'A repaint touches no file; the full parse it avoids is measured here',
      ok: derive.perPaintMs < 1 && readMs < 200,
      detail: {
        fullParse: {
          transcripts: transcripts.length,
          megabytes: Math.round((bytes / 1024 / 1024) * 10) / 10,
          rows,
          ms: Math.round(fullParseMs)
        },
        repaint: derive,
        oneReadOfClaudeJsonMs: Math.round(readMs * 100) / 100,
        claudeJsonBytes: (() => {
          try {
            return statSync(realFile).size
          } catch {
            return null
          }
        })()
      },
      notes: [
        'Percent mode reads one small JSON file, and only when it changes. The',
        'full parse above is the cost the dollar half has to avoid, measured on',
        'this machine rather than taken from the task description.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // U-9: against a live session's own /usage
  // -------------------------------------------------------------------------
  if (run('live')) {
    usage.pointAt(null)
    await ensurePercentMode(win)

    // The repo root: a directory the CLI has already been trusted in, so the
    // session reaches its prompt instead of sitting on a gate. Electron is
    // started from `packages/desktop`, hence the two levels up. The gates are
    // answered anyway - this only makes it quicker.
    const cwd = resolve(process.cwd(), '..', '..')
    const record = ctx.sessions.start({
      cwd,
      name: 'usage check',
      cols: 120,
      rows: 40
    })
    const stopGates = answerConsent(ctx, collector, [record.id])
    const ready = await waitFor(
      () => atPrompt(stripAnsi(collector.output(record.id))),
      120_000
    )
    await sleep(2000)

    const before = collector.output(record.id).length
    ctx.sessions.input(record.id, '/usage')
    await sleep(1200)
    ctx.sessions.input(record.id, '\r')

    // `/usage` paints from the cache first and repaints when the server
    // answers, so the *last* rendering is the one to read.
    const seen = (): string => stripAnsi(collector.output(record.id).slice(before))
    const answered = await waitFor(() => /Current week/.test(seen()), 90_000)
    await sleep(6000)
    stopGates()

    const panel = seen()
    const squashed = panel.replace(/\s+/g, '')
    const lastMatch = (re: RegExp): number | null => {
      let value: number | null = null
      for (;;) {
        const match = re.exec(squashed)
        if (match === null) break
        value = Number(match[1])
      }
      return value
    }
    // The TUI draws a bar of block characters between the label and the number.
    const tuiSession = lastMatch(/Currentsession[^%]{0,80}?(\d+)%used/g)
    const tuiWeek = lastMatch(/Currentweek\(allmodels\)[^%]{0,80}?(\d+)%used/g)

    // The status bar has to catch up on its own: the CLI rewrote
    // `~/.claude.json` and nothing here told Helm about it.
    const text = await waitForText(
      win,
      (t) => paintedPercents(t).session === tuiSession && paintedPercents(t).weekly === tuiWeek,
      20_000
    )
    const painted = paintedPercents(text)
    const mine = ownRead(realFile)
    const expected = ownExpectation(mine, Date.now())

    await screenshot(win, shotDir, 'usage-9-live.png')
    await ctx.sessions.close({ id: record.id, force: true })

    checks.push({
      id: 'U-9',
      criterion: 'Percent mode matches what /usage reports inside a live session',
      title: 'The bar and the session agree to the percentage point',
      ok:
        ready &&
        answered &&
        tuiSession !== null &&
        tuiWeek !== null &&
        painted.session === tuiSession &&
        painted.weekly === tuiWeek &&
        expected.session === tuiSession &&
        expected.weekly === tuiWeek,
      detail: {
        cwd,
        reachedPrompt: ready,
        usagePanelAppeared: answered,
        tui: { session: tuiSession, week: tuiWeek },
        statusBar: painted,
        fileAfterRefresh: expected,
        readingAgeSeconds:
          mine.fetchedAtMs === null ? null : Math.round((Date.now() - mine.fetchedAtMs) / 1000),
        panelTail: panel.replace(/\s+/g, ' ').trim().slice(-900)
      },
      notes: [
        'Three readings compared, not two: what the session painted in its own',
        'TUI, what this driver parsed out of ~/.claude.json by hand, and what the',
        'status bar shows.',
        'Running /usage is also what refreshes the cache, so this doubles as proof',
        'that the bar follows a session it is hosting without being told.'
      ]
    })
  }

  usage.pointAt(null)
  return checks
}
