import type { ConfigFile, ConfigFileKind } from '../types'

/**
 * What a configuration file may be called, where it lands, and what goes in it.
 *
 * Pure by construction - no `node:` imports - and re-exported from `types.ts`,
 * which is the one entry point the renderer may import values from (CLAUDE.md,
 * hard rules). The argument is `validate.ts`'s: a name the CLI cannot address
 * must be refused *before* the request is sent, so the dialog refuses it as it
 * is typed rather than writing a file and apologising. The write path in
 * `create-rename-delete.ts` runs these same functions again, because a check in
 * the renderer is a courtesy and the one in main is the guarantee.
 *
 * "How the CLI would address it" is the whole rule here, and it is not the same
 * question as "is this a legal filename". A skill is addressed by its
 * *directory*; a command by its *path*, colon-separated, so `commands/spec/plan.md`
 * is `/spec:plan`; a settings file only by the exact name the CLI looks for.
 * Every refusal below is one of those three facts, not a house style.
 */

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * The kinds `New` can scaffold.
 *
 * `hook` is absent deliberately. A hook is a *script* - Helm cannot guess
 * whether it should be PowerShell, sh or node - and it does nothing until
 * `settings.json` names it in a matcher, so an empty file of a guessed language
 * would be a scaffold that scaffolds nothing. `other` is absent because it is
 * not a thing anybody sets out to create; it is what the tree calls a file it
 * has no name for.
 */
export type CreatableKind =
  | 'skill'
  | 'command'
  | 'agent'
  | 'rule'
  | 'settings'
  | 'settings-local'
  | 'claude-md'
  | 'mcp'

export interface CreatableKindSpec {
  kind: CreatableKind
  /** Singular, as the dialog's picker says it. */
  label: string
  /**
   * False for the fixed-name singletons. The CLI looks for `settings.json` by
   * that name, so there is nothing to type and the field is not offered.
   */
  named: boolean
  /** Only these three scopes may hold it; see `planConfigFile`. */
  projectOnly: boolean
  /** One line under the picker saying what the thing is for. */
  hint: string
}

export const CREATABLE_KINDS: readonly CreatableKindSpec[] = [
  {
    kind: 'skill',
    label: 'Skill',
    named: true,
    projectOnly: false,
    hint: 'A folder holding a SKILL.md. The folder name is the skill name.'
  },
  {
    kind: 'command',
    label: 'Command',
    named: true,
    projectOnly: false,
    hint: 'A markdown prompt invoked as a slash command. The path is the namespace.'
  },
  {
    kind: 'agent',
    label: 'Agent',
    named: true,
    projectOnly: false,
    hint: 'A subagent the main agent can hand work to.'
  },
  {
    kind: 'rule',
    label: 'Rule',
    named: true,
    projectOnly: false,
    hint: 'Markdown read alongside CLAUDE.md.'
  },
  {
    kind: 'settings',
    label: 'settings.json',
    named: false,
    projectOnly: false,
    hint: 'Settings for this scope, as a JSON object.'
  },
  {
    kind: 'settings-local',
    label: 'settings.local.json',
    named: false,
    projectOnly: true,
    hint: 'Settings for this machine only, outranking the committed ones.'
  },
  {
    kind: 'claude-md',
    label: 'CLAUDE.md',
    named: false,
    projectOnly: false,
    hint: 'Instructions every session in this scope reads.'
  },
  {
    kind: 'mcp',
    label: '.mcp.json',
    named: false,
    projectOnly: true,
    hint: 'MCP servers this project offers, committed with it.'
  }
]

/**
 * The kinds `Rename` applies to.
 *
 * These four and no others, because for these four the name *is* the address: a
 * skill's directory, a command's namespace path, an agent's file, a rule's file.
 * The singletons are excluded for the opposite reason - the CLI finds
 * `settings.json` by looking for that exact name, so renaming one does not
 * rename a setting, it hides the file. A `hook` or an `other` is an ordinary
 * file with an extension that means something to whatever runs it, and moving
 * one is Explorer's job.
 */
export const RENAMABLE_KINDS: readonly ConfigFileKind[] = ['skill', 'command', 'agent', 'rule']

export function isRenamable(kind: ConfigFileKind): boolean {
  return RENAMABLE_KINDS.includes(kind)
}

/** Why a kind cannot be renamed, as a sentence for the disabled control. */
export function renameRefusal(kind: ConfigFileKind): string | null {
  if (isRenamable(kind)) return null
  if (kind === 'hook' || kind === 'other') {
    return 'Claude Code addresses this file by its path rather than by a name, and its extension matters to whatever runs it. Rename it in Explorer.'
  }
  return 'Claude Code finds this file by its exact name, so renaming it would stop it being read at all.'
}

// ---------------------------------------------------------------------------
// The name itself
// ---------------------------------------------------------------------------

