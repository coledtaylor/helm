import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { cleanStaleMcpConfigs } from './mcp'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm mcp sweep-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the leftover MCP config sweep at start', () => {
  it('removes what a dead process left and keeps everything else', () => {
    const dir = join(root, 'mcp')
    mkdirSync(dir, { recursive: true })
    const mine = join(dir, `mcp-${String(process.pid)}-a1b2c3.json`)
    writeFileSync(mine, '{}')
    writeFileSync(join(dir, 'mcp-999999-deadbeef.json'), '{}')
    writeFileSync(join(dir, 'mcp-424242-c0ffee.json'), '{}')
    writeFileSync(join(dir, 'not-ours.json'), '{}')

    // `999999` is gone; `424242` answers EPERM, which means alive.
    const removed = cleanStaleMcpConfigs(dir, (pid) => (pid === 999999 ? 'gone' : pid === 424242 ? 'alive' : 'gone'))

    expect(removed.map((path) => basename(path))).toEqual(['mcp-999999-deadbeef.json'])
    // This process's own file is not stale, whatever the probe says about it.
    expect(existsSync(mine)).toBe(true)
    expect(existsSync(join(dir, 'mcp-424242-c0ffee.json'))).toBe(true)
    expect(existsSync(join(dir, 'not-ours.json'))).toBe(true)
  })

  it('leaves a file alone when the owner cannot be established', () => {
    const dir = join(root, 'mcp')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mcp-777777-abc123.json'), '{}')
    expect(cleanStaleMcpConfigs(dir, () => 'unknown')).toEqual([])
    expect(existsSync(join(dir, 'mcp-777777-abc123.json'))).toBe(true)
  })

  it('finds nothing to do where no folder was ever made', () => {
    expect(cleanStaleMcpConfigs(join(root, 'never made'), () => 'gone')).toEqual([])
  })
})
