import { type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createProfile,
  deleteProfile,
  findProfileByName,
  listProfiles,
  profileDraft,
  profileFromYaml,
  profileToYaml,
  readProfile,
  type Profile,
  type Project
} from '@helm/core'
import { screenshot, sleep, squash, stripAnsi, waitFor } from './bridge'
import type { Check } from './fidelity'
import { atPrompt, type Collector } from './m2check'
import { shimRoot } from './paths'
import type { Services } from './services'
import type { SessionHost } from './sessions'

/**
 * M3's acceptance criteria, driven through the app the way a user reaches them.
 *
 * This is the milestone the whole product is contingent on (SPEC 7): if a
 * root-launched session with overlays does not actually expose project skills,
 * the premise is wrong. Spike A proved the mechanism headlessly with `-p`; what
 * is here is the first interactive proof, in a hosted TUI, from a profile the
 * driver built by clicking the real form.
 *
 * So the probes talk to a live model rather than asserting on argv alone. Argv
 * is checked too, because it is cheap and exact - but a composed session that
 * assembles the right flags and still cannot invoke a skill would pass an
 * argv-only check, and that is precisely the failure this milestone exists to
 * rule out.
 *
 * `pnpm m3-check` -> helm-data/m3-report.json
 */

export interface M3Context {
  win: BrowserWindow
  services: Services
  sessions: SessionHost
}

/** Haiku throughout: these probes are about resolution, not reasoning, and the
 * driver waits on every one of them. */
const MODEL = 'haiku'

/** Distinctive enough that it cannot appear in the TUI by accident. */
const OPENING_TOKEN = 'HELM-OPENING-OK'
const OPENING_PROMPT = `Reply with exactly the token ${OPENING_TOKEN} and nothing else.`

const PROFILE_NAME = 'M3 composition'
const FIXTURE_PROFILE = 'M3 skill refresh'

// ---------------------------------------------------------------------------
// Talking to the renderer
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  return win.webContents.executeJavaScript(expression, true) as Promise<T>
}

async function clickByLabel(win: BrowserWindow, label: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = [...document.querySelectorAll('[aria-label]')]
        .find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!el) return false; el.click(); return true })()`
  )
}

async function clickButtonText(win: BrowserWindow, text: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent ?? '').includes(${JSON.stringify(text)}));
      if (!el) return false; el.click(); return true })()`
  )
}

/**
 * Sets a React-controlled field.
 *
 * Assigning `.value` updates the DOM node and nothing else: React tracks the
 * previous value on the element and skips the change it did not see happen. The
 * prototype's setter plus a bubbling `input` event is what makes React notice,
 * and it is the same path a keystroke takes.
 */
async function fill(win: BrowserWindow, label: string, value: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => {
      const el = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
      if (!el) return false;
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true })()`
  )
}

async function isChecked(win: BrowserWindow, label: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
      return Boolean(el && el.checked) })()`
  )
}

async function tabOrder(win: BrowserWindow): Promise<string[]> {
  return js<string[]>(
    win,
    `[...document.querySelectorAll('[role="tab"]')].map((t) => t.dataset.tab ?? '')`
  )
}

async function pollJs(win: BrowserWindow, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await js<boolean>(win, `Boolean(${expression})`).catch(() => false)
    if (ok) return true
    await sleep(250)
  }
  return false
}

// ---------------------------------------------------------------------------
// Talking to a hosted session
// ---------------------------------------------------------------------------

/**
 * Answers the consent prompts a hosted session raises, for as long as it runs.
 *
 * Two families, and the second is why this exists rather than M2's
 * startup-only version. Folder trust and MCP enablement happen once, at start.
 * **Skill consent happens every time a skill is invoked** - "Use skill
 * `atlas:think`? 1. Yes / 2. Yes, and don't ask again / 3. No" - which is
 * exactly what these checks do on purpose. Left unanswered it does not fail
 * loudly; the session simply sits on the prompt, and the answer to the probe
 * arrives minutes later, during some later probe's window, which reads as the
 * composition being broken when it is not.
 *
 * Answered by Enter rather than by typing `1`: the caret already sits on Yes,
 * and Enter means the same thing whether or not the menu takes digits.
 * Occurrences are counted rather than matched, so a second prompt with the same
 * wording is still answered and an already-answered one is not answered twice.
 */
