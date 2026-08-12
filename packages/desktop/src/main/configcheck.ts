import { type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import {
  claudeHome,
  countConfigSnapshots,
  createProfile,
  deleteProfile,
  findProfileByName,
  readConfigFileContent,
  type Profile
} from '@helm/core'
import { screenshot, sleep, waitFor } from './bridge'
import type { Check } from './fidelity'
import type { Collector, CheckContext } from './sessionscheck'
import { ask, waitForPrompt } from './profilescheck'

/**
 * The config-console criteria, driven through the app the way a user reaches
 * them.
 *
 * The discipline is history-check's: nothing is asserted against Helm's own
 * answer alone. Every count, hash and predicted name is checked against a
 * second read written in this file, which shares no code with the thing it is
 * checking - a naive
 * `readdirSync` walk beside the tree scanner, a `createHash` beside the
 * snapshot table, a hand-built `<overlay>:<skill>` beside the effective view.
 * A parser agreeing with itself proves nothing.
 *
 * And for the criterion that is about a *session* rather than a file, the
 * second opinion is a real one: a live `claude` on haiku is asked what it
 * actually sees, and the prediction is compared to its answer.
 *
 * This is also the one milestone that writes into `~/.claude`, so the driver
 * treats the user's real files the way the app does - a snapshot first, a
 * hash-verified restore afterwards, and a plain copy on disk as a backstop in
 * case this process dies between the two.
 *
 * `pnpm config-check` -> helm-data/config-report.json
 */

const MODEL = 'haiku'
const PROFILE_NAME = 'Effective view'

/** Distinctive enough that they cannot appear in a TUI by accident. */
const TOKENS = {
  alphaThink: 'HELMM5ALPHATHINK',
  betaThink: 'HELMM5BETATHINK',
  alphaOnly: 'HELMM5ALPHAONLY',
  mcp: 'HELMM5MCPTOKEN'
}

const MCP_SERVER = 'helm-config-probe'

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

/**
 * What a `.claude` tree contains, walked naively.
 *
 * Deliberately not the tree scanner's algorithm: a plain recursion, a check for
 * `SKILL.md` by name, and `.md` counted under `commands/` and `agents/`. The
 * point is to disagree with the scanner if the scanner is wrong.
 */
interface Walked {
  skills: string[]
  commands: string[]
  agents: string[]
  settings: string[]
  claudeMd: boolean
  mcpJson: boolean
}

function walk(dir: string, into: string[], suffix: string): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      walk(path, into, suffix)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
      into.push(path)
    }
  }
}

function walkSkills(dir: string, into: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const child = join(dir, entry.name)
    if (existsSync(join(child, 'SKILL.md'))) into.push(entry.name)
    else walkSkills(child, into)
  }
}

/** `isUserScope` because the user scope's base directory *is* `.claude`. */
function walkTree(base: string, isUserScope: boolean): Walked {
  const claudeDir = isUserScope ? base : join(base, '.claude')
  const skills: string[] = []
  const commands: string[] = []
  const agents: string[] = []
  const settings: string[] = []

  walkSkills(join(claudeDir, 'skills'), skills)
  walk(join(claudeDir, 'commands'), commands, '.md')
  walk(join(claudeDir, 'agents'), agents, '.md')
  for (const name of ['settings.json', 'settings.local.json']) {
    if (existsSync(join(claudeDir, name))) settings.push(name)
  }

  return {
    skills: skills.sort(),
    commands: commands.sort(),
    agents: agents.sort(),
    settings: settings.sort(),
    // Beside the `.claude` directory for a project; inside it for the user.
    claudeMd: existsSync(join(isUserScope ? base : base, 'CLAUDE.md')),
    mcpJson: existsSync(join(base, '.mcp.json'))
  }
}

/**
 * The names a session would resolve, predicted by hand.
 *
 * The overlay's namespace is `basename(path).toLowerCase()` and nothing else,
 * written out here rather than borrowed from `overlayPluginNames` - because
 * borrowing it would make the check and the thing it checks the same function.
 */
function predictSkillNames(cwd: string, overlays: string[], userHome: string): string[] {
  const out: string[] = []
  const bare: string[] = []
  walkSkills(join(userHome, 'skills'), bare)
  walkSkills(join(cwd, '.claude', 'skills'), bare)
  out.push(...bare)
  for (const overlay of overlays) {
    const names: string[] = []
    walkSkills(join(overlay, '.claude', 'skills'), names)
    out.push(...names.map((name) => `${basename(overlay).toLowerCase()}:${name}`))
  }
  return out.sort()
}

/**
 * Which settings layer wins each leaf, computed independently.
 *
 * Local over project over user, per leaf path - which is the order the CLI
 * documents and which the live-session probe below re-measures rather than
 * assumes.
 */
function flattenJson(value: unknown, prefix: string, into: Map<string, string>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      if (prefix !== '') into.set(prefix, '{}')
      return
    }
    for (const [key, child] of entries) {
      flattenJson(child, prefix === '' ? key : `${prefix}.${key}`, into)
    }
    return
  }
  if (prefix !== '') into.set(prefix, JSON.stringify(value))
}

