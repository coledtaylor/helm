import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countConfigSnapshots, readConfigSnapshots } from '../store/config'
import { openStore, type Store } from '../store/db'
import { createHarness } from './harness'
import { listTemplates } from './templates'
import {
  createTemplate,
  deleteTemplate,
  importIntoTemplate,
  makeSubstitutable,
  previewFolderAsTemplate,
  readTemplateDetail,
  renameTemplate,
  saveFolderAsTemplate,
  templateNameProblems,
  writeTemplateMetadata
} from './template-authoring'

/**
 * Authoring a template, against real directories.
 *
 * The same argument the rest of `discovery/` makes: every claim here is about
 * files on disk, and a filesystem stubbed well enough to be worth testing
 * against is a filesystem. The junction cases are the ones that matter most and
 * they are the ones a stub could not express at all.
 */

let root: string
let templatesDir: string
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-authoring-'))
  templatesDir = join(root, 'templates')
  mkdirSync(templatesDir, { recursive: true })
  store = openStore({ file: ':memory:' })
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** Every path under a directory, relative and sorted. Knows nothing of templates. */
function tree(dir: string, base = dir, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    into.push(relative(base, path).split(sep).join('/'))
    if (entry.isDirectory() && !entry.isSymbolicLink()) tree(path, base, into)
  }
  return into.sort()
}

