import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readConfigFileContent, writeSnapshottedFile } from '../config/write'
import type { Store } from '../store/db'
import {
  DOT_CLAUDE_ALIAS,
  HARNESS_MANIFEST,
  KEEP_FILE,
  MINIMAL_TEMPLATE,
  TEMPLATE_MANIFEST,
  TPL_SUFFIX,
  rewriteSegment,
  templateIdProblems
} from './templates'

/**
 * Authoring a template: the parts of it a file explorer cannot do.
 *
 * `templates.ts` is the reader - it lists templates and writes one into a new
 * harness. This is the writer, and it exists because a template directory is a
 * plain folder the user can open in any editor, so the only things worth
 * building in the app are the ones Explorer has no idea about: **find the skill
 * you already wrote and copy it in**, and **turn a harness you have been living
 * in into a template**. There is deliberately no in-app file editor;
 * `shell:showItem` opens the folder and the user's own editor takes it from
 * there.
 *
 * Four rules run through everything below.
 *
 * - **A reparse point is unlinked, never walked.** Every walk here asks
 *   `isSymbolicLink()` *before* asking `isDirectory()`, because on Windows a
 *   junction answers yes to both and the order is what decides whether a delete
 *   removes a template or the repository the template was pointing at. This is
 *   the overlay-shim rule (CLAUDE.md, "Overlays") in the second place it is
 *   load-bearing, and `pnpm template-check` proves it a second time.
 * - **`.git` and `node_modules` are never copied, at any depth.** Not a default
 *   the user can override: a `.git` copied into a template puts one workspace's
 *   history into every harness made from it afterwards, and `node_modules` is
 *   the reason a "save this folder" feature turns into a gigabyte. They are
 *   *listed* in the preview, marked and unticked, rather than silently pruned -
 *   nothing is copied that was not shown.
 * - **Nothing is written that the engine would then refuse.** A folder being
 *   frozen may hold a `harness.yaml`; `applyTemplate` refuses one, so freezing
 *   it would author a template that can never fully apply. It is refused here
 *   instead, where the user is looking at it.
 * - **The bytes are copied, not round-tripped.** `copyFile`, for the reason
 *   `applyTemplate` uses it: a skill may bundle a PNG, and a trip through a
 *   utf8 string corrupts it. The one thing written as text is `template.yaml`,
 *   and that goes through `writeSnapshottedFile` - the config console's write,
 *   with a guard of this surface's own, exactly as the content viewer does it.
 *   There is no second write path with a second set of bugs.
 *
 * Nothing here imports Electron and nothing here knows where the templates
 * directory is; the host passes it in.
 */

// ---------------------------------------------------------------------------
// What is never copied, and what is merely unticked
// ---------------------------------------------------------------------------

/**
 * Refused at every depth, whatever the user ticks.
 *
 * Both are directories a workspace accumulates rather than things anybody
 * authored, and both are actively harmful in a template: `.git` would put this
 * harness's history inside every harness made from the template, and
 * `node_modules` is what makes the difference between a template that is
 * kilobytes and one that is gigabytes. Pruning them is also what bounds the
 * walk that states the size - without it, previewing a harness with a few
 * checkouts in it means counting a few hundred thousand files.
 */
const NEVER_COPIED = new Map<string, string>([
  ['.git', 'a repository’s history is not a scaffold'],
  ['node_modules', 'installed packages are not a scaffold']
])

/**
 * Refused at the *root* of a folder being frozen, each for its own reason.
 *
 * `harness.yaml` is instance metadata and `applyTemplate` refuses a template
 * that supplies one - Helm writes that file, because `template:` in it is the
 * provenance the launcher reads back. Copying it here would author a template
 * that is guaranteed to report a problem the first time anybody uses it.
 * `template.yaml` is written by this file, last, from the name and description
 * the dialog asked for; a copied one would be overwritten or would collide.
 */
const ROOT_REFUSED = new Map<string, string>([
  [HARNESS_MANIFEST, 'Helm writes this into the new harness, so a template cannot supply one'],
  [TEMPLATE_MANIFEST, 'this is written from the name and description below']
])

/**
 * Listed, counted, and **unticked by default** - but the user may tick it.
 *
 * The difference from the two sets above is the whole argument for asking
 * rather than guessing: Helm cannot know that `notes/` is a journal rather than
 * a scaffold, and it cannot know that `repos/` is empty rather than eleven
 * checkouts. So everything defaults to included and the instance data is
 * unticked - `repos/` because it is the one directory whose *purpose* is to
 * hold things that belong to this harness and not to the layout.
 */
const UNTICKED_BY_DEFAULT = new Set(['repos'])

/**
 * Where a per-entry count stops.
 *
 * A number rather than no limit, because the preview is a dialog somebody is
 * waiting in front of. A row that hits it reports `truncated` and the dialog
 * says "more than", which is all the disclosure the decision needs - the point
 * of the figure is to stop a gigabyte being a surprise, and "more than 50,000
 * files" does that as well as an exact count would.
 */
const COUNT_BUDGET = 50_000