function settingsTruth(cwd: string, userHome: string): Map<string, { value: string; layer: string }> {
  const layers: Array<[string, string]> = [
    ['local', join(cwd, '.claude', 'settings.local.json')],
    ['project', join(cwd, '.claude', 'settings.json')],
    ['user', join(userHome, 'settings.json')]
  ]
  const winners = new Map<string, { value: string; layer: string }>()
  for (const [layer, file] of layers) {
    const flat = new Map<string, string>()
    try {
      flattenJson(JSON.parse(readFileSync(file, 'utf8')), '', flat)
    } catch {
      continue
    }
    for (const [key, value] of flat) {
      if (!winners.has(key)) winners.set(key, { value, layer })
    }
  }
  return winners
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

/**
 * Sets a React-controlled field.
 *
 * Assigning `.value` updates the DOM node and nothing else - React tracks the
 * previous value on the element and skips a change it did not see happen. The
 * prototype's setter plus a bubbling `input` event is the path a keystroke and
 * a paste both take. Used rather than typing because the editor's content is a
 * whole file, and a hundred lines at twelve milliseconds a character is a
 * minute per assertion.
 */
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

/** Opens the console, waiting for its list to paint. */
async function showConsole(win: BrowserWindow): Promise<boolean> {
  if (!(await click(win, '[data-tab="config"]'))) {
    await click(win, 'aside button[data-open-config]')
  }
  return pollJs(win, `document.querySelector('select[data-config-scope]')`, 15_000)
}

/**
 * Points the switcher at a scope, and refuses to continue if it did not move.
 *
 * A `<select>` assigned a value it has no option for keeps the one it had, and
 * every assertion after that would then be made against the wrong directory -
 * silently, and in the case of a save, destructively. This is the check that
 * caught exactly that during development.
 */
async function selectScope(win: BrowserWindow, path: string): Promise<void> {
  await setValue(win, 'select[data-config-scope]', path)
  await sleep(700)
  const landed = await js<string>(
    win,
    `document.querySelector('select[data-config-scope]')?.value ?? ''`
  )
  if (landed.toLowerCase() !== path.toLowerCase()) {
    throw new Error(
      `the scope switcher has no option for ${path} - it is showing ${landed || '(nothing)'}`
    )
  }
}

async function selectView(win: BrowserWindow, view: string): Promise<boolean> {
  const ok = await click(win, `button[data-config-view="${view}"]`)
  await sleep(500)
  return ok
}

/** What the file list is currently showing, read off the rendered rows. */
async function listedFiles(win: BrowserWindow): Promise<Array<{ relPath: string; kind: string }>> {
  return js<Array<{ relPath: string; kind: string }>>(
    win,
    `[...document.querySelectorAll('button[data-config-file]')].map((el) => ({
      relPath: el.dataset.configFile, kind: el.dataset.configKind }))`
  )
}

/**
 * Opens a file in the editor and edits it, through the surface.
 *
 * Returns what the pane reported rather than what the disk says - the caller
 * checks the disk itself, with its own read.
 */
async function editFile(
  win: BrowserWindow,
  relPath: string,
  content: string
): Promise<{ opened: boolean; saved: boolean; dirtyBeforeSave: boolean; status: string }> {
  const opened = await click(win, `button[data-config-file="${cssEscape(relPath)}"]`)
  if (!opened) return { opened: false, saved: false, dirtyBeforeSave: false, status: '' }
  await pollJs(win, `document.querySelector('textarea[data-config-editor]')`, 10_000)
  await sleep(300)

  await setValue(win, 'textarea[data-config-editor]', content)
  await sleep(250)
  const dirtyBeforeSave = await js<boolean>(
    win,
    `document.querySelector('[data-dirty]')?.dataset.dirty === 'true'`
  )
  const saved = await click(win, 'button[data-save-config]')
  await sleep(900)
  const status = await js<string>(
    win,
    `(document.querySelector('[data-dirty]')?.textContent ?? '').trim()`
  )
  return { opened, saved, dirtyBeforeSave, status }
}

/**
 * A relative path as a CSS attribute value.
 *
 * The paths here use forward slashes, which need no escaping - but a quote in a
 * file name would end the selector, and a file named by a user can contain one.
 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  root: string
  workspace: string
  alpha: string
  beta: string
  mcpServer: string
}

function writeSkill(repo: string, name: string, token: string): void {
  const dir = join(repo, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: Helm config probe skill. Reports the token ${token}.`,
      '---',
      '',
      `# ${token}`,
      '',
      `This skill exists to be read back. Its token is ${token}.`,
      ''
    ].join('\n')
  )
}

/**
 * A workspace and two overlay repos the driver owns.
 *
 * Against fixtures rather than the user's repositories, for the same reason
 * profiles-check's skill-edit check is: composing an overlay builds a shim whose
 * subdirectories are junctions into the source, and a check that plants probe
 * files in one of the user's own repositories - or that tears a shim down over it - is not
 * something a check gets to do with somebody's real work.
 *
 * Both overlays define `think`, which is what makes the same-named-skill
 * criterion checkable: the two bodies differ, so a session quoting both
 * headings has resolved two distinct skills rather than one twice.
 */
function buildFixtures(dataDir: string): Fixtures {
  const root = join(dataDir, 'config-fixtures')
  rmSync(root, { recursive: true, force: true })

  const workspace = join(root, 'workspace')
  const alpha = join(root, 'alpha')
  const beta = join(root, 'beta')

  writeSkill(alpha, 'think', TOKENS.alphaThink)
  writeSkill(alpha, 'alpha-only', TOKENS.alphaOnly)
  writeSkill(beta, 'think', TOKENS.betaThink)
  writeFileSync(join(alpha, 'CLAUDE.md'), '# Alpha instructions\n\nComposed by Helm.\n')
  writeFileSync(join(beta, 'CLAUDE.md'), '# Beta instructions\n\nComposed by Helm.\n')

  mkdirSync(join(workspace, '.claude'), { recursive: true })
  writeSkill(workspace, 'workspace-skill', 'HELMM5WORKSPACE')
  writeFileSync(join(workspace, 'CLAUDE.md'), '# Workspace instructions\n')
  mkdirSync(join(workspace, '.claude', 'commands'), { recursive: true })
  writeFileSync(join(workspace, '.claude', 'commands', 'probe.md'), '# probe command\n')
  mkdirSync(join(workspace, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(workspace, '.claude', 'agents', 'probe-agent.md'), '---\ndescription: A probe.\n---\n')

  // The layer pair the settings criterion turns on. `PROJECTONLY` is set only
  // by the lower of the two, so a session reporting both proves the merge is
  // per leaf rather than a whole-key replacement.
  writeFileSync(
    join(workspace, '.claude', 'settings.json'),
    `${JSON.stringify(
      { env: { HELM_M5_LAYER: 'PROJECTWINS', HELM_M5_PROJECTONLY: 'PROJECTONLY' } },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(workspace, '.claude', 'settings.local.json'),
    `${JSON.stringify({ env: { HELM_M5_LAYER: 'LOCALWINS' } }, null, 2)}\n`
  )

  // A dependency-free stdio MCP server, so criterion 4 does not depend on the
  // network or on a package that might not install.
  const mcpDir = join(root, 'mcp')
  mkdirSync(mcpDir, { recursive: true })
  const mcpServer = join(mcpDir, 'server.mjs')
  writeFileSync(
    mcpServer,
    `import { createInterface } from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method } = msg
  if (id === undefined) return
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: ${JSON.stringify(MCP_SERVER)}, version: '0.0.1' } } })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'helm_probe_token',
      description: 'Returns the Helm config probe token.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } })
  } else if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: ${JSON.stringify(TOKENS.mcp)} }], isError: false } })
  } else if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } })
  } else if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: [] } })
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
  }
})
`
  )

  return { root, workspace, alpha, beta, mcpServer }
}

/**
 * The token a skill body declares, read out of the file.
 *
 * Asked for by name rather than as "the first H1 heading", which is what this
 * started as and which is not a stable thing to compare against: a model
 * answering `S1=# HELMM5ALPHATHINK` has read the right file and quoted the
 * heading *including its hash*, and an equality check on the text calls that a
 * failure. The token is a bare word with one meaning.
 *
 * Read from disk rather than from the constant it was written with, so this is
 * still a claim about the file the session resolved.
 */
