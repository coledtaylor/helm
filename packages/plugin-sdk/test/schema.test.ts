import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ENV_NAME_PATTERN,
  ID_PATTERN,
  MANIFEST_FIELDS,
  MANIFEST_LIMITS,
  NAME_PATTERN,
  ORIGIN_PATTERN,
  PANEL_ACTION_ICONS,
  SECRET_KEY_PATTERN,
  SERVICE_START_MODES,
  SETTING_KEY_PATTERN,
  SETTING_TYPES,
  SUPPORTED_API_VERSIONS,
  validateManifest
} from '../src/manifest.js'
import { MINIMAL, SAMPLE, SDK_DIR, TEMPLATE } from './fixtures'
import { schemaErrors } from './jsonschema'

/**
 * `helm-plugin.schema.json` is for an editor, and the validator is what Helm
 * runs. They must say the same thing, so this holds the one to the other: the
 * same names, enums, patterns and limits, and the same verdict on real
 * manifests - "the schema accepts it" meaning "Helm loads it with nothing to
 * warn about".
 */

type Schema = Record<string, unknown>
const schema = JSON.parse(readFileSync(join(SDK_DIR, 'helm-plugin.schema.json'), 'utf8')) as Schema
const properties = schema['properties'] as Record<string, Schema>
const defs = schema['$defs'] as Record<string, Schema>
const prop = (name: string): Schema => properties[name] as Schema

/** Helm loads it, and says nothing about it. */
const helmAccepts = (manifest: unknown): boolean => {
  const result = validateManifest(manifest)
  return result.ok && result.warnings.length === 0
}

describe('the schema names what the validator names', () => {
  it('has exactly the top-level fields the validator knows, and the same required ones', () => {
    expect(Object.keys(properties).sort()).toEqual([...MANIFEST_FIELDS].sort())
    expect(schema['required']).toEqual(['apiVersion', 'id', 'name'])
    expect(schema['additionalProperties']).toBe(false)
  })

  it('lists the same enums', () => {
    expect(prop('apiVersion')['enum']).toEqual([...SUPPORTED_API_VERSIONS])
    const action = ((prop('panels')['additionalProperties'] as Schema)['properties'] as Record<string, Schema>)['actions'] as Schema
    expect(((action['items'] as Schema)['properties'] as Record<string, Schema>)['icon']?.['enum']).toEqual([...PANEL_ACTION_ICONS])
    const setting = defs['setting'] as Schema
    expect((setting['properties'] as Record<string, Schema>)['type']?.['enum']).toEqual([...SETTING_TYPES])
    const variants = (setting['oneOf'] as Schema[]).map(
      (variant) => ((variant['properties'] as Record<string, Schema>)['type'] as Schema)['const']
    )
    expect(variants).toEqual([...SETTING_TYPES])
    const service = (prop('service')['oneOf'] as Schema[])[1] as Schema
    expect((service['properties'] as Record<string, Schema>)['start']?.['enum']).toEqual([...SERVICE_START_MODES])
  })

  it('carries the validator patterns, source for source', () => {
    expect(prop('id')['pattern']).toBe(ID_PATTERN.source)
    expect(defs['name']?.['pattern']).toBe(NAME_PATTERN.source)
    expect((prop('secrets')['items'] as Schema)['pattern']).toBe(SECRET_KEY_PATTERN.source)
    expect((prop('network')['items'] as Schema)['pattern']).toBe(ORIGIN_PATTERN.source)
    expect(((defs['env'] as Schema)['propertyNames'] as Schema)['pattern']).toBe(ENV_NAME_PATTERN.source)
    const setting = defs['setting'] as Schema
    expect((setting['properties'] as Record<string, Schema>)['key']?.['pattern']).toBe(SETTING_KEY_PATTERN.source)
    // None of them carries a flag the schema would lose.
    for (const pattern of [ID_PATTERN, NAME_PATTERN, SECRET_KEY_PATTERN, ORIGIN_PATTERN, ENV_NAME_PATTERN, SETTING_KEY_PATTERN]) {
      expect(pattern.flags).toBe('')
    }
  })

  it('has the same limits', () => {
    expect(prop('panels')['maxProperties']).toBe(MANIFEST_LIMITS.panels)
    expect(prop('tabs')['maxProperties']).toBe(MANIFEST_LIMITS.tabs)
    expect(prop('exec')['maxProperties']).toBe(MANIFEST_LIMITS.exec)
    expect(prop('commands')['maxItems']).toBe(MANIFEST_LIMITS.commands)
    expect(prop('settings')['maxItems']).toBe(MANIFEST_LIMITS.settings)
    expect(prop('network')['maxItems']).toBe(MANIFEST_LIMITS.network)
    expect(prop('secrets')['maxItems']).toBe(MANIFEST_LIMITS.secrets)
    expect(defs['args']?.['maxItems']).toBe(MANIFEST_LIMITS.args)
    expect(defs['env']?.['maxProperties']).toBe(MANIFEST_LIMITS.env)
  })
})