// ---------------------------------------------------------------------------
// Walking, with the link question answered first
// ---------------------------------------------------------------------------

/** One directory entry, with the three questions already asked in the right order. */
interface Entry {
  name: string
  path: string
  /**
   * A junction or a symlink. Decided **first**: a Windows junction reports as a
   * directory too, and a walk that asked `isDirectory()` first would descend
   * into one. Every other flag here is false when this is true.
   */
  link: boolean
  directory: boolean
  file: boolean
}

async function entriesOf(dir: string): Promise<Entry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .map((entry) => {
      const link = entry.isSymbolicLink()
      return {
        name: entry.name,
        path: join(dir, entry.name),
        link,
        directory: !link && entry.isDirectory(),
        file: !link && entry.isFile()
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/**
 * Removes a reparse point without following it.
 *
 * `rm` unlinks a symlink and, through libuv, a directory junction as well.
 * `rmdir` is the fallback for the platform that will not unlink a directory
 * reparse point - it removes the link, never the target. Neither ever reads
 * through the point, which is the whole property being bought: the shim sweep's
 * rule is that a temp cleaner following a junction deletes the repository's
 * `.claude/skills`, and a template holding one is the same threat with the same
 * consequence.
 */
async function unlinkReparsePoint(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch {
    await rmdir(path)
  }
}

/**
 * Removes a directory tree, unlinking every reparse point it meets.
 *
 * Written out rather than left to `fs.rm(..., { recursive: true })` because the
 * property that matters is not "the directory is gone" - it is "nothing outside
 * the directory was touched", and that is a claim about the traversal rather
 * than about the result. Reading the code has to be enough to see it, and here
 * it is one branch: a link is unlinked and not descended into.
 */
async function removeTree(dir: string, problems: string[]): Promise<void> {
  let entries: Entry[]
  try {
    entries = await entriesOf(dir)
  } catch (err) {
    problems.push(`${dir} could not be read: ${message(err)}`)
    return
  }

  for (const entry of entries) {
    try {
      if (entry.link) {
        await unlinkReparsePoint(entry.path)
        continue
      }
      if (entry.directory) {
        await removeTree(entry.path, problems)
        continue
      }
      await rm(entry.path, { force: true })
    } catch (err) {
      problems.push(`${entry.path} could not be removed: ${message(err)}`)
    }
  }

  try {
    await rmdir(dir)
  } catch (err) {
    problems.push(`${dir} could not be removed: ${message(err)}`)
  }
}

interface Measured {
  files: number
  bytes: number
  /** The count stopped at `COUNT_BUDGET`; the real figure is higher. */
  truncated: boolean
  /** Links met and not followed, as relative paths. */
  links: string[]
}

/**
 * Counts a tree, refusing what will never be copied and following nothing.
 *
 * The same traversal the copy makes, so the number the dialog states is the
 * number of files the copy will write rather than a second opinion about the
 * directory.
 */
async function measureTree(dir: string, base: string, into: Measured): Promise<Measured> {
  if (into.files >= COUNT_BUDGET) {
    into.truncated = true
    return into
  }

  let entries: Entry[]
  try {
    entries = await entriesOf(dir)
  } catch {
    // Unreadable, which is not a count of zero anywhere it matters: the entry is
    // still listed and the user still decides. Nothing is claimed about it.
    return into
  }

  for (const entry of entries) {
    if (entry.link) {
      into.links.push(relative(base, entry.path).split(sep).join('/'))
      continue
    }
    if (NEVER_COPIED.has(entry.name.toLowerCase())) continue
    if (entry.directory) {
      await measureTree(entry.path, base, into)
      if (into.truncated) return into
      continue
    }
    if (!entry.file) continue
    into.files += 1
    if (into.files >= COUNT_BUDGET) {
      into.truncated = true
      return into
    }
    try {
      into.bytes += (await stat(entry.path)).size
    } catch {
      // Gone between the readdir and the stat. Counted, unmeasured.
    }
  }
  return into
}

interface Copied {
  files: string[]
  bytes: number
  problems: string[]
}

/**
 * Copies a tree, byte for byte, refusing the same things the count refused.
 *
 * `COPYFILE_EXCL` is not used: the destination is a template directory this
 * call has just created, or one whose colliding entries the caller has already
 * decided about. What is not negotiable is that the bytes arrive unchanged, so
 * it is `copyFile` rather than a read and a write.
 */
async function copyTree(from: string, to: string, base: string, into: Copied): Promise<Copied> {
  let entries: Entry[]
  try {
    entries = await entriesOf(from)
  } catch (err) {
    into.problems.push(`${label(base, from)} could not be read: ${message(err)}`)
    return into
  }

  await mkdir(to, { recursive: true })

  for (const entry of entries) {
    const rel = label(base, entry.path)
    if (entry.link) {
      into.problems.push(
        `"${rel}" is a link and was not copied. A template may only contain real files and folders.`
      )
      continue
    }
    const refusal = NEVER_COPIED.get(entry.name.toLowerCase())
    if (refusal !== undefined) {
      into.problems.push(`"${rel}" was not copied: ${refusal}.`)
      continue
    }
    if (entry.directory) {
      await copyTree(entry.path, join(to, entry.name), base, into)
      continue
    }
    if (!entry.file) {
      into.problems.push(`"${rel}" is neither a file nor a folder and was not copied.`)
      continue
    }
    try {
      await copyFile(entry.path, join(to, entry.name))
      into.files.push(rel)
      into.bytes += (await stat(entry.path)).size
    } catch (err) {
      into.problems.push(`"${rel}" could not be copied: ${message(err)}`)
    }
  }
  return into
}

function label(base: string, path: string): string {
  const rel = relative(base, path)
  return rel === '' ? path : rel.split(sep).join('/')
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The write guard
// ---------------------------------------------------------------------------

/**
 * What this surface may write, which is: inside one template directory.
 *
 * The third of these, beside `assertWritable` (configuration) and
 * `assertContentWritable` (notes), and it is the *only* new thing needed to
 * reuse the console's write wholesale. Everything that makes a config save safe
 * - the snapshot taken before the bytes are touched, the write aborted if the
 * snapshot cannot be taken, the refusal when the file on disk is not the file
 * this was based on, the refusal to rewrite something that is not text - is
 * what a template's manifest wants too, so `writeSnapshottedFile` does the work
 * and this decides only which paths are in scope.
 */
export function assertTemplateWritable(scopePath: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`Refusing to write a relative path: ${path}`)
  const absolute = resolve(path)
  const scope = resolve(scopePath)

  const rel = relative(scope, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write ${absolute}: it is not inside ${scope}.`)
  }
  for (const segment of rel.split(sep)) {
    if (NEVER_COPIED.has(segment.toLowerCase())) {
      throw new Error(`Refusing to write ${absolute}: ${segment} is never part of a template.`)
    }
  }
}

// ---------------------------------------------------------------------------
// Naming a template
// ---------------------------------------------------------------------------

/**
 * Everything wrong with a proposed template name, as sentences.
 *
 * `templateIdProblems` is the shape check the *reader* already makes, and it
 * runs first so a name refused at creation is refused for the same reason and
 * in the same words a hostile `harness:create` would be. What is added here is
 * what only a writer needs to know: the built-in owns `minimal`, and a name
 * already taken is a different template.
 */
export async function templateNameProblems(
  templatesDir: string,
  name: string,
  { allowExisting = false }: { allowExisting?: boolean } = {}
): Promise<string[]> {
  const problems = templateIdProblems(name)
  if (problems.length > 0) return problems

  const trimmed = name.trim()
  if (trimmed.toLowerCase() === MINIMAL_TEMPLATE) {
    return [`"${MINIMAL_TEMPLATE}" is Helm's built-in scaffold, so a template cannot be called that.`]
  }
  if (!allowExisting && (await isDirectory(join(templatesDir, trimmed)))) {
    return [`There is already a template called "${trimmed}".`]
  }
  return []
}

/** `template.yaml` as this file writes it. Quoted, so a colon in a label is safe. */
function manifestText(label: string, description: string): string {
  const lines = [`label: ${JSON.stringify(label)}`]
  if (description.trim() !== '') lines.push(`description: ${JSON.stringify(description.trim())}`)
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Reading one template, in detail
// ---------------------------------------------------------------------------

/** One file in a template, and what a harness would receive it as. */
export interface TemplateFile {
  /** Relative to the template directory, forward-slashed. */
  relPath: string
  /**
   * The path a new harness gets: `.tpl` dropped, `dot-claude` rewritten, and -
   * for a `.gitkeep` - the empty folder it declares, with a trailing slash.
   * Empty when the file is not written at all.
   */
  target: string
  size: number
  mtimeMs: number
  /** A `.tpl`: its `{{...}}` placeholders are filled in on the way out. */
  substituted: boolean
  /** A link, which the engine refuses. Listed so the author can see why. */
  link: boolean
}

/** One template, as the manager shows it. */
export interface TemplateDetail {
  id: string
  dir: string
  /** From `template.yaml`, or the folder name when it sets none. */
  label: string
  description: string
  /** Whether there is a `template.yaml` at all - absent is legal. */
  hasManifest: boolean
  /** Everything but `template.yaml`, sorted by path. */
  files: TemplateFile[]
  fileCount: number
  totalBytes: number
  /** The newest mtime in the tree, or the directory's own when it is empty. */
  modifiedAtMs: number
  problems: string[]
}

/** The three placeholders, named once so the UI cannot invent a fourth. */
export const TEMPLATE_VARIABLES = ['{{NAME}}', '{{CREATED_AT}}', '{{TEMPLATE}}'] as const

/**
 * One template's contents, for the manager's file list.
 *
 * A listing rather than a plan, and the difference is deliberate: `planTemplate`
 * answers "what would be written", which drops the `.gitkeep` and the manifest
 * and says nothing about a file it refuses. This answers "what is in the
 * folder", because the author is looking at their own directory and a file
 * missing from the list is a file they cannot fix. What each one *becomes* is a
 * column, computed with the same two rules the writer uses.
 */
export async function readTemplateDetail(
  templatesDir: string,
  id: string
): Promise<TemplateDetail> {
  const problems = templateIdProblems(id)
  const dir = join(templatesDir, id.trim())
  const empty: TemplateDetail = {
    id,
    dir,
    label: id,
    description: '',
    hasManifest: false,
    files: [],
    fileCount: 0,
    totalBytes: 0,
    modifiedAtMs: 0,
    problems
  }
  if (problems.length > 0) return empty
  if (!(await isDirectory(dir))) {
    return { ...empty, problems: [`There is no template called "${id}".`] }
  }

  const files: TemplateFile[] = []
  const walkProblems: string[] = []
  let modifiedAtMs = 0
  try {
    modifiedAtMs = (await stat(dir)).mtimeMs
  } catch {
    // The directory answered `isDirectory` a line ago; a failure here is a race
    // and leaves the timestamp at zero, which the UI renders as unknown.
  }

  const walk = async (at: string, relativeDir: string): Promise<void> => {
    let entries: Entry[]
    try {
      entries = await entriesOf(at)
    } catch (err) {
      walkProblems.push(
        `${relativeDir === '' ? 'The template' : relativeDir} could not be read: ${message(err)}`
      )
      return
    }
    for (const entry of entries) {
      const rel = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.link) {
        files.push({
          relPath: rel,
          target: '',
          size: 0,
          mtimeMs: 0,
          substituted: false,
          link: true
        })
        walkProblems.push(
          `"${rel}" is a link. A template may only contain real files and folders, so it is not written.`
        )
        continue
      }
      if (entry.directory) {
        await walk(entry.path, rel)
        continue
      }
      if (!entry.file) continue
      if (relativeDir === '' && entry.name === TEMPLATE_MANIFEST) continue

      let info
      try {
        info = await stat(entry.path)
      } catch {
        // Gone between the readdir and the stat. Not there, so not listed.
        continue
      }
      if (info.mtimeMs > modifiedAtMs) modifiedAtMs = info.mtimeMs
      files.push({
        relPath: rel,
        target: targetOf(rel, entry.name),
        size: info.size,
        mtimeMs: info.mtimeMs,
        substituted: isTpl(entry.name),
        link: false
      })
    }
  }
  await walk(dir, '')

  const metadata = await readManifest(dir)
  files.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { sensitivity: 'base' }))

  return {
    id,
    dir,
    label: metadata.label ?? id,
    description: metadata.description ?? '',
    hasManifest: metadata.exists,
    files,
    fileCount: files.filter((file) => !file.link).length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    modifiedAtMs,
    problems: [...(metadata.problem === null ? [] : [metadata.problem]), ...walkProblems]
  }
}

function isTpl(name: string): boolean {
  return name.length > TPL_SUFFIX.length && name.endsWith(TPL_SUFFIX)
}

/** What a harness receives this file as. The writer's two rules, read-only. */
function targetOf(rel: string, name: string): string {
  const rewritten = rel.split('/').map(rewriteSegment).join('/')
  if (name === KEEP_FILE) {
    const cut = rewritten.lastIndexOf('/')
    return cut === -1 ? '' : `${rewritten.slice(0, cut)}/`
  }
  const written = isTpl(rewritten) ? rewritten.slice(0, rewritten.length - TPL_SUFFIX.length) : rewritten
  return written === HARNESS_MANIFEST ? '' : written
}

/**
 * `template.yaml`'s label and description, for the metadata form.
 *
 * Read as lines rather than through the YAML parser that `listTemplates` uses,
 * and that is not a shortcut: this answer feeds a form whose Save rewrites the
 * file, so what it has to report is what the *two fields* say. A parser would
 * also report an `order:` this form does not offer and cannot preserve through
 * a round trip - which is the one thing a metadata form must not silently drop.
 */
async function readManifest(
  dir: string
): Promise<{ exists: boolean; label: string | null; description: string | null; problem: string | null }> {
  const file = readConfigFileContent(join(dir, TEMPLATE_MANIFEST))
  if (!file.exists) return { exists: false, label: null, description: null, problem: null }
  if (file.binary) {
    return {
      exists: true,
      label: null,
      description: null,
      problem: `${TEMPLATE_MANIFEST} is not text, so Helm will not rewrite it.`
    }
  }
  const read = (key: string): string | null => {
    for (const line of file.content.split('\n')) {
      const match = new RegExp(`^${key}:\\s*(.*)$`).exec(line)
      if (!match) continue
      const raw = (match[1] ?? '').trim()
      if (raw === '') return null
      try {
        return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw.replace(/^'(.*)'$/, '$1')
      } catch {
        return raw
      }
    }
    return null
  }
  return { exists: true, label: read('label'), description: read('description'), problem: null }
}

// ---------------------------------------------------------------------------
// Create, rename, delete, retitle
// ---------------------------------------------------------------------------

export interface TemplateWriteResult {
  ok: boolean
  /** The template's id afterwards, or null when nothing was written. */
  template: string | null
  /** What went wrong, as sentences. Rendered straight into the dialog. */
  problems: string[]
}

const refuse = (...problems: string[]): TemplateWriteResult => ({
  ok: false,
  template: null,
  problems
})

/**
 * Scaffolds a template: the directory, and a `template.yaml` in it.
 *
 * An empty tree and nothing else. A "starter" template with files in it would
 * be Helm's opinion about somebody's layout arriving inside the feature whose
 * entire purpose is that the layout is theirs - which is the same argument
 * `minimal` is built on, one level up.
 */
export async function createTemplate(
  store: Store,
  request: { templatesDir: string; name: string; label?: string; description?: string }
): Promise<TemplateWriteResult> {
  const name = request.name.trim()
  const problems = await templateNameProblems(request.templatesDir, name)
  if (problems.length > 0) return refuse(...problems)

  const dir = join(request.templatesDir, name)
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    return refuse(`"${name}" could not be created: ${message(err)}`)
  }

  const written = writeSnapshottedFile(
    store,
    {
      scopePath: dir,
      path: join(dir, TEMPLATE_MANIFEST),
      content: manifestText((request.label ?? '').trim() === '' ? name : (request.label ?? ''), request.description ?? ''),
      // Null is "I believe this file does not exist", so a `template.yaml` that
      // appeared between the mkdir and here is a conflict rather than a silent
      // overwrite of somebody else's template.
      expectedHash: null,
      reason: 'create'
    },
    assertTemplateWritable
  )
  if (!written.ok) {
    return refuse(
      written.conflict
        ? `${TEMPLATE_MANIFEST} appeared in "${name}" while Helm was creating it, so nothing was written.`
        : (written.error ?? 'The write was refused.')
    )
  }
  return { ok: true, template: name, problems: [] }
}

