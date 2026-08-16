import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness } from './harness'
import {
  listTemplates,
  previewTemplate,
  seedTemplates,
  substituteTemplate,
  templateIdProblems,
  SHIPPED_TEMPLATES
} from './templates'

let root: string
let templatesDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'helm-templates-'))
  templatesDir = join(root, 'templates')
  await mkdir(templatesDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Every path under a directory, relative and sorted. */
async function tree(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    out.push(path.slice(base.length + 1).split('\\').join('/'))
    if (entry.isDirectory()) out.push(...(await tree(path, base)))
  }
  return out.sort()
}

/** Writes `files` as a template directory. Keys are relative paths. */
async function plant(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(templatesDir, name)
  for (const [relativePath, contents] of Object.entries(files)) {
    const file = join(dir, ...relativePath.split('/'))
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, contents, 'utf8')
  }
  return dir
}

describe('listTemplates', () => {
  it('puts the built-in first however the directory sorts', async () => {
    await plant('aaa', { 'template.yaml': 'label: "Aaa"\n' })

    const listing = await listTemplates(templatesDir)
    expect(listing.templates.map((t) => t.id)).toEqual(['minimal', 'aaa'])
    expect(listing.templates[0]?.builtIn).toBe(true)
    expect(listing.dir).toBe(templatesDir)
  })

  it('is a one-row picker when the directory is not there at all', async () => {
    const listing = await listTemplates(join(root, 'nothing-here'))
    expect(listing.templates.map((t) => t.id)).toEqual(['minimal'])
    expect(listing.problems).toEqual([])
  })

  it('reads label, description and order, and falls back to the folder name', async () => {
    await plant('described', {
      'template.yaml': 'label: "A label"\ndescription: "A sentence."\norder: 3\n'
    })
    await plant('bare', { 'a.txt': 'x' })

    const listing = await listTemplates(templatesDir)
    expect(listing.templates.slice(1)).toEqual([
      { id: 'described', label: 'A label', description: 'A sentence.', order: 3, builtIn: false },
      { id: 'bare', label: 'bare', description: null, order: null, builtIn: false }
    ])
  })

  it('sorts by order, then label, with the unordered ones last', async () => {
    await plant('one', { 'template.yaml': 'label: "zeta"\norder: 1\n' })
    await plant('two', { 'template.yaml': 'label: "alpha"\norder: 2\n' })
    await plant('three', { 'template.yaml': 'label: "beta"\n' })
    await plant('four', { 'template.yaml': 'label: "aardvark"\n' })

    const listing = await listTemplates(templatesDir)
    expect(listing.templates.map((t) => t.label)).toEqual([
      'Minimal',
      'zeta',
      'alpha',
      'aardvark',
      'beta'
    ])
  })

  it('skips one malformed template with a sentence and keeps the rest', async () => {
    await plant('good', { 'template.yaml': 'label: "Good"\n' })
    await plant('broken', { 'template.yaml': 'label: "unterminated\n  - [\n' })

    const listing = await listTemplates(templatesDir)
    expect(listing.templates.map((t) => t.id)).toEqual(['minimal', 'good'])
    expect(listing.problems).toHaveLength(1)
    expect(listing.problems[0]).toContain('broken')
  })

  it('will not let a folder take the built-in name', async () => {
    await plant('minimal', { 'template.yaml': 'label: "Impostor"\n' })

    const listing = await listTemplates(templatesDir)
    expect(listing.templates.map((t) => t.id)).toEqual(['minimal'])
    expect(listing.templates[0]?.label).toBe('Minimal')
    expect(listing.problems[0]).toContain('built-in')
  })

  it('does not offer a link as a template', async () => {
    const real = await plant('real', { 'template.yaml': 'label: "Real"\n' })
    await symlink(real, join(templatesDir, 'linked'), 'junction')

    const listing = await listTemplates(templatesDir)
    expect(listing.templates.map((t) => t.id)).toEqual(['minimal', 'real'])
    expect(listing.problems.join(' ')).toContain('linked')
  })
})

describe('previewTemplate', () => {
  it('describes the minimal scaffold per mode', async () => {
    const forNew = await previewTemplate({ templatesDir, template: 'minimal', mode: 'new' })
    expect(forNew.entries).toEqual(['harness.yaml', 'repos/', '.claude/'])

    const forConvert = await previewTemplate({ templatesDir, template: 'anything', mode: 'convert' })
    expect(forConvert.entries).toEqual(['harness.yaml', '.claude/'])
    expect(forConvert.template).toBe('minimal')
  })

  it('lists a template as the writer would write it, manifest first', async () => {
    await plant('demo', {
      'template.yaml': 'label: "Demo"\n',
      'CLAUDE.md.tpl': '# {{NAME}}\n',
      'dot-claude/settings.json': '{}',
      'notes/.gitkeep': ''
    })

    const preview = await previewTemplate({ templatesDir, template: 'demo' })
    expect(preview.entries).toEqual([
      'harness.yaml',
      '.claude/settings.json',
      'CLAUDE.md',
      'notes/'
    ])
    expect(preview.note).toContain('Demo')
    expect(preview.problems).toEqual([])
  })

  it('says so rather than listing nothing for a template that is not there', async () => {
    const preview = await previewTemplate({ templatesDir, template: 'absent' })
    expect(preview.entries).toEqual([])
    expect(preview.problems).toEqual(['There is no template called "absent".'])
  })
})

