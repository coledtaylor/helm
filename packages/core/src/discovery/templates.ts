import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { constants as copyFileConstants, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Harness templates: a user-authored directory tree that becomes a new harness.
 *
 * The whole of the mechanism is "copy a directory, fill in three placeholders".
 * That is deliberate and it is the second design - the first carried a creation
 * manifest, per-file hashes and an update-from-template pass, and all of it is
 * gone. A template makes a harness; from that moment the harness belongs to the
 * user and their agents, to change as they please. Helm records no history and
 * re-applies nothing. Anyone who wants that has git.
 *
 * Four rules shape the format, and each one is here because the obvious
 * alternative is wrong:
 *
 * - **Substitution is `.tpl`-only.** A whole-file `replaceAll` over every file
 *   corrupts any template that legitimately contains `{{...}}` - a GitHub
 *   Actions workflow, a Jinja or Handlebars fixture, a Go template - and it
 *   corrupts it silently, in a file the author never thought of as a template.
 *   So the extension is the opt-in: `x.yml.tpl` is substituted and written as
 *   `x.yml`, and `x.yml` is copied byte for byte.
 * - **`dot-claude/` is an alias for `.claude/`.** A literal dot directory works
 *   and is preferred; the alias exists because a template is a thing people
 *   keep in a repository, and several tools - npm packaging among them - drop
 *   or rename dot directories on the way in and out.
 * - **An empty directory is declared with `.gitkeep`.** The writer creates
 *   directories only as parents of the files it writes, so an empty one would
 *   otherwise never arrive. The marker file itself is *not* written: it exists
 *   to survive git, and copying it into somebody's new harness would be
 *   copying our mechanism into their workspace.
 * - **Entries that leave the harness are refused.** Absolute targets, anything
 *   that climbs out with `..`, and junctions or symlinks. A template is a file
 *   that can travel - mailed, cloned, unzipped - which is the same threat model
 *   the `repos:` key already refuses these three for.
 *
 * Nothing here imports Electron and nothing here knows where the templates
 * directory is: the host passes it in. `desktop/src/main/paths.ts` resolves it
 * on the `PORTABLE_EXECUTABLE_DIR` branch, which is the same one `dataDir`
 * uses, so a portable install keeps its templates on the stick and every check
 * gets a directory of its own without a second mechanism being invented.
 */

/**
 * The five names the format is made of.
 *
 * Exported because `template-authoring.ts` writes what this file reads, and a
 * second copy of `'template.yaml'` over there is how an authoring surface ends
 * up producing a template the engine will not open.
 */

/** The metadata file at the root of a template directory. */
export const TEMPLATE_MANIFEST = 'template.yaml'

/** The manifest Helm writes into every harness, template or not. */
export const HARNESS_MANIFEST = 'harness.yaml'

/** Written as `.claude`. See the header - the alias is for git and for npm. */
export const DOT_CLAUDE_ALIAS = 'dot-claude'

/** Declares a directory that has nothing in it. Not itself written. */
export const KEEP_FILE = '.gitkeep'

/** The one extension that opts a file in to substitution. Stripped on write. */
export const TPL_SUFFIX = '.tpl'

/**
 * What `template:` says when the caller does not name one, and the id of the
 * built-in scaffold.
 *
 * `minimal` is code, not a directory. It cannot be edited, cannot be deleted,
 * and cannot be broken by anything anyone puts in the templates directory -
 * which is the point: the picker's first row is the one that always works.
 */
export const MINIMAL_TEMPLATE = 'minimal'

/** One row of the picker. */
export interface TemplateChoice {
  /** Directory name, and what `template:` records. `minimal` for the built-in. */
  id: string
  label: string
  description: string | null
  /** `order:` from `template.yaml`. Sorted on before the label; null sorts last. */
  order: number | null
  /** The built-in scaffold, which has no directory behind it. */
  builtIn: boolean
}

export interface TemplateListing {
  /** `minimal` first and always, then the user's by `order` then label. */
  templates: TemplateChoice[]
  /** Where the user's templates live, so the dialog can say so. */
  dir: string
  /** One sentence per template that could not be read. */
  problems: string[]
}

/** What the New Harness dialog lists under "What gets written". */
export interface TemplatePreview {
  template: string
  /** Display order - the manifest first, then everything else by path. */
  entries: string[]
  /** The sentence under the list. Owned here so there is one authority. */
  note: string
  problems: string[]
}

export const MINIMAL_CHOICE: TemplateChoice = {
  id: MINIMAL_TEMPLATE,
  label: 'Minimal',
  description: 'A manifest, an empty repos/ and an empty .claude/. Nothing else.',
  order: null,
  builtIn: true
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/**
 * Problems with a template id, as sentences.
 *
 * The id arrives over IPC and is joined onto the templates directory, so it is
 * the one value in this file that a renderer chooses. `..\..\Windows` and
 * `C:\Windows` are the two shapes that matter and both are refused by name
 * rather than by a path comparison after the fact, because a comparison that
 * runs after `join` has already been given the value is a comparison that has
 * to be right about every way Windows spells a path.
 */
export function templateIdProblems(id: string): string[] {
  const problems: string[] = []
  const trimmed = id.trim()
  if (trimmed === '') return ['A template name is required.']
  if (isAbsolute(trimmed)) problems.push(`"${trimmed}" is an absolute path, not a template name.`)
  if (/[\\/]/.test(trimmed)) problems.push(`"${trimmed}" is a path, not a template name.`)
  if (trimmed === '.' || trimmed === '..') problems.push(`"${trimmed}" is not a template name.`)
  return problems
}

/**
 * Whether `candidate` stays inside `root`, answered on resolved paths.
 *
 * The second half of the refusal above, and it guards a different value: the
 * relative path of an entry *inside* a template, which nothing outside this
 * file chose but which a reparse point can still redirect.
 */
function isInside(root: string, candidate: string): boolean {
  const within = relative(resolve(root), resolve(candidate))
  return within !== '' && !within.startsWith('..') && !isAbsolute(within)
}

// ---------------------------------------------------------------------------
// Reading a template
// ---------------------------------------------------------------------------

/** `template.yaml`, parsed with `harness.yaml`'s tolerant discipline. */
interface TemplateMetadata {
  label: string | null
  description: string | null
  order: number | null
}

/**
 * Reads `template.yaml`, or says the template should be skipped.
 *
 * Three outcomes, and the middle one is the reason this returns a union rather
 * than a nullable: **absent** metadata is fine (the directory name is the
 * label), **malformed** metadata is not, and the difference has to reach the
 * picker as a sentence about one template rather than as an empty list. A
 * templates directory with one bad file in it still has a working picker.
 */
async function readTemplateMetadata(
  dir: string
): Promise<{ ok: true; metadata: TemplateMetadata } | { ok: false; problem: string }> {
  let raw: string
  try {
    raw = await readFile(join(dir, TEMPLATE_MANIFEST), 'utf8')
  } catch {
    return { ok: true, metadata: { label: null, description: null, order: null } }
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    return {
      ok: false,
      problem: `${TEMPLATE_MANIFEST} in "${basenameOf(dir)}" could not be read: ${
        err instanceof Error ? err.message.split('\n')[0] : String(err)
      }`
    }
  }

  if (parsed === null || parsed === undefined) {
    return { ok: true, metadata: { label: null, description: null, order: null } }
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      problem: `${TEMPLATE_MANIFEST} in "${basenameOf(dir)}" is not a set of keys, so that template was skipped.`
    }
  }

  const record = parsed as Record<string, unknown>
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  return {
    ok: true,
    metadata: {
      label: str(record['label']),
      description: str(record['description']),
      order: num(record['order'])
    }
  }
}

/** The last segment of a path, without pulling `basename` into every call. */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}