/** Rewrites `label` and `description`, leaving the rest of the folder alone. */
export async function writeTemplateMetadata(
  store: Store,
  request: { templatesDir: string; template: string; label: string; description: string }
): Promise<TemplateWriteResult> {
  const id = request.template.trim()
  const problems = templateIdProblems(id)
  if (problems.length > 0) return refuse(...problems)

  const dir = join(request.templatesDir, id)
  if (!(await isDirectory(dir))) return refuse(`There is no template called "${id}".`)

  const file = join(dir, TEMPLATE_MANIFEST)
  const current = readConfigFileContent(file)
  if (current.exists && current.binary) {
    return refuse(`${TEMPLATE_MANIFEST} in "${id}" is not text, so Helm will not rewrite it.`)
  }

  const written = writeSnapshottedFile(
    store,
    {
      scopePath: dir,
      path: file,
      content: manifestText(request.label.trim() === '' ? id : request.label, request.description),
      expectedHash: current.exists ? current.hash : null,
      reason: 'edit'
    },
    assertTemplateWritable
  )
  if (!written.ok) {
    return refuse(
      written.conflict
        ? `${TEMPLATE_MANIFEST} in "${id}" changed on disk while the form was open, so nothing was written.`
        : (written.error ?? 'The write was refused.')
    )
  }
  return { ok: true, template: id, problems: [] }
}