export function answerConsent(ctx: M3Context, collector: Collector, ids: number[]): () => void {
  const answered = new Map<string, number>()
  const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length

  /**
   * A session's captured output is cumulative, so the gates answered earlier in
   * its life are still in it. Seeding the counts with what is already there is
   * what makes this "answer the gates from here on" rather than "answer every
   * gate this session has ever shown" - and the latter is not merely redundant:
   * the MCP gate is answered with Escape, which in a session that has since
   * reached its prompt cancels whatever the model is in the middle of.
   */
  const baseline = (id: number, kind: string, re: RegExp): void => {
    answered.set(`${kind}:${String(id)}`, count(squash(collector.output(id)), re))
  }
  for (const id of ids) {
    baseline(id, 'trust', /doyoutrust|trustthisfolder|quicksafetycheck/g)
    baseline(id, 'mcp', /mcpservers/g)
    baseline(id, 'consent', /doyouwanttoproceed/g)
  }

  const timer = setInterval(() => {
    for (const id of ids) {
      // Matched against `squash`ed output - lowercased, all whitespace removed.
      // The TUI positions text by moving the cursor rather than by emitting the
      // spaces between words, so the stream really does read
      // `quicksafetycheck:isthisaproject...`, and a pattern with a space in it
      // matches nothing. M2's `/Do you trust/` survived only because the
      // folders it launched against were already trusted.
      const text = squash(collector.output(id))
      // Wording moves between releases: 2.1.225 asks folder trust as "Quick
      // safety check: Is this a project you created or one you trust?" where an
      // earlier one asked "Do you trust the files in this folder?". Both are
      // listed rather than one replaced - a stale alternative costs nothing,
      // and an unanswered gate is a session that hangs to the timeout without
      // saying why.
      const gates: Array<[string, RegExp, string]> = [
        ['trust', /doyoutrust|trustthisfolder|quicksafetycheck/g, '\r'],
        ['mcp', /mcpservers/g, '\x1b'],
        ['consent', /doyouwanttoproceed/g, '\r']
      ]
      for (const [kind, re, keys] of gates) {
        const key = `${kind}:${String(id)}`
        const seen = count(text, re)
        if (seen > (answered.get(key) ?? 0)) {
          answered.set(key, seen)
          ctx.sessions.input(id, keys)
        }
      }
    }
  }, 400)
  return () => clearInterval(timer)
}

/**
 * Types a prompt into a live TUI and waits for the answer to contain `expect`.
 *
 * Compared against `squash`ed output because the TUI positions text without
 * emitting the spaces between words, so nothing about the whitespace in a
 * rendered answer is dependable. The text and the Enter go separately: sent as
 * one write, a long line arrives as a paste, which the composer treats
 * differently from typed input.
 */
export async function ask(
  ctx: M3Context,
  collector: Collector,
  id: number,
  prompt: string,
  expect: string[],
  timeoutMs = 180_000
): Promise<{ ok: boolean; answer: string }> {
  const before = collector.output(id).length
  ctx.sessions.input(id, prompt)
  await sleep(600)
  ctx.sessions.input(id, '\r')

  const stopConsent = answerConsent(ctx, collector, [id])
  const wanted = expect.map((token) => squash(token))
  const seen = (): string => squash(collector.output(id).slice(before))
  const ok = await waitFor(() => wanted.every((token) => seen().includes(token)), timeoutMs)
  stopConsent()

  // The tail is what a person would have on screen; the whole stream is mostly
  // redraws of the composer.
  const answer = stripAnsi(collector.output(id).slice(before)).replace(/\s+/g, ' ').trim()
  return { ok, answer: answer.slice(-1200) }
}