/**
 * One path segment of a name.
 *
 * Lowercase letters, digits and single hyphens. This is the shape the platform
 * documents for a skill - whose directory name and whose frontmatter `name` have
 * to agree - and it is what every command, agent and rule in the wild uses, so
 * one rule covers all four rather than four rules that differ by a character
 * class nobody can remember.
 *
 * It also removes a whole failure mode on Windows: a case-insensitive filesystem
 * makes `Foo` and `foo` the same directory, so a name that could carry case
 * would need a collision check that knew that. A lowercase-only name cannot
 * collide with itself.
 */
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Names Windows will not give a file whatever the API says. */
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/

/** Long enough for the longest real skill name; short enough to stay a name. */
const MAX_SEGMENT = 64

/**
 * Deep enough for `commands/spec/section/thing`, bounded because the tree walk
 * is (`MAX_DEPTH` in `tree.ts`) and a file below its floor would be written and
 * then never listed.
 */
const MAX_SEGMENTS = 5

export interface NameCheck {
  ok: boolean
  /** Null when ok; otherwise one sentence naming the rule that was broken. */
  error: string | null
  /** The name split into path segments. Empty when it did not pass. */
  segments: readonly string[]
}

/**
 * Splits and checks a typed name.
 *
 * `:` and `/` are both accepted as the separator and mean the same thing,
 * because a command is *displayed* as `spec:plan` and *stored* as `spec/plan.md`
 * - somebody who has just read one of those and is typing the other is not
 * making a mistake.
 */
export function checkConfigName(kind: ConfigFileKind, raw: string): NameCheck {
  const fail = (error: string): NameCheck => ({ ok: false, error, segments: [] })
  const trimmed = raw.trim()
  if (trimmed === '') return fail('Give it a name.')

  const segments = trimmed.split(/[:/\\]/)
  const nested = kind !== 'skill'

  if (!nested && segments.length > 1) {
    return fail(
      'A skill name is a single word - the folder it lives in. Skills are not namespaced by path.'
    )
  }
  if (segments.length > MAX_SEGMENTS) {
    return fail(`That is ${String(segments.length)} levels deep; ${String(MAX_SEGMENTS)} is the most.`)
  }

  for (const segment of segments) {
    if (segment === '') {
      return fail('An empty step in the name - two separators together, or one at an end.')
    }
    if (segment.length > MAX_SEGMENT) {
      return fail(`"${segment}" is longer than ${String(MAX_SEGMENT)} characters.`)
    }
    if (RESERVED_DEVICE.test(segment)) {
      return fail(`Windows reserves "${segment}" for a device and will not name a file that.`)
    }
    if (!SEGMENT.test(segment)) {
      return fail(
        'Lowercase letters, digits and single hyphens between them - that is how the CLI addresses one of these.'
      )
    }
  }

  return { ok: true, error: null, segments }
}

// ---------------------------------------------------------------------------
// Where it lands
// ---------------------------------------------------------------------------

export interface ConfigFilePlan {
  /**
   * The file itself, relative to the scope's *base* directory and
   * forward-slashed - the same string as `ConfigFile.relPath`, so a caller can
   * compare it against a tree it already has.
   */
  relPath: string
  /**
   * For a skill, the directory that carries the name and that a rename moves.
   * Null for every other kind, whose unit is the one file.
   */
  dirRelPath: string | null
  /** How Claude Code addresses it: `/spec:plan`, `think`, `settings.json`. */
  address: string
  /** The scaffold's bytes, newline-terminated. */
  content: string
}

export interface PlanResult {
  ok: boolean
  error: string | null
  plan: ConfigFilePlan | null
}

/**
 * The `.claude` prefix, or the absence of one.
 *
 * The user scope's base directory *is* `.claude` (`userConfigScope`), so nothing
 * in a user-scope relative path names it. `CLAUDE.md` and `.mcp.json` are the
 * other way round: they sit *beside* a project's `.claude`, and the user scope's
 * instruction file lives inside it - which comes out as the same relative path
 * either way, so both are prefix-free.
 */
function inside(userScope: boolean, ...parts: string[]): string {
  return [...(userScope ? [] : ['.claude']), ...parts].join('/')
}

export interface PlanInput {
  kind: CreatableKind
  /** Ignored for the fixed-name singletons. */
  name: string
  /** True when the scope's base directory is itself `.claude` - the user scope. */
  userScope: boolean
}

/**
 * Where a new file of this kind and name goes, and what is written into it.
 *
 * The scaffolds are not empty files, and that is the point of the criterion they
 * satisfy: an empty `SKILL.md` is not a skill, it is a file the CLI skips. Each
 * one is the smallest thing the platform will actually load, with the field that
 * decides whether it is *used* filled in with a sentence saying so - a skill and
 * an agent are selected on their `description` alone, and a blank one is the
 * quiet failure this scaffold exists to prevent.
 */
