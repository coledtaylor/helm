import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readClaudeInventory } from './claude-inventory'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'helm-inventory-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function file(relative: string, content = ''): Promise<void> {
  const path = join(root, relative)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

describe('readClaudeInventory', () => {
  it('reports nothing for a directory with no .claude and no CLAUDE.md', async () => {
    const inventory = await readClaudeInventory(root)
    expect(inventory).toEqual({
      skills: 0,
      commands: 0,
      agents: 0,
      hooks: false,
      settings: false,
      claudeMd: false,
      mcp: false
    })
  })

  it('sees a CLAUDE.md even without a .claude directory', async () => {
    await file('CLAUDE.md', '# rules')
    const inventory = await readClaudeInventory(root)
    expect(inventory.claudeMd).toBe(true)
    expect(inventory.skills).toBe(0)
  })

  it('counts a skill as a directory holding SKILL.md, not as a directory', async () => {
    await file('.claude/skills/notes/SKILL.md')
    await file('.claude/skills/notes/reference.md')
    await file('.claude/skills/notes/scripts/helper.md')
    // A directory under skills/ with no SKILL.md is not a skill.
    await file('.claude/skills/leftovers/README.md')

    const inventory = await readClaudeInventory(root)
    expect(inventory.skills).toBe(1)
  })

  it('counts namespaced commands at every depth', async () => {
    // `/spec:plan` and `/spec:board` live in commands/spec/, so a top-level
    // count would report 1 for what Claude Code exposes as two commands.
    await file('.claude/commands/spec/plan.md')
    await file('.claude/commands/spec/board.md')
    await file('.claude/commands/status.md')

    const inventory = await readClaudeInventory(root)
    expect(inventory.commands).toBe(3)
  })

  it('counts agents as markdown files', async () => {
    await file('.claude/agents/reviewer.md')
    await file('.claude/agents/planner.md')
    await file('.claude/agents/notes.txt')

    const inventory = await readClaudeInventory(root)
    expect(inventory.agents).toBe(2)
  })

  it('flags hooks, settings, CLAUDE.md and .mcp.json', async () => {
    await file('.claude/hooks/post-bash.ps1')
    await file('.claude/settings.json', '{}')
    await file('CLAUDE.md')
    await file('.mcp.json', '{}')

    const inventory = await readClaudeInventory(root)
    expect(inventory.hooks).toBe(true)
    expect(inventory.settings).toBe(true)
    expect(inventory.claudeMd).toBe(true)
    expect(inventory.mcp).toBe(true)
  })

  it('treats settings.local.json as settings', async () => {
    await file('.claude/settings.local.json', '{}')
    const inventory = await readClaudeInventory(root)
    expect(inventory.settings).toBe(true)
  })
})