/**
 * Renames a template's directory.
 *
 * `rename` rather than a copy and a delete, which is the opposite of what
 * `renameConfigEntry` does - and the difference is the reason, not an
 * inconsistency. That one copies so every moved file lands in the snapshot
 * table, because it is moving files inside `~/.claude`, which is Claude Code's
 * and which Helm may only touch with a way back. A template directory is
 * Helm's own, holds whatever the author put there including binaries the
 * snapshot table cannot hold, and a rename that copied a hundred megabytes to
 * be tidy would be the wrong trade twice over.
 */
export async function renameTemplate(request: {
  templatesDir: string
  template: string
  name: string
}): Promise<TemplateWriteResult> {
  const from = request.template.trim()
  const to = request.name.trim()
  const fromProblems = templateIdProblems(from)
  if (fromProblems.length > 0) return refuse(...fromProblems)
  if (from.toLowerCase() === to.toLowerCase()) return refuse(`It is already called "${from}".`)

  const problems = await templateNameProblems(request.templatesDir, to)
  if (problems.length > 0) return refuse(...problems)

  const source = join(request.templatesDir, from)
  if (!(await isDirectory(source))) return refuse(`There is no template called "${from}".`)

  try {
    await rename(source, join(request.templatesDir, to))
  } catch (err) {
    return refuse(`"${from}" could not be renamed: ${message(err)}`)
  }
  return { ok: true, template: to, problems: [] }
}

