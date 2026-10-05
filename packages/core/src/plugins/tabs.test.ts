import { describe, expect, it } from 'vitest'
import {
  canonicalParams,
  isPluginRailId,
  PLUGIN_PARAMS_LIMITS,
  pluginParamsProblem,
  pluginRailId,
  pluginTabId,
  pluginTabNameProblem
} from './tabs'

describe('pluginParamsProblem', () => {
  it('takes a flat record of strings, finite numbers and booleans', () => {
    expect(pluginParamsProblem({})).toBeNull()
    expect(pluginParamsProblem({ run: 1234, live: true, name: 'a b', 'x.y_z-1': '' })).toBeNull()
  })

  it.each([
    [null, 'object'],
    [[], 'object'],
    ['run=1', 'object'],
    [{ run: { id: 1 } }, 'string, a number or true/false'],
    [{ run: null }, 'string, a number or true/false'],
    [{ run: Number.NaN }, 'finite'],
    [{ run: Number.POSITIVE_INFINITY }, 'finite'],
    [{ 'two words': 1 }, 'letters, digits'],
    [{ run: 'x'.repeat(PLUGIN_PARAMS_LIMITS.valueLength + 1) }, 'longer than']
  ])('refuses %j', (value, said) => {
    expect(pluginParamsProblem(value)).toContain(said)
  })

  it('refuses more parameters than a tab may carry', () => {
    const many = Object.fromEntries(Array.from({ length: PLUGIN_PARAMS_LIMITS.keys + 1 }, (_, i) => [`k${String(i)}`, i]))
    expect(pluginParamsProblem(many)).toContain('at most')
  })
})

describe('pluginTabNameProblem', () => {
  it('takes the names a manifest could declare, and nothing else', () => {
    expect(pluginTabNameProblem('sample', 'detail')).toBeNull()
    expect(pluginTabNameProblem('Sample', 'detail')).toContain('plugin id')
    expect(pluginTabNameProblem('sample', 'Detail')).toContain('tab name')
    expect(pluginTabNameProblem('sample', 3)).toContain('tab name')
  })
})

describe('pluginTabId', () => {
  it('is the bare tab with no parameters, and sorts the ones it has', () => {
    expect(canonicalParams({})).toBe('')
    expect(pluginTabId('sample', 'detail', {})).toBe('plugin:sample/detail')
    expect(pluginTabId('sample', 'run', { b: 2, a: 'x' })).toBe('plugin:sample/run?{"a":"x","b":2}')
  })
})

describe('plugin rail ids', () => {
  it('are prefixed, so no plugin can take one of the ids Helm uses for its own destinations', () => {
    expect(pluginRailId('history')).toBe('plugin:history')
    expect(isPluginRailId('plugin:history')).toBe(true)
    expect(isPluginRailId('history')).toBe(false)
    expect(isPluginRailId('plugin:')).toBe(false)
    expect(isPluginRailId('plugin:Not-An-Id')).toBe(false)
  })
})
