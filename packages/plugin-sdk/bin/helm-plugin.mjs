#!/usr/bin/env node
// @ts-check
/**
 * `helm-plugin`: make a plugin, and check one the way Helm will.
 *
 *   helm-plugin create <folder> [--id <id>] [--name <name>]
 *   helm-plugin validate [folder]
 *
 * Plain JavaScript and Node's own modules only, so it runs straight from the
 * SDK's folder - linked by path or installed - with nothing to build first.
 * `validate` runs the validator Helm itself runs (`src/manifest.js`), plus the
 * checks Helm makes on the folder when it loads it (`src/folder.js`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkPluginFolder, MANIFEST_FILE } from '../src/folder.js'
import { ID_PATTERN } from '../src/manifest.js'

const SDK = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATE = join(SDK, 'template')
const SCHEMA = join(SDK, 'helm-plugin.schema.json')
/** What the template is called, replaced by what the new plugin is called. */
const TEMPLATE_ID = 'my-plugin'
const TEMPLATE_NAME = 'My plugin'
const NAME_MAX = 60

const USAGE = `helm-plugin - make a Helm plugin, and check one

Usage:
  helm-plugin create <folder> [--id <id>] [--name <name>]
      Writes a new plugin into <folder>, which must be new or empty: a rail
      icon, a sidebar panel and a tab, in plain HTML and JavaScript.
      --id    the plugin's id: lower-case letters, digits and dashes
              (default: made from the folder's name)
      --name  what Helm calls it (default: made from the id)

  helm-plugin validate [folder]
      Checks the plugin in [folder] (default: this folder) as Helm does when
      it loads it: the manifest, and every file it names. Exits 1 on errors.

  helm-plugin --help
`

/** @param {string} text */
function out(text) {
  process.stdout.write(`${text}\n`)
}

/** @param {string} text */
function err(text) {
  process.stderr.write(`${text}\n`)
}

/**
 * @param {readonly string[]} argv the arguments after the command
 * @param {readonly string[]} known the options the command takes, without `--`
 * @returns {{ positional: string[], options: Map<string, string>, problem: string | null }}
 */
function parse(argv, known) {
  /** @type {string[]} */
  const positional = []
  /** @type {Map<string, string>} */
  const options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = /** @type {string} */ (argv[index])
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (!known.includes(name)) return { positional, options, problem: `unknown option --${name}` }
    let value = eq === -1 ? argv[index + 1] : arg.slice(eq + 1)
    if (eq === -1) index += 1
    if (value === undefined || (eq === -1 && value.startsWith('--'))) return { positional, options, problem: `--${name} needs a value` }
    options.set(name, value)
  }
  return { positional, options, problem: null }
}

/**
 * An id from a folder's name: lower-cased, anything else made a dash.
 *
 * @param {string} folderName
 */
function idFrom(folderName) {
  return folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
}

/** @param {string} id */
function nameFrom(id) {
  const words = id.split('-').filter((word) => word !== '').join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** @param {string} text */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Every file under `dir`, relative to it.
 *
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
function walk(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : join(prefix, entry.name)
    if (entry.isDirectory()) return walk(dir, rel)
    return entry.isFile() ? [rel] : []
  })
}

/**
 * Where the new manifest's `$schema` points: this SDK's schema, relative to
 * the plugin so the pair can move together, or by URL when no relative path
 * exists (another drive).
 *
 * @param {string} target
 */
function schemaReference(target) {
  const rel = relative(target, SCHEMA)
  if (rel === '' || isAbsolute(rel)) return pathToFileURL(SCHEMA).href
  return rel.split(sep).join('/')
}

/**
 * @param {readonly string[]} argv
 * @returns {number} the exit code
 */
