import { createHash } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import type { BrowserWindow } from 'electron'
import {
  claudeHome,
  historyFileIn,
  projectsDirIn,
  readArchivedConversation,
  readHistorySessions,
  readSettings,
  type ArchivedConversation,
  type Store
} from '@helm/core'
import { screenshot, sleep, typeText, sendKey } from './bridge'
import type { Check } from './fidelity'
import type { CheckContext } from './sessionscheck'

/**
 * The transcript archive, driven through the app the way a user reaches it.
 *
 * `pnpm transcript-check` -> helm-data/transcript-report.json.
 * Two phases, no `claude` sessions, about a minute and a half - most of which
 * is spent waiting for the watcher to notice a planted transcript on its own
 * rather than being told to look.
 *
 * Three things about the shape of this file are worth knowing before touching
 * it.
 *
 * **It runs against a `.claude` tree of its own**, planted by
 * `scripts/run-transcript.mjs` and pointed at with the real `CLAUDE_CONFIG_DIR`
 * environment variable rather than a test hook. That is deliberate on both
 * counts: fixtures are the only way to know exactly what the archive should
 * hold, and using the variable the CLI itself honours means T-0 is a real
 * assertion about the criterion "no `os.homedir()` assumption" rather than a
 * statement about a flag only checks pass.
 *
 * **Every claim has a read this driver makes for itself.** The archived text is
 * compared against this file's own naive parse of the fixture bytes, the
 * read-only claim against this file's own sha256 walk, the incremental claim
 * against this file's own `statSync`. A parser agreeing with itself proves
 * nothing.
 *
 * **Every comparator is made to fail before its pass is believed.** T-1 mutates
 * the expected conversation and requires the comparison to reject it; T-5
 * plants a file in the fixture tree and requires the hash to move. CLAUDE.md's
 * rule about PROF-4 is what these are for: a probe that cannot fail is worse
 * than no probe.
 */

const GROUPS = ['setup', 'capture', 'incremental', 'search', 'bounded', 'readonly'] as const
type Group = (typeof GROUPS)[number]

/**
 * A token that appears in no prompt and in no other conversation.
 *
 * The search criterion is "findable by content, and **not** findable in
 * `history_prompts`", so the token has to be one that could only have come out
 * of a message body. Planted in the middle of a conversation rather than at
 * either end, because the first message is also the row's headline and the last
 * is the one a naive tail read would find on its own.
 */
const NEEDLE = 'zorblatt'
const SURVIVOR_NEEDLE = 'quillamere'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface PlantedMessage {
  role: 'user' | 'assistant'
  text: string
}

interface Fixture {
  sessionId: string
  file: string
  /** Exactly what the archive should end up holding, in order. */
  messages: PlantedMessage[]
  /** Last message time, which is what eviction orders by. */
  lastAt: number
}

/** A uuid the fixtures can generate without colliding with anything real. */
let uuidSeq = 0
function fixtureUuid(): string {
  uuidSeq++
  return `feed0000-0000-4000-8000-${uuidSeq.toString(16).padStart(12, '0')}`
}

function sessionUuid(index: number): string {
  return `fee5${index.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`
}

/**
 * A transcript line as Claude Code writes one.
 *
 * Written out here rather than built by anything in `packages/core`, so the
 * fixture is a statement about the file format and not a round trip through the
 * parser being tested.
 */
function transcriptLine(
  sessionId: string,
  message: PlantedMessage,
  atMs: number,
  cwd: string
): string {
  const body =
    message.role === 'user'
      ? { role: 'user', content: message.text }
      : { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: message.text }] }
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: message.role,
    message: body,
    uuid: fixtureUuid(),
    timestamp: new Date(atMs).toISOString(),
    userType: 'external',
    cwd,
    sessionId,
    version: '2.1.225',
    gitBranch: 'main'
  })
}

/**
 * Lines that are not conversation, mixed in so the fixture exercises the skip
 * path rather than only the happy one.
 *
 * The tool traffic is the interesting half: it is the bulk of a real transcript
 * and the archive is only small because it drops it, so a fixture with none of
 * it would let a regression that archived everything pass unnoticed.
 */
function noiseLines(sessionId: string, atMs: number, cwd: string): string[] {
  const base = {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId,
    version: '2.1.225'
  }
  return [
    JSON.stringify({ ...base, type: 'system', uuid: fixtureUuid(), timestamp: new Date(atMs).toISOString() }),
    JSON.stringify({
      ...base,
      type: 'attachment',
      uuid: fixtureUuid(),
      timestamp: new Date(atMs).toISOString(),
      content: 'x'.repeat(2048)
    }),
    // A tool call and its result. The call survives as a one-line marker; the
    // result, which is where the bytes are, must not survive at all.
    JSON.stringify({
      ...base,
      type: 'assistant',
      uuid: fixtureUuid(),
      timestamp: new Date(atMs).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'y'.repeat(4096) } }]
      }
    }),
    JSON.stringify({
      ...base,
      type: 'user',
      uuid: fixtureUuid(),
      timestamp: new Date(atMs).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'z'.repeat(8192) }]
      }
    }),
    // Not JSON at all. Skipped, not fatal.
    '{ this line is not json',
    // The caveat the CLI injects around a slash command: a message nobody wrote.
    JSON.stringify({
      ...base,
      type: 'user',
      isMeta: true,
      uuid: fixtureUuid(),
      timestamp: new Date(atMs).toISOString(),
      message: { role: 'user', content: '<local-command-caveat>ignore this</local-command-caveat>' }
    })
  ]
}