/**
 * Every template in `dir`, with `minimal` at the front.
 *
 * A directory that cannot be listed at all - it does not exist yet, or it is
 * not readable - is not an error: the picker is still correct, it just has one
 * row. Seeding is what creates it, and seeding happens at app start.
 */
export async function listTemplates(dir: string): Promise<TemplateListing> {
  const problems: string[] = []
  const templates: TemplateChoice[] = [MINIMAL_CHOICE]

  let entries: Array<{ name: string; isDirectory: boolean; isLink: boolean }>
  try {
    entries = (await readdir(dir, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isLink: entry.isSymbolicLink()
    }))
  } catch {
    return { templates, dir, problems }
  }

  const found: TemplateChoice[] = []
  for (const entry of entries) {
    if (entry.isLink) {
      problems.push(`"${entry.name}" is a link rather than a folder, so it was not offered.`)
      continue
    }
    if (!entry.isDirectory) continue
    if (entry.name === MINIMAL_TEMPLATE) {
      // The built-in owns the name. A directory called `minimal` cannot take it
      // over, because the row that always works is the point of the built-in.
      problems.push(
        `"${MINIMAL_TEMPLATE}" is Helm's built-in scaffold, so the folder of that name was not offered.`
      )
      continue
    }
    const read = await readTemplateMetadata(join(dir, entry.name))
    if (!read.ok) {
      problems.push(read.problem)
      continue
    }
    found.push({
      id: entry.name,
      label: read.metadata.label ?? entry.name,
      description: read.metadata.description,
      order: read.metadata.order,
      builtIn: false
    })
  }

  found.sort((a, b) => {
    // `order:` first, and a template with none sorts after every template with
    // one - "unordered" is not "zero", and a template that never asked to be
    // first should not displace one that did.
    if (a.order !== b.order) {
      if (a.order === null) return 1
      if (b.order === null) return -1
      return a.order - b.order
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  })

  templates.push(...found)
  return { templates, dir, problems }
}

