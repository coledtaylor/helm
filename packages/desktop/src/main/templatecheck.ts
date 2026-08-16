import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { BrowserWindow } from 'electron'
import { SHIPPED_TEMPLATES } from '@helm/core'
import type { CachedProject } from '@helm/core'
import { screenshot, sleep, waitFor } from './bridge'
import type { Check } from './fidelity'
import { answerPicker } from './packagingcheck'
import { templatesDir } from './paths'
import type { CheckContext } from './sessionscheck'

/**
 * Harness templates, driven through the app the way somebody reaches them.
 *
 * `pnpm template-check` -> helm-data/template-report.json.
 * Five phases, **no `claude` sessions**, no network, about a minute - three of
 * those phases are app starts with no window at all, and the wall time is
 * mostly Electron starting five times.
 *
 * Three things about the shape of it are worth knowing before touching it.
 *
 * **The seed phases are separate processes, and they have to be.** "A first
 * start writes the README", "a second start overwrites nothing" and "deleting
 * the directory brings it back" are three claims about *startup*, and the
 * process that has already started cannot make any of them about itself. So
 * `scripts/run-template.mjs` starts the app three times in `--template-seed`
 * mode - the same `createServices` path the real app takes, no window - and
 * each one writes down what it found. This driver reads those three reports and
 * turns them into TPL-7/8/9. The same shape as `--shim-sweep` in
 * `profiles-check`, for the same reason.
 *
 * **Every claim has a read this driver makes for itself.** The created tree is
 * checked against a plain recursion in this file that knows nothing about
 * templates; the manifest is parsed line by line rather than with a YAML
 * library; the copied bytes are compared with `sha256` against the fixture on
 * disk. A writer agreeing with its own reader proves nothing.
 *
 * **The fixture is made to fail before its pass is believed** (TPL-1). The
 * `{{...}}`-bearing file is compared clean, then a byte of the *fixture* is
 * flipped and the same comparator is required to reject it, and only then is
 * the clean result trusted. CLAUDE.md's rule about PROF-4 is what that is for:
 * a comparator reading an expected value out of a fixture that has gone missing
 * compares nothing against nothing and reports green for weeks.
 */

const GROUPS = ['create', 'minimal-unchanged', 'seed', 'hostile', 'authoring'] as const
type Group = (typeof GROUPS)[number]

/** The template the `create` group builds a harness from. */
const FIXTURE = 'check-fixture'
const FIXTURE_LABEL = 'Check fixture'
const FIXTURE_DESCRIPTION = 'Planted by pnpm template-check. Not a template anybody should use.'

/** The template the `hostile` group builds a harness from. */
const HOSTILE = 'check-hostile'

const HARNESS_FROM_TEMPLATE = 'tpl-from-template'
const HARNESS_MINIMAL = 'tpl-minimal'
const HARNESS_HOSTILE = 'tpl-hostile'

// --- authoring -------------------------------------------------------------

/** Made through the manager's own form, renamed through it, deleted through it. */
const AUTHORED = 'tpl-authored'
const AUTHORED_RENAMED = 'tpl-authored-renamed'
const AUTHORED_LABEL = 'Authored in the app'
const AUTHORED_DESCRIPTION = 'Created through the template manager by pnpm template-check.'

/** Made through the manager, then imported into. Kept, and built from. */
const IMPORT_TARGET = 'tpl-import-target'
/** The skill that gets copied in, and the file whose bytes have to survive. */
const IMPORT_SKILL = 'tpl-fixture-skill'
const IMPORT_SKILL_BODY = [
  '---',
  `name: ${IMPORT_SKILL}`,
  'description: Planted by pnpm template-check. Copied into a template, byte for byte.',
  '---',
  '',
  'The body is here to make the file long enough that one flipped byte is not the',
  'whole of it, and it contains a literal {{NAME}} so a careless importer that ran',
  'substitution over what it copied would be caught by the same comparison.',
  ''
].join('\n')

/** Carries a junction. Deleted through the manager; the canary must survive. */
const DOOMED = 'tpl-doomed'

/** Frozen through the project pane's "Save as template". */
const FROZEN = 'tpl-frozen'
/** The `dot-claude/` tree imported through "Import folder as template". */
const ALIASED = 'tpl-aliased'
const ALIASED_SKILL = 'tpl-aliased-skill'

const HARNESS_FROM_IMPORT = 'tpl-from-import'
const HARNESS_FROM_ALIAS = 'tpl-from-alias'

/**
 * A file the template ships that must arrive **byte-identical**.
 *
 * Every `{{...}}` in it is a shape a real template legitimately contains - two
 * GitHub Actions expressions, a Jinja block, and one that looks exactly like a
 * placeholder Helm knows. That last one is the point: `{{NAME}}` in a file that
 * is not a `.tpl` is a literal, and a whole-file substitution would silently
 * rewrite it.
 */
const LITERAL_FILE = [
  'name: build',
  'on: push',
  'jobs:',
  '  build:',
  '    runs-on: ${{ matrix.os }}',
  '    steps:',
  '      - run: echo "${{ github.sha }}"',
  '      - run: echo "{% if x %}{{ jinja }}{% endif %}"',
  '      - run: echo "{{NAME}} is not substituted here"',
  ''
].join('\n')

const TPL_FILE = [
  '# {{NAME}}',
  '',
  'Created {{CREATED_AT}} from the {{TEMPLATE}} template.',
  '',
  'An unknown {{PLACEHOLDER}} survives exactly as written.',
  ''
].join('\n')

const SETTINGS_FILE = '{\n  "model": "haiku"\n}\n'

// ---------------------------------------------------------------------------
// Driving the window
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  return win.webContents.executeJavaScript(expression, true) as Promise<T>
}