function write(path: string, content: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

describe('templateNameProblems', () => {
  it('refuses a path, an absolute, the built-in name and a name already taken', async () => {
    expect(await templateNameProblems(templatesDir, '')).toHaveLength(1)
    expect(await templateNameProblems(templatesDir, '../escape')).toHaveLength(1)
    expect(await templateNameProblems(templatesDir, 'C:\\Windows')).not.toHaveLength(0)
    expect((await templateNameProblems(templatesDir, 'minimal'))[0]).toContain('built-in')
    // Case-folded, because Windows would let a `Minimal` folder shadow the row
    // that always works and the reader refuses only the exact name.
    expect((await templateNameProblems(templatesDir, 'MINIMAL'))[0]).toContain('built-in')

    mkdirSync(join(templatesDir, 'taken'))
    expect((await templateNameProblems(templatesDir, 'taken'))[0]).toContain('already a template')
    expect(await templateNameProblems(templatesDir, 'taken', { allowExisting: true })).toEqual([])
  })

  it('accepts an ordinary folder name', async () => {
    expect(await templateNameProblems(templatesDir, 'client-work')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Create, metadata, rename, delete
// ---------------------------------------------------------------------------

describe('createTemplate', () => {
  it('scaffolds a manifest and an empty tree, and the picker then offers it', async () => {
    const result = await createTemplate(store, {
      templatesDir,
      name: 'client-work',
      label: 'Client work',
      description: 'One sentence.'
    })

    expect(result.ok).toBe(true)
    expect(result.template).toBe('client-work')
    expect(tree(join(templatesDir, 'client-work'))).toEqual(['template.yaml'])

    const listing = await listTemplates(templatesDir)
    expect(listing.templates.map((choice) => choice.id)).toEqual(['minimal', 'client-work'])
    expect(listing.templates[1]?.label).toBe('Client work')
    expect(listing.templates[1]?.description).toBe('One sentence.')
  })

  it('uses the folder name when no label is given, and writes nothing twice', async () => {
    await createTemplate(store, { templatesDir, name: 'bare' })
    expect(readFileSync(join(templatesDir, 'bare', 'template.yaml'), 'utf8')).toContain('"bare"')

    const again = await createTemplate(store, { templatesDir, name: 'bare' })
    expect(again.ok).toBe(false)
    expect(again.problems[0]).toContain('already a template')
  })

  it('refuses a name that is a path, and writes nothing', async () => {
    const result = await createTemplate(store, { templatesDir, name: '../escape' })
    expect(result.ok).toBe(false)
    expect(tree(templatesDir)).toEqual([])
  })

  it('records the manifest in the snapshot table, because it goes through the console’s write', async () => {
    // The point of routing through `writeSnapshottedFile` rather than reaching
    // for `writeFile`: there is one write path in the app and it always records.
    // A row here is the evidence that this surface did not open a second one.
    expect(countConfigSnapshots(store)).toBe(0)

    await createTemplate(store, { templatesDir, name: 'recorded', label: 'Recorded' })
    const dir = join(templatesDir, 'recorded')
    expect(readConfigSnapshots(store, dir, 'template.yaml').map((row) => row.reason)).toEqual([
      'create'
    ])

    await writeTemplateMetadata(store, {
      templatesDir,
      template: 'recorded',
      label: 'Renamed',
      description: ''
    })
    // Newest first, and the edit's row holds what was there *before* it - which
    // is what makes it an undo rather than a log line.
    const rows = readConfigSnapshots(store, dir, 'template.yaml')
    expect(rows.map((row) => row.reason)).toEqual(['edit', 'create'])
  })
})

describe('writeTemplateMetadata', () => {
  it('rewrites label and description without touching the rest of the folder', async () => {
    await createTemplate(store, { templatesDir, name: 'work', label: 'Work' })
    write(join(templatesDir, 'work', 'CLAUDE.md.tpl'), '# {{NAME}}\n')

    const result = await writeTemplateMetadata(store, {
      templatesDir,
      template: 'work',
      label: 'Renamed label',
      description: 'A new sentence.'
    })

    expect(result.ok).toBe(true)
    const listing = await listTemplates(templatesDir)
    expect(listing.templates[1]?.label).toBe('Renamed label')
    expect(listing.templates[1]?.description).toBe('A new sentence.')
    expect(readFileSync(join(templatesDir, 'work', 'CLAUDE.md.tpl'), 'utf8')).toBe('# {{NAME}}\n')
  })

  it('quotes a label containing a colon, which bare YAML would not survive', async () => {
    await createTemplate(store, { templatesDir, name: 'work' })
    await writeTemplateMetadata(store, {
      templatesDir,
      template: 'work',
      label: 'Work: the sequel',
      description: ''
    })

    const listing = await listTemplates(templatesDir)
    expect(listing.problems).toEqual([])
    expect(listing.templates[1]?.label).toBe('Work: the sequel')
  })

  it('refuses a template that is not there', async () => {
    const result = await writeTemplateMetadata(store, {
      templatesDir,
      template: 'nothing',
      label: 'x',
      description: ''
    })
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toContain('no template called')
  })
})

describe('renameTemplate', () => {
  it('moves the whole folder and keeps its contents', async () => {
    await createTemplate(store, { templatesDir, name: 'before', label: 'Before' })
    write(join(templatesDir, 'before', 'notes', 'a.md'), 'hello')

    const result = await renameTemplate({ templatesDir, template: 'before', name: 'after' })

    expect(result.ok).toBe(true)
    expect(existsSync(join(templatesDir, 'before'))).toBe(false)
    expect(readFileSync(join(templatesDir, 'after', 'notes', 'a.md'), 'utf8')).toBe('hello')
  })

  it('refuses a name that is taken, the built-in name, and its own name', async () => {
    await createTemplate(store, { templatesDir, name: 'a' })
    await createTemplate(store, { templatesDir, name: 'b' })

    expect((await renameTemplate({ templatesDir, template: 'a', name: 'b' })).ok).toBe(false)
    expect((await renameTemplate({ templatesDir, template: 'a', name: 'minimal' })).ok).toBe(false)
    expect((await renameTemplate({ templatesDir, template: 'a', name: 'a' })).ok).toBe(false)
    expect(existsSync(join(templatesDir, 'a'))).toBe(true)
  })
})

describe('deleteTemplate', () => {
  it('removes the folder and everything in it', async () => {
    await createTemplate(store, { templatesDir, name: 'gone' })
    write(join(templatesDir, 'gone', 'deep', 'nested', 'a.txt'), 'x')

    const result = await deleteTemplate({ templatesDir, template: 'gone' })

    expect(result.ok).toBe(true)
    expect(existsSync(join(templatesDir, 'gone'))).toBe(false)
    expect(tree(templatesDir)).toEqual([])
  })

  it('unlinks a junction rather than walking into what it points at', async () => {
    const canary = join(root, 'canary')
    write(join(canary, 'do-not-touch.txt'), 'untouched')
    await createTemplate(store, { templatesDir, name: 'hostile' })
    // `junction` needs no elevation on Windows and is the reparse point
    // CLAUDE.md's rule about overlay shims is written about.
    symlinkSync(canary, join(templatesDir, 'hostile', 'escape'), 'junction')

    const result = await deleteTemplate({ templatesDir, template: 'hostile' })

    expect(result.ok).toBe(true)
    expect(existsSync(join(templatesDir, 'hostile'))).toBe(false)
    // The claim is about the bytes, not about a filename being absent.
    expect(readFileSync(join(canary, 'do-not-touch.txt'), 'utf8')).toBe('untouched')
  })

  it('refuses a name that climbs out, and removes nothing', async () => {
    mkdirSync(join(root, 'sibling'), { recursive: true })
    const result = await deleteTemplate({ templatesDir, template: '../sibling' })
    expect(result.ok).toBe(false)
    expect(existsSync(join(root, 'sibling'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Detail and `.tpl`
// ---------------------------------------------------------------------------

describe('readTemplateDetail', () => {
  it('lists every file with what a harness would receive it as', async () => {
    await createTemplate(store, { templatesDir, name: 'shaped', label: 'Shaped' })
    const dir = join(templatesDir, 'shaped')
    write(join(dir, 'CLAUDE.md.tpl'), '# {{NAME}}\n')
    write(join(dir, 'workflow.yml'), 'on: push\n')
    write(join(dir, 'dot-claude', 'settings.json'), '{}\n')
    write(join(dir, 'notes', '.gitkeep'), '')

    const detail = await readTemplateDetail(templatesDir, 'shaped')

    expect(detail.label).toBe('Shaped')
    expect(detail.fileCount).toBe(4)
    expect(detail.files.map((file) => `${file.relPath} -> ${file.target}`)).toEqual([
      'CLAUDE.md.tpl -> CLAUDE.md',
      'dot-claude/settings.json -> .claude/settings.json',
      'notes/.gitkeep -> notes/',
      'workflow.yml -> workflow.yml'
    ])
    expect(detail.files.filter((file) => file.substituted).map((file) => file.relPath)).toEqual([
      'CLAUDE.md.tpl'
    ])
    // `template.yaml` describes the template rather than being content of it.
    expect(detail.files.some((file) => file.relPath === 'template.yaml')).toBe(false)
  })

  it('names a link rather than leaving it out of the list', async () => {
    const canary = join(root, 'canary')
    mkdirSync(canary, { recursive: true })
    await createTemplate(store, { templatesDir, name: 'linky' })
    symlinkSync(canary, join(templatesDir, 'linky', 'escape'), 'junction')

    const detail = await readTemplateDetail(templatesDir, 'linky')

    expect(detail.files.map((file) => file.relPath)).toEqual(['escape'])
    expect(detail.files[0]?.link).toBe(true)
    expect(detail.problems.join(' ')).toContain('escape')
    // A link is not a file the template contributes.
    expect(detail.fileCount).toBe(0)
  })

  it('says which template is not there rather than reporting an empty one', async () => {
    const detail = await readTemplateDetail(templatesDir, 'nothing')
    expect(detail.problems[0]).toContain('no template called')
  })
})

describe('makeSubstitutable', () => {
  it('renames a file to .tpl, and the engine then substitutes it', async () => {
    await createTemplate(store, { templatesDir, name: 'sub' })
    write(join(templatesDir, 'sub', 'CLAUDE.md'), '# {{NAME}}\n')

    const result = await makeSubstitutable({ templatesDir, template: 'sub', path: 'CLAUDE.md' })

    expect(result.ok).toBe(true)
    expect(existsSync(join(templatesDir, 'sub', 'CLAUDE.md'))).toBe(false)

    const harness = join(root, 'made')
    const created = await createHarness({
      mode: 'new',
      dir: root,
      name: 'made',
      templatesDir,
      template: 'sub'
    })
    expect(created.problems).toEqual([])
    expect(readFileSync(join(harness, 'CLAUDE.md'), 'utf8')).toBe('# made\n')
  })

  it('refuses a binary, a file already substituted, and the manifest', async () => {
    await createTemplate(store, { templatesDir, name: 'sub' })
    const dir = join(templatesDir, 'sub')
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
    write(join(dir, 'a.md.tpl'), 'x')

    expect((await makeSubstitutable({ templatesDir, template: 'sub', path: 'logo.png' })).problems[0])
      .toContain('not text')
    expect((await makeSubstitutable({ templatesDir, template: 'sub', path: 'a.md.tpl' })).ok).toBe(false)
    expect(
      (await makeSubstitutable({ templatesDir, template: 'sub', path: 'template.yaml' })).ok
    ).toBe(false)
    expect(existsSync(join(dir, 'logo.png'))).toBe(true)
  })

  it('refuses a path that climbs out of the template', async () => {
    await createTemplate(store, { templatesDir, name: 'sub' })
    write(join(root, 'outside.md'), 'x')
    const result = await makeSubstitutable({
      templatesDir,
      template: 'sub',
      path: '../../outside.md'
    })
    expect(result.ok).toBe(false)
    expect(existsSync(join(root, 'outside.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

describe('importIntoTemplate', () => {
  it('copies files in as plain bytes and reports created against replaced', async () => {
    await createTemplate(store, { templatesDir, name: 'target' })
    const source = write(join(root, 'project', '.claude', 'skills', 'think', 'SKILL.md'), 'body\n')

    const first = await importIntoTemplate({
      templatesDir,
      template: 'target',
      files: [{ source, target: '.claude/skills/think/SKILL.md' }]
    })
    expect(first.created).toEqual(['.claude/skills/think/SKILL.md'])
    expect(first.replaced).toEqual([])
    expect(
      readFileSync(join(templatesDir, 'target', '.claude', 'skills', 'think', 'SKILL.md'), 'utf8')
    ).toBe('body\n')

    writeFileSync(source, 'edited\n')
    const second = await importIntoTemplate({
      templatesDir,
      template: 'target',
      files: [{ source, target: '.claude/skills/think/SKILL.md' }]
    })
    expect(second.created).toEqual([])
    expect(second.replaced).toEqual(['.claude/skills/think/SKILL.md'])
    expect(
      readFileSync(join(templatesDir, 'target', '.claude', 'skills', 'think', 'SKILL.md'), 'utf8')
    ).toBe('edited\n')
  })

  it('copies bytes rather than text, so a bundled binary survives', async () => {
    await createTemplate(store, { templatesDir, name: 'target' })
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x89, 0x50])
    const source = join(root, 'logo.png')
    writeFileSync(source, bytes)

    await importIntoTemplate({
      templatesDir,
      template: 'target',
      files: [{ source, target: '.claude/skills/think/logo.png' }]
    })

    expect(
      readFileSync(join(templatesDir, 'target', '.claude', 'skills', 'think', 'logo.png')).equals(bytes)
    ).toBe(true)
  })

  it('refuses a source that is a junction rather than copying what it points at', async () => {
    await createTemplate(store, { templatesDir, name: 'target' })
    const canary = join(root, 'canary')
    write(join(canary, 'do-not-touch.txt'), 'untouched')
    const link = join(root, 'linked')
    symlinkSync(canary, link, 'junction')

    const result = await importIntoTemplate({
      templatesDir,
      template: 'target',
      files: [{ source: link, target: '.claude/skills/think/SKILL.md' }]
    })

    // Refused because it is not a file, which is the same answer a junction
    // gets everywhere else here - and the picker cannot offer one anyway, since
    // `readConfigTree` does not walk into a symlinked directory.
    expect(result.ok).toBe(false)
    expect(result.created).toEqual([])
    expect(existsSync(join(templatesDir, 'target', '.claude'))).toBe(false)
    expect(readFileSync(join(canary, 'do-not-touch.txt'), 'utf8')).toBe('untouched')
  })

  it('refuses a target that climbs out of the template, and writes nothing there', async () => {
    await createTemplate(store, { templatesDir, name: 'target' })
    const source = write(join(root, 'a.md'), 'x')

    const result = await importIntoTemplate({
      templatesDir,
      template: 'target',
      files: [{ source, target: '../../escaped.md' }]
    })

    expect(result.ok).toBe(false)
    expect(result.problems[0]).toContain('escaped.md')
    expect(existsSync(join(root, 'escaped.md'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A folder becomes a template
// ---------------------------------------------------------------------------

/** A harness with the things somebody would want to leave behind. */
function plantHarness(): string {
  const dir = join(root, 'my-harness')
  write(join(dir, 'harness.yaml'), 'name: my-harness\n')
  write(join(dir, 'CLAUDE.md'), '# my-harness\n')
  write(join(dir, '.claude', 'skills', 'think', 'SKILL.md'), 'skill\n')
  write(join(dir, 'notes', 'journal.md'), 'a private journal\n')
  write(join(dir, 'repos', 'thing', 'README.md'), 'a checkout\n')
  write(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  write(join(dir, 'tools', 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  write(join(dir, 'tools', 'run.mjs'), 'console.log(1)\n')
  return dir
}

describe('previewFolderAsTemplate', () => {
  it('lists the top level, unticks the instance data, and counts what is ticked', async () => {
    const dir = plantHarness()

    const preview = await previewFolderAsTemplate({ dir, kind: 'harness' })
    const byName = new Map(preview.entries.map((entry) => [entry.name, entry]))

    expect([...byName.keys()].sort()).toEqual([
      '.claude',
      '.git',
      'CLAUDE.md',
      'harness.yaml',
      'notes',
      'repos',
      'tools'
    ])
    // The four defaults, and each is listed rather than pruned - nothing is
    // copied that was not shown.
    expect(byName.get('harness.yaml')?.included).toBe(false)
    expect(byName.get('.git')?.included).toBe(false)
    expect(byName.get('repos')?.included).toBe(false)
    expect(byName.get('.claude')?.included).toBe(true)
    expect(byName.get('notes')?.included).toBe(true)
    expect(byName.get('tools')?.included).toBe(true)

    // `harness.yaml` and `.git` are refused whatever the user ticks; `repos` is
    // merely unticked, because a repos/ scaffold is a defensible thing to want.
    expect(byName.get('harness.yaml')?.refused).not.toBeNull()
    expect(byName.get('.git')?.refused).not.toBeNull()
    expect(byName.get('repos')?.refused).toBeNull()

    // `tools/node_modules` is not counted: it is never copied, at any depth.
    expect(byName.get('tools')?.fileCount).toBe(1)
    // Ticked by default: CLAUDE.md, .claude/skills/think/SKILL.md,
    // notes/journal.md, tools/run.mjs.
    expect(preview.fileCount).toBe(4)
    expect(preview.totalBytes).toBeGreaterThan(0)
  })

  it('names a junction at the top level and never follows one below it', async () => {
    const canary = join(root, 'canary')
    write(join(canary, 'do-not-touch.txt'), 'untouched')
    const dir = plantHarness()
    symlinkSync(canary, join(dir, 'escape'), 'junction')
    symlinkSync(canary, join(dir, 'tools', 'deep-escape'), 'junction')

    const preview = await previewFolderAsTemplate({ dir, kind: 'harness' })
    const escape = preview.entries.find((entry) => entry.name === 'escape')

    expect(escape?.link).toBe(true)
    expect(escape?.included).toBe(false)
    expect(preview.problems.join(' ')).toContain('escape')
    expect(preview.problems.join(' ')).toContain('deep-escape')
    // The junction's target contributes nothing to the count.
    expect(preview.entries.find((entry) => entry.name === 'tools')?.fileCount).toBe(1)
  })
})

describe('saveFolderAsTemplate', () => {
  it('copies what was ticked, leaves out what was not, and writes a manifest', async () => {
    const dir = plantHarness()
    const preview = await previewFolderAsTemplate({ dir, kind: 'harness' })

    const result = await saveFolderAsTemplate(store, {
      dir,
      templatesDir,
      name: 'frozen',
      label: 'Frozen',
      description: 'A harness, frozen.',
      include: preview.entries.filter((entry) => entry.included).map((entry) => entry.name)
    })

    expect(result.ok).toBe(true)
    expect(tree(join(templatesDir, 'frozen'))).toEqual([
      '.claude',
      '.claude/skills',
      '.claude/skills/think',
      '.claude/skills/think/SKILL.md',
      'CLAUDE.md',
      'notes',
      'notes/journal.md',
      'template.yaml',
      'tools',
      'tools/run.mjs'
    ])
    // The manifest a harness gets is Helm's to write, so it is not carried in.
    expect(existsSync(join(templatesDir, 'frozen', 'harness.yaml'))).toBe(false)
    expect(result.fileCount).toBe(4)

    const listing = await listTemplates(templatesDir)
    expect(listing.templates.map((choice) => choice.id)).toEqual(['minimal', 'frozen'])
    expect(listing.templates[1]?.label).toBe('Frozen')
  })

  it('refuses harness.yaml even when it is ticked, rather than authoring a broken template', async () => {
    const dir = plantHarness()

    const result = await saveFolderAsTemplate(store, {
      dir,
      templatesDir,
      name: 'frozen',
      label: '',
      description: '',
      include: ['harness.yaml', 'CLAUDE.md']
    })

    expect(existsSync(join(templatesDir, 'frozen', 'harness.yaml'))).toBe(false)
    expect(existsSync(join(templatesDir, 'frozen', 'CLAUDE.md'))).toBe(true)
    expect(result.problems.join(' ')).toContain('harness.yaml')
  })

  it('does not recurse into a junction, and what it pointed at is untouched', async () => {
    const canary = join(root, 'canary')
    write(join(canary, 'do-not-touch.txt'), 'untouched')
    const dir = plantHarness()
    symlinkSync(canary, join(dir, 'tools', 'deep-escape'), 'junction')

    const result = await saveFolderAsTemplate(store, {
      dir,
      templatesDir,
      name: 'frozen',
      label: '',
      description: '',
      include: ['tools']
    })

    expect(result.ok).toBe(true)
    expect(tree(join(templatesDir, 'frozen'))).toEqual(['template.yaml', 'tools', 'tools/run.mjs'])
    expect(result.problems.join(' ')).toContain('deep-escape')
    expect(readFileSync(join(canary, 'do-not-touch.txt'), 'utf8')).toBe('untouched')
  })

  it('keeps dot-claude verbatim, and a harness made from it receives .claude', async () => {
    const folder = join(root, 'authored-elsewhere')
    write(join(folder, 'dot-claude', 'skills', 'think', 'SKILL.md'), 'skill\n')
    write(join(folder, 'CLAUDE.md.tpl'), '# {{NAME}}\n')

    const preview = await previewFolderAsTemplate({ dir: folder, kind: 'folder' })
    const saved = await saveFolderAsTemplate(store, {
      dir: folder,
      templatesDir,
      name: 'imported',
      label: 'Imported',
      description: '',
      include: preview.entries.filter((entry) => entry.included).map((entry) => entry.name)
    })
    expect(saved.ok).toBe(true)
    // Verbatim in the template: the alias is the author's choice, applied by
    // the writer rather than undone on the way in.
    expect(existsSync(join(templatesDir, 'imported', 'dot-claude'))).toBe(true)

    const listing = await listTemplates(templatesDir)
    expect(listing.templates.map((choice) => choice.id)).toContain('imported')

    await createHarness({
      mode: 'new',
      dir: root,
      name: 'from-imported',
      templatesDir,
      template: 'imported'
    })
    expect(
      readFileSync(join(root, 'from-imported', '.claude', 'skills', 'think', 'SKILL.md'), 'utf8')
    ).toBe('skill\n')
    expect(readFileSync(join(root, 'from-imported', 'CLAUDE.md'), 'utf8')).toBe('# from-imported\n')
  })

  it('refuses a name that is taken and leaves the existing template alone', async () => {
    await createTemplate(store, { templatesDir, name: 'taken', label: 'Taken' })
    const dir = plantHarness()

    const result = await saveFolderAsTemplate(store, {
      dir,
      templatesDir,
      name: 'taken',
      label: '',
      description: '',
      include: ['CLAUDE.md']
    })

    expect(result.ok).toBe(false)
    expect(tree(join(templatesDir, 'taken'))).toEqual(['template.yaml'])
  })
})