// ---------------------------------------------------------------------------
// Walking a template into a list of writes
// ---------------------------------------------------------------------------

/** One thing the writer will do, in the order it will do it. */
interface PlannedEntry {
  /** Absolute path in the template. */
  source: string
  /** Path relative to the harness root, with `/` separators. */
  target: string
  /** `directory` is a `.gitkeep`'s parent - nothing is read for it. */
  kind: 'file' | 'template' | 'directory'
}

interface TemplatePlan {
  entries: PlannedEntry[]
  problems: string[]
}

/** `dot-claude` -> `.claude`, per segment. Everything else is left alone. */
export function rewriteSegment(name: string): string {
  return name === DOT_CLAUDE_ALIAS ? '.claude' : name
}

/**
 * Walks a template directory into an ordered list of writes.
 *
 * Sorted by target path at every level, so two runs of the same template write
 * the same files in the same order - which is what makes a partial failure
 * readable rather than a different list every time.
 *
 * It refuses rather than follows: a junction or symlink is reported and not
 * descended into, so a template carrying a reparse point into `C:\` produces a
 * sentence instead of a walk of the disk.
 */
async function planTemplate(
  templateDir: string,
  relativeDir = '',
  plan: TemplatePlan = { entries: [], problems: [] }
): Promise<TemplatePlan> {
  const here = relativeDir === '' ? templateDir : join(templateDir, relativeDir)
  let entries
  try {
    entries = await readdir(here, { withFileTypes: true })
  } catch (err) {
    plan.problems.push(
      `${relativeDir === '' ? 'The template' : relativeDir} could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return plan
  }

  const sorted = [...entries].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )

  for (const entry of sorted) {
    const sourceRel = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
    const source = join(templateDir, ...sourceRel.split('/'))

    // Metadata about the template, not content of it.
    if (relativeDir === '' && entry.name === TEMPLATE_MANIFEST) continue

    if (entry.isSymbolicLink()) {
      plan.problems.push(
        `"${sourceRel}" is a link and was not written. A template may only contain real files and folders.`
      )
      continue
    }

    const targetRel = sourceRel
      .split('/')
      .map(rewriteSegment)
      .join('/')

    if (entry.isDirectory()) {
      await planTemplate(templateDir, sourceRel, plan)
      continue
    }
    if (!entry.isFile()) {
      plan.problems.push(`"${sourceRel}" is neither a file nor a folder and was not written.`)
      continue
    }

    if (entry.name === KEEP_FILE) {
      // The marker declares its parent, and the parent is what gets made. At
      // the root of a template it declares nothing that is not already there.
      const cut = targetRel.lastIndexOf('/')
      const parent = cut === -1 ? '' : targetRel.slice(0, cut)
      if (parent === '') continue
      if (!guard(parent, plan)) continue
      plan.entries.push({ source, target: parent, kind: 'directory' })
      continue
    }

    const isTpl = entry.name.length > TPL_SUFFIX.length && entry.name.endsWith(TPL_SUFFIX)
    const written = isTpl ? targetRel.slice(0, targetRel.length - TPL_SUFFIX.length) : targetRel
    if (written === '') continue
    if (!guard(written, plan)) continue

    if (written === HARNESS_MANIFEST) {
      // Helm writes the manifest, last and always, because `template:` in it is
      // the provenance the launcher reads back. A template's own copy is
      // refused out loud rather than silently overwritten.
      plan.problems.push(
        `"${sourceRel}" was skipped: ${HARNESS_MANIFEST} is written by Helm, so a template cannot supply one.`
      )
      continue
    }

    plan.entries.push({ source, target: written, kind: isTpl ? 'template' : 'file' })
  }

  return plan
}

/**
 * Refuses a target that leaves the harness, and says which one it was.
 *
 * On the relative path itself rather than on a resolved one, so the plan can be
 * built without a destination - the preview has no harness to resolve against.
 * `applyTemplate` asks the question a second time against the real directory,
 * because the two are different claims: this one is about the path a template
 * asked for, that one is about the file a write is actually about to open.
 */
function guard(targetRel: string, plan: TemplatePlan): boolean {
  if (isAbsolute(targetRel)) {
    plan.problems.push(`"${targetRel}" is an absolute path and was not written.`)
    return false
  }
  const segments = targetRel.split('/')
  if (segments.some((segment) => segment === '..' || segment === '' || segment === '.')) {
    plan.problems.push(`"${targetRel}" points outside the new harness and was not written.`)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------

export interface TemplateValues {
  NAME: string
  CREATED_AT: string
  TEMPLATE: string
}

/**
 * The three placeholders, and nothing else.
 *
 * No conditionals and no loops, on purpose: a template language is a thing that
 * grows, and the moment it can branch it needs a debugger. Anything a template
 * cannot express is a thing the harness's own agents can do afterwards, in the
 * harness, where they can see the result.
 *
 * An unrecognised `{{...}}` survives exactly as written. The same rule the
 * pull-request prompt template follows, and for the same reason: a typo should
 * show up in the file as a typo, not as a word that quietly went missing.
 */
export function substituteTemplate(text: string, values: TemplateValues): string {
  return text
    .split('{{NAME}}')
    .join(values.NAME)
    .split('{{CREATED_AT}}')
    .join(values.CREATED_AT)
    .split('{{TEMPLATE}}')
    .join(values.TEMPLATE)
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** What the minimal scaffold writes, per mode. Read by the dialog, not guessed. */
const MINIMAL_ENTRIES: Record<'new' | 'convert', string[]> = {
  new: [HARNESS_MANIFEST, 'repos/', '.claude/'],
  convert: [HARNESS_MANIFEST, '.claude/']
}

const MINIMAL_NOTE: Record<'new' | 'convert', string> = {
  new: 'Nothing else. No starter skills, notes or rules - what belongs in a harness is yours to decide.',
  convert: 'The manifest records repos: "." so the repositories already in this folder stay visible.'
}

export interface PreviewTemplateRequest {
  templatesDir: string
  template: string
  /** Convert is template-free and writes the bare minimum; see `createHarness`. */
  mode?: 'new' | 'convert' | undefined
}

/**
 * The file list the dialog shows, from the same walk that writes it.
 *
 * Display order rather than write order: the manifest first, because it is the
 * one entry that makes the directory a harness, and then everything else by
 * path. What is *written* last is the manifest - see `createHarness` - and the
 * two orders differ deliberately rather than by accident.
 */
export async function previewTemplate(request: PreviewTemplateRequest): Promise<TemplatePreview> {
  const mode = request.mode ?? 'new'
  if (mode === 'convert' || request.template === MINIMAL_TEMPLATE) {
    const effective = mode === 'convert' ? 'convert' : 'new'
    return {
      template: mode === 'convert' ? MINIMAL_TEMPLATE : request.template,
      entries: [...MINIMAL_ENTRIES[effective]],
      note: MINIMAL_NOTE[effective],
      problems: []
    }
  }

  const idProblems = templateIdProblems(request.template)
  if (idProblems.length > 0) {
    return { template: request.template, entries: [], note: '', problems: idProblems }
  }

  const templateDir = join(request.templatesDir, request.template.trim())
  if (!(await isDirectory(templateDir))) {
    return {
      template: request.template,
      entries: [],
      note: '',
      problems: [`There is no template called "${request.template}".`]
    }
  }

  const listing = await listTemplates(request.templatesDir)
  const choice = listing.templates.find((candidate) => candidate.id === request.template)
  const plan = await planTemplate(templateDir)
  const entries = plan.entries
    .map((entry) => (entry.kind === 'directory' ? `${entry.target}/` : entry.target))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

  return {
    template: request.template,
    entries: [HARNESS_MANIFEST, ...entries],
    note: `Written from the ${choice?.label ?? request.template} template, laid out as its own folder is.`,
    problems: plan.problems
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface ApplyTemplateRequest {
  templatesDir: string
  template: string
  /** The harness directory. It exists already; this writes into it. */
  target: string
  values: TemplateValues
}

export interface ApplyTemplateResult {
  /** Paths written, relative to the harness, in the order they were written. */
  created: string[]
  /** What could not be written, as sentences. Never a claim of a rollback. */
  problems: string[]
  /** False when the template could not be opened at all - nothing was written. */
  applied: boolean
}

/**
 * Writes a template's tree into a harness that already exists.
 *
 * **Partial failure is honest, not atomic.** A dozen files can fail on the
 * eighth, and the three answers to that are to pretend a rollback happened, to
 * report a failure over a harness that is largely there, or to say what was
 * written and what was not. This is the third: `created` is what actually
 * landed and `problems` names the rest. A harness half-written is a directory
 * the user can look at, finish or delete; a rollback that deleted eight files
 * to be tidy is a rollback that can fail on its fourth delete and leave nothing
 * to look at and nothing said about it.
 */
export async function applyTemplate(request: ApplyTemplateRequest): Promise<ApplyTemplateResult> {
  const idProblems = templateIdProblems(request.template)
  if (idProblems.length > 0) return { created: [], problems: idProblems, applied: false }

  const templateDir = join(request.templatesDir, request.template.trim())
  if (!(await isDirectory(templateDir))) {
    return {
      created: [],
      problems: [`There is no template called "${request.template}".`],
      applied: false
    }
  }

  const plan = await planTemplate(templateDir)
  const created: string[] = []
  const problems = [...plan.problems]

  const ordered = [...plan.entries].sort((a, b) =>
    a.target.localeCompare(b.target, undefined, { sensitivity: 'base' })
  )

  for (const entry of ordered) {
    const destination = join(request.target, ...entry.target.split('/'))
    // The second gate, against the real directory rather than against the path
    // the template asked for. `guard` has already refused the shapes it can see
    // in a string; this is what would catch one it could not.
    if (!isInside(request.target, destination)) {
      problems.push(`"${entry.target}" points outside the new harness and was not written.`)
      continue
    }
    try {
      if (entry.kind === 'directory') {
        await mkdir(destination, { recursive: true })
        created.push(`${entry.target}/`)
        continue
      }
      await mkdir(join(destination, '..'), { recursive: true })
      if (entry.kind === 'template') {
        const raw = await readFile(entry.source, 'utf8')
        // `wx`: a template cannot overwrite what an earlier entry of its own
        // wrote. Two sources landing on one target is an author's mistake and
        // it should read as one rather than as a file that quietly won.
        await writeFile(destination, substituteTemplate(raw, request.values), {
          encoding: 'utf8',
          flag: 'wx'
        })
      } else {
        // `copyFile`, not read-then-write: a template may hold a PNG, and a
        // round trip through a utf8 string would corrupt it. `COPYFILE_EXCL`
        // for the reason `wx` is above, so `a.txt` and `a.txt.tpl` in one
        // template is a sentence rather than a silent winner.
        await copyFile(entry.source, destination, copyFileConstants.COPYFILE_EXCL)
      }
      created.push(entry.target)
    } catch (err) {
      problems.push(
        `${entry.target} could not be written: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return { created, problems, applied: true }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * What a first start writes into an empty templates directory: the README that
 * says how to write one, and one example that demonstrates every part of the
 * format.
 *
 * Held as strings rather than shipped as files, and that is a packaging
 * decision rather than a stylistic one. A packaged Helm is an asar; loose
 * files beside it need an `extraResources` entry, an unpacking rule and a
 * different path in three of the four run modes. A constant is in the bundle
 * by construction and cannot be half-shipped.
 */
export const SHIPPED_TEMPLATES: Record<string, string> = {
  'README.md': `# Harness templates

A template is a folder in this directory. Creating a harness from it copies the
folder's contents into the new harness, and that is the whole mechanism.

    templates/
      README.md          <- this file
      example/           <- one template, named by its folder
        template.yaml    <- what the picker shows
        ...              <- everything else is copied as-is

## template.yaml

    label: "Example"
    description: "One sentence, shown under the label in the picker."
    order: 10

All three are optional. Without a label the folder name is used; \`order\` sorts
the picker, and a template without one sorts after every template with one. A
\`template.yaml\` that cannot be parsed skips that one template and leaves the
rest of the picker working.

## The rest of the folder

Copied verbatim into the new harness, with four rules:

- **\`.tpl\` files are filled in and the extension is dropped.**
  \`CLAUDE.md.tpl\` is written as \`CLAUDE.md\` with \`{{NAME}}\`,
  \`{{CREATED_AT}}\` and \`{{TEMPLATE}}\` substituted. There are no other
  placeholders, and no conditionals or loops.
- **Every other file is copied byte for byte.** A workflow file full of
  \`\${{ ... }}\` arrives exactly as you wrote it. That is why substitution is
  opt-in rather than applied everywhere.
- **\`dot-claude/\` is written as \`.claude/\`.** A literal \`.claude/\` works
  too; the alias exists because some tools drop dot directories when a template
  is packaged or copied.
- **An empty folder needs a \`.gitkeep\`.** Folders are created as the parents
  of files, so an empty one would otherwise never arrive. The \`.gitkeep\`
  itself is not copied.

## What is refused

Absolute paths, anything that climbs out of the harness with \`..\`, and
junctions or symlinks. \`harness.yaml\` too - Helm writes that one, because
\`template:\` in it records which template a harness came from.

## Minimal

The first row of the picker is built in and is not a folder here. It writes a
manifest, an empty \`repos/\` and an empty \`.claude/\`, and nothing you put in
this directory can change or break it.

## Editing

These files are written once, when this directory does not exist. Nothing here
is ever overwritten, so anything you change stays changed - and deleting the
whole directory puts the originals back at the next start.
`,

  'example/template.yaml': `label: "Example"
description: "A CLAUDE.md naming the harness, an empty repos/ and an empty .claude/skills/."
order: 10
`,

  'example/CLAUDE.md.tpl': `# {{NAME}}

Created {{CREATED_AT}} from the {{TEMPLATE}} template.

Replace this file with whatever the agents working here need to know.
`,

  'example/dot-claude/skills/.gitkeep': '',

  'example/repos/.gitkeep': ''
}

export interface SeedResult {
  /** False when the directory was already there, which is the ordinary case. */
  seeded: boolean
  created: string[]
  problem: string | null
}

/**
 * Writes the shipped README and example, once, and never again.
 *
 * The trigger is the **directory being absent**, not a stamp and not a hash.
 * Helm keeps no record of what it wrote here, so it cannot tell an edited file
 * from an untouched one - and an "improved" example overwriting somebody's
 * edited copy is the one failure this must not have. The accepted consequence
 * is stated rather than worked around: a better shipped example never reaches
 * an existing install. Deleting the directory brings it back, which is why
 * there is no reset feature.
 *
 * Synchronous, because it runs on the startup path beside `cleanStaleShims`,
 * where anything deferred is something the first window can race.
 */
export function seedTemplates(dir: string): SeedResult {
  if (existsSync(dir)) return { seeded: false, created: [], problem: null }

  const created: string[] = []
  try {
    mkdirSync(dir, { recursive: true })
    for (const relativePath of Object.keys(SHIPPED_TEMPLATES).sort()) {
      const destination = join(dir, ...relativePath.split('/'))
      mkdirSync(join(destination, '..'), { recursive: true })
      // `wx` again, and here it is the whole guarantee: two Helms starting at
      // once must not have one of them writing over the other's copy.
      writeFileSync(destination, SHIPPED_TEMPLATES[relativePath] ?? '', {
        encoding: 'utf8',
        flag: 'wx'
      })
      created.push(relativePath)
    }
  } catch (err) {
    return {
      seeded: created.length > 0,
      created,
      problem: `the templates directory could not be seeded: ${
        err instanceof Error ? err.message : String(err)
      }`
    }
  }
  return { seeded: true, created, problem: null }
}