/** Brings a session to the point where it will accept a prompt. */
export async function waitForPrompt(
  ctx: M3Context,
  collector: Collector,
  id: number,
  timeoutMs = 120_000
): Promise<boolean> {
  // `answerConsent`, not M2's startup-only helper: a profile launched against a
  // directory Claude Code has not seen before stops on the trust gate, and this
  // driver's fixture repo is new by construction.
  const stop = answerConsent(ctx, collector, [id])
  const ready = await waitFor(() => atPrompt(stripAnsi(collector.output(id))), timeoutMs)
  stop()
  await sleep(2500)
  return ready
}

/** The tail a person would have on screen, for a failure to be readable from. */
const tail = (collector: Collector, id: number, n = 900): string =>
  stripAnsi(collector.output(id)).replace(/\s+/g, ' ').trim().slice(-n)

// ---------------------------------------------------------------------------
// Fixtures for the "edit a skill and relaunch" criterion
// ---------------------------------------------------------------------------

/**
 * A throwaway repo with one skill in it.
 *
 * The criterion is about editing a source repo's skill, and the source repos on
 * this machine are the user's real ones. Writing a probe into `repos/atlas`
 * to prove a point about cache invalidation is not a thing a test gets to do,
 * so this criterion gets a repo the driver owns.
 */
