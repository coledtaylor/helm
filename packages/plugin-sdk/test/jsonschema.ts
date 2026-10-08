/**
 * Just enough of JSON Schema 2020-12 to run `helm-plugin.schema.json` against
 * a manifest: the keywords that schema uses, and nothing else. A keyword it
 * does not know fails loudly, so the schema cannot grow a rule this quietly
 * skips.
 */

type Schema = Record<string, unknown>

const KNOWN = new Set([
  '$schema',
  '$defs',
  '$ref',
  'title',
  'description',
  // An annotation for editors, like the two above: it validates nothing.
  'default',
  'type',
  'enum',
  'const',
  'pattern',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'items',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'maxProperties',
  'oneOf'
])

export function schemaErrors(root: Schema, value: unknown): string[] {
  const errors: string[] = []
  check(root, root, value, '$', errors)
  return errors
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function check(root: Schema, schema: Schema, value: unknown, at: string, errors: string[]): void {
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) throw new Error(`jsonschema: unsupported keyword ${key} at ${at}`)
  }
  if (typeof schema['$ref'] === 'string') {
    const ref = schema['$ref']
    if (!ref.startsWith('#/$defs/')) throw new Error(`jsonschema: unsupported $ref ${ref}`)
    const target = (root['$defs'] as Record<string, Schema>)[ref.slice('#/$defs/'.length)]
    if (target === undefined) throw new Error(`jsonschema: no definition for ${ref}`)
    check(root, target, value, at, errors)
  }
  const type = schema['type']
  if (typeof type === 'string' && typeOf(value) !== type) {
    errors.push(`${at}: expected ${type}, got ${typeOf(value)}`)
    return
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].some((option) => option === value)) {
    errors.push(`${at}: not one of ${JSON.stringify(schema['enum'])}`)
  }
  if ('const' in schema && schema['const'] !== value) errors.push(`${at}: not ${JSON.stringify(schema['const'])}`)

  if (typeof value === 'string') {
    const length = [...value].length
    if (typeof schema['minLength'] === 'number' && length < schema['minLength']) errors.push(`${at}: too short`)
    if (typeof schema['maxLength'] === 'number' && length > schema['maxLength']) errors.push(`${at}: too long`)
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern'], 'u').test(value)) {
      errors.push(`${at}: does not match ${schema['pattern']}`)
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) errors.push(`${at}: too few items`)
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) errors.push(`${at}: too many items`)
    if (schema['uniqueItems'] === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${at}: items repeat`)
    }
    if (typeof schema['items'] === 'object' && schema['items'] !== null) {
      for (const [index, item] of value.entries()) check(root, schema['items'] as Schema, item, `${at}[${String(index)}]`, errors)
    }
  }

  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    for (const key of (schema['required'] as string[] | undefined) ?? []) {
      if (!(key in record)) errors.push(`${at}: ${key} is required`)
    }
    if (typeof schema['maxProperties'] === 'number' && keys.length > schema['maxProperties']) {
      errors.push(`${at}: too many properties`)
    }
    const properties = (schema['properties'] as Record<string, Schema> | undefined) ?? {}
    for (const key of keys) {
      if (typeof schema['propertyNames'] === 'object') check(root, schema['propertyNames'] as Schema, key, `${at} key ${key}`, errors)
      const property = properties[key]
      if (property !== undefined) {
        check(root, property, record[key], `${at}.${key}`, errors)
        continue
      }
      const additional = schema['additionalProperties']
      if (additional === false) errors.push(`${at}: ${key} is not allowed`)
      else if (typeof additional === 'object' && additional !== null) check(root, additional as Schema, record[key], `${at}.${key}`, errors)
    }
  }

  if (Array.isArray(schema['oneOf'])) {
    const passing = (schema['oneOf'] as Schema[]).filter((option) => {
      const inner: string[] = []
      check(root, option, value, at, inner)
      return inner.length === 0
    })
    if (passing.length !== 1) errors.push(`${at}: matches ${String(passing.length)} of oneOf, not exactly 1`)
  }
}
