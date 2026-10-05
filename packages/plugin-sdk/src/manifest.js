// @ts-check
/**
 * What `helm-plugin.json` may say, as code.
 *
 * One validator, run by Helm when it loads a plugin and by `helm-plugin
 * validate` when somebody builds one, so the two cannot disagree about whether
 * a manifest is good. It is plain JavaScript on purpose: the command runs
 * straight from this folder, linked or installed, with nothing to build first.
 *
 * Pure: no file system and no network. What the manifest *names* is checked
 * here - shapes, references between its parts, paths that stay inside the
 * folder. Whether those files exist is the caller's question, and
 * `manifestFiles` lists them for it.
 *
 * `helm-plugin.schema.json` says the same things for an editor's benefit, and a
 * test holds the two to each other.
 */

/** The bridge versions this Helm speaks. */
export const SUPPORTED_API_VERSIONS = Object.freeze([1])

/** A plugin's id: the host of its origin, which a standard scheme lower-cases. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/** A panel, tab, command, action or program name. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** A secret's key, as `{{key}}` names it. */
export const SECRET_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** A setting's key. */
export const SETTING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

/** An environment variable's name. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** `{{key}}`, wherever a secret may be referenced. */
export const PLACEHOLDER_PATTERN = /\{\{([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\}\}/g

/** Past this an icon is not an icon. */
export const ICON_MAX_BYTES = 64 * 1024

/** The path prefix Helm serves its own runtime under on every plugin's origin. */
export const RESERVED_PREFIX = '__helm/'

/** @type {readonly import('./types').PanelActionIcon[]} */
export const PANEL_ACTION_ICONS = Object.freeze([
  'refresh',
  'plus',
  'search',
  'list',
  'settings',
  'external',
  'pin',
  'edit',
  'trash',
  'link',
  'eye'
])

const SETTING_TYPES = Object.freeze(['text', 'number', 'toggle', 'select', 'secret'])

const LIMITS = Object.freeze({
  panels: 20,
  tabs: 50,
  actions: 5,
  commands: 100,
  settings: 100,
  network: 50,
  secrets: 50,
  exec: 50,
  args: 64,
  env: 64,
  options: 100
})

const KNOWN_FIELDS = new Set([
  '$schema',
  'apiVersion',
  'id',
  'name',
  'version',
  'description',
  'icon',
  'rail',
  'panels',
  'tabs',
  'background',
  'commands',
  'settings',
  'network',
  'secrets',
  'exec',
  'service'
])

/**
 * Every `{{key}}` in a string, in order, repeats kept.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function placeholders(text) {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((match) => /** @type {string} */ (match[1]))
}

/**
 * One `network` entry, read: an origin, optionally with `*.` in front of a
 * domain to mean every subdomain of it (and not the domain itself).
 *
 * Null for anything else - a path, a query, a scheme other than http and
 * https, a wildcard anywhere but the front, or a wildcard over an IP address.
 *
 * @param {string} entry
 * @returns {import('./manifest').OriginPattern | null}
 */
