import type {
  ConfigFile,
  ConfigFileContent,
  ConfigRendered,
  ConfigScope,
  ConfigTree,
  EffectiveView
} from '@helm/core/types'
import recording from './fixtures/config.fixture.json'
import { fixturePath, recorded } from './recorded.testkit'

/**
 * A user `.claude` and a project with one of everything the console shows, as
 * the host answers for them: the tree, the effective view, each file's bytes
 * and each file rendered. The files were:
 *
 * - `home/.claude/settings.json`: `{ model: 'sonnet', env: { A: 'user' } }`
 * - `app/CLAUDE.md`
 * - `app/.claude/settings.json`: `PROJECT_SETTINGS`
 * - `app/.claude/settings.local.json`: `{ env: { B: 'local' } }`
 * - `app/.claude/hooks/guard.js`, named by the PreToolUse hook
 * - `app/.claude/skills/think/SKILL.md` (`SKILL`) and `prompts.md` beside it
 * - `app/.claude/commands/spec/plan.md`, `app/.claude/agents/reviewer.md`
 * - `app/.claude/workflows/audit-routes.js`, whose `meta.name` is `route-audit`
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
  /** What `config:read` answers for a file of the tree. */
  content: (relPath: string) => ConfigFileContent
  /** What `config:render` answers for a file of the tree. */
  rendered: (relPath: string) => ConfigRendered
  dispose: () => void
}

export const PROJECT_SETTINGS = {
  model: 'opus',
  env: { A: 'project', B: 'project' },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/guard.js' }] }] }
}

export const SKILL = '---\nname: think\ndescription: Think before acting\n---\n\n# Think\n\nPonder first.\n'

interface Recording {
  scope: ConfigScope
  tree: ConfigTree
  view: EffectiveView
  contents: Record<string, ConfigFileContent>
  rendered: Record<string, ConfigRendered>
}

function lookup<T>(table: Record<string, T>, relPath: string): T {
  const found = table[relPath]
  if (found === undefined) throw new Error(`the fixture has no ${relPath}`)
  return found
}

export function makeConfigFixture(): ConfigFixture {
  const answer = recorded<Recording>(recording)
  return {
    root: fixturePath(),
    userClaude: fixturePath('home/.claude'),
    project: fixturePath('app'),
    scope: answer.scope,
    tree: answer.tree,
    view: answer.view,
    file: (relPath) => {
      const found = answer.tree.files.find((candidate) => candidate.relPath === relPath)
      if (!found) throw new Error(`the fixture has no ${relPath}`)
      return found
    },
    content: (relPath) => lookup(answer.contents, relPath),
    rendered: (relPath) => lookup(answer.rendered, relPath),
    dispose: () => undefined
  }
}