describe('substituteTemplate', () => {
  const values = { NAME: 'work', CREATED_AT: '2026-08-15T00:00:00.000Z', TEMPLATE: 'demo' }

  it('fills in the three placeholders, every occurrence', () => {
    expect(substituteTemplate('{{NAME}} {{NAME}} {{TEMPLATE}} {{CREATED_AT}}', values)).toBe(
      'work work demo 2026-08-15T00:00:00.000Z'
    )
  })

  it('leaves anything else exactly as written', () => {
    const source = '${{ github.sha }} {{ NAME }} {{name}} {{UNKNOWN}}'
    expect(substituteTemplate(source, values)).toBe(source)
  })
})

describe('templateIdProblems', () => {
  it('refuses a path where a name belongs', () => {
    for (const id of ['..', '../x', '..\\x', 'a/b', 'a\\b', 'C:\\Windows', '/etc', '']) {
      expect(templateIdProblems(id), id).not.toEqual([])
    }
  })

  it('passes an ordinary folder name', () => {
    for (const id of ['demo', 'my-template', 'Work Space', 'a1']) {
      expect(templateIdProblems(id), id).toEqual([])
    }
  })
})

describe('createHarness from a template', () => {
  it('writes the tree, substitutes only .tpl, and records the provenance', async () => {
    const literal = 'runs-on: ${{ matrix.os }}\nname: {{NAME}}\n'
    await plant('demo', {
      'template.yaml': 'label: "Demo"\n',
      'CLAUDE.md.tpl': '# {{NAME}}\n\nfrom {{TEMPLATE}} at {{CREATED_AT}}\n',
      'workflow.yml': literal,
      'dot-claude/settings.json': '{"model":"opus"}',
      'notes/.gitkeep': ''
    })

    const result = await createHarness({
      mode: 'new',
      dir: root,
      name: 'work',
      template: 'demo',
      templatesDir
    })
    const harness = join(root, 'work')

    expect(result.problems).toEqual([])
    expect(result.path).toBe(harness)
    expect(await tree(harness)).toEqual([
      '.claude',
      '.claude/settings.json',
      'CLAUDE.md',
      'harness.yaml',
      'notes',
      'workflow.yml'
    ])

    // The .tpl was filled in and lost its extension.
    const claudeMd = await readFile(join(harness, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toMatch(/^# work$/m)
    expect(claudeMd).toMatch(/from demo at \d{4}-\d{2}-\d{2}T/)

    // The non-.tpl file arrived byte for byte, `{{...}}` and all. This is the
    // whole reason substitution is opt-in.
    expect(await readFile(join(harness, 'workflow.yml'), 'utf8')).toBe(literal)

    // Provenance, and the timestamp the .tpl was given is the manifest's.
    const manifest = await readFile(join(harness, 'harness.yaml'), 'utf8')
    expect(manifest).toMatch(/^template: "demo"$/m)
    const created = /^created: "([^"]+)"$/m.exec(manifest)?.[1]
    expect(claudeMd).toContain(created as string)
  })

  it('does not write the .gitkeep it made the folder for', async () => {
    await plant('demo', { 'notes/.gitkeep': '' })
    await createHarness({ mode: 'new', dir: root, name: 'work', template: 'demo', templatesDir })

    expect(await tree(join(root, 'work'))).toEqual(['harness.yaml', 'notes'])
  })

  it('refuses a template name that is a path, and writes nothing', async () => {
    for (const template of ['../escape', '..\\escape', 'C:\\Windows\\System32']) {
      const result = await createHarness({
        mode: 'new',
        dir: root,
        name: 'work',
        template,
        templatesDir
      })
      expect(result.path, template).toBeNull()
      expect(result.problems.length, template).toBeGreaterThan(0)
      expect(await tree(root)).toEqual(['templates'])
    }
  })

  it('refuses a template that is not there, and leaves no directory behind', async () => {
    const result = await createHarness({
      mode: 'new',
      dir: root,
      name: 'work',
      template: 'absent',
      templatesDir
    })
    expect(result.path).toBeNull()
    expect(result.problems).toEqual(['There is no template called "absent".'])
    expect(await tree(root)).toEqual(['templates'])
  })

  it('will not follow a junction out of the template', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'untouched', 'utf8')
    await plant('hostile', { 'template.yaml': 'label: "Hostile"\n', 'ok.txt': 'fine' })
    await symlink(outside, join(templatesDir, 'hostile', 'escape'), 'junction')

    const result = await createHarness({
      mode: 'new',
      dir: root,
      name: 'work',
      template: 'hostile',
      templatesDir
    })

    expect(result.path).toBe(join(root, 'work'))
    expect(result.problems.join(' ')).toContain('escape')
    expect(result.problems.join(' ')).toContain('link')
    // The harness has the honest half of the template and nothing else, and
    // what the junction pointed at is exactly as it was.
    expect(await tree(join(root, 'work'))).toEqual(['harness.yaml', 'ok.txt'])
    expect(await tree(outside)).toEqual(['secret.txt'])
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('untouched')
  })

  it('will not let a template supply the manifest', async () => {
    await plant('demo', { 'harness.yaml.tpl': 'name: "not-yours"\n', 'a.txt': 'x' })

    const result = await createHarness({
      mode: 'new',
      dir: root,
      name: 'work',
      template: 'demo',
      templatesDir
    })

    expect(result.problems.join(' ')).toContain('harness.yaml')
    expect(await readFile(join(root, 'work', 'harness.yaml'), 'utf8')).toMatch(/^name: "work"$/m)
  })

  it('reports what it actually wrote when one entry fails halfway', async () => {
    // Two sources, one target: `a.txt` and `a.txt.tpl` both want `a.txt`. The
    // first wins, the second is refused, and neither is silent.
    await plant('demo', { 'a.txt': 'plain', 'a.txt.tpl': '{{NAME}}', 'b.txt': 'also written' })

    const result = await createHarness({
      mode: 'new',
      dir: root,
      name: 'work',
      template: 'demo',
      templatesDir
    })

    expect(result.path).toBe(join(root, 'work'))
    expect(result.created).toEqual(['a.txt', 'b.txt', 'harness.yaml'])
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toContain('a.txt')
    expect(await readFile(join(root, 'work', 'a.txt'), 'utf8')).toBe('plain')
    expect(await readFile(join(root, 'work', 'b.txt'), 'utf8')).toBe('also written')
  })

  it('ignores a template when converting', async () => {
    await plant('demo', { 'CLAUDE.md.tpl': '# {{NAME}}\n' })
    await mkdir(join(root, 'alpha'), { recursive: true })

    const result = await createHarness({
      mode: 'convert',
      dir: root,
      template: 'demo',
      templatesDir
    })

    expect(result.problems).toEqual([])
    expect(await readFile(join(root, 'harness.yaml'), 'utf8')).toMatch(/^template: "minimal"$/m)
    expect(await tree(root)).not.toContain('CLAUDE.md')
  })
})