describe('the schema and the validator agree on manifests', () => {
  const FULL = {
    $schema: './node_modules/@helm/plugin-sdk/helm-plugin.schema.json',
    apiVersion: 1,
    id: 'full',
    name: 'Full',
    version: '2.0.0-beta.1',
    description: 'Every field.',
    icon: 'art/icon.png',
    rail: { title: 'Full', panel: 'main' },
    panels: { main: { title: 'Main', entry: 'dist/main.html', actions: [{ id: 'go', title: 'Go', icon: 'eye' }] } },
    tabs: { run: { title: 'Run', entry: 'dist/run.html' } },
    background: 'dist/bg.html',
    commands: [
      { id: 'run', title: 'Open a run', tab: 'run' },
      { id: 'sync', title: 'Sync now' }
    ],
    settings: [
      { key: 'host', type: 'text', label: 'Host', default: 'x', placeholder: 'y', description: 'Where.' },
      { key: 'n', type: 'number', label: 'N', min: 1, max: 9, default: 3 },
      { key: 'on', type: 'toggle', label: 'On', default: true },
      { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }], default: 'a' },
      { key: 'tokenSetting', type: 'secret', label: 'Token', secret: 'token' }
    ],
    network: ['https://api.example.com', 'https://*.example.org', 'http://127.0.0.1:8080/'],
    secrets: ['token'],
    exec: { git: 'git', tool: { command: 'bin/tool.cmd', args: ['--json'], env: { TOKEN: '{{token}}' } } },
    service: { node: 'service/main.mjs', args: ['--quiet'], env: { TOKEN: '{{token}}' }, start: 'enable' }
  }

  const valid: Array<[string, unknown]> = [
    ['the sample plugin', SAMPLE],
    ['the template', TEMPLATE],
    ['the smallest manifest', MINIMAL],
    ['a manifest with every field', FULL],
    ['a command service', { ...MINIMAL, service: { command: 'srv', start: 'demand' } }],
    ['no service', { ...MINIMAL, service: null }]
  ]

  it.each(valid)('both accept %s', (_what, manifest) => {
    expect(validateManifest(manifest)).toMatchObject({ ok: true, warnings: [] })
    expect(schemaErrors(schema, manifest)).toEqual([])
    // And it has every field the schema says is required.
    for (const field of schema['required'] as string[]) expect(manifest).toHaveProperty(field)
  })

  const invalid: Array<[string, Record<string, unknown>]> = [
    ['an unknown field (a warning in Helm)', { ...MINIMAL, tab: {} }],
    ['apiVersion 2', { ...MINIMAL, apiVersion: 2 }],
    ['no apiVersion', { id: 'x', name: 'X' }],
    ['an id with capitals', { ...MINIMAL, id: 'Minimal' }],
    ['no name', { apiVersion: 1, id: 'x' }],
    ['a blank name', { ...MINIMAL, name: '   ' }],
    ['a name too long', { ...MINIMAL, name: 'n'.repeat(61) }],
    ['a description too long', { ...MINIMAL, description: 'd'.repeat(301) }],
    ['a gif icon', { ...MINIMAL, icon: 'icon.gif' }],
    ['a panel key with capitals', { ...MINIMAL, panels: { Main: { title: 'M', entry: 'm.html' } } }],
    ['a panel with no entry', { ...MINIMAL, panels: { main: { title: 'M' } } }],
    ['an action icon Helm lacks', { ...MINIMAL, panels: { main: { title: 'M', entry: 'm.html', actions: [{ id: 'a', title: 'A', icon: 'rocket' }] } } }],
    ['a command with no title', { ...MINIMAL, background: 'bg.html', commands: [{ id: 'go' }] }],
    ['a setting of an unknown type', { ...MINIMAL, settings: [{ key: 'a', label: 'A', type: 'colour' }] }],
    ['a select with no options', { ...MINIMAL, settings: [{ key: 'a', label: 'A', type: 'select', options: [] }] }],
    ['a toggle with a string default', { ...MINIMAL, settings: [{ key: 'a', label: 'A', type: 'toggle', default: 'yes' }] }],
    ['a setting key starting with a digit', { ...MINIMAL, settings: [{ key: '1a', label: 'A', type: 'toggle' }] }],
    ['an origin with a path', { ...MINIMAL, network: ['https://api.example.com/v1'] }],
    ['an ftp origin', { ...MINIMAL, network: ['ftp://x.example.com'] }],
    ['a secret key with a space', { ...MINIMAL, secrets: ['a b'] }],
    ['a secret listed twice', { ...MINIMAL, secrets: ['a', 'a'] }],
    ['a program with a leading space', { ...MINIMAL, exec: { git: ' git' } }],
    ['an exec key with capitals', { ...MINIMAL, exec: { Git: 'git' } }],
    ['program arguments that are not strings', { ...MINIMAL, exec: { git: { command: 'git', args: [1] } } }],
    ['an environment name with a dash', { ...MINIMAL, exec: { git: { command: 'git', env: { 'A-B': 'x' } } } }],
    ['a service with both kinds', { ...MINIMAL, service: { command: 'a', node: 'b.mjs' } }],
    ['a service with neither kind', { ...MINIMAL, service: {} }],
    ['a python node service', { ...MINIMAL, service: { node: 'srv.py' } }],
    ['a service start Helm lacks', { ...MINIMAL, service: { node: 'srv.mjs', start: 'boot' } }]
  ]

  it.each(invalid)('both refuse %s', (_what, manifest) => {
    expect(helmAccepts(manifest)).toBe(false)
    expect(schemaErrors(schema, manifest)).not.toEqual([])
  })

  it.each([
    ['dist/a.html', true],
    ['./dist\\a.HTML', true],
    ['dist//a.html', true],
    ['a.html/', true],
    ['__helm.html', true],
    ['a..b.html', true],
    ['..x/a.html', true],
    ['../a.html', false],
    ['a/../b.html', false],
    ['/a.html', false],
    ['\\a.html', false],
    ['C:a.html', false],
    ['__helm/a.html', false],
    ['./__helm/a.html', false],
    [' a.html', false],
    ['a.htm', false],
    ['a.html/x', false]
  ])('both judge the page path %j the same way (%s)', (entry, expected) => {
    const manifest = { ...MINIMAL, tabs: { a: { title: 'A', entry } } }
    expect(helmAccepts(manifest)).toBe(expected)
    expect(schemaErrors(schema, manifest).length === 0).toBe(expected)
  })

  it.each([
    ['https://api.example.com', true],
    ['HTTP://API.EXAMPLE.COM:8080/', true],
    ['https://*.example.com', true],
    ['http://[::1]:3000', true],
    ['https://api.example.com/v1', false],
    ['https://api.example.com?x', false],
    ['https://user@api.example.com', false],
    ['ws://api.example.com', false]
  ])('both judge the origin %j the same way (%s)', (origin, expected) => {
    const manifest = { ...MINIMAL, network: [origin] }
    expect(helmAccepts(manifest)).toBe(expected)
    expect(schemaErrors(schema, manifest).length === 0).toBe(expected)
  })

  /**
   * What only the validator can say, because it reads one field against
   * another or reads a value the way a URL parser does. The schema accepts
   * these and Helm does not; `helm-plugin validate` is where an author hears
   * about them.
   */
  it.each([
    ['a rail naming no panel', { ...MINIMAL, rail: { title: 'R', panel: 'missing' } }],
    ['a command naming no tab', { ...MINIMAL, background: 'bg.html', commands: [{ id: 'a', title: 'A', tab: 'x' }] }],
    ['a command nothing receives', { ...MINIMAL, commands: [{ id: 'a', title: 'A' }] }],
    ['an undeclared secret', { ...MINIMAL, exec: { git: { command: 'git', env: { T: '{{token}}' } } } }],
    ['a secret setting for an undeclared key', { ...MINIMAL, settings: [{ key: 'a', label: 'A', type: 'secret', secret: 'token' }] }],
    ['a number default outside its bounds', { ...MINIMAL, settings: [{ key: 'a', label: 'A', type: 'number', min: 1, max: 2, default: 3 }] }],
    ['a wildcard over an address', { ...MINIMAL, network: ['https://*.127.0.0.1'] }],
    ['a port past 65535', { ...MINIMAL, network: ['http://127.0.0.1:70000'] }],
    ['a wildcard inside a host', { ...MINIMAL, network: ['https://api.*.example.com'] }],
    ['a repeated command id', { ...MINIMAL, background: 'bg.html', commands: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }]
  ])('leaves %s to the validator', (_what, manifest) => {
    expect(helmAccepts(manifest)).toBe(false)
    expect(schemaErrors(schema, manifest)).toEqual([])
  })
})