/** What the fixture's messages look like once the parser has kept its part. */
function toolMarker(): PlantedMessage {
  return { role: 'assistant', text: '[tool: Read]' }
}

interface PlantOptions {
  projectsDir: string
  /** Directory under `projects/`, as Claude Code encodes a working directory. */
  projectDir: string
  cwd: string
  index: number
  /** Message bodies. The tool marker and the noise are added around them. */
  bodies: PlantedMessage[]
  startedAt: number
}

/**
 * Writes one transcript and returns exactly what the archive should hold for it.
 *
 * The returned `messages` is this driver's statement of the answer, built while
 * the file is written rather than parsed back out of it - so a comparison
 * against it is a comparison against an independent reading and not a round
 * trip.
 */
function plantTranscript(options: PlantOptions): Fixture {
  const { projectsDir, projectDir, cwd, index, bodies, startedAt } = options
  const sessionId = sessionUuid(index)
  const dir = join(projectsDir, projectDir)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)

  const lines: string[] = []
  const expected: PlantedMessage[] = []
  let at = startedAt

  for (const [position, body] of bodies.entries()) {
    lines.push(transcriptLine(sessionId, body, at, cwd))
    expected.push(body)
    at += 1000
    // The noise goes in the middle, where a reader that stopped at the first
    // unusable line would still have looked usable.
    if (position === 0) {
      lines.push(...noiseLines(sessionId, at, cwd))
      expected.push(toolMarker())
      at += 1000
    }
  }

  writeFileSync(file, lines.map((line) => `${line}\n`).join(''), 'utf8')
  return { sessionId, file, messages: expected, lastAt: at - 1000 }
}

/** A prompt line for the fixture `history.jsonl`, so the session is in the index. */
function historyLine(sessionId: string, cwd: string, atMs: number, display: string): string {
  return JSON.stringify({ display, pastedContents: {}, timestamp: atMs, project: cwd, sessionId })
}

// ---------------------------------------------------------------------------
// This driver's own readers
// ---------------------------------------------------------------------------

/**
 * The conversation this driver expects, read out of the fixture bytes with none
 * of the code under test.
 *
 * Deliberately naive - `readFileSync`, `split`, `JSON.parse`, a hand-written
 * content walk - because the point is to disagree with the incremental reader
 * if the incremental reader is wrong.
 */
function readFixtureConversation(file: string): PlantedMessage[] {
  const out: PlantedMessage[] = []
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = row['type']
    if (type !== 'user' && type !== 'assistant') continue
    if (row['isMeta'] === true) continue
    const message = row['message'] as Record<string, unknown> | undefined
    const content = message?.['content']
    const parts: string[] = []
    if (typeof content === 'string') {
      if (content.trim() !== '') parts.push(content.trim())
    } else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
        else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
          parts.push(block['thinking'])
        } else if (block['type'] === 'tool_use') parts.push(`[tool: ${String(block['name'])}]`)
      }
    }
    const text = parts.join('\n\n').trim()
    if (text === '') continue
    out.push({ role: type, text })
  }
  return out
}

/** Two conversations, compared message by message. The comparator T-1 breaks. */
function sameConversation(a: readonly PlantedMessage[], b: readonly PlantedMessage[]): boolean {
  if (a.length !== b.length) return false
  return a.every((message, index) => {
    const other = b[index]
    return other !== undefined && other.role === message.role && other.text === message.text
  })
}

/** One character changed, so the comparison above has something to reject. */
function mutate(messages: readonly PlantedMessage[]): PlantedMessage[] {
  const copy = messages.map((message) => ({ ...message }))
  const target = copy[Math.floor(copy.length / 2)] ?? copy[0]
  if (target !== undefined) {
    target.text = `${target.text.slice(0, -1)}${target.text.endsWith('!') ? '?' : '!'}`
  }
  return copy
}

/** What the archive actually holds, in the same shape. */
function archivedMessages(conversation: ArchivedConversation | null): PlantedMessage[] {
  return (conversation?.messages ?? []).map((message) => ({ role: message.role, text: message.text }))
}

/**
 * A manifest of every file under a tree, and one hash over the lot.
 *
 * Path, size, mtime and content hash per file. Content alone would miss a
 * rewrite with identical bytes; mtime alone would miss a rename. The manifest
 * is sorted, so the digest does not depend on directory order.
 */
function hashTree(root: string): { digest: string; files: number; bytes: number } {
  const entries: string[] = []
  let bytes = 0

  const walk = (dir: string): void => {
    let listing
    try {
      listing = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const stats = statSync(path)
      const content = createHash('sha256').update(readFileSync(path)).digest('hex')
      bytes += stats.size
      entries.push(
        `${relative(root, path)}\t${String(stats.size)}\t${String(stats.mtimeMs)}\t${content}`
      )
    }
  }

  walk(root)
  return {
    digest: createHash('sha256').update(entries.join('\n')).digest('hex'),
    files: entries.length,
    bytes
  }
}

/**
 * Text that deflate cannot flatten, for the fixtures that have to reach a size.
 *
 * A linear congruential generator in base 36. The archive compresses real
 * conversation about 15x on these fixtures, which is the feature working and
 * makes a size-based fixture impossible to write by repeating a phrase - the
 * first version of the bounded group did exactly that and produced 74 bytes per
 * conversation, under the setting's own floor. Deterministic, so a failing run
 * can be reproduced.
 */
function incompressible(seed: number, chars: number): string {
  let x = (seed * 2654435761) >>> 0
  let out = ''
  while (out.length < chars) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    out += `${x.toString(36)} `
  }
  return out.slice(0, chars)
}

