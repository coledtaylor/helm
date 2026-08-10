import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/**
 * Making a harness, as opposed to finding one.
 *
 * Helm's minimum harness is a directory with a `harness.yaml` in it. That is
 * the whole definition - the manifest's contents are read when present and
 * decoration when not - which makes scaffolding one cheap enough to offer on
 * first run rather than asking the user to already have a workspace laid out.
 *
 * Two shapes, because there are two ways someone arrives here:
 *
 *   'new'     - a directory that does not exist yet. Gets `harness.yaml`,
 *               `repos/` and `.claude/`, and nothing else.
 *   'convert' - a directory that already holds repositories. Gets a
 *               `harness.yaml` and `repos: .` so the repos already sitting at
 *               its top level stay visible; without that key a harness only
 *               ever lists `repos/*` and converting a folder would hide
 *               everything in it.
 *
 * What is deliberately *not* here is a layout. No notes convention, no rules,
 * no starter skills, no CLAUDE.md - those are one person's way of working, and
 * a scaffold that bakes them in is a scaffold that has an opinion about someone
 * else's workspace. A fuller layout is a named `template:`, which this records
 * and does not invent.
 */

const HARNESS_MANIFEST = 'harness.yaml'

/** The manifest format this writer produces. Not Helm's version, nor the harness's. */
export const HARNESS_FORMAT_VERSION = '1'

/** What `template:` says when the caller does not name one. */
export const MINIMAL_TEMPLATE = 'minimal'

/**
 * Reserved on Windows regardless of extension, and unusable as a directory
 * name even though `mkdir` reports something unhelpful when you try.
 */
const RESERVED_NAMES =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

// Spaces and dashes stay allowed - they are ordinary in a folder name, and
// CLAUDE.md requires paths with spaces to work. These are the ones Windows
// itself refuses.
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*]/

export interface CreateHarnessRequest {
  mode: 'new' | 'convert'
  /**
   * For 'new', the directory the harness is created *inside*. For 'convert',
   * the directory that becomes the harness.
   */
  dir: string
  /** For 'new', the directory name and the manifest's `name`. */
  name?: string | undefined
  /** Recorded in `template:`. The scaffold is the same either way. */
  template?: string | undefined
}

export interface CreateHarnessResult {
  /** The harness directory, or null when nothing was written. */
  path: string | null
  /** Paths created, relative to `path`, in the order they were written. */
  created: string[]
  /** Why nothing was written. Non-empty means `path` is null. */
  problems: string[]
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Problems with a proposed directory name, as sentences. */
export function harnessNameProblems(name: string): string[] {
  const problems: string[] = []
  const trimmed = name.trim()
  if (trimmed === '') return ['A name is required.']
  if (trimmed === '.' || trimmed === '..') problems.push(`"${trimmed}" is not a folder name.`)
  if (ILLEGAL_NAME_CHARS.test(trimmed)) {
    problems.push('A name cannot contain \\ / : * ? " < > | or a path separator.')
  }
  if (RESERVED_NAMES.test(trimmed)) problems.push(`"${trimmed}" is a reserved device name on Windows.`)
  // Windows silently strips both, so a directory asked for as `dev.` is created
  // as `dev` and every path the caller then builds is wrong.
  if (trimmed.endsWith('.') || trimmed.endsWith(' ')) {
    problems.push('A name cannot end with a space or a dot.')
  }
  return problems
}

/**
 * The manifest, written by hand rather than through a YAML serialiser.
 *
 * Four keys, five when converting, and no comments: "the scaffold contains no
 * opinion" is a claim someone should be able to check by reading the file, and
 * the fewer things in it the shorter that reading is. JSON strings are valid
 * YAML double-quoted scalars, so `JSON.stringify` is the escaping.
 */
function manifestYaml(fields: {
  name: string
  template: string
  version: string
  created: string
  repos?: string | undefined
}): string {
  const lines = [
    `name: ${JSON.stringify(fields.name)}`,
    `template: ${JSON.stringify(fields.template)}`,
    `version: ${JSON.stringify(fields.version)}`,
    `created: ${JSON.stringify(fields.created)}`
  ]
  if (fields.repos !== undefined) lines.push(`repos: ${JSON.stringify(fields.repos)}`)
  return `${lines.join('\n')}\n`
}

/**
 * Whether a directory already holds repositories at its top level.
 *
 * Used only to decide whether a conversion needs `repos: .`: a folder that
 * already has a `repos/` subdirectory means what the default means, and
 * writing the key anyway would point the scanner at the wrong place.
 */
async function hasReposSubdir(dir: string): Promise<boolean> {
  return isDirectory(join(dir, 'repos'))
}

export async function createHarness(
  request: CreateHarnessRequest
): Promise<CreateHarnessResult> {
  const problems: string[] = []
  const dir = resolve(request.dir)

  if (request.mode === 'new') {
    const name = (request.name ?? '').trim()
    problems.push(...harnessNameProblems(name))
    if (!(await isDirectory(dir))) problems.push(`${dir} is not a folder.`)
    if (problems.length > 0) return { path: null, created: [], problems }

    const target = join(dir, name)
    if (await exists(target)) {
      // Not an overwrite, and not a silent merge either: an existing directory
      // here is either already a harness or someone else's data, and the caller
      // asked to create one rather than to adopt one.
      return {
        path: null,
        created: [],
        problems: [
          (await exists(join(target, HARNESS_MANIFEST)))
            ? `${target} is already a harness.`
            : `${target} already exists.`
        ]
      }
    }

    const created: string[] = []
    await mkdir(target, { recursive: true })
    await mkdir(join(target, 'repos'), { recursive: true })
    created.push('repos')
    await mkdir(join(target, '.claude'), { recursive: true })
    created.push('.claude')
    await writeFile(
      join(target, HARNESS_MANIFEST),
      manifestYaml({
        name,
        template: request.template ?? MINIMAL_TEMPLATE,
        version: HARNESS_FORMAT_VERSION,
        created: new Date().toISOString()
      }),
      'utf8'
    )
    created.push(HARNESS_MANIFEST)
    return { path: target, created, problems: [] }
  }

  // convert
  if (!(await isDirectory(dir))) {
    return { path: null, created: [], problems: [`${dir} is not a folder.`] }
  }
  if (await exists(join(dir, HARNESS_MANIFEST))) {
    return { path: null, created: [], problems: [`${dir} is already a harness.`] }
  }

  const created: string[] = []
  const reposAtTopLevel = !(await hasReposSubdir(dir))
  await writeFile(
    join(dir, HARNESS_MANIFEST),
    manifestYaml({
      name: (request.name ?? '').trim() || basename(dir),
      template: request.template ?? MINIMAL_TEMPLATE,
      version: HARNESS_FORMAT_VERSION,
      created: new Date().toISOString(),
      ...(reposAtTopLevel ? { repos: '.' } : {})
    }),
    'utf8'
  )
  created.push(HARNESS_MANIFEST)

  if (!(await isDirectory(join(dir, '.claude')))) {
    await mkdir(join(dir, '.claude'), { recursive: true })
    created.push('.claude')
  }
  return { path: dir, created, problems: [] }
}

/**
 * How many directories a conversion would expose, so the UI can say what is
 * about to happen instead of asking the user to trust it. Counted the way the
 * scanner counts, minus the dot directories it skips.
 */
export async function countTopLevelFolders(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).length
  } catch {
    return 0
  }
}