function create(argv) {
  const { positional, options, problem } = parse(argv, ['id', 'name'])
  if (problem !== null) {
    err(`helm-plugin create: ${problem}`)
    return 1
  }
  const [folder, extra] = positional
  if (folder === undefined || extra !== undefined) {
    err('helm-plugin create: give one folder to create the plugin in. See helm-plugin --help.')
    return 1
  }
  const target = resolve(folder)
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) {
      err(`helm-plugin create: ${target} is a file, not a folder.`)
      return 1
    }
    if (readdirSync(target).length > 0) {
      err(`helm-plugin create: ${target} is not empty. Create a plugin in a new or empty folder.`)
      return 1
    }
  }

  const id = options.get('id') ?? idFrom(basename(target))
  if (!ID_PATTERN.test(id)) {
    err(
      `helm-plugin create: "${id}" cannot be a plugin id. An id is 1-63 lower-case letters, digits and dashes, starting with a letter or digit. Pass one with --id.`
    )
    return 1
  }
  const name = (options.get('name') ?? nameFrom(id)).trim()
  if (name === '' || name.length > NAME_MAX) {
    err(`helm-plugin create: a name is 1-${String(NAME_MAX)} characters.`)
    return 1
  }

  for (const rel of walk(TEMPLATE)) {
    const from = join(TEMPLATE, rel)
    const to = join(target, rel)
    mkdirSync(join(to, '..'), { recursive: true })
    if (rel === MANIFEST_FILE) {
      const manifest = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(from, 'utf8')))
      const renamed = /** @type {Record<string, unknown>} */ (
        JSON.parse(JSON.stringify(manifest), (_key, value) => (value === TEMPLATE_NAME ? name : value))
      )
      renamed['id'] = id
      writeFileSync(to, `${JSON.stringify({ $schema: schemaReference(target), ...renamed }, null, 2)}\n`)
      continue
    }
    const extension = extname(rel).toLowerCase()
    if (extension === '.html') {
      writeFileSync(to, readFileSync(from, 'utf8').split(TEMPLATE_NAME).join(escapeHtml(name)))
    } else if (extension === '.md') {
      writeFileSync(to, readFileSync(from, 'utf8').split(TEMPLATE_NAME).join(name).split(TEMPLATE_ID).join(id))
    } else {
      writeFileSync(to, readFileSync(from))
    }
  }

  const check = checkPluginFolder(target)
  if (!check.ok) {
    for (const message of check.errors) err(`error: ${message}`)
    return 1
  }
  out(`Created "${name}" (${id}) in ${target}`)
  out('')
  out('Next:')
  out(`  1. In Helm, open Settings > Plugins > Add folder and pick ${target}`)
  out('  2. Edit pages/panel.html and pages/panel.js. Helm reloads the plugin when you save.')
  out(`  3. helm-plugin validate "${target}" checks it as Helm will.`)
  return 0
}

/**
 * @param {readonly string[]} argv
 * @returns {number} the exit code
 */
function validate(argv) {
  const { positional, problem } = parse(argv, [])
  if (problem !== null) {
    err(`helm-plugin validate: ${problem}`)
    return 1
  }
  if (positional.length > 1) {
    err('helm-plugin validate: give at most one folder. See helm-plugin --help.')
    return 1
  }
  const folder = positional[0] ?? process.cwd()
  const check = checkPluginFolder(folder)
  for (const message of check.errors) err(`error: ${message}`)
  for (const message of check.warnings) err(`warning: ${message}`)
  if (!check.ok) {
    err(`${String(check.errors.length)} ${check.errors.length === 1 ? 'error' : 'errors'}: Helm would not load this plugin.`)
    return 1
  }
  const manifest = /** @type {import('../src/manifest').NormalizedManifest} */ (check.manifest)
  const warned = check.warnings.length === 0 ? '' : ` (${String(check.warnings.length)} ${check.warnings.length === 1 ? 'warning' : 'warnings'})`
  out(`${manifest.name} (${manifest.id}): Helm would load it${warned}.`)
  return 0
}

/**
 * @param {readonly string[]} argv
 * @returns {number}
 */
function main(argv) {
  const [command, ...rest] = argv
  switch (command) {
    case 'create':
      return create(rest)
    case 'validate':
      return validate(rest)
    case '--help':
    case '-h':
    case 'help':
      out(USAGE)
      return 0
    case undefined:
      err(USAGE)
      return 1
    default:
      err(`helm-plugin: unknown command "${command}". See helm-plugin --help.`)
      return 1
  }
}

process.exitCode = main(process.argv.slice(2))