/** Every archived session, oldest last-message first. The eviction order. */
function allArchived(
  store: Store
): Array<{ sessionId: string; lastAt: number; storedBytes: number }> {
  const rows = store.raw
    .prepare(
      `SELECT session_id, COALESCE(last_at, 0) AS last_at, stored_bytes
       FROM transcript_sessions WHERE state = 'archived'
       ORDER BY COALESCE(last_at, 0), session_id`
    )
    .all() as Array<{ session_id: string; last_at: number; stored_bytes: number }>
  return rows.map((row) => ({
    sessionId: row.session_id,
    lastAt: row.last_at,
    storedBytes: row.stored_bytes
  }))
}

/** The ids the ceiling has dropped, read straight out of the table. */
function evictedSessionIds(store: Store): Set<string> {
  const rows = store.raw
    .prepare("SELECT session_id FROM transcript_sessions WHERE state = 'evicted'")
    .all() as Array<{ session_id: string }>
  return new Set(rows.map((row) => row.session_id))
}

/** Whether a token appears anywhere in the prompt index. The search's converse. */
function tokenInPrompts(store: Store, token: string): number {
  const row = store.raw
    .prepare("SELECT COUNT(*) AS n FROM history_prompts WHERE text LIKE '%' || ? || '%'")
    .get(token) as { n: number }
  return row.n
}

// ---------------------------------------------------------------------------
// Talking to the renderer
// ---------------------------------------------------------------------------

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

async function showHistory(win: BrowserWindow): Promise<boolean> {
  if (!(await click(win, '[data-tab="history"]'))) {
    await click(win, 'aside button[data-open-history]')
  }
  return pollJs(win, `document.querySelector('input[data-history-search]')`, 15_000)
}

/** Rows as painted, with the archive state each one is claiming. */
interface PaintedRow {
  sessionId: string
  archive: string
  badge: string | null
  text: string
}

async function paintedRows(win: BrowserWindow): Promise<PaintedRow[]> {
  return js<PaintedRow[]>(
    win,
    `[...document.querySelectorAll('button[data-session]')].map((el) => ({
      sessionId: el.dataset.session,
      archive: el.dataset.archive,
      badge: el.querySelector('[data-badge]')?.dataset.badge ?? null,
      text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim()
    }))`
  )
}