export interface TemplateDeleteResult {
  ok: boolean
  /** The template that is gone, or null when nothing was removed. */
  template: string | null
  problems: string[]
}

/**
 * Removes a template directory, unlinking anything that is a reparse point.
 *
 * The one operation in this file where getting the traversal wrong is
 * unrecoverable, and it is why `removeTree` is written out rather than left to
 * `fs.rm(..., { recursive: true })`: a template can perfectly well contain a
 * junction - somebody experimenting, or a template imported from a folder that
 * had one - and a delete that walked into it would remove the contents of a
 * real repository. `pnpm template-check` plants one and hashes what it points
 * at either side.
 *
 * There is no undo. Deliberately: the snapshot table holds text, a template
 * holds whatever its author put there, and a "delete" that silently kept half a
 * template would be worse than one that says plainly it is final.
 */
export async function deleteTemplate(request: {
  templatesDir: string
  template: string
}): Promise<TemplateDeleteResult> {
  const id = request.template.trim()
  const idProblems = templateIdProblems(id)
  if (idProblems.length > 0) return { ok: false, template: null, problems: idProblems }

  const dir = join(request.templatesDir, id)
  if (!(await isDirectory(dir))) {
    return { ok: false, template: null, problems: [`There is no template called "${id}".`] }
  }

  const problems: string[] = []
  await removeTree(dir, problems)
  if (problems.length > 0) return { ok: false, template: null, problems }
  return { ok: true, template: id, problems: [] }
}