export function planConfigFile({ kind, name, userScope }: PlanInput): PlanResult {
  const fail = (error: string): PlanResult => ({ ok: false, error, plan: null })

  const spec = CREATABLE_KINDS.find((candidate) => candidate.kind === kind)
  if (!spec) return fail(`Helm does not scaffold a ${kind}.`)
  if (spec.projectOnly && userScope) {
    return fail(
      kind === 'mcp'
        ? 'A .mcp.json is read from a project directory. The user scope has none - user MCP servers live in ~/.claude.json, which the MCP tab manages.'
        : 'A settings.local.json is the project-local layer. The user scope is the layer underneath it, and its file is settings.json.'
    )
  }

  if (!spec.named) {
    const [relPath, address, content] = fixedFile(kind, userScope)
    return { ok: true, error: null, plan: { relPath, dirRelPath: null, address, content } }
  }

  const checked = checkConfigName(kind, name)
  if (!checked.ok) return fail(checked.error ?? 'That name will not do.')
  const segments = checked.segments
  const leaf = segments.at(-1) ?? ''

  if (kind === 'skill') {
    const dirRelPath = inside(userScope, 'skills', leaf)
    return {
      ok: true,
      error: null,
      plan: {
        relPath: `${dirRelPath}/SKILL.md`,
        dirRelPath,
        address: leaf,
        content: skillScaffold(leaf)
      }
    }
  }

  const folder = kind === 'command' ? 'commands' : kind === 'agent' ? 'agents' : 'rules'
  const relPath = inside(userScope, folder, `${segments.join('/')}.md`)
  const address =
    kind === 'command' ? `/${segments.join(':')}` : segments.join('/')
  const content =
    kind === 'command'
      ? commandScaffold(address)
      : kind === 'agent'
        ? agentScaffold(leaf)
        : ruleScaffold(leaf)

  return { ok: true, error: null, plan: { relPath, dirRelPath: null, address, content } }
}

/** `relPath`, `address`, `content` for the four kinds whose name is fixed. */
function fixedFile(kind: CreatableKind, userScope: boolean): [string, string, string] {
  switch (kind) {
    case 'settings':
      return [inside(userScope, 'settings.json'), 'settings.json', '{}\n']
    case 'settings-local':
      return [inside(userScope, 'settings.local.json'), 'settings.local.json', '{}\n']
    case 'claude-md':
      // Beside `.claude` for a project, inside it for the user scope - which is
      // the same relative path from each scope's own base directory.
      return ['CLAUDE.md', 'CLAUDE.md', claudeMdScaffold()]
    case 'mcp':
      return ['.mcp.json', '.mcp.json', '{\n  "mcpServers": {}\n}\n']
    default:
      return [inside(userScope, 'settings.json'), 'settings.json', '{}\n']
  }
}

// ---------------------------------------------------------------------------
// Scaffolds
// ---------------------------------------------------------------------------

/**
 * No colon-space anywhere in a frontmatter value below.
 *
 * The block is YAML, and a plain scalar containing `: ` is a mapping rather than
 * a string - so a helpful placeholder written with a colon in it would produce a
 * file the CLI cannot parse, from the one control whose whole job is to produce
 * a file that loads.
 */
function skillScaffold(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: What this skill does and when Claude should load it. This line is the only part read while deciding, so it is what makes the skill get used.',
    '---',
    '',
    `# ${name}`,
    '',
    'Replace this with the instructions themselves.',
    ''
  ].join('\n')
}

function commandScaffold(address: string): string {
  return [
    '---',
    `description: What ${address} does, as one line for the slash-command menu.`,
    '---',
    '',
    'Replace this with the prompt this command runs.',
    '',
    '$ARGUMENTS is whatever was typed after the command name.',
    ''
  ].join('\n')
}

function agentScaffold(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: When to hand work to this agent and what it is good at. The main agent reads this line to decide whether to delegate.',
    '---',
    '',
    "Replace this with the agent's own system prompt.",
    ''
  ].join('\n')
}

function ruleScaffold(name: string): string {
  return [`# ${name}`, '', 'Replace this with the rule, stated as an instruction.', ''].join('\n')
}

function claudeMdScaffold(): string {
  return [
    '# Instructions',
    '',
    'Everything here is read by every session started in this scope.',
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------
// What one entry is made of
// ---------------------------------------------------------------------------

/**
 * Every file the console addresses as one entry.
 *
 * A skill is a *directory*, so the thing a rename moves and a delete removes is
 * the directory's whole contents - the `SKILL.md` and whatever it bundles beside
 * it. Everything else is one file.
 *
 * Computed over a `ConfigTree`'s own listing rather than by walking the disk, so
 * the set the confirmation names and the set the write path acts on are the same
 * set produced by the same function. A preview that enumerated by a second rule
 * would eventually promise to remove one thing and remove another.
 */
export function configUnit(files: readonly ConfigFile[], file: ConfigFile): ConfigFile[] {
  if (file.kind !== 'skill') return [file]
  const dir = file.relPath.slice(0, file.relPath.lastIndexOf('/'))
  if (dir === '') return [file]
  const prefix = `${dir.toLowerCase()}/`
  // The `SKILL.md` first, so a caller reporting "and 2 more" names the file the
  // user actually chose.
  const rest = files.filter(
    (candidate) =>
      candidate.path !== file.path && candidate.relPath.toLowerCase().startsWith(prefix)
  )
  return [file, ...rest]
}