/** Replaces the search box's contents with real keystrokes. */
async function typeSearch(win: BrowserWindow, term: string): Promise<void> {
  await click(win, 'input[data-history-search]')
  await js<boolean>(
    win,
    `(() => { const el = document.querySelector('input[data-history-search]');
      el.focus(); el.select(); return true })()`
  )
  await sendKey(win, 'Backspace')
  if (term !== '') await typeText(win, term, 8)
  // Wait for the painted list to be the answer to the text now in the box and
  // the scope now selected, rather than for a fixed number of milliseconds. See
  // `historycheck.ts`'s note on why stability cannot tell "not yet" from
  // "final" - and on why this compares session ids rather than row counts, which
  // two different searches can agree on while showing different sessions.
  for (let attempt = 0; attempt < 40; attempt++) {
    const agreed = await js<boolean>(
      win,
      `(async () => {
        const box = document.querySelector('input[data-history-search]');
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
    if (agreed) return
    await sleep(60)
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export interface TranscriptCheckOptions {
  /** Where the report and the screenshots go. */
  dataDir: string
  shotDir: string
  only?: readonly string[] | undefined
}

/**
 * What phase one leaves for phase two, through `transcript-phase1.json`.
 *
 * The expected conversation travels in this file rather than being re-derived
 * in phase two, and it has to: by the time phase two runs, the transcript it
 * would have been derived from has been deleted. That is the point of the
 * phase, and it means the only honest source for "what should still be here" is
 * what the other process saw before the file went.
 */
export interface PhaseOneRecord {
  survivor: {
    sessionId: string
    file: string
    needle: string
    messages: PlantedMessage[]
  }
  claudeHome: string
}

export async function runTranscriptChecks(
  ctx: CheckContext,
  options: TranscriptCheckOptions
): Promise<Check[]> {
  const wanted = new Set<string>(options.only && options.only.length > 0 ? options.only : GROUPS)
  const run = (group: Group): boolean => wanted.has(group)

  const checks: Check[] = []
  const { win, services, archive, history } = ctx
  const home = claudeHome()
  const projectsDir = projectsDirIn(home)
  const historyFile = historyFileIn(home)
  const cwd = home

  // -------------------------------------------------------------------------
  // T-0: the fixture tree is the one being read, through CLAUDE_CONFIG_DIR
  // -------------------------------------------------------------------------
  //
  // First because nothing after it means anything otherwise: every fixture this
  // driver plants goes under `home`, and if the app is reading somewhere else
  // then every later assertion is about a tree nobody wrote to.
  const envHome = process.env['CLAUDE_CONFIG_DIR'] ?? ''
  const realHome = join(homedir(), '.claude')
  const preplanted = readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(projectsDir, entry.name))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => name.slice(0, -'.jsonl'.length).toLowerCase())
    )

  /*
   * The start-up sweep, waited for rather than sampled.
   *
   * The runner writes one transcript before the app starts, so nothing could
   * have watched it appear - the only thing that can find it is the pass at
   * start-up. That pass is deliberately behind a `setImmediate` (it is off the
   * renderer's critical path, like the session index it rides on), and
   * `onReady` fires before it, so reading the figures here without waiting
   * measures the moment before the answer exists rather than the answer.
   */
  const sweptAt = Date.now()
  const sweptStartup = await (async () => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const missing = preplanted.filter(
        (id) => readArchivedConversation(services.store, id) === null
      )
      if (missing.length === 0) return true
      if (Date.now() >= deadline) return false
      await sleep(200)
    }
  })()
  const sweptMs = Date.now() - sweptAt
  const atStart = archive.stats()

  checks.push({
    id: 'T-0',
    criterion:
      'CLAUDE_CONFIG_DIR honoured; a session that ended while Helm was closed is captured at next start',
    title: 'The archive reads the tree CLAUDE_CONFIG_DIR names, and sweeps it at start-up',
    ok:
      envHome !== '' &&
      home === envHome &&
      home.toLowerCase() !== realHome.toLowerCase() &&
      preplanted.length > 0 &&
      sweptStartup &&
      atStart.sessions >= preplanted.length,
    detail: {
      CLAUDE_CONFIG_DIR: envHome,
      claudeHomeResolvedTo: home,
      andNotTheRealOne: realHome,
      projectsDir,
      historyFile,
      transcriptsPlantedBeforeLaunch: preplanted,
      allOfThemArchived: sweptStartup,
      foundAfterMs: sweptMs,
      archivedByTheStartUpSweep: {
        sessions: atStart.sessions,
        messages: atStart.messages,
        storedBytes: atStart.storedBytes
      }
    },
    notes: [
      'The real environment variable, not a flag only checks pass. `claudeHome()` resolves it,',
      'and it is the same function every other surface uses - so this is the criterion rather',
      'than a statement about a test hook.',
      'The pre-planted transcript was written before the app started, so the watch had nothing',
      'to fire on: a sweep is the only thing that could have found it.',
      'Asserted against the real home too, because a driver reading the user`s own tree by',
      'accident would pass every other check in this file.'
    ]
  })

  // T-0 is not gated on `run('setup')`: every group below plants fixtures under
  // this tree, so a narrowed re-run needs the same statement about which tree
  // that is. It costs one `readdirSync`.

  // -------------------------------------------------------------------------
  // T-1: a planted conversation is captured, and the comparator can fail
  // -------------------------------------------------------------------------
  const capture = plantTranscript({
    projectsDir,
    projectDir: 'C--fixture-capture',
    cwd,
    index: 10,
    startedAt: Date.parse('2026-08-01T09:00:00.000Z'),
    bodies: [
      { role: 'user', text: 'How do I keep a conversation that Claude Code is about to delete?' },
      {
        role: 'assistant',
        text: `Read it before the reap. The token for this fixture is ${NEEDLE}, planted in the middle so a tail read alone would not find it.`
      },
      { role: 'user', text: 'And how big does that get?' },
      {
        role: 'assistant',
        text: 'Small: the tool traffic is the bulk of a transcript and none of it is conversation.'
      }
    ]
  })
  appendFileSync(
    historyFile,
    `${historyLine(capture.sessionId, cwd, capture.lastAt, 'How do I keep a conversation that Claude Code is about to delete?')}\n`,
    'utf8'
  )

  // Nothing forces a pass here. The watch over `projects/` has to notice on its
  // own, which is the criterion ("captured within minutes of session activity")
  // and the one claim a forced refresh would erase.
  let noticedMs = -1
  const plantedAt = Date.now()
  const captured = await (async () => {
    const deadline = Date.now() + 45_000
    for (;;) {
      const found = readArchivedConversation(services.store, capture.sessionId)
      if (found !== null && found.messages.length >= capture.messages.length) {
        noticedMs = Date.now() - plantedAt
        return found
      }
      if (Date.now() >= deadline) return found
      await sleep(250)
    }
  })()

  const expected = readFixtureConversation(capture.file)
  const actual = archivedMessages(captured)
  // The fixture has to be discriminating before its pass is believed: it must
  // carry real text, it must carry the planted token, and the comparator must
  // reject a version of it with one character changed. A comparator that
  // matched anything would report a green run over an empty archive.
  const fixtureIsReal =
    expected.length === capture.messages.length &&
    expected.some((message) => message.text.includes(NEEDLE)) &&
    expected.reduce((sum, message) => sum + message.text.length, 0) > 200
  const comparatorRejectsAMutation = !sameConversation(mutate(expected), actual)
  const comparatorAcceptsTheTruth = sameConversation(expected, actual)
  // And the tool traffic must be gone: the marker survives, the 8 KB result
  // does not.
  const noToolResults = actual.every((message) => !message.text.includes('zzzz'))
  const keptTheToolMarker = actual.some((message) => message.text === '[tool: Read]')

  if (run('capture')) {
    checks.push({
      id: 'T-1',
      criterion: 'New transcripts are captured within minutes of session activity',
      title: 'A transcript planted under projects/ is archived by the watch, message for message',
      ok:
        fixtureIsReal &&
        comparatorRejectsAMutation &&
        comparatorAcceptsTheTruth &&
        noToolResults &&
        keptTheToolMarker &&
        noticedMs >= 0,
      detail: {
        fixture: capture.file,
        fixtureBytes: statSync(capture.file).size,
        noticedAfterMs: noticedMs,
        expectedMessages: expected.length,
        archivedMessages: actual.length,
        proofs: {
          fixtureIsReal,
          comparatorAcceptsTheTruth,
          comparatorRejectsAMutation,
          keptTheToolMarker,
          noToolResults
        },
        firstDisagreement: expected.findIndex(
          (message, index) =>
            actual[index]?.text !== message.text || actual[index]?.role !== message.role
        ),
        sample: actual.slice(0, 2)
      },
      notes: [
        'Nothing here calls refresh(). The fs.watch over projects/ and the debounce behind it',
        'are what has to notice, which is what the criterion is about.',
        'The expected conversation is this file\'s own readFileSync + JSON.parse of the fixture,',
        'sharing no code with the incremental reader it is checking.',
        'The mutation is the proof the comparison can fail: one character changed in the middle',
        'message, and the comparator must reject it.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // T-2: a second pass reads the appended bytes, not the file
  // -------------------------------------------------------------------------
  if (run('incremental')) {
    const before = statSync(capture.file).size
    const appended = [
      transcriptLine(
        capture.sessionId,
        { role: 'user', text: 'One more question, appended after the first pass.' },
        capture.lastAt + 60_000,
        cwd
      ),
      transcriptLine(
        capture.sessionId,
        { role: 'assistant', text: 'And one more answer, which only the tail should have cost.' },
        capture.lastAt + 61_000,
        cwd
      )
    ]
      .map((line) => `${line}\n`)
      .join('')
    appendFileSync(capture.file, appended, 'utf8')
    const after = statSync(capture.file).size
    const appendedBytes = after - before

    const pass = archive.sweep()
    const grown = readArchivedConversation(services.store, capture.sessionId)

    checks.push({
      id: 'T-2',
      criterion: 'A transcript that has grown by n bytes costs an n-byte read',
      title: 'The second pass read only what was appended',
      ok:
        appendedBytes > 0 &&
        pass.bytesRead === appendedBytes &&
        pass.bytesRead < before &&
        pass.messages === 2 &&
        (grown?.messageCount ?? 0) === (captured?.messageCount ?? 0) + 2,
      detail: {
        fileBytesBefore: before,
        fileBytesAfter: after,
        appendedBytes,
        passReadBytes: pass.bytesRead,
        passMessages: pass.messages,
        messagesBefore: captured?.messageCount ?? 0,
        messagesAfter: grown?.messageCount ?? 0,
        passMs: Math.round(pass.ms * 100) / 100
      },
      notes: [
        'The byte counts are this driver\'s own statSync of the fixture, taken either side of',
        'its own append - not a figure the pass reported about itself.',
        'A pass that re-read the file would report ' + String(after) + ' rather than ' + String(appendedBytes) + '.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // T-3: findable by content, and not in the prompts
  // -------------------------------------------------------------------------
  if (run('search')) {
    const byMessage = readHistorySessions(services.store, { search: NEEDLE, scope: 'messages' })
    const byPrompt = readHistorySessions(services.store, { search: NEEDLE, scope: 'prompts' })
    const inPrompts = tokenInPrompts(services.store, NEEDLE)

    // And through the surface, which is where the criterion actually binds.
    await showHistory(win)
    await click(win, '[data-history-scope="messages"]')
    await sleep(200)
    await typeSearch(win, NEEDLE)
    const painted = await paintedRows(win)
    const shotSearch = await screenshot(win, options.shotDir, 'transcript-search.png')

    // The converse, through the same box: the same token with the scope back on
    // prompts must find nothing, which is what says the hit came from the
    // archive rather than from anywhere else.
    await click(win, '[data-history-scope="prompts"]')
    await sleep(200)
    await typeSearch(win, NEEDLE)
    const paintedPrompts = await paintedRows(win)

    checks.push({
      id: 'T-3',
      criterion: 'Archived sessions are searchable by message content, not just prompt text',
      title: `A token planted mid-conversation is found by content and is absent from history_prompts`,
      ok:
        inPrompts === 0 &&
        byMessage.sessions.length === 1 &&
        byMessage.sessions[0]?.sessionId.toLowerCase() === capture.sessionId &&
        byPrompt.total === 0 &&
        painted.length === 1 &&
        painted[0]?.sessionId.toLowerCase() === capture.sessionId &&
        paintedPrompts.length === 0,
      detail: {
        needle: NEEDLE,
        occurrencesInHistoryPrompts: inPrompts,
        overMessages: { total: byMessage.total, ids: byMessage.sessions.map((s) => s.sessionId) },
        overPrompts: { total: byPrompt.total },
        throughTheUi: {
          conversationsScope: painted.map((row) => row.sessionId),
          promptsScope: paintedPrompts.length,
          headline: painted[0]?.text ?? null
        },
        screenshot: shotSearch.file
      },
      notes: [
        'The token appears in no prompt on this machine and in no other conversation, so a hit',
        'can only have come out of an archived message body - which is the whole claim.',
        'The count in history_prompts is a direct LIKE over that table by this driver, not a',
        'question asked of the search being tested.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // T-4: the ceiling drops whole sessions, oldest first
  // -------------------------------------------------------------------------
  if (run('bounded')) {
    const originalCeiling = readSettings(services.store).transcriptArchiveMaxBytes

    // Five conversations an hour apart, each with a size of its own so "the
    // oldest went first" is a claim the arrangement can distinguish from "the
    // biggest went first".
    //
    // The bodies are deliberately *not* repetitive. The first version of this
    // fixture said `Conversation N. ` sixty times, which deflate turned into 74
    // bytes - so five conversations came to 880 bytes total, under the
    // validator's own 1 KB floor, and no ceiling the setting would accept could
    // evict anything. The archive being this compressible is the feature
    // working; a fixture that leans on it is a fixture that cannot test the
    // ceiling.
    const filler: Fixture[] = []
    for (let index = 0; index < 5; index++) {
      const body = incompressible(index, 3000 + index * 400)
      filler.push(
        plantTranscript({
          projectsDir,
          projectDir: `C--fixture-bounded-${String(index)}`,
          cwd,
          index: 20 + index,
          startedAt: Date.parse('2026-07-01T00:00:00.000Z') + index * 3_600_000,
          bodies: [
            { role: 'user', text: `Question ${String(index)}. ${body}` },
            { role: 'assistant', text: `Answer ${String(index)}. ${incompressible(100 + index, 3000)}` }
          ]
        })
      )
    }
    archive.sweep()

    const held = filler.map((fixture) => ({
      sessionId: fixture.sessionId,
      lastAt: fixture.lastAt,
      conversation: readArchivedConversation(services.store, fixture.sessionId)
    }))
    const allCaptured = held.every((entry) => entry.conversation?.state === 'archived')

    /*
     * The ceiling, computed from what is actually stored so the expected
     * outcome is exact.
     *
     * Every archived session in the database is in play, not only the fixtures
     * this group planted - the rule is over the archive, and asserting it over
     * a subset would let a version that evicted by size rather than by age pass
     * whenever the subset happened to agree. So: order every archived session by
     * last message time, decide that the three oldest must go, and set the
     * ceiling to exactly what the rest come to. The evictor drops while stored
     * *exceeds* the ceiling, so that is three drops and then a stop.
     */
    const archivedNow = allArchived(services.store)
    const beforeBytes = archivedNow.reduce((sum, row) => sum + row.storedBytes, 0)
    const doomed = archivedNow.slice(0, 3)
    const ceiling = beforeBytes - doomed.reduce((sum, row) => sum + row.storedBytes, 0)
    const expectedEvicted = doomed.map((row) => row.sessionId)

    // Written through the real settings channel, because a ceiling nothing set
    // through the app is a ceiling the app was never asked to honour.
    const accepted = await js<{ ok: boolean; value: number | null }>(
      win,
      `window.helm.invoke('settings:write', { transcriptArchiveMaxBytes: ${String(ceiling)} })
        .then((s) => ({ ok: true, value: s.transcriptArchiveMaxBytes }))
        .catch(() => ({ ok: false, value: null }))`
    )
    await sleep(400)
    const pass = archive.sweep()

    const after = filler.map((fixture) => readArchivedConversation(services.store, fixture.sessionId))
    const stats = archive.stats()
    // Whole or absent, never half. A session that kept some of its messages is
    // the failure this rule exists to prevent, and it is checked per session
    // against the count this driver planted rather than in aggregate: a total
    // can be right while one conversation is half there.
    const partial = after.filter((conversation, index) => {
      if (conversation === null) return true
      const planted = held[index]?.conversation?.messageCount ?? 0
      if (conversation.state === 'evicted') return conversation.messages.length !== 0
      return conversation.messages.length !== planted
    })
    const evictedIds = evictedSessionIds(services.store)
    const orderRespected =
      expectedEvicted.every((id) => evictedIds.has(id)) && evictedIds.size === expectedEvicted.length

    const shotSettings = await (async () => {
      await click(win, '[data-open-settings]')
      await pollJs(win, `document.querySelector('[data-settings-group="archive"]')`, 10_000)
      await js<void>(
        win,
        `(() => { const el = document.querySelector('[data-settings-group="archive"]');
          if (el) el.scrollIntoView({ block: 'center' }) })()`
      )
      await sleep(400)
      return screenshot(win, options.shotDir, 'transcript-settings.png')
    })()
    const statedInPane = await js<Record<string, string | null>>(
      win,
      `(() => {
        const q = (name) => document.querySelector('[' + name + ']')?.getAttribute(name) ?? null;
        return {
          sessions: q('data-settings-archive-sessions'),
          stored: q('data-settings-archive-stored'),
          evicted: q('data-settings-archive-evicted'),
          max: q('data-settings-archive-max')
        }
      })()`
    )

    await js<unknown>(
      win,
      `window.helm.invoke('settings:write', { transcriptArchiveMaxBytes: ${String(originalCeiling)} })`
    )

    checks.push({
      id: 'T-4',
      criterion: 'Storage bounded: compressed, stated ceiling, oldest archived session evicted whole',
      title: 'Driving the ceiling below what is stored drops whole sessions, oldest first',
      ok:
        allCaptured &&
        accepted.ok &&
        accepted.value === ceiling &&
        beforeBytes > ceiling &&
        stats.storedBytes <= ceiling &&
        partial.length === 0 &&
        orderRespected &&
        statedInPane.max === String(ceiling) &&
        statedInPane.stored === String(stats.storedBytes) &&
        statedInPane.evicted === String(stats.evictedSessions),
      detail: {
        plantedConversations: filler.length,
        archivedSessionsInPlay: archivedNow.length,
        storedBeforeBytes: beforeBytes,
        ceilingBytes: ceiling,
        ceilingAcceptedBySettings: accepted,
        storedAfterBytes: stats.storedBytes,
        expectedEvicted,
        actuallyEvicted: [...evictedIds],
        evictedThisPass: pass.evicted,
        perSession: held.map((entry, index) => ({
          sessionId: entry.sessionId,
          lastAt: new Date(entry.lastAt).toISOString(),
          storedBytes: entry.conversation?.storedBytes ?? 0,
          messagesBefore: entry.conversation?.messageCount ?? 0,
          stateAfter: after[index]?.state ?? 'missing',
          messagesAfter: after[index]?.messages.length ?? 0
        })),
        halfSessions: partial.length,
        oldestWentFirst: orderRespected,
        statedInPane,
        compression: {
          rawBytes: stats.rawBytes,
          storedBytes: stats.storedBytes,
          ratio:
            stats.storedBytes > 0
              ? Math.round((stats.rawBytes / stats.storedBytes) * 100) / 100
              : null
        },
        ceilingRestoredTo: originalCeiling,
        screenshot: shotSettings.file
      },
      notes: [
        'The ceiling is written through the real settings channel, so this is the setting the',
        'app honours rather than a number handed to the evictor directly - and it is computed',
        'from what is stored, so the expected set of dropped sessions is exact rather than',
        '"at least one".',
        'Ordered by last message time over every archived session, not only this group\'s',
        'fixtures: an evictor that dropped the largest rather than the oldest would agree with',
        'a subset often enough to pass.',
        '"Whole or absent" is checked per session against the message count this driver planted,',
        'not against a total: a total can be right while one conversation is half there.',
        'The pane\'s figures are read out of the DOM and compared against the store, because a',
        'stated figure that disagrees with what is stored is worse than no figure.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // T-5: nothing under the .claude tree is written, moved or deleted
  // -------------------------------------------------------------------------
  if (run('readonly')) {
    const before = hashTree(home)

    // The hasher is made to fail first. A digest that never moves is
    // indistinguishable from a digest of nothing, which is exactly how a
    // read-only claim would pass over a tree the walk could not read.
    const canary = join(projectsDir, 'canary.txt')
    writeFileSync(canary, 'this file exists only to make the hash move', 'utf8')
    const withCanary = hashTree(home)
    rmSync(canary, { force: true })
    const restored = hashTree(home)

    // Now a full pass over the whole tree, with the cursors forgotten so every
    // transcript is read from zero rather than skipped as already-indexed. The
    // strongest version of the claim: not "a pass that read nothing wrote
    // nothing", but "a pass that read every byte wrote nothing".
    services.store.raw.prepare('DELETE FROM transcript_index').run()
    const full = archive.sweep()
    history.refresh()
    const after = hashTree(home)

    checks.push({
      id: 'T-5',
      criterion: 'Nothing under ~/.claude is written, moved or deleted',
      title: 'A full pass over the tree leaves it byte-identical, and the hash can move',
      ok:
        before.files > 0 &&
        withCanary.digest !== before.digest &&
        restored.digest === before.digest &&
        after.digest === before.digest &&
        full.files > 0,
      detail: {
        tree: home,
        files: before.files,
        bytes: before.bytes,
        digestBefore: before.digest,
        digestAfter: after.digest,
        hasherProof: {
          withACanaryFile: withCanary.digest,
          movedWhenTheTreeChanged: withCanary.digest !== before.digest,
          cameBackWhenItWasRemoved: restored.digest === before.digest
        },
        passOverTheWholeTree: {
          transcriptsRead: full.files,
          bytesRead: full.bytesRead,
          messages: full.messages,
          ms: Math.round(full.ms * 100) / 100
        }
      },
      notes: [
        'Path, size, mtime and a content sha256 per file, hashed together. Content alone would',
        'miss a rewrite with identical bytes; mtime alone would miss a rename.',
        'The cursors are cleared first so the pass genuinely re-reads every transcript. A pass',
        'that skipped everything would prove nothing about what a pass does.',
        'The session index refreshes over the same tree in the same window, because it reads',
        'these files too and the claim is about the app rather than about one service.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // The survivor, handed to phase two
  // -------------------------------------------------------------------------
  const survivor = plantTranscript({
    projectsDir,
    projectDir: 'C--fixture-survivor',
    cwd,
    index: 90,
    startedAt: Date.parse('2026-08-05T12:00:00.000Z'),
    bodies: [
      { role: 'user', text: 'This conversation is about to have its transcript deleted.' },
      {
        role: 'assistant',
        text: `That is the point of the archive. The token here is ${SURVIVOR_NEEDLE}, and it has to still be findable after the file is gone and the app has restarted.`
      },
      { role: 'user', text: 'And after a restart?' },
      { role: 'assistant', text: 'Then too. Otherwise nothing here was worth building.' }
    ]
  })
  appendFileSync(
    historyFile,
    `${historyLine(survivor.sessionId, cwd, survivor.lastAt, 'This conversation is about to have its transcript deleted.')}\n`,
    'utf8'
  )
  archive.sweep()
  history.refresh()

  const survivorArchived = readArchivedConversation(services.store, survivor.sessionId)
  const record: PhaseOneRecord = {
    survivor: {
      sessionId: survivor.sessionId,
      file: survivor.file,
      needle: SURVIVOR_NEEDLE,
      messages: archivedMessages(survivorArchived)
    },
    claudeHome: home
  }
  writeFileSync(
    join(options.dataDir, 'transcript-phase1.json'),
    JSON.stringify(record, null, 2),
    'utf8'
  )

  checks.push({
    id: 'T-6',
    criterion: 'The archive survives the source transcript being deleted, and survives a restart',
    title: 'Phase one archived the conversation whose transcript phase two will delete',
    ok:
      survivorArchived?.state === 'archived' &&
      survivorArchived.messages.length === survivor.messages.length &&
      sameConversation(readFixtureConversation(survivor.file), archivedMessages(survivorArchived)),
    detail: {
      sessionId: survivor.sessionId,
      file: survivor.file,
      messages: survivorArchived?.messages.length ?? 0,
      storedBytes: survivorArchived?.storedBytes ?? 0,
      handedToPhaseTwo: join(options.dataDir, 'transcript-phase1.json')
    },
    notes: [
      'Half of a two-phase claim. The runner deletes the transcript between the phases and',
      'T-7 - written by the second app start - is the half that matters.'
    ]
  })

  // A picture of the thing this whole feature is for.
  await showHistory(win)
  await click(win, '[data-history-scope="prompts"]')
  await typeSearch(win, '')
  await click(win, `button[data-session="${survivor.sessionId}"]`)
  await pollJs(win, `document.querySelector('[data-transcript]')`, 10_000)
  await sleep(400)
  await screenshot(win, options.shotDir, 'transcript-view.png')

  return checks
}

// ---------------------------------------------------------------------------
// Phase two: after the transcript has been deleted and the app restarted
// ---------------------------------------------------------------------------

export async function runTranscriptRestartChecks(
  ctx: CheckContext,
  options: TranscriptCheckOptions
): Promise<Check[]> {
  const { win, services, archive } = ctx
  const recordFile = join(options.dataDir, 'transcript-phase1.json')

  const record = ((): PhaseOneRecord | null => {
    try {
      return JSON.parse(readFileSync(recordFile, 'utf8')) as PhaseOneRecord
    } catch {
      return null
    }
  })()

  if (record === null || record.survivor.messages.length === 0) {
    return [
      {
        id: 'T-7',
        criterion: 'The archive survives the source transcript being deleted, and survives a restart',
        title: 'Phase one left nothing for this phase to check',
        ok: false,
        detail: { recordFile, record },
        notes: ['Without phase one\'s record there is no expected conversation to compare against.']
      }
    ]
  }

  const { sessionId, file, needle, messages } = record.survivor
  // The driver's own answer to "is the transcript really gone", asked of the
  // filesystem rather than of the app.
  let sourceExists = true
  try {
    statSync(file)
  } catch {
    sourceExists = false
  }

  // A pass, so the index has noticed the file is gone before anything is
  // asserted about what the pane says.
  const pass = archive.sweep()
  ctx.history.refresh()

  const conversation = readArchivedConversation(services.store, sessionId)
  const stillThere = archivedMessages(conversation)
  const found = readHistorySessions(services.store, { search: needle, scope: 'messages' })
  const session = readHistorySessions(services.store, { search: '', scope: 'prompts' }).sessions.find(
    (row) => row.sessionId.toLowerCase() === sessionId
  )

  await showHistory(win)
  await click(win, '[data-history-scope="messages"]')
  await sleep(200)
  await typeSearch(win, needle)
  const painted = await paintedRows(win)
  await click(win, `button[data-session="${sessionId}"]`)
  await pollJs(win, `document.querySelector('[data-transcript]')`, 10_000)
  await sleep(300)
  const rendered = await js<{
    count: string | null
    messages: number
    roles: string[]
    toolRuns: number
  }>(
    win,
    `(() => {
      const section = document.querySelector('[data-transcript]');
      const items = [...document.querySelectorAll('[data-transcript-message]')];
      return {
        count: section?.querySelector('[data-transcript-count]')?.textContent ?? null,
        messages: items.length,
        roles: items.map((el) => el.dataset.transcriptMessage),
        toolRuns: document.querySelectorAll('[data-transcript-tools]').length
      }
    })()`
  )
  // What the pane should have drawn, worked out here rather than read off it.
  // The viewer folds a run of consecutive tool-only messages into one line -
  // nine full-height `[tool: PowerShell]` rows was what the first design shot
  // showed - so "every message is on screen" is a claim about two kinds of row.
  const isToolOnly = (text: string): boolean =>
    text.split('\n\n').every((part) => /^\[tool(?::\s*.+)?\]$/.test(part.trim()))
  const expectedRows = messages.filter((message) => !isToolOnly(message.text)).length
  const expectedToolRuns = messages.reduce(
    (runs, message, index) =>
      isToolOnly(message.text) && !(index > 0 && isToolOnly(messages[index - 1]?.text ?? ''))
        ? runs + 1
        : runs,
    0
  )
  const shot = await screenshot(win, options.shotDir, 'transcript-after-reap.png')

  return [
    {
      id: 'T-7',
      criterion: 'The archive survives the source transcript being deleted, and survives a restart',
      title: 'The conversation is still readable and still searchable with its transcript deleted',
      ok:
        !sourceExists &&
        conversation?.state === 'archived' &&
        sameConversation(messages, stillThere) &&
        found.sessions.some((row) => row.sessionId.toLowerCase() === sessionId) &&
        session?.transcriptFile === null &&
        session.archive === 'archived' &&
        painted.some((row) => row.sessionId.toLowerCase() === sessionId) &&
        painted.find((row) => row.sessionId.toLowerCase() === sessionId)?.badge === 'archived' &&
        expectedRows > 0 &&
        expectedToolRuns > 0 &&
        rendered.messages === expectedRows &&
        rendered.toolRuns === expectedToolRuns,
      detail: {
        sessionId,
        sourceTranscript: file,
        sourceStillOnDisk: sourceExists,
        cursorsForgottenThisPass: pass.forgotten,
        archivedMessages: stillThere.length,
        expectedMessages: messages.length,
        conversationsMatch: sameConversation(messages, stillThere),
        indexNowSays: {
          transcriptFile: session?.transcriptFile ?? null,
          archive: session?.archive ?? null,
          archivedMessages: session?.archivedMessages ?? null
        },
        searchStillFindsIt: found.sessions.map((row) => row.sessionId),
        paintedBadge: painted.find((row) => row.sessionId.toLowerCase() === sessionId)?.badge ?? null,
        rendered,
        expected: { rows: expectedRows, toolRuns: expectedToolRuns },
        screenshot: shot.file
      },
      notes: [
        'A second app start, because "survives a restart" is not a claim the process that wrote',
        'the row can make - it never restarted.',
        'The transcript is deleted by the runner between the two phases, so this is the real',
        'failure mode: Claude Code reaps the file and the conversation is still here.',
        'The expected text is what phase one recorded, compared message for message.'
      ]
    }
  ]
}

export const TRANSCRIPT_GROUPS = GROUPS