export function parseOrigin(entry) {
  const match = /^(https?):\/\/(\*\.)?([^/?#@\s]+?)(?::(\d{1,5}))?\/?$/i.exec(entry.trim())
  if (match === null) return null
  const scheme = /** @type {'http' | 'https'} */ (/** @type {string} */ (match[1]).toLowerCase())
  const wildcard = match[2] !== undefined
  const rawHost = /** @type {string} */ (match[3])
  if (rawHost.includes('*')) return null
  let host
  try {
    host = new URL(`${scheme}://${rawHost}`).hostname
  } catch {
    return null
  }
  if (host === '') return null
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')
  if (wildcard && (isIp || !host.includes('.'))) return null
  const port = match[4] === undefined ? (scheme === 'https' ? 443 : 80) : Number(match[4])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const defaultPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)
  return {
    scheme,
    host,
    wildcard,
    port,
    origin: `${scheme}://${wildcard ? '*.' : ''}${host}${defaultPort ? '' : `:${String(port)}`}`
  }
}

/**
 * Whether a URL is one a pattern allows. Scheme and port must match exactly;
 * the host must be the pattern's, or for a wildcard, a subdomain of it.
 *
 * @param {import('./manifest').OriginPattern} pattern
 * @param {URL} url
 * @returns {boolean}
 */
export function originMatches(pattern, url) {
  const scheme = url.protocol.slice(0, -1)
  if (scheme !== pattern.scheme) return false
  const port = url.port === '' ? (scheme === 'https' ? 443 : 80) : Number(url.port)
  if (port !== pattern.port) return false
  const host = url.hostname
  return pattern.wildcard ? host.endsWith(`.${pattern.host}`) : host === pattern.host
}

/**
 * A path inside the plugin folder, in one spelling: forward slashes, no `./`.
 * Null when it is absolute, climbs out with `..`, or is otherwise not a path.
 *
 * @param {string} path
 * @returns {string | null}
 */
export function normalizeEntry(path) {
  if (path.trim() !== path || path === '' || path.includes('\0')) return null
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) return null
  const parts = []
  for (const part of path.split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  if (parts.length === 0) return null
  return parts.join('/')
}

/**
 * Every file the manifest names, for the caller to check exists - Helm when it
 * loads the plugin, `helm-plugin validate` when it is built.
 *
 * @param {import('./manifest').NormalizedManifest} manifest
 * @returns {Array<{ field: string, path: string }>}
 */
export function manifestFiles(manifest) {
  /** @type {Array<{ field: string, path: string }>} */
  const files = []
  if (manifest.icon !== null) files.push({ field: 'icon', path: manifest.icon })
  for (const [key, panel] of Object.entries(manifest.panels)) files.push({ field: `panels.${key}.entry`, path: panel.entry })
  for (const [key, tab] of Object.entries(manifest.tabs)) files.push({ field: `tabs.${key}.entry`, path: tab.entry })
  if (manifest.background !== null) files.push({ field: 'background', path: manifest.background })
  if (manifest.service?.kind === 'node') files.push({ field: 'service.node', path: manifest.service.command })
  return files
}

/**
 * Reads a manifest. Every problem is reported, not only the first, so a
 * plugin author fixes them in one pass.
 *
 * @param {unknown} value the parsed `helm-plugin.json`
 * @returns {import('./manifest').ManifestResult}
 */
export function validateManifest(value) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  const fail = (/** @type {string} */ message) => {
    errors.push(message)
  }

  if (!isRecord(value)) return { ok: false, errors: ['helm-plugin.json must be a JSON object'], warnings }

  for (const key of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`"${key}" is not a manifest field and is ignored`)
  }

  const apiVersion = value['apiVersion']
  if (typeof apiVersion !== 'number' || !SUPPORTED_API_VERSIONS.includes(apiVersion)) {
    // Said first and on its own: a plugin from a newer Helm fails every other
    // check for reasons that are not its fault.
    const supported = SUPPORTED_API_VERSIONS.join(', ')
    const message =
      apiVersion === undefined
        ? `apiVersion is missing; this Helm supports ${supported}`
        : `apiVersion ${JSON.stringify(apiVersion)} is not supported by this Helm, which supports ${supported}`
    return { ok: false, errors: [message], warnings }
  }

  const id = value['id']
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    fail('id must be 1-63 lower-case letters, digits and dashes, starting with a letter or digit')
  }
  const name = text(value['name'], 'name', 60, fail)
  const version = optionalText(value['version'], 'version', 40, fail)
  const description = optionalText(value['description'], 'description', 300, fail)

  const icon = optionalEntry(value['icon'], 'icon', ['.svg', '.png'], fail)

  // --- secrets first: everything else may refer to them.
  /** @type {string[]} */
  const secrets = []
  const rawSecrets = value['secrets']
  if (rawSecrets !== undefined) {
    if (!Array.isArray(rawSecrets)) fail('secrets must be an array of keys')
    else {
      if (rawSecrets.length > LIMITS.secrets) fail(`secrets may list at most ${String(LIMITS.secrets)} keys`)
      for (const [index, key] of rawSecrets.entries()) {
        if (typeof key !== 'string' || !SECRET_KEY_PATTERN.test(key)) {
          fail(`secrets[${String(index)}] must be letters, digits, dots, dashes and underscores`)
        } else if (secrets.includes(key)) fail(`secrets lists "${key}" twice`)
        else secrets.push(key)
      }
    }
  }
  const declaredSecret = (/** @type {string} */ where, /** @type {string} */ textValue) => {
    for (const key of placeholders(textValue)) {
      if (!secrets.includes(key)) fail(`${where} uses {{${key}}}, which secrets does not declare`)
    }
  }

  // --- surfaces
  /** @type {import('./manifest').NormalizedManifest['panels']} */
  const panels = {}
  for (const [key, spec] of entries(value['panels'], 'panels', LIMITS.panels, fail)) {
    const where = `panels.${key}`
    if (!isRecord(spec)) {
      fail(`${where} must be an object`)
      continue
    }
    const title = text(spec['title'], `${where}.title`, 60, fail)
    const entry = requiredEntry(spec['entry'], `${where}.entry`, ['.html'], fail)
    /** @type {import('./types').PanelActionSpec[]} */
    const actions = []
    const rawActions = spec['actions']
    if (rawActions !== undefined) {
      if (!Array.isArray(rawActions)) fail(`${where}.actions must be an array`)
      else {
        if (rawActions.length > LIMITS.actions) fail(`${where}.actions may hold at most ${String(LIMITS.actions)}`)
        for (const [index, action] of rawActions.entries()) {
          const at = `${where}.actions[${String(index)}]`
          if (!isRecord(action)) {
            fail(`${at} must be an object`)
            continue
          }
          const actionId = action['id']
          if (typeof actionId !== 'string' || !NAME_PATTERN.test(actionId)) fail(`${at}.id must be a name`)
          else if (actions.some((other) => other.id === actionId)) fail(`${at}.id "${actionId}" is used twice`)
          const actionTitle = text(action['title'], `${at}.title`, 60, fail)
          const actionIcon = action['icon']
          if (typeof actionIcon !== 'string' || !PANEL_ACTION_ICONS.includes(/** @type {never} */ (actionIcon))) {
            fail(`${at}.icon must be one of ${PANEL_ACTION_ICONS.join(', ')}`)
            continue
          }
          if (typeof actionId === 'string' && actionTitle !== null) {
            actions.push({ id: actionId, title: actionTitle, icon: /** @type {import('./types').PanelActionIcon} */ (actionIcon) })
          }
        }
      }
    }
    if (title !== null && entry !== null) panels[key] = { title, entry, actions }
  }

  /** @type {import('./manifest').NormalizedManifest['tabs']} */
  const tabs = {}
  for (const [key, spec] of entries(value['tabs'], 'tabs', LIMITS.tabs, fail)) {
    const where = `tabs.${key}`
    if (!isRecord(spec)) {
      fail(`${where} must be an object`)
      continue
    }
    const title = text(spec['title'], `${where}.title`, 60, fail)
    const entry = requiredEntry(spec['entry'], `${where}.entry`, ['.html'], fail)
    if (title !== null && entry !== null) tabs[key] = { title, entry }
  }

  /** @type {import('./types').RailSpec | null} */
  let rail = null
  const rawRail = value['rail']
  if (rawRail !== undefined) {
    if (!isRecord(rawRail)) fail('rail must be an object')
    else {
      const title = text(rawRail['title'], 'rail.title', 60, fail)
      const panel = rawRail['panel']
      if (typeof panel !== 'string' || panels[panel] === undefined) {
        if (!(typeof panel === 'string' && isRecord(value['panels']) && panel in value['panels'])) {
          fail(`rail.panel must name one of the panels${typeof panel === 'string' ? ` - "${panel}" is not one` : ''}`)
        }
      } else if (title !== null) rail = { title, panel }
    }
  }

  const background = optionalEntry(value['background'], 'background', ['.html'], fail)

  // --- commands
  /** @type {import('./manifest').NormalizedManifest['commands']} */
  const commands = []
  const rawCommands = value['commands']
  if (rawCommands !== undefined) {
    if (!Array.isArray(rawCommands)) fail('commands must be an array')
    else {
      if (rawCommands.length > LIMITS.commands) fail(`commands may list at most ${String(LIMITS.commands)}`)
      for (const [index, command] of rawCommands.entries()) {
        const at = `commands[${String(index)}]`
        if (!isRecord(command)) {
          fail(`${at} must be an object`)
          continue
        }
        const commandId = command['id']
        if (typeof commandId !== 'string' || !NAME_PATTERN.test(commandId)) {
          fail(`${at}.id must be a name`)
          continue
        }
        if (commands.some((other) => other.id === commandId)) fail(`${at}.id "${commandId}" is used twice`)
        const title = text(command['title'], `${at}.title`, 80, fail)
        const tab = command['tab']
        if (tab !== undefined && (typeof tab !== 'string' || tabs[tab] === undefined)) {
          if (!(typeof tab === 'string' && isRecord(value['tabs']) && tab in value['tabs'])) {
            fail(`${at}.tab must name one of the tabs`)
          }
          continue
        }
        if (tab === undefined && background === null && rail === null && rawRail === undefined && value['background'] === undefined) {
          fail(`${at} has no tab, so it is delivered as an event - which needs a background page or a rail panel to receive it`)
        }
        if (title !== null) commands.push({ id: commandId, title, tab: typeof tab === 'string' ? tab : null })
      }
    }
  }

  // --- settings
  /** @type {import('./types').SettingSpec[]} */
  const settings = []
  const rawSettings = value['settings']
  if (rawSettings !== undefined) {
    if (!Array.isArray(rawSettings)) fail('settings must be an array')
    else {
      if (rawSettings.length > LIMITS.settings) fail(`settings may list at most ${String(LIMITS.settings)}`)
      for (const [index, setting] of rawSettings.entries()) {
        const parsed = readSetting(setting, `settings[${String(index)}]`, secrets, fail)
        if (parsed === null) continue
        if (settings.some((other) => other.key === parsed.key)) {
          fail(`settings[${String(index)}].key "${parsed.key}" is used twice`)
          continue
        }
        settings.push(parsed)
      }
    }
  }

  // --- network
  /** @type {import('./manifest').OriginPattern[]} */
  const network = []
  const rawNetwork = value['network']
  if (rawNetwork !== undefined) {
    if (!Array.isArray(rawNetwork)) fail('network must be an array of origins')
    else {
      if (rawNetwork.length > LIMITS.network) fail(`network may list at most ${String(LIMITS.network)} origins`)
      for (const [index, entry] of rawNetwork.entries()) {
        const pattern = typeof entry === 'string' ? parseOrigin(entry) : null
        if (pattern === null) {
          fail(
            `network[${String(index)}] must be an origin such as https://api.example.com, https://*.example.com or http://127.0.0.1:8080`
          )
          continue
        }
        if (!network.some((other) => other.origin === pattern.origin)) network.push(pattern)
      }
    }
  }

  // --- programs
  /** @type {Record<string, import('./manifest').NormalizedExec>} */
  const exec = {}
  for (const [key, spec] of entries(value['exec'], 'exec', LIMITS.exec, fail)) {
    const where = `exec.${key}`
    if (typeof spec === 'string') {
      const command = program(spec, where, fail)
      if (command !== null) exec[key] = { command, args: [], env: {} }
      continue
    }
    if (!isRecord(spec)) {
      fail(`${where} must be a program or an object with a command`)
      continue
    }
    const command = program(spec['command'], `${where}.command`, fail)
    const args = stringList(spec['args'], `${where}.args`, fail)
    const env = environment(spec['env'], `${where}.env`, fail, declaredSecret)
    if (command !== null && args !== null && env !== null) exec[key] = { command, args, env }
  }

  /** @type {import('./manifest').NormalizedService | null} */
  let service = null
  const rawService = value['service']
  if (rawService !== undefined && rawService !== null) {
    if (!isRecord(rawService)) fail('service must be an object or null')
    else {
      const hasCommand = rawService['command'] !== undefined
      const hasNode = rawService['node'] !== undefined
      if (hasCommand === hasNode) fail('service must have exactly one of command and node')
      const command = hasCommand
        ? program(rawService['command'], 'service.command', fail)
        : hasNode
          ? requiredEntry(rawService['node'], 'service.node', ['.js', '.mjs', '.cjs'], fail)
          : null
      const args = stringList(rawService['args'], 'service.args', fail)
      const env = environment(rawService['env'], 'service.env', fail, declaredSecret)
      const start = rawService['start'] ?? 'demand'
      if (start !== 'enable' && start !== 'demand') fail('service.start must be "enable" or "demand"')
      if (command !== null && args !== null && env !== null && hasCommand !== hasNode && (start === 'enable' || start === 'demand')) {
        service = { kind: hasNode ? 'node' : 'command', command, args, env, start }
      }
    }
  }

  if (errors.length > 0 || typeof id !== 'string' || name === null) {
    return { ok: false, errors: errors.length > 0 ? errors : ['the manifest is incomplete'], warnings }
  }
  return {
    ok: true,
    manifest: {
      apiVersion: /** @type {1} */ (apiVersion),
      id,
      name,
      version,
      description,
      icon,
      rail,
      panels,
      tabs,
      background,
      commands,
      settings,
      network,
      secrets,
      exec,
      service
    },
    warnings
  }
}

// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @param {(message: string) => void} fail
 * @returns {string | null}
 */
function text(value, field, max, fail) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${field} must be a non-empty string`)
    return null
  }
  if (value.length > max) {
    fail(`${field} must be at most ${String(max)} characters`)
    return null
  }
  return value.trim()
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @param {(message: string) => void} fail
 * @returns {string | null}
 */
function optionalText(value, field, max, fail) {
  return value === undefined ? null : text(value, field, max, fail)
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {readonly string[]} extensions
 * @param {(message: string) => void} fail
 * @returns {string | null}
 */
function requiredEntry(value, field, extensions, fail) {
  if (typeof value !== 'string') {
    fail(`${field} must be a path inside the plugin folder`)
    return null
  }
  const path = normalizeEntry(value)
  if (path === null) {
    fail(`${field} must be a relative path that stays inside the plugin folder`)
    return null
  }
  if (path.startsWith(RESERVED_PREFIX)) {
    fail(`${field} may not be under ${RESERVED_PREFIX}, which Helm serves its runtime from`)
    return null
  }
  if (!extensions.some((extension) => path.toLowerCase().endsWith(extension))) {
    fail(`${field} must be a ${extensions.join(' or ')} file`)
    return null
  }
  return path
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {readonly string[]} extensions
 * @param {(message: string) => void} fail
 * @returns {string | null}
 */
function optionalEntry(value, field, extensions, fail) {
  return value === undefined ? null : requiredEntry(value, field, extensions, fail)
}

/**
 * The keyed objects (`panels`, `tabs`, `exec`), each key checked.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {number} limit
 * @param {(message: string) => void} fail
 * @returns {Array<[string, unknown]>}
 */
function entries(value, field, limit, fail) {
  if (value === undefined) return []
  if (!isRecord(value)) {
    fail(`${field} must be an object`)
    return []
  }
  const all = Object.entries(value)
  if (all.length > limit) fail(`${field} may hold at most ${String(limit)}`)
  return all.filter(([key]) => {
    if (NAME_PATTERN.test(key)) return true
    fail(`${field} key "${key}" must be 1-32 lower-case letters, digits and dashes`)
    return false
  })
}

/**
 * A program: a name to find on PATH, or a path. Not a command line - the
 * arguments are separate, and nothing is ever handed to a shell.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {(message: string) => void} fail
 * @returns {string | null}
 */
function program(value, field, fail) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value) {
    fail(`${field} must be a program name or path`)
    return null
  }
  if (value.length > 260 || value.includes('\0')) {
    fail(`${field} is not a program name or path`)
    return null
  }
  return value
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {(message: string) => void} fail
 * @returns {string[] | null}
 */
function stringList(value, field, fail) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.includes('\0'))) {
    fail(`${field} must be an array of strings`)
    return null
  }
  if (value.length > LIMITS.args) {
    fail(`${field} may hold at most ${String(LIMITS.args)}`)
    return null
  }
  return /** @type {string[]} */ ([...value])
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {(message: string) => void} fail
 * @param {(where: string, text: string) => void} declaredSecret
 * @returns {Record<string, string> | null}
 */
function environment(value, field, fail, declaredSecret) {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    fail(`${field} must be an object of names to values`)
    return null
  }
  /** @type {Record<string, string>} */
  const out = {}
  const all = Object.entries(value)
  if (all.length > LIMITS.env) fail(`${field} may hold at most ${String(LIMITS.env)}`)
  let good = true
  for (const [name, entry] of all) {
    if (!ENV_NAME_PATTERN.test(name)) {
      fail(`${field} name "${name}" is not an environment variable name`)
      good = false
      continue
    }
    if (typeof entry !== 'string' || entry.includes('\0')) {
      fail(`${field}.${name} must be a string`)
      good = false
      continue
    }
    declaredSecret(`${field}.${name}`, entry)
    out[name] = entry
  }
  return good ? out : null
}

/**
 * @param {unknown} value
 * @param {string} at
 * @param {readonly string[]} secrets
 * @param {(message: string) => void} fail
 * @returns {import('./types').SettingSpec | null}
 */
function readSetting(value, at, secrets, fail) {
  if (!isRecord(value)) {
    fail(`${at} must be an object`)
    return null
  }
  const key = value['key']
  if (typeof key !== 'string' || !SETTING_KEY_PATTERN.test(key)) {
    fail(`${at}.key must start with a letter and hold only letters, digits, dots, dashes and underscores`)
    return null
  }
  const label = text(value['label'], `${at}.label`, 80, fail)
  const description = optionalText(value['description'], `${at}.description`, 300, fail)
  const type = value['type']
  if (typeof type !== 'string' || !SETTING_TYPES.includes(type)) {
    fail(`${at}.type must be one of ${SETTING_TYPES.join(', ')}`)
    return null
  }
  if (label === null) return null
  const base = description === null ? { key, label } : { key, label, description }
  const fallback = value['default']

  switch (type) {
    case 'text': {
      if (fallback !== undefined && typeof fallback !== 'string') fail(`${at}.default must be a string`)
      const placeholder = optionalText(value['placeholder'], `${at}.placeholder`, 120, fail)
      return {
        ...base,
        type,
        ...(typeof fallback === 'string' ? { default: fallback } : {}),
        ...(placeholder === null ? {} : { placeholder })
      }
    }
    case 'number': {
      const min = value['min']
      const max = value['max']
      for (const [name, bound] of /** @type {const} */ ([['min', min], ['max', max], ['default', fallback]])) {
        if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) fail(`${at}.${name} must be a number`)
      }
      const lo = typeof min === 'number' ? min : undefined
      const hi = typeof max === 'number' ? max : undefined
      if (lo !== undefined && hi !== undefined && lo > hi) fail(`${at}.min is above ${at}.max`)
      if (typeof fallback === 'number' && ((lo !== undefined && fallback < lo) || (hi !== undefined && fallback > hi))) {
        fail(`${at}.default is outside min and max`)
      }
      return {
        ...base,
        type,
        ...(typeof fallback === 'number' ? { default: fallback } : {}),
        ...(lo === undefined ? {} : { min: lo }),
        ...(hi === undefined ? {} : { max: hi })
      }
    }
    case 'toggle':
      if (fallback !== undefined && typeof fallback !== 'boolean') fail(`${at}.default must be true or false`)
      return { ...base, type, ...(typeof fallback === 'boolean' ? { default: fallback } : {}) }
    case 'select': {
      const rawOptions = value['options']
      /** @type {Array<{ value: string, label: string }>} */
      const options = []
      if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
        fail(`${at}.options must be a non-empty array`)
        return null
      }
      if (rawOptions.length > LIMITS.options) fail(`${at}.options may hold at most ${String(LIMITS.options)}`)
      for (const [index, option] of rawOptions.entries()) {
        if (!isRecord(option) || typeof option['value'] !== 'string' || typeof option['label'] !== 'string') {
          fail(`${at}.options[${String(index)}] must be { "value": string, "label": string }`)
          continue
        }
        if (options.some((other) => other.value === option['value'])) {
          fail(`${at}.options value "${option['value']}" is listed twice`)
          continue
        }
        options.push({ value: option['value'], label: option['label'] })
      }
      if (fallback !== undefined && (typeof fallback !== 'string' || !options.some((option) => option.value === fallback))) {
        fail(`${at}.default must be one of the options' values`)
      }
      return { ...base, type, options, ...(typeof fallback === 'string' ? { default: fallback } : {}) }
    }
    default: {
      const secret = value['secret']
      if (typeof secret !== 'string' || !secrets.includes(secret)) {
        fail(`${at}.secret must name a key from secrets`)
        return null
      }
      return { ...base, type: 'secret', secret }
    }
  }
}