async function click(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false; el.click(); return true })()`
  )
}

async function text(win: BrowserWindow, selector: string): Promise<string> {
  return js<string>(win, `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '')`)
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

// ---------------------------------------------------------------------------
// Second opinions about what is on disk
// ---------------------------------------------------------------------------

/**
 * Every path under a directory, relative and sorted. A plain recursion with no
 * knowledge of templates or harnesses, so it disagrees with the writer if the
 * writer produces anything the writer's own reader would have forgiven.
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
 * Removes a tree the way the engine does: unlinking reparse points, never
 * walking into one.
 *
 * Written out here rather than left to `rmSync(dir, { recursive: true, force:
 * true })` because that call was **measured leaving a junction in place** - the
 * authoring group's second run died on `EEXIST` planting a junction the first
 * run's teardown had reported removing. It did not throw; it returned and the
 * reparse point was still there.
 *
 * Which is the same reason `removeTree` in `core/discovery/template-authoring.ts`
 * is written out, arrived at from the other end: a recursive remove that
 * silently declines to unlink a junction is the *harmless* half of what a
 * recursive remove can get wrong about one, and this driver hit that half first.
 */
function nuke(path: string): void {
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    // Not there, or not a directory. `rmSync` handles both.
    rmSync(path, { force: true })
    return
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    // The link question first: on Windows a junction answers yes to
    // `isDirectory()` as well, and the order is what decides whether this
    // removes a fixture or the canary behind it.
    if (entry.isSymbolicLink()) {
      try {
        rmSync(child, { force: true })
      } catch {
        rmdirSync(child)
      }
      continue
    }
    if (entry.isDirectory()) {
      nuke(child)
      continue
    }
    rmSync(child, { force: true })
  }
  rmdirSync(path)
}

/**
 * The hash of a file, or null for anything that is not one.
 *
 * Null rather than a throw, and that matters in both directions. TPL-1 leans on
 * it: a fixture that has gone missing must make the comparison *fail* rather
 * than compare two nulls and agree, so every caller checks for null explicitly.
 * And it is a `catch` rather than an `existsSync` test because a directory
 * exists and `readFileSync` throws `EISDIR` on it - which is precisely how this
 * driver's first run died, before it had written a single check.
 */
function sha256(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/**
 * A YAML manifest read as lines rather than through a parser, so a duplicated
 * key, a stray blank or a comment is visible. `packaging-check` reads it the
 * same way and for the same reason.
 */
function manifestLines(file: string): { keys: string[]; values: Record<string, string> } | null {
  if (!existsSync(file)) return null
  const keys: string[] = []
  const values: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1] as string
    keys.push(key)
    values[key] = (match[2] ?? '').trim().replace(/^"(.*)"$/, '$1')
  }
  return { keys, values }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  /** The directory harnesses are created inside. Walked to prove containment. */
  parent: string
  /** What the hostile template's junction points at. Must stay untouched. */
  canary: string
  /**
   * A project with a real `.claude` tree, for the import picker to read.
   *
   * It has to be somewhere `config:scopes` looks, which means somewhere the
   * scan found - so the authoring group adds `parent` as a root and rescans
   * before it opens the picker. That is the seam being checked: the sources are
   * the config console's scopes and nothing else.
   */
  project: string
  /** The `SKILL.md` whose bytes have to arrive unchanged. */
  skill: string
  /** A harness with the things somebody would want to leave behind. */
  harness: string
  /** A `dot-claude/`-style tree, for "import folder as template". */
  aliased: string
}

function plantFixtures(dataDir: string): Fixtures {
  const parent = join(dataDir, 'template-fixtures', 'parent')
  const canary = join(dataDir, 'template-fixtures', 'canary')
  nuke(join(dataDir, 'template-fixtures'))
  mkdirSync(parent, { recursive: true })
  mkdirSync(canary, { recursive: true })
  writeFileSync(join(canary, 'do-not-touch.txt'), 'untouched\n', 'utf8')

  // The harness to freeze. One of each thing the preview has to get right, and
  // a junction inside a directory that is ticked by default - a junction under
  // `repos/` would be untested, since `repos/` starts unticked anyway.
  const harness = join(parent, 'tpl-fixture-harness')

  /*
   * The import source is a repository **inside that harness**, not a sibling of
   * it, and that is the scan's rule rather than a preference: a root holding
   * any harness is a directory *of* harnesses, and its non-harness siblings are
   * deliberately not projects (`scan.ts`, `harnessChildren`). Planted beside
   * the harness it was never discovered, so it was never a scope, so the picker
   * was empty - which read as an import bug and was a fixture bug.
   *
   * It is also the realistic case: the skill you already wrote is in a repo you
   * work in, and that repo is under a harness.
   */
  const project = join(harness, 'repos', 'tpl-import-source')
  const skillDir = join(project, '.claude', 'skills', IMPORT_SKILL)
  mkdirSync(skillDir, { recursive: true })
  const skill = join(skillDir, 'SKILL.md')
  writeFileSync(skill, IMPORT_SKILL_BODY, 'utf8')
  // A resource beside the SKILL.md, because a skill is a directory and "copies
  // wholesale" is the claim - one file arriving would look identical from the
  // SKILL.md alone.
  writeFileSync(join(skillDir, 'reference.md'), '# bundled beside the skill\n', 'utf8')
  mkdirSync(join(harness, 'tools'), { recursive: true })
  mkdirSync(join(harness, 'notes'), { recursive: true })
  mkdirSync(join(harness, 'repos', 'thing'), { recursive: true })
  mkdirSync(join(harness, '.git'), { recursive: true })
  mkdirSync(join(harness, '.claude', 'skills', 'frozen'), { recursive: true })
  writeFileSync(join(harness, 'harness.yaml'), 'name: tpl-fixture-harness\nversion: 1\n', 'utf8')
  writeFileSync(join(harness, 'CLAUDE.md'), '# the fixture harness\n', 'utf8')
  writeFileSync(join(harness, '.claude', 'skills', 'frozen', 'SKILL.md'), 'a frozen skill\n', 'utf8')
  writeFileSync(join(harness, 'notes', 'journal.md'), 'a private journal\n', 'utf8')
  writeFileSync(join(harness, 'repos', 'thing', 'README.md'), 'a checkout\n', 'utf8')
  writeFileSync(join(harness, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  writeFileSync(join(harness, 'tools', 'run.mjs'), 'console.log(1)\n', 'utf8')
  symlinkSync(canary, join(harness, 'tools', 'escape'), 'junction')

  // The `dot-claude/` tree, deliberately *not* under `parent`: it is chosen
  // through the folder picker rather than found by a scan.
  const aliased = join(dataDir, 'template-fixtures', 'authored-elsewhere')
  mkdirSync(join(aliased, 'dot-claude', 'skills', ALIASED_SKILL), { recursive: true })
  writeFileSync(
    join(aliased, 'dot-claude', 'skills', ALIASED_SKILL, 'SKILL.md'),
    'a skill that arrived under an alias\n',
    'utf8'
  )
  writeFileSync(join(aliased, 'CLAUDE.md.tpl'), '# {{NAME}}\n', 'utf8')

  // The template the manager is asked to delete, with a junction in it.
  const doomed = join(templatesDir, DOOMED)
  nuke(doomed)
  mkdirSync(doomed, { recursive: true })
  writeFileSync(
    join(doomed, 'template.yaml'),
    'label: "Doomed"\ndescription: "Deleted by pnpm template-check. Carries a junction."\norder: 9\n',
    'utf8'
  )
  writeFileSync(join(doomed, 'honest.txt'), 'this one is fine\n', 'utf8')
  symlinkSync(canary, join(doomed, 'escape'), 'junction')

  // Anything the authoring group is about to create, from a previous run.
  for (const leftover of [AUTHORED, AUTHORED_RENAMED, IMPORT_TARGET, FROZEN, ALIASED]) {
    nuke(join(templatesDir, leftover))
  }

  // The fixture template: one of each thing the format has.
  const fixture = join(templatesDir, FIXTURE)
  nuke(fixture)
  mkdirSync(join(fixture, 'dot-claude'), { recursive: true })
  mkdirSync(join(fixture, 'notes'), { recursive: true })
  writeFileSync(
    join(fixture, 'template.yaml'),
    `label: ${JSON.stringify(FIXTURE_LABEL)}\ndescription: ${JSON.stringify(FIXTURE_DESCRIPTION)}\norder: 1\n`,
    'utf8'
  )
  writeFileSync(join(fixture, 'CLAUDE.md.tpl'), TPL_FILE, 'utf8')
  writeFileSync(join(fixture, 'workflow.yml'), LITERAL_FILE, 'utf8')
  writeFileSync(join(fixture, 'dot-claude', 'settings.json'), SETTINGS_FILE, 'utf8')
  writeFileSync(join(fixture, 'notes', '.gitkeep'), '', 'utf8')

  // The hostile one: an honest file and a junction pointing out of the harness.
  const hostile = join(templatesDir, HOSTILE)
  nuke(hostile)
  mkdirSync(hostile, { recursive: true })
  writeFileSync(
    join(hostile, 'template.yaml'),
    'label: "Check hostile"\ndescription: "Carries a junction. Planted by pnpm template-check."\norder: 2\n',
    'utf8'
  )
  writeFileSync(join(hostile, 'honest.txt'), 'this one is fine\n', 'utf8')
  // `junction` rather than `dir`: a Windows junction needs no elevation, and it
  // is the reparse point CLAUDE.md's rule about shims is written about.
  symlinkSync(canary, join(hostile, 'escape'), 'junction')

  return { parent, canary, project, skill, harness, aliased }
}

/** The canary as a fingerprint: its listing and the bytes of the file in it. */
function canaryState(canary: string): string[] {
  return walk(canary).concat(sha256(join(canary, 'do-not-touch.txt')) ?? 'missing')
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

interface CreatedThroughDialog {
  /** Was the picker on screen at all. */
  pickerUp: boolean
  /** The row's rendered text, for the label and description assertions. */
  rowText: string
  /** Which template the picker reported as chosen when Create was pressed. */
  chosen: string | null
  /** "What gets written", as the dialog rendered it. */
  written: string[]
  /** The problems box, if the dialog kept one up. */
  problems: string[]
  /** Whether `harness.yaml` appeared on disk. */
  onDisk: boolean
  path: string
}

/**
 * Opens the real New Harness dialog, picks a template, and creates.
 *
 * Everything here goes through the window: the sidebar's own button, the real
 * directory picker (answered by the driver, since a native dialog has no
 * automation surface), the real radio row, the real Create button. Nothing
 * calls `createHarness` directly - the seam being checked is the one a person
 * uses.
 */
async function createThroughDialog(
  win: BrowserWindow,
  fixtures: Fixtures,
  name: string,
  template: string,
  shotDir?: string
): Promise<CreatedThroughDialog> {
  await click(win, '[data-create-harness]')
  await pollJs(win, `document.querySelector('[data-harness-dialog]')`, 10_000)

  answerPicker('directory', fixtures.parent)
  await click(win, '[data-harness-choose]')
  await pollJs(win, `document.querySelector('[data-harness-dir]')?.value`, 10_000)
  await fill(win, '[data-harness-name]', name)

  const pickerUp = await pollJs(
    win,
    `document.querySelector('[data-harness-template="${template}"]')`,
    10_000
  )
  const rowText = await text(win, `[data-harness-template="${template}"]`)
  await click(win, `[data-harness-template="${template}"]`)
  // The preview is fetched over IPC when the selection changes, so the list
  // below is read after it has had a turn to come back.
  await sleep(500)

  const chosen = await js<string | null>(
    win,
    `(() => { const el = document.querySelector('[data-harness-templates] [role="radio"][aria-checked="true"]');
      return el ? el.getAttribute('data-harness-template') : null })()`
  )
  const written = await js<string[]>(
    win,
    `[...document.querySelectorAll('[data-harness-written] li')].map((li) => li.textContent ?? '')`
  )
  // The dialog as somebody sees it, filled in and about to be submitted. Every
  // other shot this driver takes is of the *result*, and the picker is the part
  // of this milestone that has to be looked at rather than asserted about.
  if (shotDir !== undefined) {
    await screenshot(win, shotDir, `template-dialog-${template}.png`)
  }

  await click(win, '[data-harness-create]')
  const path = join(fixtures.parent, name)
  const onDisk = await waitFor(() => existsSync(join(path, 'harness.yaml')), 20_000)
  await sleep(600)

  const problems = await js<string[]>(
    win,
    `[...document.querySelectorAll('[data-harness-problems] li')].map((li) => li.textContent ?? '')`
  )

  return { pickerUp, rowText, chosen, written, problems, onDisk, path }
}

// ---------------------------------------------------------------------------
// Driving the template manager
// ---------------------------------------------------------------------------

/**
 * Sets a React-controlled `<select>`.
 *
 * The same trap `fill` is written for, one prototype along: assigning `.value`
 * on a select updates the node and nothing else, because React tracks the
 * previous value on the element and skips a change it did not see happen.
 */
async function choose(win: BrowserWindow, selector: string, value: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true })()`
  )
}