function skillToken(file: string): string {
  try {
    return /Its token is ([A-Z0-9]+)\./.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const GROUPS = ['browse', 'edit', 'snapshot', 'json', 'external', 'mcp', 'effective', 'doctor'] as const
type Group = (typeof GROUPS)[number]

export async function runConfigChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  dataDir: string,
  only?: readonly string[]
): Promise<Check[]> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const running = (group: Group): boolean => wanted.has(group)

  const checks: Check[] = []
  const { win, services } = ctx
  const fixtures = buildFixtures(dataDir)
  const userHome = claudeHome()

  /**
   * The user's real `~/.claude/settings.json`, copied before anything touches
   * it. The restore at the end goes through Helm's snapshot history - which is
   * the mechanism under test - and this is the backstop for the case where this
   * process does not reach the end.
   */
  const userSettings = join(userHome, 'settings.json')
  const userSettingsBefore = existsSync(userSettings) ? readFileSync(userSettings, 'utf8') : null
  const userSettingsHash = userSettingsBefore === null ? null : sha256(userSettingsBefore)
  const backup = join(dataDir, 'config-user-settings.backup.json')
  if (userSettingsBefore !== null) copyFileSync(userSettings, backup)

  /**
   * The profile goes in first, before anything is browsed.
   *
   * Not only because CFG-9 launches it: a profile's root and overlays are scopes
   * the switcher offers, and the fixture workspace is not inside any scanned
   * root. Creating the profile is what makes it reachable through the surface,
   * which is the same thing that would make a user's out-of-tree profile
   * reachable.
   */
  const stale = findProfileByName(services.store, PROFILE_NAME)
  if (stale) deleteProfile(services.store, stale.id)
  const profile: Profile = createProfile(services.store, {
    name: PROFILE_NAME,
    root: fixtures.workspace,
    overlays: [fixtures.alpha, fixtures.beta],
    access: [fixtures.alpha, fixtures.beta],
    model: MODEL,
    effort: null,
    permissionMode: null,
    agent: null,
    mcp: [],
    openingPrompt: null,
    pinnedOrder: null
  })

  const openedConsole = await showConsole(win)
  // The scope list is rebuilt from `profiles:changed`, which the store write
  // above does not emit - so the pane is asked to re-read it the way a rescan
  // would.
  await click(win, 'button[data-config-refresh]')
  await sleep(400)
  const scopeReachable = await pollJs(
    win,
    `[...document.querySelectorAll('select[data-config-scope] option')]
       .some((o) => o.value.toLowerCase() === ${JSON.stringify(fixtures.workspace.toLowerCase())})`,
    15_000
  )
  await sleep(400)

  checks.push({
    id: 'CFG-0',
    criterion: 'setup',
    title: 'The console opens and offers the fixture workspace as a scope',
    ok:
      openedConsole &&
      scopeReachable &&
      existsSync(join(fixtures.alpha, '.claude', 'skills', 'think', 'SKILL.md')) &&
      existsSync(join(fixtures.beta, '.claude', 'skills', 'think', 'SKILL.md')) &&
      existsSync(fixtures.mcpServer),
    detail: {
      fixtures: fixtures.root,
      profile: { id: profile.id, root: profile.root, overlays: profile.overlays },
      offeredInTheSwitcher: scopeReachable,
      userSettings,
      userSettingsBackedUpTo: userSettingsBefore === null ? null : backup,
      userSettingsHash
    },
    notes: [
      'The overlays are fixtures the driver owns rather than the user’s repos: composing one',
      'builds a shim of junctions into the source, and a check does not get to tear that down',
      'over somebody’s real work.',
      'The workspace is outside every scanned root, so it is only a scope because a profile',
      'points at it - which is the case a scan-only scope list would miss.'
    ]
  })

  /**
   * A group that throws becomes a failing check rather than an absent report.
   *
   * The runner treats "no report" as a failure, which is right - but it is also
   * the least useful failure there is, because the eight groups that would have
   * passed never ran. A thrown group is one group's problem.
   */
  const group = async (name: Group, run: () => Promise<Check[]>): Promise<void> => {
    if (!running(name)) return
    try {
      checks.push(...(await run()))
    } catch (err) {
      checks.push({
        id: `CFG-${name.toUpperCase()}-THREW`,
        criterion: name,
        title: `The ${name} group threw before it could assert anything`,
        ok: false,
        detail: { error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) },
        notes: ['The groups after this one still ran; this is one group’s failure, not the run’s.']
      })
    }
  }

  try {
    await group('browse', () => browseChecks(ctx, shotDir, fixtures, userHome))
    await group('edit', () => editChecks(ctx, shotDir, fixtures, userHome))
    await group('snapshot', async () => [await snapshotCheck(ctx, fixtures)])
    await group('json', async () => [await jsonCheck(ctx, shotDir, fixtures)])
    await group('external', async () => [await externalCheck(ctx, shotDir, fixtures)])
    await group('mcp', async () => [await mcpCheck(ctx, shotDir, fixtures)])
    await group('effective', () =>
      effectiveChecks(ctx, collector, shotDir, fixtures, userHome, profile, running('mcp'))
    )
    await group('doctor', async () => [await doctorCheck(ctx, shotDir)])
  } finally {
    // Whatever happened above, the user's settings go back. Through the plain
    // copy rather than the snapshot table, because this has to work even if the
    // failure was in the snapshot table.
    if (userSettingsBefore !== null && sha256File(userSettings) !== userSettingsHash) {
      writeFileSync(userSettings, userSettingsBefore)
    }
    const profile = findProfileByName(services.store, PROFILE_NAME)
    if (profile) deleteProfile(services.store, profile.id)
  }

  checks.push({
    id: 'CFG-Z',
    criterion: 'setup',
    title: 'The user’s settings.json is byte-identical to how the run found it',
    ok: sha256File(userSettings) === userSettingsHash,
    detail: {
      file: userSettings,
      hashBefore: userSettingsHash,
      hashAfter: sha256File(userSettings),
      backup
    },
    notes: [
      'This milestone is the one exception to "Helm only reads ~/.claude", so the driver',
      'proves it left the file it borrowed exactly as it found it.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// CFG-1: browsing every scope
// ---------------------------------------------------------------------------

async function browseChecks(
  ctx: CheckContext,
  shotDir: string,
  fixtures: Fixtures,
  userHome: string
): Promise<Check[]> {
  const { win, services } = ctx
  const checks: Check[] = []

  const harness = (services.lastScan?.projects ?? []).find((p) => p.kind === 'harness')
  const scopes: Array<{ kind: string; path: string; isUser: boolean }> = [
    { kind: 'user', path: userHome, isUser: true },
    ...(harness ? [{ kind: 'harness', path: harness.path, isUser: false }] : []),
    { kind: 'project', path: fixtures.workspace, isUser: false }
  ]

  const perScope: Array<Record<string, unknown>> = []
  let allAgree = scopes.length === 3

  for (const scope of scopes) {
    // The fixture workspace is not a scanned project, so it is reached through
    // the service rather than the switcher - which is exactly what the switcher
    // would do with it if the scan had found it.
    const tree = ctx.config.tree(scope.path)
    const truth = walkTree(scope.path, scope.isUser)

    const skills = tree.files.filter((f) => f.kind === 'skill')
    const commands = tree.files.filter((f) => f.kind === 'command')
    const agents = tree.files.filter((f) => f.kind === 'agent')
    const settings = tree.files.filter((f) => f.kind === 'settings' || f.kind === 'settings-local')

    const agrees =
      skills.length === truth.skills.length &&
      commands.length === truth.commands.length &&
      agents.length === truth.agents.length &&
      settings.length === truth.settings.length &&
      // Names, not just counts: a scanner that found the right number of files
      // and called them the wrong things would pass a count check.
      skills.map((f) => f.name).sort().join(',') === truth.skills.join(',')

    if (!agrees) allAgree = false
    perScope.push({
      scope: scope.kind,
      path: scope.path,
      pane: {
        skills: skills.length,
        commands: commands.length,
        agents: agents.length,
        settings: settings.map((f) => f.name)
      },
      independentWalk: {
        skills: truth.skills.length,
        commands: truth.commands.length,
        agents: truth.agents.length,
        settings: truth.settings
      },
      skillNames: skills.map((f) => f.name).sort(),
      agrees
    })
  }

  // And through the window, for the scope the switcher can actually reach.
  const harnessPath = harness?.path ?? userHome
  await selectScope(win, harnessPath)
  const painted = await listedFiles(win)
  const paintedTruth = ctx.config.tree(harnessPath)
  const shot = await screenshot(win, shotDir, 'config-files.png')

  checks.push({
    id: 'CFG-1',
    criterion: 'Can view any skill/command/agent/CLAUDE.md/settings.json across all three scopes',
    title: 'Each scope’s tree matches an independent walk of the same directory',
    ok:
      allAgree &&
      painted.length === paintedTruth.files.length &&
      painted.some((row) => row.kind === 'skill'),
    detail: {
      scopes: perScope,
      throughTheWindow: {
        scope: harnessPath,
        rows: painted.length,
        expected: paintedTruth.files.length,
        kinds: [...new Set(painted.map((row) => row.kind))].sort()
      },
      screenshot: shot.file
    },
    notes: [
      'The second read is a plain readdirSync walk in configcheck.ts, sharing no code with the',
      'tree scanner: skills are directories holding a SKILL.md, commands and agents are .md',
      'at any depth. Names are compared as well as counts.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// CFG-2: editing, in all three scopes
// ---------------------------------------------------------------------------

interface EditOutcome {
  scope: string
  relPath: string
  opened: boolean
  saved: boolean
  dirtyBeforeSave: boolean
  status: string
  onDiskAfter: string | null
  expected: string
  restored: boolean
  restoredHashMatches: boolean
}

async function editChecks(
  ctx: CheckContext,
  shotDir: string,
  fixtures: Fixtures,
  userHome: string
): Promise<Check[]> {
  const { win, services } = ctx
  const harness = (services.lastScan?.projects ?? []).find((p) => p.kind === 'harness')
  const outcomes: EditOutcome[] = []

  /**
   * Edits one file through the pane, checks the disk with its own read, then
   * puts it back from the snapshot history and checks the disk again.
   *
   * The restore is not a courtesy to the user's files - it is the criterion-3
   * assertion, made against every edit rather than against one contrived one.
   */
  const roundTrip = async (
    scopePath: string,
    scopeName: string,
    relPath: string,
    transform: (before: string) => string
  ): Promise<EditOutcome> => {
    const absolute = join(scopePath, relPath)
    const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : ''
    const beforeHash = sha256(before)
    const next = transform(before)

    await selectScope(win, scopePath)
    const edit = await editFile(win, relPath, next)
    const onDiskAfter = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null

    // Back to how it was, through the version list in the pane's own footer.
    const versions = ctx.config.snapshots(scopePath, absolute)
    const newest = versions[0]
    let restoredHashMatches = false
    let restored = false
    if (newest) {
      const result = ctx.config.restore(newest.id, absolute)
      restored = result.ok
      restoredHashMatches = sha256File(absolute) === beforeHash
    }

    return {
      scope: scopeName,
      relPath,
      opened: edit.opened,
      saved: edit.saved,
      dirtyBeforeSave: edit.dirtyBeforeSave,
      status: edit.status,
      onDiskAfter: onDiskAfter === null ? null : onDiskAfter.slice(0, 160),
      expected: next.slice(0, 160),
      restored,
      restoredHashMatches
    }
  }

  // ---- user scope: CLAUDE.md, which every session on the machine reads ----
  if (existsSync(join(userHome, 'CLAUDE.md'))) {
    outcomes.push(
      await roundTrip(userHome, 'user', 'CLAUDE.md', (before) => `${before}\n<!-- helm config probe -->\n`)
    )
  }

  // ---- user scope: settings.json, a JSON editor rather than a markdown one --
  outcomes.push(
    await roundTrip(userHome, 'user', 'settings.json', (before) => {
      const document: Record<string, unknown> = before.trim() === '' ? {} : JSON.parse(before)
      const env = { ...((document['env'] as Record<string, unknown>) ?? {}) }
      // Read back out of a live session further down, which is what makes the
      // user layer a *measured* part of the precedence chain rather than an
      // assumed one.
      env['HELM_M5_USERLAYER'] = 'USERLAYER'
      env['HELM_M5_LAYER'] = 'USERWINS'
      return `${JSON.stringify({ ...document, env }, null, 2)}\n`
    })
  )

  // ---- harness scope: a real skill ----
  if (harness) {
    const tree = ctx.config.tree(harness.path)
    const skill = tree.files.find((file) => file.kind === 'skill')
    if (skill) {
      outcomes.push(
        await roundTrip(harness.path, 'harness', skill.relPath, (before) =>
          before.replace(/\n?$/, '\n\n<!-- helm config probe -->\n')
        )
      )
    }
  }

  // ---- project scope: an agent and a settings file in the fixture ----
  outcomes.push(
    await roundTrip(fixtures.workspace, 'project', '.claude/agents/probe-agent.md', (before) =>
      `${before}\nEdited by the config-console driver.\n`
    )
  )
  outcomes.push(
    await roundTrip(fixtures.workspace, 'project', '.claude/settings.json', (before) => {
      const document: Record<string, unknown> = JSON.parse(before)
      return `${JSON.stringify({ ...document, model: 'haiku' }, null, 2)}\n`
    })
  )

  const shot = await screenshot(win, shotDir, 'config-editor.png')
  const kinds = new Set(outcomes.map((outcome) => outcome.scope))

  return [
    {
      id: 'CFG-2',
      criterion:
        'Can view and edit any skill/command/agent/CLAUDE.md/settings.json across all three scopes without leaving the app',
      title: 'A file in each of the three scopes was edited through the pane and landed on disk',
      ok:
        kinds.size === 3 &&
        outcomes.length >= 4 &&
        outcomes.every(
          (outcome) =>
            outcome.opened &&
            outcome.saved &&
            outcome.dirtyBeforeSave &&
            outcome.onDiskAfter !== null &&
            outcome.expected.startsWith(outcome.onDiskAfter.slice(0, 120))
        ),
      detail: { scopesCovered: [...kinds], edits: outcomes, screenshot: shot.file },
      notes: [
        'Every edit is read back with this file’s own readFileSync, not with the pane’s.',
        'The user scope’s files are the user’s real ones; each edit is undone from the',
        'snapshot history immediately, and CFG-3 asserts the bytes came back exactly.'
      ]
    },
    {
      id: 'CFG-3',
      criterion: 'Every write has a snapshot; restore brings back the exact prior bytes (hash-verified)',
      title: 'Every edit above restored to a file whose sha256 matches the pre-edit bytes',
      ok: outcomes.length > 0 && outcomes.every((outcome) => outcome.restored && outcome.restoredHashMatches),
      detail: {
        restores: outcomes.map((outcome) => ({
          scope: outcome.scope,
          file: outcome.relPath,
          restored: outcome.restored,
          hashMatchesPreEditBytes: outcome.restoredHashMatches
        }))
      },
      notes: [
        'The hash is computed in configcheck.ts over the bytes read before the edit and again',
        'after the restore. The snapshot table’s own recorded hash is not consulted - it is',
        'the thing being checked.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// CFG-4: no write without a snapshot
// ---------------------------------------------------------------------------

async function snapshotCheck(ctx: CheckContext, fixtures: Fixtures): Promise<Check> {
  const path = join(fixtures.workspace, '.claude', 'settings.local.json')
  const before = readFileSync(path, 'utf8')
  const beforeHash = sha256(before)
  const snapshotsBefore = countConfigSnapshots(ctx.services.store)
  // Genuinely different bytes, so this is a write rather than a no-op - the
  // no-op is the second half of the check and has to be distinguishable from
  // it. Still valid JSON, because a settings file that is not is a different
  // failure.
  const document = JSON.parse(before) as Record<string, unknown>
  const changed = `${JSON.stringify({ ...document, cleanupPeriodDays: 30 }, null, 2)}\n`

  const first = ctx.config.write({
    scopePath: fixtures.workspace,
    path,
    content: changed,
    expectedHash: sha256File(path) ?? '',
    reason: 'edit'
  })

  // The same bytes again. Nothing is written, so nothing is snapshotted - which
  // is the one case where "every write has a snapshot" is satisfied by there
  // being no write.
  const repeat = ctx.config.write({
    scopePath: fixtures.workspace,
    path,
    content: changed,
    expectedHash: sha256File(path) ?? '',
    reason: 'edit'
  })

  const afterWrites = countConfigSnapshots(ctx.services.store)
  // This file's own history, not the newest row in the database: the snapshot
  // table holds every file the run has touched, and restoring another scope's
  // version into this path is exactly what `assertWritable` exists to refuse.
  const rows = ctx.config.snapshots(fixtures.workspace, path)
  const newest = rows[0]

  // The restore is against the *recorded* content, verified byte for byte here.
  const restored = newest ? ctx.config.restore(newest.id, path) : null
  const backToStart = sha256File(path) === beforeHash

  return {
    id: 'CFG-4',
    criterion: 'Every write has a snapshot; never write without a snapshot',
    title: 'A changed write takes exactly one snapshot, an unchanged one takes none, and neither loses bytes',
    ok:
      first.ok &&
      first.snapshotId !== null &&
      repeat.ok &&
      repeat.unchanged &&
      repeat.snapshotId === null &&
      afterWrites === snapshotsBefore + 1 &&
      newest?.contentHash === beforeHash &&
      restored?.ok === true &&
      backToStart,
    detail: {
      file: path,
      snapshotsBefore,
      snapshotsAfter: afterWrites,
      firstWrite: { ok: first.ok, snapshotId: first.snapshotId, unchanged: first.unchanged },
      repeatWrite: { ok: repeat.ok, snapshotId: repeat.snapshotId, unchanged: repeat.unchanged },
      recordedHash: newest?.contentHash ?? null,
      independentPreWriteHash: beforeHash,
      bytesBackAfterRestore: backToStart
    },
    notes: [
      'The snapshot row goes in before the file is touched, and a failure to write it aborts',
      'the write - so the invariant holds even when the disk write then fails.'
    ]
  }
}

// ---------------------------------------------------------------------------
// CFG-5: malformed JSON never reaches the disk
// ---------------------------------------------------------------------------

async function jsonCheck(ctx: CheckContext, shotDir: string, fixtures: Fixtures): Promise<Check> {
  const { win } = ctx
  const relPath = '.claude/settings.json'
  const path = join(fixtures.workspace, relPath)
  const before = readFileSync(path, 'utf8')
  const beforeHash = sha256(before)
  const snapshotsBefore = countConfigSnapshots(ctx.services.store)

  await selectScope(win, fixtures.workspace)
  await click(win, `button[data-config-file="${cssEscape(relPath)}"]`)
  await pollJs(win, `document.querySelector('textarea[data-config-editor]')`, 10_000)
  await sleep(300)

  // A trailing comma on line 3 - the mistake a hand-edited settings file
  // actually gets, and the one V8's own message locates worst.
  const broken = '{\n  "env": {\n    "A": "b",\n  }\n}\n'
  await setValue(win, 'textarea[data-config-editor]', broken)
  await sleep(400)

  const state = await js<{
    saveDisabled: boolean
    error: string
    hasErrorStrip: boolean
  }>(
    win,
    `(() => {
      const save = document.querySelector('button[data-save-config]');
      const strip = document.querySelector('button[data-json-error]');
      return {
        saveDisabled: Boolean(save && save.disabled),
        error: (strip?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        hasErrorStrip: Boolean(strip)
      } })()`
  )

  // Clicked anyway. A disabled button ignores it, which is the point.
  await click(win, 'button[data-save-config]')
  await sleep(600)

  const shot = await screenshot(win, shotDir, 'config-json-error.png')
  const afterHash = sha256File(path)
  const snapshotsAfter = countConfigSnapshots(ctx.services.store)

  // The error has to name a place, and the place has to be the right one: the
  // trailing comma is on line 3, and a validator that reported the end of the
  // file would also "locate" it.
  const located = /(^|\s)3:\d+/.test(state.error)

  return {
    id: 'CFG-5',
    criterion: 'Malformed JSON is rejected client-side before write, with the error located',
    title: 'A trailing comma disables the save, is reported at line 3, and reaches neither the disk nor the snapshot table',
    ok:
      state.saveDisabled &&
      state.hasErrorStrip &&
      located &&
      afterHash === beforeHash &&
      snapshotsAfter === snapshotsBefore,
    detail: {
      file: path,
      typed: broken,
      saveDisabled: state.saveDisabled,
      reported: state.error,
      reportedLine3: located,
      fileUnchanged: afterHash === beforeHash,
      snapshotsBefore,
      snapshotsAfter,
      screenshot: shot.file
    },
    notes: [
      'The position is scanned for rather than read out of V8’s exception: on Node 24 a',
      'trailing comma reports `Unexpected token \',\' ... is not valid JSON` with no offset at',
      'all, and a validator that fell back to the end of the file would mark the wrong line.',
      'Rejected in the renderer, so nothing is sent - the main process is never asked.'
    ]
  }
}

// ---------------------------------------------------------------------------
// CFG-6: an edit made outside the app
// ---------------------------------------------------------------------------

async function externalCheck(ctx: CheckContext, shotDir: string, fixtures: Fixtures): Promise<Check> {
  const { win } = ctx
  const relPath = '.claude/agents/probe-agent.md'
  const path = join(fixtures.workspace, relPath)

  await selectScope(win, fixtures.workspace)
  await click(win, `button[data-config-file="${cssEscape(relPath)}"]`)
  await pollJs(win, `document.querySelector('textarea[data-config-editor]')`, 10_000)
  await sleep(400)

  const openedWith = readFileSync(path, 'utf8')
  const staleHash = sha256(openedWith)

  // The user starts typing.
  await setValue(win, 'textarea[data-config-editor]', `${openedWith}\nTyped in Helm.\n`)
  await sleep(200)

  // Something else writes the file. Not through Helm - this is the driver's own
  // `writeFileSync`, which is what another editor would do.
  const outside = `${openedWith}\nWritten by another editor.\n`
  writeFileSync(path, outside)

  const warned = await pollJs(win, `document.querySelector('[data-external-change]')`, 15_000)
  await sleep(400)

  const state = await js<{ warning: string; saveDisabled: boolean; hasReload: boolean }>(
    win,
    `(() => {
      const banner = document.querySelector('[data-external-change]');
      const save = document.querySelector('button[data-save-config]');
      return {
        warning: (banner?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        saveDisabled: Boolean(save && save.disabled),
        hasReload: Boolean(document.querySelector('button[data-reload-external]'))
      } })()`
  )

  const shot = await screenshot(win, shotDir, 'config-external-change.png')
  const stillOutside = readFileSync(path, 'utf8') === outside

  // And the guarantee under the warning: the write path refuses on the hash
  // whether or not the watcher ever fired.
  const refused = ctx.config.write({
    scopePath: fixtures.workspace,
    path,
    content: 'clobbered',
    expectedHash: staleHash,
    reason: 'edit'
  })

  return {
    id: 'CFG-6',
    criterion: 'External edits are detected and the open editor warns before clobbering',
    title: 'A file changed underneath the editor warns, blocks the save, and the write path refuses it anyway',
    ok:
      warned &&
      state.saveDisabled &&
      state.hasReload &&
      /changed on disk/i.test(state.warning) &&
      stillOutside &&
      !refused.ok &&
      refused.conflict?.onDiskContent === outside &&
      readFileSync(path, 'utf8') === outside,
    detail: {
      file: path,
      warningShown: warned,
      warning: state.warning.slice(0, 220),
      saveDisabledWhileUnresolved: state.saveDisabled,
      offersReload: state.hasReload,
      fileStillTheExternalVersion: stillOutside,
      mainProcessRefusal: {
        ok: refused.ok,
        conflicted: refused.conflict !== undefined,
        onDiskMatchesTheExternalWrite: refused.conflict?.onDiskContent === outside
      },
      screenshot: shot.file
    },
    notes: [
      'Two mechanisms, and only one of them is allowed to fail. The fs.watch is a courtesy:',
      'it warns while the user is still typing. The hash check inside writeConfigFile is the',
      'guarantee - it runs on every write, on a filesystem where the watch is silent, and',
      'after a change made while Helm was not running. Both are asserted here.'
    ]
  }
}

// ---------------------------------------------------------------------------
// CFG-7: adding an MCP server through the UI
// ---------------------------------------------------------------------------

async function mcpCheck(ctx: CheckContext, shotDir: string, fixtures: Fixtures): Promise<Check> {
  const { win } = ctx
  const mcpFile = join(fixtures.workspace, '.mcp.json')
  const settingsLocal = join(fixtures.workspace, '.claude', 'settings.local.json')
  rmSync(mcpFile, { force: true })

  await selectScope(win, fixtures.workspace)
  await selectView(win, 'mcp')
  await sleep(500)

  await click(win, 'button[data-mcp-add-open]')
  await sleep(300)
  await setValue(win, 'input[data-mcp-name]', MCP_SERVER)
  await setValue(win, 'select[data-mcp-scope-select]', 'project')
  await setValue(
    win,
    'textarea[data-mcp-json]',
    JSON.stringify({ type: 'stdio', command: 'node', args: [fixtures.mcpServer] })
  )
  await sleep(400)

  const previewed = await click(win, 'button[data-mcp-preview]')
  const diffShown = await pollJs(win, `document.querySelector('[data-mcp-diff]')`, 10_000)
  await sleep(300)

  const diff = await js<string>(
    win,
    `(document.querySelector('[data-mcp-diff] pre')?.textContent ?? '').trim()`
  )
  const diffShot = await screenshot(win, shotDir, 'config-mcp-diff.png')

  // The file must not exist yet: the diff is shown *before* anything is run.
  const fileBeforeApply = existsSync(mcpFile)

  const applied = await click(win, 'button[data-mcp-apply]')
  const written = await waitFor(() => existsSync(mcpFile), 90_000)
  await sleep(1500)

  const onDisk = ((): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(mcpFile, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  })()
  const servers = (onDisk?.['mcpServers'] ?? {}) as Record<string, unknown>
  const entry = servers[MCP_SERVER] as { command?: string; args?: string[] } | undefined

  // A `.mcp.json` server gates on first launch until a settings layer approves
  // it, so the console offers the approval - and it is a snapshotted write like
  // any other, not a special case.
  await sleep(600)
  const approveClicked = await click(win, `button[data-mcp-approve="${MCP_SERVER}"]`)
  await waitFor(() => {
    try {
      const parsed = JSON.parse(readFileSync(settingsLocal, 'utf8')) as Record<string, unknown>
      const list = parsed['enabledMcpjsonServers']
      return Array.isArray(list) && list.includes(MCP_SERVER)
    } catch {
      return false
    }
  }, 20_000)
  await sleep(600)

  const approved = ((): boolean => {
    try {
      const parsed = JSON.parse(readFileSync(settingsLocal, 'utf8')) as Record<string, unknown>
      const list = parsed['enabledMcpjsonServers']
      return Array.isArray(list) && list.includes(MCP_SERVER)
    } catch {
      return false
    }
  })()

  const shot = await screenshot(win, shotDir, 'config-mcp.png')
  const approvalSnapshots = ctx.config.snapshots(fixtures.workspace, settingsLocal)

  return {
    id: 'CFG-7',
    criterion: 'MCP servers: add via `claude mcp add-json` subprocess; show .mcp.json diff before applying',
    title: 'The diff is shown before the CLI runs, and the CLI writes the server into .mcp.json',
    ok:
      previewed &&
      diffShown &&
      !fileBeforeApply &&
      diff.includes(MCP_SERVER) &&
      applied &&
      written &&
      entry?.command === 'node' &&
      entry.args?.[0] === fixtures.mcpServer &&
      approveClicked &&
      approved &&
      approvalSnapshots.length > 0,
    detail: {
      file: mcpFile,
      fileExistedWhenTheDiffWasShown: fileBeforeApply,
      diff: diff.slice(0, 600),
      writtenByTheCli: written,
      onDisk: entry ?? null,
      approvedInSettingsLocal: approved,
      approvalSnapshotTaken: approvalSnapshots.length > 0,
      screenshots: [diffShot.file, shot.file]
    },
    notes: [
      'Helm never edits this file itself: the diff is a prediction, and `claude mcp add-json`',
      'is what actually writes. The file is snapshotted before the subprocess runs, because a',
      'write Helm delegates is still a write Helm caused.',
      'Whether the server actually *works* is CFG-9, which asks a real session to call its tool.'
    ]
  }
}

// ---------------------------------------------------------------------------
// CFG-8 / CFG-9: the effective view, against a computation and against a session
// ---------------------------------------------------------------------------

async function effectiveChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  fixtures: Fixtures,
  userHome: string,
  profile: Profile,
  mcpConfigured: boolean
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []
  const overlays = [fixtures.alpha, fixtures.beta]

  /**
   * The top of the settings chain, put in place before anything is predicted.
   *
   * The three layers have to be live *at launch* for a session to be able to
   * report which one won - a value written and restored beforehand is a layer
   * the session never saw. So the user layer is set here, through the console's
   * own snapshotted write path, and taken back out at the end of this group
   * from the snapshot that write produced.
   *
   * This is the user's real `~/.claude/settings.json`. It is the only way to
   * measure the user layer rather than assume it: `CLAUDE_CONFIG_DIR` moves the
   * whole config directory, credentials included, so a session pointed at a
   * fixture home cannot start.
   */
  const userSettings = join(userHome, 'settings.json')
  const userBefore = readConfigFileContent(userSettings)
  const userBeforeHash = sha256File(userSettings)
  const userDocument =
    userBefore.exists && userBefore.content.trim() !== ''
      ? (JSON.parse(userBefore.content) as Record<string, unknown>)
      : {}
  const userWrite = ctx.config.write({
    scopePath: userHome,
    path: userSettings,
    content: `${JSON.stringify(
      {
        ...userDocument,
        env: {
          ...((userDocument['env'] as Record<string, unknown>) ?? {}),
          HELM_M5_LAYER: 'USERWINS',
          HELM_M5_USERLAYER: 'USERLAYER'
        }
      },
      null,
      2
    )}\n`,
    expectedHash: userBefore.exists ? userBefore.hash : null,
    reason: 'edit'
  })

  const view = ctx.config.effective({ profileId: profile.id })

  // ---- against an independent computation --------------------------------
  const predicted = predictSkillNames(fixtures.workspace, overlays, userHome)
  const fromView = view.skills.map((skill) => skill.invocation).sort()

  const settings = settingsTruth(fixtures.workspace, userHome)
  const viewSettings = new Map(view.settings.map((setting) => [setting.key, setting]))
  const settingsDisagreements = [...settings.entries()]
    .filter(([key, expected]) => {
      const actual = viewSettings.get(key)
      return actual === undefined || actual.value !== expected.value || actual.winner !== expected.layer
    })
    .map(([key]) => key)

  await selectView(win, 'effective')
  await setValue(win, 'select[data-effective-profile]', String(profile.id))
  await sleep(1200)
  const painted = await js<{ invocations: string[]; shared: string[] }>(
    win,
    `(() => ({
      invocations: [...document.querySelectorAll('[data-invocation]')].map((el) => el.dataset.invocation),
      shared: [...document.querySelectorAll('[data-shared-name]')].map((el) => el.dataset.sharedName)
    }))()`
  )
  const viewShot = await screenshot(win, shotDir, 'config-effective.png')

  const sharedThink = view.sharedNames.find((entry) => entry.name === 'think')

  checks.push({
    id: 'CFG-8',
    criterion: 'Effective view: which skills resolve and under which overlay namespace',
    title: 'Every predicted name matches a hand-built `<overlay>:<skill>` list, and the pane paints them',
    ok:
      fromView.join(',') === predicted.join(',') &&
      sharedThink?.invocations.join(',') === 'alpha:think,beta:think' &&
      settingsDisagreements.length === 0 &&
      painted.invocations.length === view.skills.length &&
      painted.shared.includes('think'),
    detail: {
      cwd: view.cwd,
      overlays: view.overlays,
      view: fromView,
      independentPrediction: predicted,
      sameNamedSkill: sharedThink ?? null,
      settingsKeysChecked: settings.size,
      settingsDisagreements,
      paintedInTheWindow: painted.invocations.length,
      screenshot: viewShot.file
    },
    notes: [
      'The second list is built in configcheck.ts from `basename(overlay).toLowerCase()` and the',
      'skill directory names - it does not call overlayPluginNames, which is the function the',
      'view uses, so the two can disagree.',
      'Settings are compared per leaf against an independent flatten-and-pick over the three',
      'files, winner included.'
    ]
  })

  // ---- against a live session --------------------------------------------
  const before = ctx.sessions.list().length
  const launched = ctx.sessions.launchProfile({ profileId: profile.id, cols: 100, rows: 30 })
  await waitFor(() => ctx.sessions.list().length > before, 30_000)
  const id = launched.session.id

  const ready = await waitForPrompt(ctx, collector, id, 180_000)

  const tokens = {
    alphaThink: skillToken(join(fixtures.alpha, '.claude', 'skills', 'think', 'SKILL.md')),
    betaThink: skillToken(join(fixtures.beta, '.claude', 'skills', 'think', 'SKILL.md')),
    alphaOnly: skillToken(join(fixtures.alpha, '.claude', 'skills', 'alpha-only', 'SKILL.md'))
  }
  /**
   * The tokens have to exist and differ for the answer to be evidence.
   *
   * This is the PROF-4 lesson, applied here on purpose: a reader that returns
   * `''` for a missing fixture turns the expected token into a substring of
   * every answer, and the check reports green having proved nothing.
   */
  const values = Object.values(tokens)
  const tokensUsable = values.every((token) => token !== '') && new Set(values).size === 3

  // Three skills, one of them the same-named pair under both predicted
  // namespaces. The two `think` bodies carry different tokens, so an answer
  // with both is proof of two distinct skills rather than one resolving twice.
  const skills =
    ready && tokensUsable
      ? await ask(
          ctx,
          collector,
          id,
          `Invoke the skill named alpha:think, then beta:think, then alpha:alpha-only. ` +
            `Each skill body states a token. Then reply with exactly three lines: ` +
            `S1=<the first skill's token>, S2=<the second skill's token>, S3=<the third skill's token>.`,
          [`S1=${tokens.alphaThink}`, `S2=${tokens.betaThink}`, `S3=${tokens.alphaOnly}`]
        )
      : {
          ok: false,
          answer: ready
            ? 'the fixture skills carry no distinct tokens, so no answer would be evidence'
            : 'the session never reached a prompt'
        }

  // The settings override, observed rather than assumed. `env` is the one
  // setting whose winner a session can be asked about directly.
  const settingsProbe = ready
    ? await ask(
        ctx,
        collector,
        id,
        'Use the Bash tool to run: echo "$HELM_M5_LAYER|$HELM_M5_PROJECTONLY|$HELM_M5_USERLAYER" ' +
          'and then reply with exactly ENV=<the line it printed>.',
        ['ENV=LOCALWINS|PROJECTONLY|USERLAYER']
      )
    : { ok: false, answer: 'the session never reached a prompt' }

  const mcpProbe =
    ready && mcpConfigured
      ? await ask(
          ctx,
          collector,
          id,
          'Call the MCP tool helm_probe_token (it takes no arguments) and reply with exactly ' +
            'MCP=<the text it returned>.',
          [`MCP=${TOKENS.mcp}`]
        )
      : { ok: false, answer: mcpConfigured ? 'the session never reached a prompt' : 'the mcp group was not run' }

  const sessionShot = await screenshot(win, shotDir, 'config-session.png')

  const predictedLayer = viewSettings.get('env.HELM_M5_LAYER')

  checks.push({
    id: 'CFG-9',
    criterion:
      'Effective view for a real profile matches observed in-session behavior (>=3 skills, 1 same-named skill in two overlays, 1 setting override)',
    title: 'A live session resolved all three predicted skills and reported the predicted settings winner',
    ok: ready && tokensUsable && skills.ok && settingsProbe.ok,
    detail: {
      session: { id, cwd: launched.session.cwd, argv: launched.session.argv },
      overlaysComposed: launched.overlays,
      reachedPrompt: ready,
      skills: {
        asked: ['alpha:think', 'beta:think', 'alpha:alpha-only'],
        expected: { S1: tokens.alphaThink, S2: tokens.betaThink, S3: tokens.alphaOnly },
        tokensUsableAsEvidence: tokensUsable,
        matched: skills.ok,
        answer: skills.answer
      },
      settingOverride: {
        key: 'env.HELM_M5_LAYER',
        predictedWinner: predictedLayer?.winner ?? null,
        predictedValue: predictedLayer?.value ?? null,
        alsoDefinedBy: predictedLayer?.candidates.map((c) => `${c.layer}=${c.value}`) ?? [],
        userLayerWrittenByTheConsole: {
          ok: userWrite.ok,
          snapshotId: userWrite.snapshotId,
          file: userSettings
        },
        observed: settingsProbe.answer,
        matched: settingsProbe.ok
      },
      screenshot: sessionShot.file
    },
    notes: [
      'The two `think` bodies carry different tokens, so a session reporting both has resolved',
      'two distinct skills under two predicted namespaces - not one skill twice. The tokens are',
      'read out of the fixture files and asserted distinct first, because an expected value of',
      '`` is a substring of every answer (see PROF-4, which passed for weeks on exactly that).',
      '`env` is the setting a session can be asked about: the three layers set',
      'HELM_M5_LAYER to USERWINS / PROJECTWINS / LOCALWINS and the session reports which one',
      'arrived. HELM_M5_PROJECTONLY is set only by the project layer, so its presence shows',
      'the merge is per leaf rather than a whole-key replacement - which is why the effective',
      'view is keyed by leaf path.'
    ]
  })

  if (mcpConfigured) {
    checks.push({
      id: 'CFG-10',
      criterion: 'Adding an MCP server through the UI results in a working server in the next launched session',
      title: 'The session launched after the UI added the server called its tool and got the token back',
      ok: ready && mcpProbe.ok,
      detail: {
        server: MCP_SERVER,
        addedBy: 'the config console, via `claude mcp add-json --scope project`',
        approvedBy: 'the config console, via enabledMcpjsonServers in settings.local.json',
        expected: `MCP=${TOKENS.mcp}`,
        answer: mcpProbe.answer,
        transport: 'stdio, a dependency-free node script written by this driver'
      },
      notes: [
        'The server is a fixture rather than a real one on purpose: the criterion is about',
        'Helm’s plumbing, and a check that depended on the network would fail for reasons that',
        'are not Helm’s.',
        'The session is launched *after* both UI actions, which is what "the next launched',
        'session" means.'
      ]
    })
  }

  await ctx.sessions.close({ id, force: true })
  await sleep(2000)

  // The user's file goes back, through the snapshot the write above produced -
  // which is the restore path the console offers, exercised against the one
  // file on the machine where getting it wrong would matter most.
  const undo = userWrite.snapshotId === null ? null : ctx.config.restore(userWrite.snapshotId, userSettings)
  checks.push({
    id: 'CFG-9B',
    criterion: 'Every write has a snapshot; restore brings back the exact prior bytes (hash-verified)',
    title: 'The user’s settings.json, borrowed for the probe above, came back byte-identical',
    ok: userWrite.ok && undo?.ok === true && sha256File(userSettings) === userBeforeHash,
    detail: {
      file: userSettings,
      written: { ok: userWrite.ok, snapshotId: userWrite.snapshotId },
      restored: undo?.ok ?? false,
      hashBefore: userBeforeHash,
      hashAfter: sha256File(userSettings)
    },
    notes: [
      'Not a contrived file: this is `~/.claude/settings.json`, which every session on the',
      'machine reads. The hashes are computed in configcheck.ts, not read off the snapshot row.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// CFG-11: claude doctor
// ---------------------------------------------------------------------------

async function doctorCheck(ctx: CheckContext, shotDir: string): Promise<Check> {
  const { win } = ctx
  await showConsole(win)
  await selectView(win, 'health')
  await sleep(400)

  const clicked = await click(win, 'button[data-run-doctor]')
  const painted = await pollJs(win, `document.querySelector('[data-doctor-output]')`, 180_000)
  await sleep(600)

  const shown = await js<{ output: string; rows: number; exit: string }>(
    win,
    `(() => ({
      output: (document.querySelector('[data-doctor-output]')?.textContent ?? '').trim(),
      rows: document.querySelectorAll('[data-doctor-rows] > div').length,
      exit: (document.querySelector('[data-doctor-exit]')?.textContent ?? '').trim()
    }))()`
  )
  const shot = await screenshot(win, shotDir, 'config-health.png')

  // Independently: the same CLI, run again from here. The two runs are seconds
  // apart, so the version and the platform lines have to agree even though the
  // timing lines will not.
  const { resolveClaudeCommand } = await import('./claude-cli')
  const command = resolveClaudeCommand()
  let secondRun = ''
  if (command) {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    try {
      const result = await promisify(execFile)(command.file, [...command.prefixArgs, 'doctor'], {
        timeout: 120_000,
        windowsHide: true
      })
      secondRun = `${result.stdout}${result.stderr}`.trim()
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string }
      secondRun = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim()
    }
  }

  const versionLine = /Running:\s*(.+)/.exec(secondRun)?.[1]?.trim() ?? ''

  return {
    id: 'CFG-11',
    criterion: '`claude doctor` output surfaced as a health panel',
    title: 'The panel shows the CLI’s own output, and it agrees with a second run from this file',
    ok:
      clicked &&
      painted &&
      shown.output.length > 20 &&
      shown.rows >= 3 &&
      versionLine !== '' &&
      shown.output.includes(versionLine),
    detail: {
      clicked,
      rowsParsed: shown.rows,
      exit: shown.exit,
      panelOutput: shown.output.slice(0, 400),
      secondRunFromTheDriver: secondRun.slice(0, 400),
      agreedOn: versionLine,
      screenshot: shot.file
    },
    notes: [
      'Shown, not interpreted: the CLI is the authority on whether its own installation is',
      'healthy, and a shell that paraphrased that into a green tick would be inventing a',
      'judgement it did not make. The rows are a layout of its lines, and the raw text is kept',
      'below them for the ones the parse did not recognise.'
    ]
  }
}