/**
 * Renames one file to `x.tpl`, which is how a file opts in to substitution.
 *
 * The one piece of `.tpl` awareness that is an *action* rather than a label,
 * and it is here because `.tpl` is a Helm invention nobody guesses from a
 * folder listing. A binary is refused: substitution reads the file as utf8 and
 * writes the result, so marking a PNG substitutable would be arranging for it
 * to be corrupted at creation time rather than now.
 */
export async function makeSubstitutable(request: {
  templatesDir: string
  template: string
  /** Relative to the template directory, forward-slashed. */
  path: string
}): Promise<TemplateWriteResult> {
  const id = request.template.trim()
  const idProblems = templateIdProblems(id)
  if (idProblems.length > 0) return refuse(...idProblems)

  const dir = join(request.templatesDir, id)
  const segments = request.path.split('/').filter((segment) => segment !== '')
  if (segments.length === 0 || segments.some((segment) => segment === '..' || segment === '.')) {
    return refuse(`"${request.path}" is not a file in this template.`)
  }
  const source = join(dir, ...segments)
  const rel = segments.join('/')
  if (rel === TEMPLATE_MANIFEST) {
    return refuse(`${TEMPLATE_MANIFEST} describes the template rather than being written into a harness.`)
  }
  if (isTpl(rel)) return refuse(`"${rel}" is already substituted.`)

  const current = readConfigFileContent(source)
  if (!current.exists) return refuse(`"${rel}" is no longer there. Re-read the template and try again.`)
  if (current.binary) {
    return refuse(
      `"${rel}" is not text. Substitution reads a file as text and writes it back, so a binary ` +
        'marked substitutable would arrive corrupted.'
    )
  }
  if (readConfigFileContent(`${source}${TPL_SUFFIX}`).exists) {
    return refuse(`"${rel}${TPL_SUFFIX}" is already there.`)
  }

  try {
    await rename(source, `${source}${TPL_SUFFIX}`)
  } catch (err) {
    return refuse(`"${rel}" could not be renamed: ${message(err)}`)
  }
  return { ok: true, template: id, problems: [] }
}

// ---------------------------------------------------------------------------
// Importing files into a template
// ---------------------------------------------------------------------------

/** One file to copy in: where it is, and what it becomes inside the template. */
export interface TemplateImportFile {
  /** Absolute path of the source. Read only - nothing is written to it. */
  source: string
  /** Relative to the template directory, forward-slashed. */
  target: string
}

export interface TemplateImportResult {
  ok: boolean
  /** Targets that did not exist before, relative to the template. */
  created: string[]
  /** Targets that did, and were replaced. Named rather than counted. */
  replaced: string[]
  problems: string[]
}

/**
 * Copies chosen files into a template, as plain files.
 *
 * **No link back to the source.** A template travels - mailed, cloned,
 * unzipped - so a reference to `~/.claude/skills/think` would be a template
 * that produces a different harness on a different machine, and produces
 * nothing at all on somebody else's. The copy is the feature.
 *
 * The direction is worth stating because of what the sources are. Every scope
 * the config console exposes can be imported *from*, `~/.claude` included, and
 * that is a **read**: this function opens the source and writes only inside the
 * templates directory. CLAUDE.md's rule - `~/.claude` is Claude Code's and Helm
 * only reads it, with the config console's snapshotted write as the single
 * exception - is not widened here, and `assertTemplateWritable` is what says
 * so mechanically rather than by intention.
 *
 * Replacing rather than refusing an existing target, and it is named in the
 * result. Re-importing a skill you have since edited is the ordinary second use
 * of this feature, and a refusal would mean deleting the file by hand first;
 * what would be wrong is doing it silently, so the dialog says which files were
 * replaced.
 */