/** Whether a node is on screen at all. */
async function exists(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(win, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)
}

/**
 * Opens the manager the way the criterion names, and says whether both routes
 * were there.
 *
 * "Reachable from the New Harness dialog **and** from the settings pane" is two
 * claims, so both handles are looked for and each is actually pressed. The
 * dialog route is checked first and closed again, because the manager withholds
 * the harness dialog while it is up - one `Overlay` at a time - and a run that
 * left the dialog open behind it would be measuring a stack of two.
 */
async function openManagerBothWays(
  win: BrowserWindow,
  fixtures: Fixtures
): Promise<{ fromDialog: boolean; fromSettings: boolean }> {
  await click(win, '[data-create-harness]')
  await pollJs(win, `document.querySelector('[data-harness-dialog]')`, 10_000)
  answerPicker('directory', fixtures.parent)
  await click(win, '[data-harness-choose]')
  await pollJs(win, `document.querySelector('[data-harness-dir]')?.value`, 10_000)
  // The picker only paints once `template:list` has answered, and the link
  // lives on its label row.
  await pollJs(win, `document.querySelector('[data-harness-manage-templates]')`, 10_000)
  await click(win, '[data-harness-manage-templates]')
  const fromDialog = await pollJs(win, `document.querySelector('[data-template-manager]')`, 10_000)
  await click(win, '[data-template-close]')
  await sleep(300)
  await dismissDialog(win)

  await click(win, '[data-open-settings]')
  await pollJs(win, `document.querySelector('[data-settings-pane]')`, 10_000)
  await js<void>(
    win,
    `(() => { const el = document.querySelector('[data-settings-group="templates"]');
      if (el) el.scrollIntoView({ block: 'center' }) })()`
  )
  await sleep(250)
  await click(win, '[data-settings-manage-templates]')
  const fromSettings = await pollJs(
    win,
    `document.querySelector('[data-template-manager]')`,
    10_000
  )
  return { fromDialog, fromSettings }
}

/** Selects a template's row in the manager and waits for its files to land. */
async function selectTemplate(win: BrowserWindow, template: string): Promise<void> {
  await click(win, `[data-template-row="${template}"]`)
  await pollJs(
    win,
    `document.querySelector('[data-template-name]')?.value === ${JSON.stringify(template)}`,
    10_000
  )
  // `template:detail` is a second round trip after the row is selected.
  await sleep(400)
}

/** Creates a template through the manager's own New form. */
async function createTemplateThroughManager(win: BrowserWindow, name: string): Promise<void> {
  await click(win, '[data-template-new]')
  await pollJs(win, `document.querySelector('[data-template-new-name]')`, 10_000)
  await fill(win, '[data-template-new-name]', name)
  await click(win, '[data-template-new-confirm]')
  await pollJs(win, `document.querySelector('[data-template-row="${name}"]')`, 10_000)
  await sleep(400)
}

/** Closes the dialog if it is still up, so the next group starts clean. */
async function dismissDialog(win: BrowserWindow): Promise<void> {
  await js<void>(
    win,
    `(() => { const el = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent ?? '').trim() === 'Cancel');
      if (el) el.click() })()`
  )
  await sleep(300)
}

// ---------------------------------------------------------------------------
// The seed phases' reports
// ---------------------------------------------------------------------------

/** What `--template-seed` writes: the whole directory, hashed. */
export interface SeedPhaseReport {
  dir: string
  seeded: boolean
  created: string[]
  files: Array<{ path: string; sha256: string }>
}

/**
 * Reads one seed phase's report.
 *
 * A missing file is not read as an empty directory: it is a phase that did not
 * run, and the check that depends on it has to fail rather than compare two
 * empty lists and agree with itself.
 */
function readSeedPhase(dataDir: string, name: string): SeedPhaseReport | null {
  const file = join(dataDir, name)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SeedPhaseReport
  } catch {
    return null
  }
}

/**
 * The whole templates directory as paths and hashes, for a `--template-seed`
 * phase to write down.
 *
 * Exported because `index.ts` runs that phase, and it is the *only* thing that
 * phase does beyond starting the app.
 */
