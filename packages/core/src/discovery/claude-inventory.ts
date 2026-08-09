import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_INVENTORY, type ClaudeInventory } from '../types'

/**
 * Counts a project's `.claude/` contents the way Claude Code resolves them.
 *
 * The distinction that matters: a *skill* is a directory containing `SKILL.md`,
 * while *commands* and *agents* are markdown files at any depth. Counting
 * top-level entries instead - the obvious implementation - reports
 * `repos/atlas` as having 1 command when it has 20 under `commands/spec/`,
 * because namespaced commands live in subdirectories (`/spec:plan`).
 */

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Markdown files anywhere under `dir`. Symlinked directories are not followed:
 * a junction pointing back up the tree would otherwise recurse forever. */
async function countMarkdown(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }

  let count = 0
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      count += await countMarkdown(join(dir, entry.name))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      count += 1
    }
  }
  return count
}

/** Directories holding a `SKILL.md`, at any depth. */
async function countSkills(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }

  let count = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const child = join(dir, entry.name)
    if (await exists(join(child, 'SKILL.md'))) count += 1
    else count += await countSkills(child)
  }
  return count
}

export async function readClaudeInventory(projectPath: string): Promise<ClaudeInventory> {
  const claudeDir = join(projectPath, '.claude')
  if (!(await isDirectory(claudeDir))) {
    // A project can still carry a CLAUDE.md without a `.claude/` directory, and
    // that alone changes how a session behaves, so it is checked either way.
    return { ...EMPTY_INVENTORY, claudeMd: await exists(join(projectPath, 'CLAUDE.md')) }
  }

  const [skills, commands, agents, hooks, settings, settingsLocal, claudeMd, mcp] =
    await Promise.all([
      countSkills(join(claudeDir, 'skills')),
      countMarkdown(join(claudeDir, 'commands')),
      countMarkdown(join(claudeDir, 'agents')),
      isDirectory(join(claudeDir, 'hooks')),
      exists(join(claudeDir, 'settings.json')),
      exists(join(claudeDir, 'settings.local.json')),
      exists(join(projectPath, 'CLAUDE.md')),
      exists(join(projectPath, '.mcp.json'))
    ])

  return {
    skills,
    commands,
    agents,
    hooks,
    settings: settings || settingsLocal,
    claudeMd,
    mcp
  }
}

export async function hasClaudeDir(projectPath: string): Promise<boolean> {
  return isDirectory(join(projectPath, '.claude'))
}