export async function importIntoTemplate(request: {
  templatesDir: string
  template: string
  files: readonly TemplateImportFile[]
}): Promise<TemplateImportResult> {
  const id = request.template.trim()
  const idProblems = templateIdProblems(id)
  if (idProblems.length > 0) return { ok: false, created: [], replaced: [], problems: idProblems }

  const dir = join(request.templatesDir, id)
  if (!(await isDirectory(dir))) {
    return { ok: false, created: [], replaced: [], problems: [`There is no template called "${id}".`] }
  }
  if (request.files.length === 0) {
    return { ok: false, created: [], replaced: [], problems: ['Nothing was selected.'] }
  }

  const created: string[] = []
  const replaced: string[] = []
  const problems: string[] = []

  for (const file of request.files) {
    const destination = join(dir, ...file.target.split('/'))
    try {
      // The same guard the manifest write goes through, so an import cannot
      // reach a path the metadata form could not.
      assertTemplateWritable(dir, destination)
    } catch (err) {
      problems.push(`"${file.target}" was not copied: ${message(err)}`)
      continue
    }
    try {
      const info = await stat(file.source)
      if (!info.isFile()) {
        problems.push(`"${file.target}" was not copied: its source is not a file.`)
        continue
      }
    } catch (err) {
      problems.push(`"${file.target}" was not copied: ${message(err)}`)
      continue
    }

    const existed = readConfigFileContent(destination).exists
    try {
      await mkdir(join(destination, '..'), { recursive: true })
      await copyFile(file.source, destination)
      ;(existed ? replaced : created).push(file.target)
    } catch (err) {
      problems.push(`"${file.target}" could not be copied: ${message(err)}`)
    }
  }

  return { ok: created.length + replaced.length > 0, created, replaced, problems }
}

// ---------------------------------------------------------------------------
// A folder becomes a template
// ---------------------------------------------------------------------------

/** Which of the two this is. The defaults and the wording differ; nothing else. */
export type FolderTemplateKind = 'harness' | 'folder'

/** One thing at the top of the folder, and whether it would be copied. */
export interface FolderEntry {
  name: string
  directory: boolean
  /** Files under it that would be copied. `truncated` says the count stopped. */
  fileCount: number
  bytes: number
  truncated: boolean
  /** Ticked when the dialog opens. */
  included: boolean
  /** Set when Helm will not copy it whatever the user ticks, and why. */
  refused: string | null
  /** A link. Never followed, never copied. */
  link: boolean
}

export interface FolderTemplatePreview {
  dir: string
  kind: FolderTemplateKind
  entries: FolderEntry[]
  /** Files and bytes of everything ticked by default. The number that matters. */
  fileCount: number
  totalBytes: number
  /** The sentence under the list. Owned here so there is one authority. */
  note: string
  problems: string[]
}

/**
 * What "Save as template" would copy, before anything is copied.
 *
 * Top-level entries, each with the recursive file count and size of what would
 * actually land. Per-entry rather than per-file because that is the granularity
 * the decision is made at - "`notes/` is my journal, not a scaffold" - and
 * because a harness has thousands of files and a checkbox on each of them is a
 * list nobody reads. The figures are what stop a gigabyte being a surprise, so
 * they are computed by the same traversal the copy makes rather than estimated.
 */