export function hashTemplatesDir(dir: string): Array<{ path: string; sha256: string }> {
  const files: Array<{ path: string; sha256: string }> = []
  for (const relativePath of walk(dir)) {
    // Directories are in the walk and are not hashable; asking `sha256` first
    // and filtering afterwards is what threw `EISDIR` on the first run.
    const full = join(dir, ...relativePath.split('/'))
    try {
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }
    const hash = sha256(full)
    if (hash !== null) files.push({ path: relativePath, sha256: hash })
  }
  return files
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export interface TemplateOptions {
  dataDir: string
  shotDir: string
  only?: string[] | undefined
}

export async function runTemplateChecks(
  ctx: CheckContext,
  options: TemplateOptions
): Promise<Check[]> {
  const { win } = ctx
  const { dataDir, shotDir } = options
  const wanted = new Set<Group>(
    (options.only?.filter((group): group is Group => GROUPS.includes(group as Group)) ??
      GROUPS) as Group[]
  )
  const checks: Check[] = []

  const fixtures = plantFixtures(dataDir)

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------
  if (wanted.has('create')) {
    const fixtureDir = join(templatesDir, FIXTURE)
    const sourceLiteral = join(fixtureDir, 'workflow.yml')

    const made = await createThroughDialog(win, fixtures, HARNESS_FROM_TEMPLATE, FIXTURE, shotDir)
    const shot = await screenshot(win, shotDir, 'template-created.png')
    const tree = walk(made.path)
    const writtenLiteral = join(made.path, 'workflow.yml')

    /*
     * TPL-1, and it comes first because everything below it is only worth what
     * this says.
     *
     * `sameBytes` is the comparator TPL-3 leans on. Here it is asked three
     * questions in a row: is the fixture actually there and non-empty, does it
     * agree with what was written, and - with one byte of the fixture flipped -
     * does it still agree. The third answer has to be *no*. Without it a
     * fixture that had gone missing would make both sides `null`, the
     * comparison would hold, and this whole group would report green over
     * nothing at all. That is PROF-4, exactly.
     */
    const sameBytes = (): boolean => {
      const a = sha256(sourceLiteral)
      const b = sha256(writtenLiteral)
      return a !== null && b !== null && a === b
    }
    const fixtureBytes = existsSync(sourceLiteral) ? readFileSync(sourceLiteral) : null
    const fixturePresent = fixtureBytes !== null && fixtureBytes.length > 0
    const cleanCompare = sameBytes()
    let mutatedCompare: boolean | null = null
    if (fixturePresent) {
      const mutated = Buffer.from(fixtureBytes)
      // One byte, in the middle, and put straight back: the fixture has to be
      // exactly as it was for TPL-3 to be about the template rather than about
      // this probe's leftovers.
      mutated[Math.floor(mutated.length / 2)] = (mutated[Math.floor(mutated.length / 2)] ?? 0) ^ 0x01
      writeFileSync(sourceLiteral, mutated)
      mutatedCompare = sameBytes()
      writeFileSync(sourceLiteral, fixtureBytes)
    }
    const restored = sha256(sourceLiteral) !== null && sameBytes()

    checks.push({
      id: 'TPL-1',
      criterion: 'The template fixture is proven discriminating before any pass over it is believed',
      title: 'The byte comparator agrees, then is made to disagree, then agrees again',
      ok: fixturePresent && cleanCompare && mutatedCompare === false && restored,
      detail: {
        fixture: sourceLiteral,
        fixtureBytes: fixtureBytes?.length ?? 0,
        cleanCompare,
        mutatedCompare,
        restored
      },
      notes: [
        'A comparator that reads its expected value out of a fixture is worth nothing until the fixture has been made to fail it - CLAUDE.md, PROF-4. One byte of the fixture is flipped and the same function is required to reject the file it had just accepted.',
        'The byte is put back and the comparison re-run, so TPL-3 below is about the template rather than about what this probe left behind.'
      ]
    })

    checks.push({
      id: 'TPL-2',
      criterion: 'The picker offers the template with the label and description from template.yaml',
      title: `The fixture's own label and description are on its row`,
      ok:
        made.pickerUp &&
        made.rowText.includes(FIXTURE_LABEL) &&
        made.rowText.includes(FIXTURE_DESCRIPTION) &&
        made.chosen === FIXTURE,
      detail: {
        pickerPresent: made.pickerUp,
        rowText: made.rowText,
        chosen: made.chosen,
        expectedLabel: FIXTURE_LABEL,
        expectedDescription: FIXTURE_DESCRIPTION,
        screenshot: shot.file
      },
      notes: [
        'Read out of the rendered row rather than out of `template:list`: the claim is that what an author wrote in template.yaml reaches the screen, and a channel agreeing with itself would not say that.'
      ]
    })

    /*
     * The tree, from a recursion that knows nothing about templates.
     *
     * `dot-claude/` has to arrive as `.claude/`, `notes/.gitkeep` has to arrive
     * as an empty `notes/` with no marker file in it, `CLAUDE.md.tpl` has to
     * have lost its extension, and `template.yaml` must not be there at all -
     * it is metadata about the template, not content of it.
     */
    const expectedTree = [
      '.claude',
      '.claude/settings.json',
      'CLAUDE.md',
      'harness.yaml',
      'notes',
      'workflow.yml'
    ]
    // The manifest first, then every target by path - `previewTemplate`'s
    // display order, which is deliberately not the write order (the manifest is
    // written last, so a partial apply still leaves a harness).
    const expectedPreview = [
      'harness.yaml',
      '.claude/settings.json',
      'CLAUDE.md',
      'notes/',
      'workflow.yml'
    ]
    const previewMatches = made.written.join(',') === expectedPreview.join(',')

    checks.push({
      id: 'TPL-3',
      criterion:
        'Create-from-template writes the tree, with the dot-claude alias and .gitkeep folders, and the dialog said so first',
      title: 'The harness on disk is the template, and matches what the dialog listed',
      ok:
        made.onDisk &&
        made.problems.length === 0 &&
        tree.join(',') === expectedTree.join(',') &&
        previewMatches,
      detail: {
        path: made.path,
        tree,
        expectedTree,
        whatTheDialogListed: made.written,
        expectedPreview,
        dialogProblems: made.problems
      },
      notes: [
        'The walk is a plain recursion in this driver, so it disagrees with the writer if the writer leaves anything extra behind - a copied .gitkeep, or the template.yaml that describes the template rather than belonging to the harness.',
        'The dialog\'s own list is compared against the same creation, because "What gets written" is now read from the engine and a preview that described a different layout would be a lie a screenshot could not catch.'
      ]
    })

    const claudeMd = existsSync(join(made.path, 'CLAUDE.md'))
      ? readFileSync(join(made.path, 'CLAUDE.md'), 'utf8')
      : ''
    const manifest = manifestLines(join(made.path, 'harness.yaml'))
    const createdAt = manifest?.values['created'] ?? ''
    const substituted =
      claudeMd.includes(`# ${HARNESS_FROM_TEMPLATE}`) &&
      // The whole rendered line, not a fragment of it: `{{TEMPLATE}}` sits
      // between two words in the fixture, so an assertion that dropped them
      // would also pass over a substitution that ate one.
      claudeMd.includes(`Created ${createdAt} from the ${FIXTURE} template.`) &&
      createdAt !== '' &&
      claudeMd.includes(createdAt) &&
      // An unknown placeholder survives as written, the way the review prompt's
      // does: a typo has to show up as a typo rather than as a missing word.
      claudeMd.includes('{{PLACEHOLDER}}')

    checks.push({
      id: 'TPL-4',
      criterion:
        'Substitution stays inside .tpl: a non-.tpl file containing a literal {{...}} arrives byte-identical',
      title: 'The .tpl was filled in and renamed; the workflow file is unchanged to the byte',
      ok: substituted && cleanCompare && fixturePresent,
      detail: {
        claudeMd,
        manifestCreated: createdAt,
        literalFile: writtenLiteral,
        literalSha: sha256(writtenLiteral),
        fixtureSha: sha256(sourceLiteral),
        literalContainsPlaceholders: readFileSync(writtenLiteral, 'utf8').includes('{{NAME}}')
      },
      notes: [
        'The workflow file carries two GitHub Actions expressions, a Jinja block and a literal {{NAME}}. A whole-file replaceAll would rewrite the last of those silently, in a file nobody thought of as a template, which is the entire argument for the .tpl restriction.',
        'The timestamp in the rendered .tpl is compared against the manifest\'s own `created:`, so the two halves of one creation cannot disagree about when it happened.'
      ]
    })

    // The provenance, in the manifest and then on the screen. The row is
    // scrolled into view before it is photographed: a harness group sits below
    // the pinned list, so on a machine with a few pins the evidence for "it is
    // on the row" would otherwise be a shot of the row not being on screen.
    await js<void>(
      win,
      `(() => { const el = document.querySelector('[data-project-meta]');
        if (el) el.scrollIntoView({ block: 'center' }) })()`
    )
    await sleep(400)
    const rowShot = await screenshot(win, shotDir, 'template-row-meta.png')
    const rowMeta = await js<string[]>(
      win,
      `[...document.querySelectorAll('[data-project-meta]')].map((el) => el.getAttribute('data-project-meta') ?? '')`
    )
    await js<boolean>(
      win,
      `(() => { const el = [...document.querySelectorAll('aside button[title]')]
          .find((b) => b.title.toLowerCase() === ${JSON.stringify(made.path.toLowerCase())});
        if (!el) return false; el.click(); return true })()`
    )
    await sleep(600)
    const paneTemplate = await text(win, '[data-harness-template-name]')
    const paneShot = await screenshot(win, shotDir, 'template-provenance.png')
    const cached = await js<CachedProject[]>(win, `window.helm.invoke('discovery:cached')`)
    const cachedRow =
      cached.find((row) => row.path.toLowerCase() === made.path.toLowerCase()) ?? null

    checks.push({
      id: 'TPL-5',
      criterion:
        'template: is recorded as provenance, survives the projects cache, and is visible on the harness row and its pane',
      title: `The harness says it came from ${FIXTURE}, in the manifest, the cache, the row and the pane`,
      ok:
        manifest?.values['template'] === FIXTURE &&
        rowMeta.includes(FIXTURE) &&
        paneTemplate.trim() === FIXTURE &&
        cachedRow?.template === FIXTURE,
      detail: {
        manifestTemplate: manifest?.values['template'] ?? null,
        sidebarMetaLines: rowMeta,
        paneTemplate,
        cachedRow,
        rowScreenshot: rowShot.file,
        screenshot: paneShot.file
      },
      notes: [
        'The cache row is read through `discovery:cached` - the same channel the launcher paints its first frame from. That is the one `useLauncher` used to hardcode to null, so a regression there shows up here rather than as a row that is briefly wrong on every cold start.',
        'Nothing else reads the value back. It is provenance: the harness belongs to whoever works in it from the moment it exists, and no template is ever re-applied to it.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // minimal-unchanged
  // -------------------------------------------------------------------------
  if (wanted.has('minimal-unchanged')) {
    const made = await createThroughDialog(win, fixtures, HARNESS_MINIMAL, 'minimal', shotDir)
    const tree = walk(made.path)
    const manifest = manifestLines(join(made.path, 'harness.yaml'))

    checks.push({
      id: 'TPL-6',
      criterion: 'minimal stays built-in code and byte-identical to what it wrote before templates',
      title: 'Minimal still writes exactly .claude, harness.yaml and repos, with four keys',
      ok:
        made.onDisk &&
        made.chosen === 'minimal' &&
        made.problems.length === 0 &&
        tree.join(',') === '.claude,harness.yaml,repos' &&
        manifest !== null &&
        manifest.keys.join(',') === 'name,template,version,created' &&
        manifest.values['name'] === HARNESS_MINIMAL &&
        manifest.values['template'] === 'minimal',
      detail: {
        path: made.path,
        chosen: made.chosen,
        tree,
        manifestKeys: manifest?.keys ?? [],
        manifestValues: manifest?.values ?? {},
        whatTheDialogListed: made.written
      },
      notes: [
        'The same claim `packaging-check` PKG-11 makes, from the other side: there it is one creation among the first-run walk, here it is the row deliberately chosen out of a picker that now has several. Minimal is code rather than a directory, so nothing anybody puts in the templates directory can reach it.',
        'The manifest is read line by line, which is what makes "exactly four keys, in this order" checkable - a YAML parser would forgive a repeat or a stray key.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // seed - three separate app starts, read back here
  // -------------------------------------------------------------------------
  if (wanted.has('seed')) {
    const first = readSeedPhase(dataDir, 'template-seed-1.json')
    const second = readSeedPhase(dataDir, 'template-seed-2.json')
    const third = readSeedPhase(dataDir, 'template-seed-3.json')
    const shipped = Object.keys(SHIPPED_TEMPLATES).sort()

    checks.push({
      id: 'TPL-7',
      criterion: 'A first start into an absent templates directory writes README.md and one example',
      title: `A first start wrote ${String(shipped.length)} files, the README and the example among them`,
      ok:
        first !== null &&
        first.seeded &&
        first.created.slice().sort().join(',') === shipped.join(',') &&
        first.files.some((file) => file.path === 'README.md') &&
        first.files.some((file) => file.path.startsWith('example/')),
      detail: {
        phaseRan: first !== null,
        seeded: first?.seeded ?? null,
        created: first?.created ?? [],
        expected: shipped,
        dir: first?.dir ?? null
      },
      notes: [
        'A separate app start, because "the first start writes it" is not a claim a process that has already started can make about itself. `run-template.mjs` removes the directory and runs `--template-seed`; this reads what that wrote down.',
        'The expected list is `SHIPPED_TEMPLATES` itself rather than a copy of it here, so adding a file to the shipped example cannot leave this asserting the old set.'
      ]
    })

    const unchanged =
      first !== null &&
      second !== null &&
      second.seeded === false &&
      second.created.length === 0 &&
      // The runner edited README.md between the phases. Its hash has to have
      // moved and then stayed moved: "identical to phase one" would also be
      // what a phase that never ran would report.
      first.files.length === second.files.length &&
      second.files.some((file) => {
        const before = first.files.find((candidate) => candidate.path === file.path)
        return file.path === 'README.md' && before !== undefined && before.sha256 !== file.sha256
      }) &&
      second.files
        .filter((file) => file.path !== 'README.md')
        .every((file) =>
          first.files.some(
            (candidate) => candidate.path === file.path && candidate.sha256 === file.sha256
          )
        )

    checks.push({
      id: 'TPL-8',
      criterion: 'A second start overwrites nothing, however the seeded files have been edited',
      title: 'The edit made between two app starts is still there after the second',
      ok: unchanged,
      detail: {
        firstPhaseRan: first !== null,
        secondPhaseRan: second !== null,
        secondSeeded: second?.seeded ?? null,
        secondCreated: second?.created ?? [],
        readmeBefore: first?.files.find((file) => file.path === 'README.md')?.sha256 ?? null,
        readmeAfter: second?.files.find((file) => file.path === 'README.md')?.sha256 ?? null
      },
      notes: [
        'The edit is the whole probe. Helm keeps no hashes of what it seeded, so it cannot tell an edited file from an untouched one - which is exactly why it must never overwrite, and why "the file is still what the user made it" is the thing to assert rather than "the file is still there".',
        'Every other seeded file is required to be byte-identical too, so a pass cannot come from a second start that rewrote everything including the edit.'
      ]
    })

    checks.push({
      id: 'TPL-9',
      criterion: 'Deleting the templates directory re-seeds it, which is the whole of "reset"',
      title: 'A third start, with the directory removed, put the shipped files back',
      ok:
        third !== null &&
        second !== null &&
        third.seeded &&
        third.created.slice().sort().join(',') === shipped.join(',') &&
        // And the *original* README is back, not the edited one.
        third.files.find((file) => file.path === 'README.md')?.sha256 !==
          second.files.find((file) => file.path === 'README.md')?.sha256,
      detail: {
        phaseRan: third !== null,
        seeded: third?.seeded ?? null,
        created: third?.created ?? [],
        readmeAfterEdit: second?.files.find((file) => file.path === 'README.md')?.sha256 ?? null,
        readmeAfterReseed: third?.files.find((file) => file.path === 'README.md')?.sha256 ?? null
      },
      notes: [
        'This is why there is no reset feature and no "restore defaults" button: deleting the directory is the mechanism, and it falls out of the rule that seeding triggers on the directory being absent.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // hostile
  // -------------------------------------------------------------------------
  if (wanted.has('hostile')) {
    const parentBefore = walk(fixtures.parent)
    const canaryBefore = walk(fixtures.canary).concat(
      sha256(join(fixtures.canary, 'do-not-touch.txt')) ?? 'missing'
    )

    /*
     * A template name that is a path.
     *
     * Driven through the channel rather than the dialog, and that is not a
     * shortcut: the picker cannot produce one of these, so the dialog is not
     * where the refusal has to hold. `harness:create` is a channel a renderer
     * calls with a string, and the value being refused is exactly the string a
     * renderer chooses. This is the real channel and the real handler.
     */
    const hostileNames = ['../escape', '..\\escape', 'C:\\Windows\\System32', '/etc']
    const refusals: Array<{ template: string; path: string | null; problems: string[] }> = []
    for (const [index, template] of hostileNames.entries()) {
      const outcome = await js<{ path: string | null; problems: string[] }>(
        win,
        `window.helm.invoke('harness:create', {
          mode: 'new',
          dir: ${JSON.stringify(fixtures.parent)},
          name: ${JSON.stringify(`tpl-refused-${String(index)}`)},
          template: ${JSON.stringify(template)}
        }).then((r) => ({ path: r.path, problems: r.problems }))`
      )
      refusals.push({ template, ...outcome })
    }
    const parentAfterNames = walk(fixtures.parent)

    checks.push({
      id: 'TPL-10',
      criterion:
        'A template name that is absolute or climbs out is refused with a readable sentence, and nothing is written',
      title: `${String(hostileNames.length)} hostile template names refused, no directory left behind`,
      ok:
        refusals.every(
          (refusal) =>
            refusal.path === null &&
            refusal.problems.length > 0 &&
            refusal.problems.every((problem) => /[a-z]/.test(problem) && problem.endsWith('.'))
        ) && parentAfterNames.join(',') === parentBefore.join(','),
      detail: {
        refusals,
        parentBefore,
        parentAfter: parentAfterNames
      },
      notes: [
        'The parent is walked either side rather than the new directory being checked for: "it refused" and "it refused after making the folder" look identical from the return value alone.',
        'The sentences are required to be sentences - prose, ending in a full stop - because `problems` is rendered straight into the dialog and a stack trace or an errno there is a refusal nobody can act on.'
      ]
    })

    const made = await createThroughDialog(win, fixtures, HARNESS_HOSTILE, HOSTILE)
    const tree = walk(made.path)
    const canaryAfter = walk(fixtures.canary).concat(
      sha256(join(fixtures.canary, 'do-not-touch.txt')) ?? 'missing'
    )
    const shot = await screenshot(win, shotDir, 'template-hostile.png')
    await dismissDialog(win)

    checks.push({
      id: 'TPL-11',
      criterion:
        'A junction inside a template is refused with a sentence, the honest half is still written, and nothing lands outside the harness',
      title: 'The junction was not followed, and what it pointed at is untouched',
      ok:
        made.onDisk &&
        made.problems.length > 0 &&
        made.problems.join(' ').includes('escape') &&
        tree.join(',') === 'harness.yaml,honest.txt' &&
        canaryAfter.join(',') === canaryBefore.join(','),
      detail: {
        path: made.path,
        tree,
        problems: made.problems,
        canaryBefore,
        canaryAfter,
        screenshot: shot.file
      },
      notes: [
        'The junction was planted with `symlinkSync(..., "junction")`, which needs no elevation on Windows and is the same reparse point CLAUDE.md\'s rule about overlay shims is written about: a writer that follows one instead of refusing it is a writer that can reach the whole disk.',
        'Partial rather than atomic, and asserted as such: the honest file is there, the manifest is there, and the entry that could not be written is a sentence in `problems`. No rollback is claimed, and the dialog stays up holding that list because there is nowhere else it is kept.',
        'What the junction pointed at is hashed either side, so "nothing was written outside the harness" is a claim about the bytes rather than about the absence of a filename.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // authoring - the manager, skill import, and freezing a folder
  // -------------------------------------------------------------------------
  if (wanted.has('authoring')) {
    await dismissDialog(win)

    // The import picker's sources are `config:scopes`, which is built from the
    // last scan - so the fixtures have to be somewhere Helm scans before any of
    // this can be about the real seam. Through the real channels, both.
    const rootsAfterAccept = await js<string[]>(
      win,
      `window.helm.invoke('roots:accept', { path: ${JSON.stringify(fixtures.parent)} })`
    )

    /*
     * Scan until the fixture is a scope, rather than scanning once.
     *
     * One scan is not enough and the reason is a race worth naming: the app
     * kicks off its own pass at `renderer:ready`, that pass walks this
     * machine's real roots and takes seconds, and `runScan` assigns
     * `services.lastScan` when it *finishes*. A driver that accepted a root and
     * scanned immediately would have its result overwritten by the startup pass
     * landing afterwards with the old roots - which is exactly what happened,
     * and it looked like the fixture had never been discovered at all.
     *
     * So the condition is the one that actually matters - the fixture is in
     * `config:scopes` - and it is asked through the same channel the import
     * picker reads.
     */
    let scanned: { projects: string[]; errors: string[] } = { projects: [], errors: [] }
    let scopesHaveFixture = false
    for (let attempt = 0; attempt < 6 && !scopesHaveFixture; attempt++) {
      scanned = await js<{ projects: string[]; errors: string[] }>(
        win,
        `window.helm.invoke('discovery:scan', { includeGit: false }).then((r) => ({
          projects: r.projects.map((p) => p.path),
          errors: r.errors.map((e) => e.path + ': ' + e.message)
        }))`
      )
      await sleep(600)
      scopesHaveFixture = await js<boolean>(
        win,
        `window.helm.invoke('config:scopes').then((s) => s.some(
          (scope) => scope.path.toLowerCase() === ${JSON.stringify(fixtures.project.toLowerCase())}
        ))`
      )
    }

    const reach = await openManagerBothWays(win, fixtures)

    // --- TPL-12  the manager: create, describe, rename, delete -------------
    await createTemplateThroughManager(win, AUTHORED)
    const afterCreate = walk(join(templatesDir, AUTHORED))

    await fill(win, '[data-template-label]', AUTHORED_LABEL)
    await fill(win, '[data-template-description]', AUTHORED_DESCRIPTION)
    await click(win, '[data-template-save]')
    await sleep(700)
    const described = manifestLines(join(templatesDir, AUTHORED, 'template.yaml'))

    // The rename goes through the same form: the folder name *is* the id.
    await fill(win, '[data-template-name]', AUTHORED_RENAMED)
    await click(win, '[data-template-save]')
    await pollJs(win, `document.querySelector('[data-template-row="${AUTHORED_RENAMED}"]')`, 10_000)
    await sleep(500)
    const renamed = {
      oldGone: !existsSync(join(templatesDir, AUTHORED)),
      newThere: existsSync(join(templatesDir, AUTHORED_RENAMED, 'template.yaml')),
      // The metadata has to have travelled with it. A rename that lost the
      // label would leave a template the picker shows by its folder name.
      manifest: manifestLines(join(templatesDir, AUTHORED_RENAMED, 'template.yaml'))
    }

    // The manager as somebody sees it, with a template selected, its files
    // listed and the import picker under them. A new surface is not done until
    // it has been looked at rather than reasoned about (CLAUDE.md).
    const managerShot = await screenshot(win, shotDir, 'template-manager.png')

    // What the manager lists, against the driver's own listing of the folder.
    const listedRows = await js<string[]>(
      win,
      `[...document.querySelectorAll('[data-template-row]')].map((el) => el.getAttribute('data-template-row') ?? '')`
    )
    const onDiskTemplates = readdirSync(templatesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()

    await selectTemplate(win, AUTHORED_RENAMED)
    await click(win, '[data-template-delete]')
    await sleep(250)
    await click(win, '[data-template-delete-confirm]')
    await pollJs(win, `!document.querySelector('[data-template-row="${AUTHORED_RENAMED}"]')`, 10_000)
    await sleep(400)
    const deleted = !existsSync(join(templatesDir, AUTHORED_RENAMED))

    checks.push({
      id: 'TPL-12',
      criterion:
        'The manager is reachable from the New Harness dialog and the settings pane, and does list, create, rename, delete, metadata and Show in Explorer',
      title: 'A template was created, described, renamed and deleted through the real manager',
      ok:
        reach.fromDialog &&
        reach.fromSettings &&
        afterCreate.join(',') === 'template.yaml' &&
        described?.values['label'] === AUTHORED_LABEL &&
        described.values['description'] === AUTHORED_DESCRIPTION &&
        renamed.oldGone &&
        renamed.newThere &&
        renamed.manifest?.values['label'] === AUTHORED_LABEL &&
        listedRows.slice().sort().join(',') ===
          onDiskTemplates.filter((name) => listedRows.includes(name)).join(',') &&
        listedRows.includes(AUTHORED_RENAMED) &&
        deleted,
      detail: {
        reachableFromNewHarnessDialog: reach.fromDialog,
        reachableFromSettings: reach.fromSettings,
        afterCreate,
        described: described?.values ?? null,
        renamed,
        listedRows,
        onDiskTemplates,
        deletedFromDisk: deleted,
        screenshot: managerShot.file
      },
      notes: [
        'Every claim is read back off the disk by this driver - a plain `readdirSync` for the list and the line-wise manifest reader for the metadata - rather than out of `template:list`. A channel agreeing with the writer that called it proves nothing about either.',
        'Create scaffolds a manifest and *nothing else*: the walk is required to be exactly `template.yaml`, so a starter file added to the scaffold would fail here rather than arriving in somebody\'s harness.',
        'Both entry points are pressed rather than merely looked for, and the dialog route is closed again before the settings route is tried - the manager withholds the harness dialog while it is up, so a run that left it open would be measuring two overlays.'
      ]
    })

    // --- TPL-13  import a skill, byte for byte, and then use it ------------
    await createTemplateThroughManager(win, IMPORT_TARGET)
    await choose(win, '[data-template-import-scope]', fixtures.project)
    const sawSkill = await pollJs(
      win,
      `document.querySelector('[data-template-import-file=".claude/skills/${IMPORT_SKILL}/SKILL.md"]')`,
      10_000
    )
    // The scope list itself, so "sourced from `config:scopes`" is a claim about
    // what the picker was offered rather than about what it happened to show.
    const offeredScopes = await js<string[]>(
      win,
      `[...document.querySelectorAll('[data-template-import-scope] option')].map((el) => el.value)`
    )
    const userScopeOffered = await js<boolean>(
      win,
      `[...document.querySelectorAll('[data-template-import-scope] option')]
        .some((el) => (el.textContent ?? '').includes('~/.claude'))`
    )
    await click(
      win,
      `[data-template-import-file=".claude/skills/${IMPORT_SKILL}/SKILL.md"]`
    )
    await sleep(200)
    await click(win, '[data-template-import-confirm]')
    await sleep(900)

    const importedSkill = join(
      templatesDir,
      IMPORT_TARGET,
      '.claude',
      'skills',
      IMPORT_SKILL,
      'SKILL.md'
    )
    const importedTree = walk(join(templatesDir, IMPORT_TARGET))

    /*
     * The same discipline TPL-1 applies to the create fixture, applied to this
     * one - and it has to be applied again, because this is a *different*
     * fixture read by a *different* comparison. `sameSkill` is asked clean,
     * then a byte of the source is flipped and it is required to reject the
     * file it had just accepted, then the byte goes back.
     *
     * Without it, a source that had gone missing would make both hashes null,
     * `a === b` would hold, and this whole probe would report green over two
     * files that do not exist.
     */
    const sameSkill = (): boolean => {
      const a = sha256(fixtures.skill)
      const b = sha256(importedSkill)
      return a !== null && b !== null && a === b
    }
    const skillBytes = existsSync(fixtures.skill) ? readFileSync(fixtures.skill) : null
    const skillPresent = skillBytes !== null && skillBytes.length > 0
    const skillClean = sameSkill()
    let skillMutated: boolean | null = null
    if (skillPresent) {
      const mutated = Buffer.from(skillBytes)
      const at = Math.floor(mutated.length / 2)
      mutated[at] = (mutated[at] ?? 0) ^ 0x01
      writeFileSync(fixtures.skill, mutated)
      skillMutated = sameSkill()
      writeFileSync(fixtures.skill, skillBytes)
    }
    const skillRestored = sha256(fixtures.skill) !== null && sameSkill()

    // End to end: the template is used, and the file has to survive that too.
    // The manager is closed first - it withholds the harness dialog while it is
    // up (one `Overlay` at a time), so a run that left it open would sit here
    // waiting for a dialog that is deliberately not being drawn.
    await click(win, '[data-template-close]')
    await sleep(400)
    const fromImport = await createThroughDialog(
      win,
      fixtures,
      HARNESS_FROM_IMPORT,
      IMPORT_TARGET,
      shotDir
    )
    await dismissDialog(win)
    const inHarness = join(
      fromImport.path,
      '.claude',
      'skills',
      IMPORT_SKILL,
      'SKILL.md'
    )

    checks.push({
      id: 'TPL-13',
      criterion:
        'A skill is imported from a config-console scope as plain, byte-identical files, and survives being made into a harness',
      title: 'The imported SKILL.md matches the source sha256, in the template and in the harness',
      ok:
        scopesHaveFixture &&
        sawSkill &&
        offeredScopes.includes(fixtures.project) &&
        userScopeOffered &&
        skillPresent &&
        skillClean &&
        skillMutated === false &&
        skillRestored &&
        // A skill is a directory: the file beside the SKILL.md travels with it.
        importedTree.includes(`.claude/skills/${IMPORT_SKILL}/reference.md`) &&
        sha256(inHarness) === sha256(fixtures.skill) &&
        fromImport.problems.length === 0,
      detail: {
        pickerSawTheSkill: sawSkill,
        // What the fixture had to travel through to become a scope at all: a
        // root, then a scan, then `config:scopes`. Reported whether or not this
        // passes, because "the picker was empty" has three different causes and
        // the return value alone distinguishes none of them.
        rootsAfterAccept,
        scannedProjects: scanned.projects.filter((path) =>
          path.toLowerCase().startsWith(fixtures.parent.toLowerCase())
        ),
        scanErrors: scanned.errors,
        fixtureBecameAScope: scopesHaveFixture,
        offeredScopes,
        userScopeOffered,
        sourceSha: sha256(fixtures.skill),
        templateSha: sha256(importedSkill),
        harnessSha: sha256(inHarness),
        cleanCompare: skillClean,
        mutatedCompare: skillMutated,
        restored: skillRestored,
        importedTree,
        harnessProblems: fromImport.problems
      },
      notes: [
        'The comparator is made to disagree before its agreement is believed, exactly as TPL-1 does for the create fixture. A second fixture and a second comparison earn the proof a second time - CLAUDE.md, PROF-4.',
        'The scope list is read out of the rendered `<select>`, and the user scope is required to be among the options: importing a skill you wrote for yourself is the obvious case, and it is a *read* of `~/.claude` - the only thing Helm does there.',
        'The bundled `reference.md` has to be in the template too. `skills/<name>/` copies wholesale, and a SKILL.md arriving on its own would look identical from a single hash.',
        'The harness at the end is created through the real New Harness dialog, so the claim is end to end rather than about the template directory alone.'
      ]
    })

    // --- TPL-14 / TPL-15  save a harness as a template ---------------------
    const canaryBeforeSave = canaryState(fixtures.canary)

    // The harness's own row in the sidebar, then its pane's action.
    await js<boolean>(
      win,
      `(() => { const el = [...document.querySelectorAll('aside button[title]')]
          .find((b) => b.title.toLowerCase() === ${JSON.stringify(fixtures.harness.toLowerCase())});
        if (!el) return false; el.click(); return true })()`
    )
    await pollJs(win, `document.querySelector('[data-project-save-template]')`, 10_000)
    await click(win, '[data-project-save-template]')
    const previewUp = await pollJs(win, `document.querySelector('[data-save-template]')`, 10_000)
    // The walk behind the preview is real work over a fixture with a repos/ in
    // it; the total is what is being read, so it has to have landed.
    await pollJs(
      win,
      `!(document.querySelector('[data-save-template-total]')?.textContent ?? '').includes('reading')`,
      15_000
    )
    await sleep(300)

    const previewRows = await js<Array<{ name: string; on: string | null; text: string }>>(
      win,
      `[...document.querySelectorAll('[data-save-template-entry]')].map((el) => ({
        name: el.getAttribute('data-save-template-entry') ?? '',
        on: el.getAttribute('data-save-template-entry-on'),
        text: el.textContent ?? ''
      }))`
    )
    const totalBefore = await text(win, '[data-save-template-total]')
    const saveShot = await screenshot(win, shotDir, 'template-save-as.png')

    // Untick the one thing only a person can judge: `notes/` is a journal here,
    // and Helm has no way to know that - which is the whole reason it asks.
    await click(win, '[data-save-template-entry="notes"]')
    await sleep(200)
    const totalAfterUntick = await text(win, '[data-save-template-total]')

    await fill(win, '[data-save-template-name]', FROZEN)
    await fill(win, '[data-save-template-label]', 'Frozen fixture')
    await click(win, '[data-save-template-confirm]')
    await sleep(1200)

    const frozenTree = walk(join(templatesDir, FROZEN))
    const canaryAfterSave = canaryState(fixtures.canary)

    const tickedAtOpen = new Map(previewRows.map((row) => [row.name, row.on === 'true']))

    checks.push({
      id: 'TPL-14',
      criterion:
        'Save as template previews every entry with per-entry checkboxes and sensible defaults, states the file count and total size before writing, and writes only what was ticked',
      title: 'The preview unticked the instance data, stated the size, and the write matched it',
      ok:
        previewUp &&
        // The four defaults, each read off the row as rendered.
        tickedAtOpen.get('harness.yaml') === false &&
        tickedAtOpen.get('repos') === false &&
        tickedAtOpen.get('.git') === false &&
        tickedAtOpen.get('.claude') === true &&
        tickedAtOpen.get('CLAUDE.md') === true &&
        tickedAtOpen.get('notes') === true &&
        tickedAtOpen.get('tools') === true &&
        // Stated, and it is a real figure rather than a placeholder.
        /\d/.test(totalBefore) &&
        totalBefore !== totalAfterUntick &&
        // What landed is what was ticked at the moment Create was pressed.
        frozenTree.join(',') ===
          [
            '.claude',
            '.claude/skills',
            '.claude/skills/frozen',
            '.claude/skills/frozen/SKILL.md',
            'CLAUDE.md',
            'template.yaml',
            'tools',
            'tools/run.mjs'
          ].join(','),
      detail: {
        previewUp,
        previewRows,
        totalBefore,
        totalAfterUntick,
        frozenTree,
        screenshot: saveShot.file
      },
      notes: [
        'The tick state is read off each rendered row rather than from the engine, because the claim is that the *dialog* defaults the way the rule says - "Helm cannot tell a journal from a scaffold, so it asks" is a claim about what is on screen.',
        'The total is required to change when an entry is unticked. A figure that is merely present would also be produced by a label that states the whole folder however much of it is selected, which is precisely the surprise the number exists to prevent.',
        'The resulting tree is walked by a recursion in this driver that knows nothing about templates, so anything extra - the `harness.yaml` that would make the template refuse itself later, the `.git` that would put this workspace\'s history into every harness - fails here.'
      ]
    })

    checks.push({
      id: 'TPL-15',
      criterion:
        'Neither saving nor deleting follows a junction into a real repository',
      title: 'The save skipped the planted junction, and deleting a template unlinked its own',
      ok:
        // Saving: `tools/` was ticked and holds a junction into the canary.
        !frozenTree.includes('tools/escape') &&
        !frozenTree.some((entry) => entry.endsWith('do-not-touch.txt')) &&
        canaryAfterSave.join(',') === canaryBeforeSave.join(','),
      detail: {
        frozenTree,
        junctionPlantedAt: join(fixtures.harness, 'tools', 'escape'),
        canaryBefore: canaryBeforeSave,
        canaryAfter: canaryAfterSave
      },
      notes: [
        'The junction is inside `tools/`, which is ticked by default - a junction under `repos/` would be untested, since `repos/` starts unticked and the walk would never have reached it.',
        'The canary is hashed either side rather than merely listed: "it did not follow the junction" is a claim about bytes, and a copy that had followed it would show up as `do-not-touch.txt` inside the template.',
        'The deleting half of this criterion is TPL-16, which removes a template that carries one.'
      ]
    })

    // --- TPL-16  deleting a template unlinks rather than walks -------------
    const canaryBeforeDelete = canaryState(fixtures.canary)
    // Back to Settings: TPL-14 left the harness's own project pane on screen.
    await click(win, '[data-open-settings]')
    await pollJs(win, `document.querySelector('[data-settings-manage-templates]')`, 10_000)
    await click(win, '[data-settings-manage-templates]')
    await pollJs(win, `document.querySelector('[data-template-manager]')`, 10_000)
    await selectTemplate(win, DOOMED)
    // What the manager said about the junction before it was asked to delete.
    const doomedFiles = await js<string[]>(
      win,
      `[...document.querySelectorAll('[data-template-file]')].map((el) => el.getAttribute('data-template-file') ?? '')`
    )
    await click(win, '[data-template-delete]')
    await sleep(250)
    await click(win, '[data-template-delete-confirm]')
    await pollJs(win, `!document.querySelector('[data-template-row="${DOOMED}"]')`, 15_000)
    await sleep(500)
    const canaryAfterDelete = canaryState(fixtures.canary)

    checks.push({
      id: 'TPL-16',
      criterion: 'Deleting a template unlinks a junction it carries; what it pointed at survives',
      title: 'A template holding a junction was deleted and the fixture behind it is untouched',
      ok:
        doomedFiles.includes('escape') &&
        !existsSync(join(templatesDir, DOOMED)) &&
        canaryAfterDelete.join(',') === canaryBeforeDelete.join(','),
      detail: {
        listedFiles: doomedFiles,
        templateGone: !existsSync(join(templatesDir, DOOMED)),
        canaryBefore: canaryBeforeDelete,
        canaryAfter: canaryAfterDelete,
        canaryPath: fixtures.canary
      },
      notes: [
        'This is the overlay-shim deletion discipline proven a second time where it is a second time load-bearing (CLAUDE.md, "Overlays"): a delete that walked into the reparse point instead of unlinking it would remove the contents of a real repository, which is the one unrecoverable failure in this milestone.',
        'The manager is required to have *listed* the junction first. A template whose link was silently omitted from the file list would be a template whose author cannot see why a file never arrives.',
        'The canary is hashed either side, so the claim is about bytes rather than about a directory still existing.'
      ]
    })

    // --- TPL-17  import a folder as a template, dot-claude and all ---------
    answerPicker('directory', fixtures.aliased)
    await click(win, '[data-template-import-folder]')
    const aliasDialogUp = await pollJs(
      win,
      `document.querySelector('[data-save-template="folder"]')`,
      10_000
    )
    await pollJs(
      win,
      `!(document.querySelector('[data-save-template-total]')?.textContent ?? '').includes('reading')`,
      10_000
    )
    await fill(win, '[data-save-template-name]', ALIASED)
    await fill(win, '[data-save-template-label]', 'Aliased fixture')
    await click(win, '[data-save-template-confirm]')
    await sleep(1000)

    const aliasedTree = walk(join(templatesDir, ALIASED))
    await js<void>(
      win,
      `(() => { const el = document.querySelector('[data-template-close]'); if (el) el.click() })()`
    )
    await sleep(400)

    const fromAlias = await createThroughDialog(win, fixtures, HARNESS_FROM_ALIAS, ALIASED)
    await dismissDialog(win)
    const aliasHarnessTree = walk(fromAlias.path)

    checks.push({
      id: 'TPL-17',
      criterion:
        'Import folder as template accepts a dot-claude tree, shows in the picker, and lands as .claude in the harness',
      title: 'A dot-claude/ folder was imported, offered in the picker, and arrived as .claude/',
      ok:
        aliasDialogUp &&
        // Verbatim in the template: the alias is the author's choice, and the
        // engine is what applies it. Rewriting it on the way in would undo a
        // decision made for the tool that needed it.
        aliasedTree.includes(`dot-claude/skills/${ALIASED_SKILL}/SKILL.md`) &&
        !aliasedTree.some((entry) => entry.startsWith('.claude')) &&
        // And it is offered, which is what makes it a template rather than a
        // folder Helm happened to copy.
        fromAlias.pickerUp &&
        fromAlias.chosen === ALIASED &&
        aliasHarnessTree.includes(`.claude/skills/${ALIASED_SKILL}/SKILL.md`) &&
        // The `.tpl` in it went through substitution on the way out, so the
        // import did not quietly flatten the format either.
        readFileSync(join(fromAlias.path, 'CLAUDE.md'), 'utf8') === `# ${HARNESS_FROM_ALIAS}\n` &&
        fromAlias.problems.length === 0,
      detail: {
        dialogOpened: aliasDialogUp,
        aliasedTree,
        pickerOfferedIt: fromAlias.pickerUp,
        chosen: fromAlias.chosen,
        harnessTree: aliasHarnessTree,
        claudeMd: existsSync(join(fromAlias.path, 'CLAUDE.md'))
          ? readFileSync(join(fromAlias.path, 'CLAUDE.md'), 'utf8')
          : null,
        problems: fromAlias.problems
      },
      notes: [
        'The template keeps `dot-claude/` and the *harness* gets `.claude/`. That is the alias working rather than being undone: it exists because tools drop dot directories when a template is packaged, and normalising it on import would throw away the choice the author made for whichever tool needed it.',
        'The end of this is a real creation through the real dialog, so "lands as .claude/" is checked where a user would see it rather than in the template directory.'
      ]
    })

    // --- TPL-18  .tpl awareness in the manager -----------------------------
    await click(win, '[data-open-settings]')
    await pollJs(win, `document.querySelector('[data-settings-manage-templates]')`, 10_000)
    await click(win, '[data-settings-manage-templates]')
    await pollJs(win, `document.querySelector('[data-template-manager]')`, 10_000)
    await selectTemplate(win, ALIASED)

    const tplRows = await js<Array<{ path: string; tpl: string | null; badge: boolean }>>(
      win,
      `[...document.querySelectorAll('[data-template-file]')].map((el) => ({
        path: el.getAttribute('data-template-file') ?? '',
        tpl: el.getAttribute('data-template-file-tpl'),
        badge: Boolean(el.querySelector('[data-template-file-badge]'))
      }))`
    )
    const variablesLine = await text(win, '[data-template-variables]')

    // "Make substitutable" on the one file in this template that is not one.
    const plainFile = `dot-claude/skills/${ALIASED_SKILL}/SKILL.md`
    const substitutableOffered = await exists(
      win,
      `[data-template-substitutable="${plainFile}"]`
    )
    await click(win, `[data-template-substitutable="${plainFile}"]`)
    await sleep(900)
    const renamedOnDisk =
      existsSync(join(templatesDir, ALIASED, ...`${plainFile}.tpl`.split('/'))) &&
      !existsSync(join(templatesDir, ALIASED, ...plainFile.split('/')))

    checks.push({
      id: 'TPL-18',
      criterion:
        'The file list badges substitution-bearing files, names the three variables in-UI, and offers "make substitutable"',
      title: 'The .tpl badge, the three variable names, and a rename that added one',
      ok:
        tplRows.some((row) => row.path === 'CLAUDE.md.tpl' && row.tpl === 'true' && row.badge) &&
        tplRows.some((row) => row.path === plainFile && row.tpl === 'false' && !row.badge) &&
        variablesLine.includes('{{NAME}}') &&
        variablesLine.includes('{{CREATED_AT}}') &&
        variablesLine.includes('{{TEMPLATE}}') &&
        substitutableOffered &&
        renamedOnDisk,
      detail: {
        rows: tplRows,
        variablesLine,
        substitutableOffered,
        renamedOnDisk,
        expectedAfterRename: join(templatesDir, ALIASED, ...`${plainFile}.tpl`.split('/'))
      },
      notes: [
        'The badge is read as a rendered element rather than from the attribute alone, and a non-`.tpl` row is required to *not* have one - a badge on everything would pass an assertion that only looked for its presence.',
        'The three variable names are read out of the help line as it renders. `.tpl` is a Helm invention nobody guesses from a folder listing, so the names being on screen is the acceptance criterion rather than a nicety.',
        'The rename is verified on disk by this driver, not from the notice the manager printed.'
      ]
    })

    await js<void>(
      win,
      `(() => { const el = document.querySelector('[data-template-close]'); if (el) el.click() })()`
    )
    await sleep(300)

    // The fixture root goes back out of the settings. It is written to the
    // check's own database, which survives the run - so leaving it in would put
    // every later run's startup scan through a fixture tree the next
    // `plantFixtures` is about to delete underneath it.
    await js<string[]>(
      win,
      `window.helm.invoke('roots:remove', { path: ${JSON.stringify(fixtures.parent)} })`
    )
    await sleep(300)
  }

  return checks
}
