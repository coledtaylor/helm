import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countConfigSnapshots, readConfigSnapshots } from '../store/config'
import { openStore, type Store } from '../store/db'
import { createConfigFile, deleteConfigEntry, renameConfigEntry } from './create-rename-delete'
import { checkConfigName, configUnit, planConfigFile } from './names'
import { projectConfigScope, readConfigTree, userConfigScope } from './tree'
import { restoreConfigSnapshot } from './write'
import { parseFrontmatter } from './validate'

/**
 * Adding, renaming and removing entries, against a real directory.
 *
 * The same argument `config.test.ts` makes: every claim here is about files on
 * disk, and a filesystem stubbed well enough to be worth testing against is a
 * filesystem.
 */

let root: string
let store: Store

function write(relPath: string, content: string): string {
  const path = join(root, relPath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** The scope and its tree, re-read, which is how the console addresses a file. */
function scopeAndTree(): ReturnType<typeof readConfigTree> {
  return readConfigTree(projectConfigScope(root))
}

function fileNamed(name: string): NonNullable<ReturnType<typeof scopeAndTree>['files'][number]> {
  const found = scopeAndTree().files.find((file) => file.name === name)
  if (!found) throw new Error(`no file named ${name} in the tree`)
  return found
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-crud-'))
  store = openStore({ file: ':memory:' })
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe('checkConfigName', () => {
  it('accepts the shape the CLI addresses and refuses the rest', () => {
    expect(checkConfigName('skill', 'brew-coffee').ok).toBe(true)
    expect(checkConfigName('command', 'spec:plan').segments).toEqual(['spec', 'plan'])
    // The two separators mean the same thing: a command is shown as `spec:plan`
    // and stored as `spec/plan.md`, and somebody typing either is not wrong.
    expect(checkConfigName('command', 'spec/plan').segments).toEqual(['spec', 'plan'])

    expect(checkConfigName('skill', 'Brew Coffee').ok).toBe(false)
    expect(checkConfigName('skill', 'brew_coffee').ok).toBe(false)
    expect(checkConfigName('skill', '').ok).toBe(false)
    expect(checkConfigName('command', 'a::b').ok).toBe(false)
    expect(checkConfigName('command', '../escape').ok).toBe(false)
    // Windows will not name a file this whatever the API says.
    expect(checkConfigName('agent', 'con').ok).toBe(false)
  })

  it('refuses a namespaced skill, because a skill is one directory', () => {
    expect(checkConfigName('skill', 'group:thing').ok).toBe(false)
    expect(checkConfigName('command', 'group:thing').ok).toBe(true)
  })
})

describe('planConfigFile', () => {
  it('puts each kind where the CLI reads it, and says how it is addressed', () => {
    const skill = planConfigFile({ kind: 'skill', name: 'think', userScope: false })
    expect(skill.plan?.relPath).toBe('.claude/skills/think/SKILL.md')
    expect(skill.plan?.dirRelPath).toBe('.claude/skills/think')
    expect(skill.plan?.address).toBe('think')

    const command = planConfigFile({ kind: 'command', name: 'spec:plan', userScope: false })
    expect(command.plan?.relPath).toBe('.claude/commands/spec/plan.md')
    expect(command.plan?.address).toBe('/spec:plan')

    // The user scope's base directory *is* `.claude`, so nothing in a
    // user-scope relative path names it.
    const userSkill = planConfigFile({ kind: 'skill', name: 'think', userScope: true })
    expect(userSkill.plan?.relPath).toBe('skills/think/SKILL.md')

    // Both of these sit beside a project's `.claude` rather than inside it.
    expect(planConfigFile({ kind: 'claude-md', name: '', userScope: false }).plan?.relPath).toBe(
      'CLAUDE.md'
    )
    expect(planConfigFile({ kind: 'mcp', name: '', userScope: false }).plan?.relPath).toBe(
      '.mcp.json'
    )
  })

  it('refuses the two project-only kinds in the user scope', () => {
    expect(planConfigFile({ kind: 'mcp', name: '', userScope: true }).ok).toBe(false)
    expect(planConfigFile({ kind: 'settings-local', name: '', userScope: true }).ok).toBe(false)
    expect(planConfigFile({ kind: 'settings', name: '', userScope: true }).ok).toBe(true)
  })

  it('scaffolds frontmatter that parses and carries a description', () => {
    for (const kind of ['skill', 'agent'] as const) {
      const plan = planConfigFile({ kind, name: 'probe', userScope: false }).plan
      const parsed = parseFrontmatter(plan?.content ?? '')
      expect(parsed).not.toBeNull()
      const fields = new Map((parsed?.fields ?? []).map((field) => [field.key, field.value]))
      // The name has to match the thing it names, and the description is what
      // decides whether the model ever loads it - a blank one is the quiet
      // failure the scaffold exists to prevent.
      expect(fields.get('name')).toBe('probe')
      expect((fields.get('description') ?? '').length).toBeGreaterThan(20)
    }
    // A settings file's empty state is an object, not an empty file: the CLI
    // parses this layer, and zero bytes is a parse error.
    expect(
      JSON.parse(planConfigFile({ kind: 'settings', name: '', userScope: false }).plan?.content ?? '')
    ).toEqual({})
    expect(
      JSON.parse(planConfigFile({ kind: 'mcp', name: '', userScope: false }).plan?.content ?? '')
    ).toEqual({ mcpServers: {} })
  })
})

describe('configUnit', () => {
  it('is a skill’s whole directory and one file for everything else', () => {
    write('.claude/skills/think/SKILL.md', '# Think\n')
    write('.claude/skills/think/reference.md', '# Reference\n')
    write('.claude/skills/other/SKILL.md', '# Other\n')
    write('.claude/commands/plan.md', '# Plan\n')

    const tree = scopeAndTree()
    const skill = tree.files.find((file) => file.name === 'think')
    const command = tree.files.find((file) => file.name === 'plan')
    expect(configUnit(tree.files, skill!).map((f) => f.relPath).sort()).toEqual([
      '.claude/skills/think/SKILL.md',
      '.claude/skills/think/reference.md'
    ].sort())
    expect(configUnit(tree.files, command!)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('createConfigFile', () => {
  it('writes the scaffold and takes a create snapshot before touching the disk', () => {
    const scope = projectConfigScope(root)
    const before = countConfigSnapshots(store)

    const result = createConfigFile(store, scope, { kind: 'skill', name: 'brew-coffee' })

    expect(result.ok).toBe(true)
    expect(result.relPath).toBe('.claude/skills/brew-coffee/SKILL.md')
    expect(existsSync(join(root, '.claude', 'skills', 'brew-coffee', 'SKILL.md'))).toBe(true)
    expect(countConfigSnapshots(store)).toBe(before + 1)

    const rows = readConfigSnapshots(store, root, '.claude/skills/brew-coffee/SKILL.md')
    expect(rows[0]?.reason).toBe('create')

    // The tree agrees the thing that was made is the thing that was asked for.
    expect(fileNamed('brew-coffee').kind).toBe('skill')
  })

  it('refuses a collision before it writes anything', () => {
    const scope = projectConfigScope(root)
    createConfigFile(store, scope, { kind: 'skill', name: 'think' })
    const body = readFileSync(join(root, '.claude/skills/think/SKILL.md'), 'utf8')
    const snapshots = countConfigSnapshots(store)

    const again = createConfigFile(store, scope, { kind: 'skill', name: 'think' })

    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/already/i)
    // Nothing was written and nothing was recorded, which is what "before
    // anything is written" has to mean.
    expect(readFileSync(join(root, '.claude/skills/think/SKILL.md'), 'utf8')).toBe(body)
    expect(countConfigSnapshots(store)).toBe(snapshots)
  })

  it('counts a bare skill directory as the name being taken', () => {
    mkdirSync(join(root, '.claude', 'skills', 'think'), { recursive: true })
    const result = createConfigFile(store, projectConfigScope(root), {
      kind: 'skill',
      name: 'think'
    })
    expect(result.ok).toBe(false)
  })

  it('refuses a name the CLI could not address, and writes nothing', () => {
    const result = createConfigFile(store, projectConfigScope(root), {
      kind: 'command',
      name: 'Not A Name'
    })
    expect(result.ok).toBe(false)
    expect(countConfigSnapshots(store)).toBe(0)
    expect(existsSync(join(root, '.claude', 'commands'))).toBe(false)
  })

  it('restores a create snapshot by removing the file again', () => {
    const scope = projectConfigScope(root)
    const created = createConfigFile(store, scope, { kind: 'rule', name: 'house-style' })
    expect(created.snapshotId).not.toBeNull()

    restoreConfigSnapshot(store, created.snapshotId ?? 0, created.path ?? '')
    expect(existsSync(created.path ?? '')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

describe('renameConfigEntry', () => {
  it('moves a skill’s whole directory, not just its SKILL.md', () => {
    write('.claude/skills/think/SKILL.md', '---\nname: think\ndescription: Ponder.\n---\n# Think\n')
    write('.claude/skills/think/reference.md', '# Reference\n')
    const tree = scopeAndTree()

    const result = renameConfigEntry(
      store,
      projectConfigScope(root),
      tree.files,
      fileNamed('think'),
      'ponder'
    )

    expect(result.ok).toBe(true)
    expect(result.moved).toHaveLength(2)
    expect(existsSync(join(root, '.claude/skills/ponder/SKILL.md'))).toBe(true)
    // The bundled resource came with it, byte for byte - a skill that arrives
    // without its references is a skill that has been broken by being renamed.
    expect(readFileSync(join(root, '.claude/skills/ponder/reference.md'), 'utf8')).toBe(
      '# Reference\n'
    )
    // And the old directory is gone, rather than left behind empty.
    expect(existsSync(join(root, '.claude/skills/think'))).toBe(false)
    expect(fileNamed('ponder').kind).toBe('skill')

    // The frontmatter followed it. A skill whose `name` and whose directory
    // disagree has been half-renamed, and the CLI resolves it by the directory.
    const moved = readFileSync(join(root, '.claude/skills/ponder/SKILL.md'), 'utf8')
    expect(parseFrontmatter(moved)?.fields).toContainEqual({ key: 'name', value: 'ponder' })
    expect(result.frontmatterRenamed).toBe(true)
    // Nothing else in the file moved.
    expect(moved).toBe(
      '---\nname: ponder\ndescription: Ponder.\n---\n# Think\n'
    )
  })

  it('leaves a frontmatter name alone when it does not name the old address', () => {
    // Somebody set this on purpose - it is not the thing being renamed, so Helm
    // does not touch it. The rename still happens.
    write('.claude/skills/think/SKILL.md', '---\nname: something-else\n---\n# Think\n')
    const result = renameConfigEntry(
      store,
      projectConfigScope(root),
      scopeAndTree().files,
      fileNamed('think'),
      'ponder'
    )
    expect(result.ok).toBe(true)
    expect(result.frontmatterRenamed).toBe(false)
    expect(readFileSync(join(root, '.claude/skills/ponder/SKILL.md'), 'utf8')).toBe(
      '---\nname: something-else\n---\n# Think\n'
    )
  })

  it('records the source’s original bytes, not the retitled ones', () => {
    const before = '---\nname: think\ndescription: Ponder.\n---\n# Think\n'
    write('.claude/skills/think/SKILL.md', before)
    const scope = projectConfigScope(root)
    renameConfigEntry(store, scope, scopeAndTree().files, fileNamed('think'), 'ponder')

    // The whole point of the copy-then-delete shape: undoing a rename has to
    // give back what was on disk, not what the rename would have written.
    const rows = readConfigSnapshots(store, root, '.claude/skills/think/SKILL.md')
    expect(rows[0]?.reason).toBe('rename')
    restoreConfigSnapshot(store, rows[0]?.id ?? 0, join(root, '.claude/skills/think/SKILL.md'))
    expect(readFileSync(join(root, '.claude/skills/think/SKILL.md'), 'utf8')).toBe(before)
  })

  it('renames a command across its namespace path and prunes what it emptied', () => {
    write('.claude/commands/spec/plan.md', '# Plan\n')
    const tree = scopeAndTree()

    const result = renameConfigEntry(
      store,
      projectConfigScope(root),
      tree.files,
      fileNamed('spec:plan'),
      'review:plan'
    )

    expect(result.ok).toBe(true)
    expect(result.relPath).toBe('.claude/commands/review/plan.md')
    expect(readFileSync(join(root, '.claude/commands/review/plan.md'), 'utf8')).toBe('# Plan\n')
    expect(existsSync(join(root, '.claude/commands/spec'))).toBe(false)
    expect(fileNamed('review:plan').kind).toBe('command')
  })

  it('leaves both halves recoverable: the source’s bytes and the destination’s absence', () => {
    write('.claude/commands/plan.md', '# Plan\n')
    const scope = projectConfigScope(root)
    const result = renameConfigEntry(store, scope, scopeAndTree().files, fileNamed('plan'), 'design')
    expect(result.ok).toBe(true)

    const sourceRows = readConfigSnapshots(store, root, '.claude/commands/plan.md')
    expect(sourceRows[0]?.reason).toBe('rename')
    const destRows = readConfigSnapshots(store, root, '.claude/commands/design.md')
    expect(destRows[0]?.reason).toBe('create')

    // Restoring the source row puts the file back where it was, with its bytes.
    restoreConfigSnapshot(store, sourceRows[0]?.id ?? 0, join(root, '.claude/commands/plan.md'))
    expect(readFileSync(join(root, '.claude/commands/plan.md'), 'utf8')).toBe('# Plan\n')
    // Restoring the destination's `create` row removes what the rename made.
    restoreConfigSnapshot(store, destRows[0]?.id ?? 0, join(root, '.claude/commands/design.md'))
    expect(existsSync(join(root, '.claude/commands/design.md'))).toBe(false)
  })

  it('refuses a collision and a rename of a file the CLI finds by name', () => {
    write('.claude/skills/think/SKILL.md', '# Think\n')
    write('.claude/skills/ponder/SKILL.md', '# Ponder\n')
    write('.claude/settings.json', '{}\n')
    const scope = projectConfigScope(root)

    const collision = renameConfigEntry(
      store,
      scope,
      scopeAndTree().files,
      fileNamed('think'),
      'ponder'
    )
    expect(collision.ok).toBe(false)
    expect(readFileSync(join(root, '.claude/skills/ponder/SKILL.md'), 'utf8')).toBe('# Ponder\n')

    const settings = renameConfigEntry(
      store,
      scope,
      scopeAndTree().files,
      fileNamed('settings.json'),
      'options'
    )
    expect(settings.ok).toBe(false)
    expect(existsSync(join(root, '.claude/settings.json'))).toBe(true)
  })

  it('refuses to move a skill bundling bytes it cannot record, and moves nothing', () => {
    write('.claude/skills/think/SKILL.md', '# Think\n')
    writeFileSync(join(root, '.claude/skills/think/logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    const scope = projectConfigScope(root)

    const result = renameConfigEntry(store, scope, scopeAndTree().files, fileNamed('think'), 'ponder')

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not text/i)
    expect(existsSync(join(root, '.claude/skills/ponder'))).toBe(false)
    expect(existsSync(join(root, '.claude/skills/think/SKILL.md'))).toBe(true)
    expect(countConfigSnapshots(store)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('deleteConfigEntry', () => {
  it('records every file before removing any, and restores from the same history', () => {
    write('.claude/agents/reviewer.md', '---\ndescription: Reviews.\n---\nBody.\n')
    const scope = projectConfigScope(root)
    const before = readFileSync(join(root, '.claude/agents/reviewer.md'), 'utf8')

    const result = deleteConfigEntry(store, scope, scopeAndTree().files, fileNamed('reviewer'))

    expect(result.ok).toBe(true)
    expect(existsSync(join(root, '.claude/agents/reviewer.md'))).toBe(false)

    // The row is ordinary per-file history, listed under the file's own key -
    // which is what makes "undo this delete" and "restore this version" the
    // same mechanism rather than two.
    const rows = readConfigSnapshots(store, root, '.claude/agents/reviewer.md')
    expect(rows[0]?.reason).toBe('delete')
    expect(rows[0]?.id).toBe(result.removed[0]?.snapshotId)

    restoreConfigSnapshot(store, rows[0]?.id ?? 0, join(root, '.claude/agents/reviewer.md'))
    expect(readFileSync(join(root, '.claude/agents/reviewer.md'), 'utf8')).toBe(before)
  })

  it('removes a skill’s whole directory and can put all of it back', () => {
    write('.claude/skills/think/SKILL.md', '# Think\n')
    write('.claude/skills/think/reference.md', '# Reference\n')
    const scope = projectConfigScope(root)

    const result = deleteConfigEntry(store, scope, scopeAndTree().files, fileNamed('think'))

    expect(result.ok).toBe(true)
    expect(result.removed).toHaveLength(2)
    expect(existsSync(join(root, '.claude/skills/think'))).toBe(false)

    for (const removed of result.removed) {
      restoreConfigSnapshot(store, removed.snapshotId, removed.path)
    }
    expect(readFileSync(join(root, '.claude/skills/think/SKILL.md'), 'utf8')).toBe('# Think\n')
    expect(readFileSync(join(root, '.claude/skills/think/reference.md'), 'utf8')).toBe(
      '# Reference\n'
    )
  })

  it('refuses a skill bundling bytes it cannot record, and removes nothing', () => {
    write('.claude/skills/think/SKILL.md', '# Think\n')
    writeFileSync(join(root, '.claude/skills/think/logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]))

    const result = deleteConfigEntry(
      store,
      projectConfigScope(root),
      scopeAndTree().files,
      fileNamed('think')
    )

    expect(result.ok).toBe(false)
    expect(existsSync(join(root, '.claude/skills/think/SKILL.md'))).toBe(true)
    expect(countConfigSnapshots(store)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The posture
// ---------------------------------------------------------------------------

describe('the writable surface', () => {
  it('is exactly what it was: nothing outside the scope, nothing that is not config', () => {
    const outside = join(root, 'outside.md')
    writeFileSync(outside, 'not config\n')
    write('.claude/commands/plan.md', '# Plan\n')

    const scope = projectConfigScope(join(root, 'nested'))
    mkdirSync(join(root, 'nested'), { recursive: true })

    // A file that is not under the scope it claims. `assertWritable` is the
    // floor under every path in this module, and none of them widened it.
    expect(() =>
      deleteConfigEntry(store, scope, scopeAndTree().files, {
        path: outside,
        relPath: '../outside.md',
        kind: 'other',
        name: 'outside.md',
        size: 11,
        mtimeMs: 0,
        description: null,
        binary: false
      })
    ).toThrow(/not inside/i)
    expect(existsSync(outside)).toBe(true)
  })

  it('creates in the user scope through the same guard, whose base *is* .claude', () => {
    // `userConfigScope` treats the directory it is handed as `.claude` itself,
    // which is the one shape `assertWritable` has a special case for.
    const home = join(root, 'home', '.claude')
    mkdirSync(home, { recursive: true })
    const scope = userConfigScope(home)

    const result = createConfigFile(store, scope, { kind: 'skill', name: 'think' })
    expect(result.ok).toBe(true)
    expect(result.relPath).toBe('skills/think/SKILL.md')
    expect(existsSync(join(home, 'skills', 'think', 'SKILL.md'))).toBe(true)
  })
})
