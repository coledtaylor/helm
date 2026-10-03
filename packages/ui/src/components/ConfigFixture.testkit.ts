import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  computeEffectiveView,
  projectConfigScope,
  readConfigTree,
  type ConfigFile,
  type ConfigScope,
  type ConfigTree,
  type EffectiveView
} from '@helm/core'

/**
 * A user `.claude` and a project with one of everything the console shows,
 * read by core the way main reads them. Each value a test expects is written
 * here, in the file that produces it.
 */
export interface ConfigFixture {
  root: string
  /** The user's `.claude` directory. */
  userClaude: string
  project: string
  scope: ConfigScope
  tree: ConfigTree
  /** What a session in the project resolves. */
  view: EffectiveView
  file: (relPath: string) => ConfigFile
  dispose: () => void
}

export const PROJECT_SETTINGS = {
  model: 'opus',
  env: { A: 'project', B: 'project' },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/guard.js' }] }] }
}

export const SKILL = '---\nname: think\ndescription: Think before acting\n---\n\n# Think\n\nPonder first.\n'

export function makeConfigFixture(): ConfigFixture {
  const root = mkdtempSync(join(tmpdir(), 'helm config ui-'))
  const write = (path: string, body: string): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }

  const userClaude = join(root, 'home', '.claude')
  write(join(userClaude, 'settings.json'), `${JSON.stringify({ model: 'sonnet', env: { A: 'user' } }, null, 2)}\n`)

  const project = join(root, 'app')
  write(join(project, 'CLAUDE.md'), '# App\n\nInstructions for the app.\n')
  write(join(project, '.claude', 'settings.json'), `${JSON.stringify(PROJECT_SETTINGS, null, 2)}\n`)
  write(join(project, '.claude', 'settings.local.json'), `${JSON.stringify({ env: { B: 'local' } }, null, 2)}\n`)
  write(join(project, '.claude', 'hooks', 'guard.js'), 'process.exit(0)\n')
  write(join(project, '.claude', 'skills', 'think', 'SKILL.md'), SKILL)
  write(join(project, '.claude', 'skills', 'think', 'prompts.md'), '# Prompts\n\nAsk twice.\n')
  write(join(project, '.claude', 'commands', 'spec', 'plan.md'), '---\ndescription: Plan a spec\n---\n\nPlan it.\n')
  write(join(project, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews a change\n---\n\nReview.\n')

  const scope = projectConfigScope(project, 'project', 'app')
  const tree = readConfigTree(scope)
  const view = computeEffectiveView({ cwd: project, overlays: [], userHome: userClaude })

  return {
    root,
    userClaude,
    project,
    scope,
    tree,
    view,
    file: (relPath) => {
      const found = tree.files.find((candidate) => candidate.relPath === relPath)
      if (!found) throw new Error(`the fixture has no ${relPath}`)
      return found
    },
    dispose: () => rmSync(root, { recursive: true, force: true })
  }
}