export async function previewFolderAsTemplate(request: {
  dir: string
  kind: FolderTemplateKind
}): Promise<FolderTemplatePreview> {
  const dir = resolve(request.dir)
  const empty: FolderTemplatePreview = {
    dir,
    kind: request.kind,
    entries: [],
    fileCount: 0,
    totalBytes: 0,
    note: '',
    problems: []
  }
  if (request.dir.trim() === '') return { ...empty, problems: ['Choose a folder first.'] }
  if (!(await isDirectory(dir))) return { ...empty, problems: [`${dir} is not a folder.`] }

  let top: Entry[]
  try {
    top = await entriesOf(dir)
  } catch (err) {
    return { ...empty, problems: [`${dir} could not be read: ${message(err)}`] }
  }

  const entries: FolderEntry[] = []
  const problems: string[] = []
  for (const entry of top) {
    if (entry.link) {
      entries.push({
        name: entry.name,
        directory: false,
        fileCount: 0,
        bytes: 0,
        truncated: false,
        included: false,
        refused: 'a template may only contain real files and folders',
        link: true
      })
      problems.push(`"${entry.name}" is a link and will not be copied or followed.`)
      continue
    }
    if (!entry.directory && !entry.file) continue

    const refused =
      NEVER_COPIED.get(entry.name.toLowerCase()) ??
      ROOT_REFUSED.get(entry.name.toLowerCase()) ??
      null

    const measured = entry.directory
      ? await measureTree(entry.path, entry.path, { files: 0, bytes: 0, truncated: false, links: [] })
      : { files: 1, bytes: await sizeOf(entry.path), truncated: false, links: [] as string[] }
    for (const link of measured.links) {
      problems.push(`"${entry.name}/${link}" is a link and will not be copied or followed.`)
    }

    entries.push({
      name: entry.name,
      directory: entry.directory,
      fileCount: measured.files,
      bytes: measured.bytes,
      truncated: measured.truncated,
      included: refused === null && !UNTICKED_BY_DEFAULT.has(entry.name.toLowerCase()),
      refused,
      link: false
    })
  }

  const ticked = entries.filter((entry) => entry.included)
  return {
    dir,
    kind: request.kind,
    entries,
    fileCount: ticked.reduce((sum, entry) => sum + entry.fileCount, 0),
    totalBytes: ticked.reduce((sum, entry) => sum + entry.bytes, 0),
    note:
      request.kind === 'harness'
        ? 'Ticked folders are copied whole. Untick anything that belongs to this harness rather than to the layout - Helm cannot tell a journal from a scaffold.'
        : 'Ticked folders are copied whole. dot-claude/ is kept as it is; a harness made from this template receives it as .claude/.',
    problems
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

export interface SaveFolderAsTemplateResult extends TemplateWriteResult {
  /** What landed, relative to the template. */
  created: string[]
  fileCount: number
  totalBytes: number
}

/**
 * Copies the ticked entries of a folder into a new template.
 *
 * The same call behind "Save this harness as a template" and "Import a folder
 * as a template", because they are the same operation - a folder, some of its
 * entries, and a `template.yaml` written from a name and a description. What
 * differs is where the folder came from and which entries are ticked when the
 * dialog opens, and both of those are decided before this is called.
 *
 * `dot-claude/` is copied **verbatim** rather than normalised to `.claude/`.
 * The alias is the engine's, applied when a harness is written, so a template
 * that arrived with one keeps it - renaming an author's directory on the way in
 * would silently undo the choice they made for the tool that needed it.
 *
 * The manifest is written **last**, for the reason `createHarness` writes the
 * harness manifest last: it is the file that makes the directory a template, so
 * a copy that failed half way leaves a folder rather than a broken picker row.
 */
export async function saveFolderAsTemplate(
  store: Store,
  request: {
    dir: string
    templatesDir: string
    name: string
    label: string
    description: string
    /** Top-level entry names to copy. Anything not named here is left behind. */
    include: readonly string[]
  }
): Promise<SaveFolderAsTemplateResult> {
  const fail = (...problems: string[]): SaveFolderAsTemplateResult => ({
    ok: false,
    template: null,
    problems,
    created: [],
    fileCount: 0,
    totalBytes: 0
  })

  const source = resolve(request.dir)
  if (!(await isDirectory(source))) return fail(`${source} is not a folder.`)

  const name = request.name.trim()
  const nameProblems = await templateNameProblems(request.templatesDir, name)
  if (nameProblems.length > 0) return fail(...nameProblems)
  if (request.include.length === 0) return fail('Nothing was ticked, so there is nothing to copy.')

  const wanted = new Set(request.include.map((entry) => entry.toLowerCase()))
  let top: Entry[]
  try {
    top = await entriesOf(source)
  } catch (err) {
    return fail(`${source} could not be read: ${message(err)}`)
  }

  const dir = join(request.templatesDir, name)
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    return fail(`"${name}" could not be created: ${message(err)}`)
  }

  const copied: Copied = { files: [], bytes: 0, problems: [] }
  for (const entry of top) {
    if (!wanted.has(entry.name.toLowerCase())) continue
    if (entry.link) {
      copied.problems.push(
        `"${entry.name}" is a link and was not copied. A template may only contain real files and folders.`
      )
      continue
    }
    const refused =
      NEVER_COPIED.get(entry.name.toLowerCase()) ?? ROOT_REFUSED.get(entry.name.toLowerCase()) ?? null
    if (refused !== null) {
      copied.problems.push(`"${entry.name}" was not copied: ${refused}.`)
      continue
    }
    if (entry.directory) {
      await copyTree(entry.path, join(dir, entry.name), source, copied)
      continue
    }
    if (!entry.file) continue
    try {
      await copyFile(entry.path, join(dir, entry.name), fsConstants.COPYFILE_EXCL)
      copied.files.push(entry.name)
      copied.bytes += await sizeOf(entry.path)
    } catch (err) {
      copied.problems.push(`"${entry.name}" could not be copied: ${message(err)}`)
    }
  }

  const written = writeSnapshottedFile(
    store,
    {
      scopePath: dir,
      path: join(dir, TEMPLATE_MANIFEST),
      content: manifestText(request.label.trim() === '' ? name : request.label, request.description),
      expectedHash: null,
      reason: 'create'
    },
    assertTemplateWritable
  )
  if (!written.ok) {
    return {
      ok: false,
      template: null,
      problems: [
        `"${name}" was written but ${TEMPLATE_MANIFEST} could not be: ${written.error ?? 'the write was refused'}.`,
        ...copied.problems
      ],
      created: copied.files,
      fileCount: copied.files.length,
      totalBytes: copied.bytes
    }
  }

  return {
    ok: true,
    template: name,
    problems: copied.problems,
    created: copied.files,
    fileCount: copied.files.length,
    totalBytes: copied.bytes
  }
}

/** The alias, exported so the import dialog can name it without a second copy. */
export const DOT_CLAUDE = DOT_CLAUDE_ALIAS