describe('seedTemplates', () => {
  it('writes the README and the example into a directory that is not there', async () => {
    const dir = join(root, 'seeded')
    const result = seedTemplates(dir)

    expect(result.seeded).toBe(true)
    expect(result.problem).toBeNull()
    expect(result.created.sort()).toEqual(Object.keys(SHIPPED_TEMPLATES).sort())
    expect(await tree(dir)).toContain('README.md')

    // And what it wrote is a template the engine can read back.
    const listing = await listTemplates(dir)
    expect(listing.templates.map((t) => t.id)).toEqual(['minimal', 'example'])
    expect(listing.problems).toEqual([])
  })

  it('overwrites nothing on a second call, however the files have been edited', async () => {
    const dir = join(root, 'seeded')
    seedTemplates(dir)
    await writeFile(join(dir, 'README.md'), 'mine now', 'utf8')

    const again = seedTemplates(dir)
    expect(again.seeded).toBe(false)
    expect(again.created).toEqual([])
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('mine now')
  })

  it('re-seeds once the directory is gone, which is the whole of "reset"', async () => {
    const dir = join(root, 'seeded')
    seedTemplates(dir)
    await writeFile(join(dir, 'README.md'), 'mine now', 'utf8')
    await rm(dir, { recursive: true, force: true })

    expect(seedTemplates(dir).seeded).toBe(true)
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe(SHIPPED_TEMPLATES['README.md'])
  })

  it('produces a harness from the shipped example', async () => {
    const dir = join(root, 'seeded')
    seedTemplates(dir)

    const result = await createHarness({
      mode: 'new',
      dir: root,
      name: 'work',
      template: 'example',
      templatesDir: dir
    })

    expect(result.problems).toEqual([])
    expect(await tree(join(root, 'work'))).toEqual([
      '.claude',
      '.claude/skills',
      'CLAUDE.md',
      'harness.yaml',
      'repos'
    ])
    expect(await readFile(join(root, 'work', 'CLAUDE.md'), 'utf8')).toMatch(/^# work$/m)
  })
})