function writeFixtureSkill(dir: string, token: string): void {
  const skill = join(dir, 'alpha', '.claude', 'skills', 'helm-probe')
  mkdirSync(skill, { recursive: true })
  writeFileSync(
    join(skill, 'SKILL.md'),
    [
      '---',
      'name: helm-probe',
      'description: Probe skill used by Helm’s M3 acceptance check. Reports a token.',
      '---',
      '',
      `# ${token}`,
      '',
      `This skill exists to be read back. Its token is ${token}.`,
      ''
    ].join('\n')
  )
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

interface Fixtures {
  harness: Project
  atlas: Project
  reporting: Project
}

function pick(services: Services): Fixtures | null {
  const projects = services.lastScan?.projects ?? []
  const harness = projects.find((p) => p.kind === 'harness')
  const atlas = projects.find((p) => p.name.toLowerCase() === 'atlas')
  const reporting = projects.find((p) => p.name.toLowerCase() === 'atlas-reporting')
  if (!harness || !atlas || !reporting) return null
  return { harness, atlas, reporting }
}

/**
 * `--only=fixture` and friends.
 *
 * Grouped rather than per-check, because these are a chain: M3-2 launches the
 * profile M3-1 built and M3-3..M3-7 all talk to the session M3-2 opened. The
 * groups are the points where that chain genuinely breaks - which is what makes
 * them the useful thing to re-run while fixing one of them, given a full pass
 * spawns three real sessions and takes minutes.
 */
type Group = 'compose' | 'fixture' | 'shims'
const ALL_GROUPS: Group[] = ['compose', 'fixture', 'shims']

function selectedGroups(): Group[] {
  const arg = process.argv.find((a) => a.startsWith('--only='))
  if (!arg) return ALL_GROUPS
  const asked = arg.slice('--only='.length).split(',')
  const chosen = ALL_GROUPS.filter((group) => asked.includes(group))
  return chosen.length > 0 ? chosen : ALL_GROUPS
}

export async function runM3Checks(
  ctx: M3Context,
  collector: Collector,
  shotDir: string,
  dataDir: string
): Promise<Check[]> {
  const checks: Check[] = []
  const { win } = ctx
  const groups = selectedGroups()
  const wants = (group: Group): boolean => groups.includes(group)
  if (groups.length < ALL_GROUPS.length) {
    console.log(`m3-check: running only [${groups.join(', ')}]`)
  }

  const scanned = await waitFor(() => pick(ctx.services) !== null, 120_000)
  await pollJs(win, `document.querySelectorAll('aside button[title]').length >= 3`, 30_000)
  await sleep(500)
  const fixtures = pick(ctx.services)

  if (!scanned || !fixtures) {
    checks.push({
      id: 'M3-0',
      criterion: 'setup',
      title: 'Discovery found the harness root and both overlay repos',
      ok: false,
      detail: { scanned, found: (ctx.services.lastScan?.projects ?? []).map((p) => p.name) },
      notes: [
        'M3 composes repos/atlas and repos/atlas-reporting from the harness root',
        '(CLAUDE.md, "Environment notes"). Without them there is nothing to compose.'
      ]
    })
    return checks
  }

  // Left over from an earlier run of this driver; the names are unique-indexed.
  for (const name of [PROFILE_NAME, FIXTURE_PROFILE]) {
    const existing = findProfileByName(ctx.services.store, name)
    if (existing) deleteProfile(ctx.services.store, existing.id)
  }

  if (wants('compose')) {
    checks.push(...(await runComposeChecks(ctx, collector, shotDir, fixtures)))
  }
  if (wants('fixture')) {
    checks.push(await runFixtureCheck(ctx, collector, dataDir))
  }
  if (wants('shims')) {
    checks.push(plantStaleShim())
  }
  return checks
}

/**
 * M3-1 through M3-7: one profile, built in the form, launched, and interrogated.
 *
 * These share a session on purpose. Composition is a property of a session, and
 * asking one session all five questions is both the cheaper thing and the
 * truer one - it is the session a person would have.
 */
async function runComposeChecks(
  ctx: M3Context,
  collector: Collector,
  shotDir: string,
  fixtures: Fixtures
): Promise<Check[]> {
  const checks: Check[] = []
  const { win } = ctx
  const { harness, atlas, reporting } = fixtures

  // -------------------------------------------------------------------------
  // M3-1: build a profile through the real form
  // -------------------------------------------------------------------------
  const opened = await clickByLabel(win, 'New profile')
  await sleep(600)

  await fill(win, 'Profile name', PROFILE_NAME)
  await fill(win, 'Root directory', harness.path)
  await fill(win, 'Model', MODEL)
  await fill(win, 'Opening prompt', OPENING_PROMPT)
  await sleep(200)

  // Ticking "Compose" also ticks "Access" - composing a repo's skills while
  // denying its files produces skills that cannot do anything.
  await clickByLabel(win, `Compose ${atlas.name}`)
  await sleep(150)
  await clickByLabel(win, `Compose ${reporting.name}`)
  await sleep(150)
  const accessAutoTicked =
    (await isChecked(win, `Grant access to ${atlas.name}`)) &&
    (await isChecked(win, `Grant access to ${reporting.name}`))

  const editorShot = await screenshot(win, shotDir, 'm3-profile-editor.png')
  await clickButtonText(win, 'Save profile')
  await sleep(800)

  const saved = findProfileByName(ctx.services.store, PROFILE_NAME)
  const rowPainted = await pollJs(
    win,
    `Boolean(document.querySelector('[data-profile="${String(saved?.id ?? -1)}"]'))`,
    5000
  )

  checks.push({
    id: 'M3-1',
    criterion: 'Profile CRUD UI: create from scratch; profiles stored in SQLite',
    title: 'A profile built in the form is persisted and listed',
    ok:
      opened &&
      saved !== null &&
      saved.root === harness.path &&
      saved.overlays.length === 2 &&
      saved.access.length === 2 &&
      saved.model === MODEL &&
      saved.openingPrompt === OPENING_PROMPT &&
      accessAutoTicked &&
      rowPainted,
    detail: {
      profile: saved && profileDraft(saved),
      accessAutoTicked,
      rowPainted,
      screenshot: editorShot.file
    },
    notes: ['Driven through the dialog: fields set as keystrokes, checkboxes clicked.']
  })

  if (!saved) return checks

  // -------------------------------------------------------------------------
  // M3-2: one click launches it into a tab, with the composed argv
  // -------------------------------------------------------------------------
  const before = ctx.sessions.list().length
  await js<boolean>(
    win,
    `(() => { const el = document.querySelector('[data-profile="${String(saved.id)}"]');
      if (!el) return false; el.click(); return true })()`
  )
  await waitFor(() => ctx.sessions.list().length > before, 60_000)
  const session = ctx.sessions.list().at(-1)
  await sleep(800)
  const tabs = await tabOrder(win)

  const argv = session?.argv ?? []
  const pluginDirs = argv.filter((_, i) => argv[i - 1] === '--plugin-dir')
  const memoryIndex = argv.indexOf('--append-system-prompt-file')
  const memoryFile = memoryIndex >= 0 ? argv[memoryIndex + 1] : undefined

  checks.push({
    id: 'M3-2',
    criterion: 'One-click launch from the launcher into a tab; profile → argv builder',
    title: 'Clicking the profile composes the overlays and opens a session tab',
    ok:
      session !== undefined &&
      session.profileId === saved.id &&
      session.cwd === harness.path &&
      pluginDirs.length === 2 &&
      argv.includes('--add-dir') &&
      argv.includes('--model') &&
      memoryFile !== undefined &&
      argv.at(-1) === OPENING_PROMPT &&
      tabs.includes(`session:${String(session.id)}`),
    detail: {
      session: session && { id: session.id, name: session.name, cwd: session.cwd },
      argv,
      pluginDirs,
      memoryFile,
      tabs
    },
    notes: [
      'The opening prompt is last on the argv: --add-dir is variadic, and a positional',
      'reachable from it would be read as another directory rather than a prompt.'
    ]
  })

  if (!session) return checks

  // -------------------------------------------------------------------------
  // The composed session itself
  // -------------------------------------------------------------------------
  const ready = await waitForPrompt(ctx, collector, session.id)

  // M3-3: the opening prompt fired without anyone typing it.
  const openingSeen = await waitFor(
    () => squash(collector.output(session.id)).includes(squash(OPENING_TOKEN)),
    180_000
  )
  const sessionShot = await screenshot(win, shotDir, 'm3-composed-session.png')

  checks.push({
    id: 'M3-3',
    criterion: 'Opening prompt fires automatically after session start',
    title: 'The profile’s opening prompt was submitted without any typing',
    ok: ready && openingSeen,
    detail: {
      reachedPrompt: ready,
      token: OPENING_TOKEN,
      screenshot: sessionShot.file,
      tail: stripAnsi(collector.output(session.id)).replace(/\s+/g, ' ').trim().slice(-600)
    },
    notes: ['Nothing was written to this pty before the assertion; it came in on the argv.']
  })

  // M3-4: skills from both overlays, including the same-named pair.
  //
  // `think` is defined in both repos and differs between them, which is what
  // makes it the discriminator: matching both headings proves two distinct
  // bodies resolved, where a same-named skill resolving twice to one body would
  // match only one.
  const atlasThink = firstHeading(
    join(atlas.path, '.claude', 'skills', 'think', 'SKILL.md')
  )
  const reportingThink = firstHeading(
    join(reporting.path, '.claude', 'skills', 'think', 'SKILL.md')
  )
  const skills = await ask(
    ctx,
    collector,
    session.id,
    `Invoke the skill named ${overlayName(atlas)}:think, then invoke the skill named ` +
      `${overlayName(reporting)}:think. Then reply with exactly two lines: ` +
      `SKILL1=<the first markdown H1 heading in the first skill body> and ` +
      `SKILL2=<the first markdown H1 heading in the second skill body>.`,
    [`SKILL1=${atlasThink}`, `SKILL2=${reportingThink}`]
  )

  /**
   * The probe is only evidence if the two headings exist and differ.
   *
   * `firstHeading` returns `''` for a file that is not there, which turns the
   * expected tokens into `SKILL1=` and `SKILL2=` - substrings of any answer
   * that uses the requested format at all. So a check with no fixtures behind
   * it passed while proving nothing, which is how it was found: the two source
   * repos lost their `.claude/skills` to an early version of the shim teardown
   * (fixed by `removeShimDir`, which unlinks junctions before recursing), and
   * this check went on reporting green afterwards.
   */
  const headingsUsable =
    atlasThink !== '' && reportingThink !== '' && atlasThink !== reportingThink

  checks.push({
    id: 'M3-4',
    criterion:
      'A project skill invokes in a root-launched session; same-named skills in two overlays coexist',
    title: 'Both overlays’ `think` skills resolved under their own prefixes and both invoked',
    ok: headingsUsable && skills.ok,
    detail: {
      cwd: session.cwd,
      expected: { SKILL1: atlasThink, SKILL2: reportingThink },
      headingsUsableAsEvidence: headingsUsable,
      ...(headingsUsable
        ? {}
        : {
            why: [
              `${join(atlas.path, '.claude', 'skills', 'think', 'SKILL.md')} and`,
              `${join(reporting.path, '.claude', 'skills', 'think', 'SKILL.md')} must both exist`,
              'and differ. An absent file yields an empty heading, which every answer matches.'
            ].join(' ')
          }),
      answer: skills.answer
    },
    notes: [
      'The two bodies differ, so matching both headings is proof of two distinct skills',
      'rather than one resolving twice. Spike A showed the namespacing; this shows it interactively.',
      'The guard above is not belt and braces: without it this check passes when the fixtures',
      'are missing, which is exactly the state it was found in.'
    ]
  })

  // M3-5: the CLAUDE.md gap Spike A found, closed.
  const claudeMd = await ask(
    ctx,
    collector,
    session.id,
    'Without using any tools, answer only from the instructions already in your context: ' +
      'what single python command launches the atlas GUI application? ' +
      'Reply as PYCMD=<command>. If it is not in your context, reply PYCMD=NOT_IN_CONTEXT.',
    ['PYCMD=python _launch_atlas.py']
  )

  checks.push({
    id: 'M3-5',
    criterion: "The overlaid repos' CLAUDE.md instructions are present in the session",
    title: 'An instruction that exists only in an overlay’s CLAUDE.md is in context',
    ok: claudeMd.ok,
    detail: { answer: claudeMd.answer, memoryFile },
    notes: [
      'Carried by --append-system-prompt-file, not --add-dir. Measured against 2.1.225:',
      '--add-dir does not pull in an overlaid repo’s CLAUDE.md, whatever its help text suggests.',
      'The probe forbids tools, so a correct answer cannot have come from reading the file.'
    ]
  })

  // M3-6: --add-dir actually grants the files.
  //
  // Deliberately not CLAUDE.md. Those are already in this session's context by
  // way of M3-5, so a correct answer about one would prove nothing about
  // whether the file could be *read*. `settings.local.json` is in neither the
  // context nor any plugin, so the only way to report a line of it is to have
  // opened it.
  const settings = {
    a: join(atlas.path, '.claude', 'settings.local.json'),
    b: join(reporting.path, '.claude', 'settings.local.json')
  }
  const distinct = distinctLine(settings.a, settings.b)
  const files =
    distinct === null
      ? { ok: false, answer: 'no line differs between the two settings files' }
      : await ask(
          ctx,
          collector,
          session.id,
          `Use the Read tool on ${settings.a} and on ${settings.b}. ` +
            `Reply with two lines: F1=<line ${String(distinct.line)} of the first file, verbatim> ` +
            `and F2=<line ${String(distinct.line)} of the second file, verbatim>.`,
          [distinct.a, distinct.b]
        )

  checks.push({
    id: 'M3-6',
    criterion: 'Cross-repo file access works in the same session via --add-dir',
    title: 'A file in each overlay repo was read from a session rooted elsewhere',
    ok: files.ok,
    detail: {
      cwd: session.cwd,
      read: [settings.a, settings.b],
      expected: distinct,
      answer: files.answer
    },
    notes: [
      'Neither path is under the session’s working directory, and neither file is in',
      'context - so the line can only have come from a real read.',
      'The line index is chosen at runtime as the first one whose contents differ',
      'between the two files, so one answer cannot satisfy both.'
    ]
  })

  // -------------------------------------------------------------------------
  // M3-7: YAML round trip
  // -------------------------------------------------------------------------
  const original = readProfile(ctx.services.store, saved.id)
  const yaml = original ? profileToYaml(profileDraft(original)) : ''
  const removed = deleteProfile(ctx.services.store, saved.id)
  const absent = findProfileByName(ctx.services.store, PROFILE_NAME) === null
  const reimported = yaml === '' ? null : createProfile(ctx.services.store, profileFromYaml(yaml))

  checks.push({
    id: 'M3-7',
    criterion: 'Profile round-trips through YAML export → delete → import intact',
    title: 'A profile survives being written to YAML, deleted, and read back',
    ok:
      original !== null &&
      removed &&
      absent &&
      reimported !== null &&
      JSON.stringify(profileDraft(reimported)) === JSON.stringify(profileDraft(original)),
    detail: {
      yaml,
      deleted: removed,
      absentAfterDelete: absent,
      before: original && profileDraft(original),
      after: reimported && profileDraft(reimported)
    },
    notes: [
      'Paths under the root are written relative to it, so the file travels with the harness',
      'rather than hardcoding this machine.'
    ]
  })

  const remaining = listProfiles(ctx.services.store).find((p) => p.name === PROFILE_NAME)
  if (remaining) deleteProfile(ctx.services.store, remaining.id)

  return checks
}

/**
 * M3-8: editing a source repo's skill, then relaunching.
 *
 * Against a fixture repo rather than the user's. The criterion requires editing
 * a source repo's skill, and the source repos on this machine are real ones -
 * writing a probe into `repos/atlas` to make a point about cache
 * invalidation is not something a check gets to do.
 */
async function runFixtureCheck(
  ctx: M3Context,
  collector: Collector,
  dataDir: string
): Promise<Check> {
  const fixtureRoot = join(dataDir, 'm3-fixtures')
  rmSync(fixtureRoot, { recursive: true, force: true })
  writeFixtureSkill(fixtureRoot, 'HELMPROBEALPHA')

  const fixtureProfile: Profile = createProfile(ctx.services.store, {
    name: FIXTURE_PROFILE,
    root: fixtureRoot,
    overlays: [join(fixtureRoot, 'alpha')],
    access: [join(fixtureRoot, 'alpha')],
    model: MODEL,
    effort: null,
    permissionMode: null,
    agent: null,
    mcp: [],
    openingPrompt: null,
    pinnedOrder: null
  })

  const firstRun = await probeFixture(ctx, collector, fixtureProfile.id, 'HELMPROBEALPHA')

  // The edit a person would make, in the source repo rather than in the shim.
  writeFixtureSkill(fixtureRoot, 'HELMPROBEBRAVO')
  const secondRun = await probeFixture(ctx, collector, fixtureProfile.id, 'HELMPROBEBRAVO')

  // The driver's own profile, not the user's.
  deleteProfile(ctx.services.store, fixtureProfile.id)

  return {
    id: 'M3-8',
    criterion: 'Editing a source repo’s skill then relaunching the profile picks up the change',
    title: 'A relaunched profile loads the edited skill body, not the one it was built with',
    ok: firstRun.ok && secondRun.ok,
    detail: {
      fixture: fixtureRoot,
      first: { expected: 'HELMPROBEALPHA', ...firstRun },
      second: { expected: 'HELMPROBEBRAVO', ...secondRun }
    },
    notes: [
      'Against a fixture repo, not the user’s: the criterion requires editing a source repo,',
      'and writing a probe into repos/atlas to prove it is not something a check may do.',
      'The shim links rather than copies, so the second session sees the edit through the junction.',
      '`skillOnDisk` is read back *through* the shim, so a failure says whether it was the',
      'fixture or the link that was wrong.'
    ]
  }
}

/**
 * M3-9: leave a stale shim for the next app start to sweep.
 *
 * The criterion is about what happens at startup, which cannot be asserted by
 * the process that already started. So this plants what a crash would have left
 * and `--shim-sweep` - a second, real app start - reports on it.
 */
function plantStaleShim(): Check {
  const planted = join(shimRoot, 'overlay-m3-crashed')
  mkdirSync(join(planted, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(planted, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'm3-crashed', version: '0.0.0' })
  )
  // No junction in it: what is being tested is whether the sweep finds and
  // removes a stamped `overlay-*` directory, and planting a real link into a
  // real repo would put the user's files behind a deletion this check wants to
  // happen.
  writeFileSync(
    join(planted, '.helm-overlay.json'),
    JSON.stringify({
      name: 'm3-crashed',
      projectPath: planted,
      mode: 'junction',
      linked: [],
      fingerprint: 'planted-by-m3-check',
      builtAt: new Date().toISOString()
    })
  )

  return {
    id: 'M3-9',
    criterion: 'Stale shim dirs from crashed sessions are cleaned up on next app start',
    title: 'A shim left behind by a crash is planted for the next start to find',
    ok: true,
    detail: { planted, shimRoot },
    notes: [
      'This check only sets the trap. Whether it caught anything is decided by the',
      '--shim-sweep run that follows, and asserted by scripts/verify-shims.mjs.'
    ]
  }
}

/** Launches the fixture profile, asks its skill for its token, then closes. */
async function probeFixture(
  ctx: M3Context,
  collector: Collector,
  profileId: number,
  token: string
): Promise<{
  ok: boolean
  answer: string
  argv: string[]
  overlays: string[]
  skillOnDisk: string
  reachedPrompt: boolean
}> {
  const launched = ctx.sessions.launchProfile({ profileId, cols: 100, rows: 30 })
  const id = launched.session.id

  // Read back through the shim rather than from the source, so a failure says
  // which of the two - the fixture or the link - was not what it should be.
  const shimmed = join(shimRoot, 'overlay-alpha', 'skills', 'helm-probe', 'SKILL.md')
  let skillOnDisk: string
  try {
    skillOnDisk = readFileSync(shimmed, 'utf8').trim().split('\n').pop() ?? ''
  } catch (err) {
    skillOnDisk = `unreadable through the shim: ${err instanceof Error ? err.message : String(err)}`
  }

  const common = {
    argv: launched.session.argv,
    overlays: launched.overlays,
    skillOnDisk
  }

  const ready = await waitForPrompt(ctx, collector, id)
  if (!ready) {
    const why = tail(collector, id)
    await ctx.sessions.close({ id, force: true })
    await sleep(1500)
    return { ok: false, answer: `never reached a prompt. Last output: ${why}`, reachedPrompt: false, ...common }
  }

  const result = await ask(
    ctx,
    collector,
    id,
    'Invoke the skill named alpha:helm-probe, then reply with exactly ' +
      'TOKEN=<the first markdown H1 heading in that skill body>.',
    [`TOKEN=${token}`]
  )
  await ctx.sessions.close({ id, force: true })
  await sleep(1500)
  return { ...result, reachedPrompt: true, ...common }
}

const overlayName = (project: Project): string => project.name.toLowerCase()

/** The first `# heading` in a skill body, which is what the probes ask for. */
function firstHeading(file: string): string {
  try {
    const match = /^#\s+(.+)$/m.exec(readFileSync(file, 'utf8'))
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

/**
 * The first line number at which two files differ, with both versions.
 *
 * Computed rather than hardcoded so the probe keeps working when the user edits
 * either file, and so one answer cannot satisfy both halves of the check - the
 * two repos' settings files share a preamble, and asking for "the first 60
 * characters" of each got the same string twice.
 */
function distinctLine(
  fileA: string,
  fileB: string
): { line: number; a: string; b: string } | null {
  let a: string[]
  let b: string[]
  try {
    a = readFileSync(fileA, 'utf8').split(/\r?\n/)
    b = readFileSync(fileB, 'utf8').split(/\r?\n/)
  } catch {
    return null
  }

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = (a[i] ?? '').trim()
    const right = (b[i] ?? '').trim()
    // Long enough that echoing it is evidence, and different enough that
    // echoing one does not accidentally answer for the other.
    if (left.length >= 12 && right.length >= 12 && left !== right) {
      return { line: i + 1, a: left, b: right }
    }
  }
  return null
}
