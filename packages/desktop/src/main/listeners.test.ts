import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What main may listen on and write for agent tools, read from its source: the
 * local host serves its sessions' tools on its own listener, so main binds a
 * port only for a forward the user asked for (`host/forwards.ts`), mints no
 * bearer token, and writes no `--mcp-config`. The one thing main still does
 * with those files is sweep the ones an earlier version left
 * (`cleanStaleMcpConfigs` at start).
 *
 * Read from the source rather than by starting main because the claim is about
 * what main contains at all: a listener that no test happens to start is still
 * one main could bind.
 */

const MAIN = import.meta.dirname

/** Every file of main's own code, by its path under `main/` with `/` separators. */
function mainSources(): Map<string, string> {
  const sources = new Map<string, string>()
  for (const entry of readdirSync(MAIN, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    if (/\.(test|testkit)\.ts$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue
    const path = join(entry.parentPath, entry.name)
    sources.set(relative(MAIN, path).split(sep).join('/'), readFileSync(path, 'utf8'))
  }
  return sources
}

const filesWhere = (test: (source: string) => boolean): string[] =>
  [...mainSources()]
    .filter(([, source]) => test(source))
    .map(([path]) => path)
    .sort()

describe("main's listeners", () => {
  it('S6: binds a port only for a forwarded port, never for agent tools', () => {
    expect(mainSources().size).toBeGreaterThan(20)
    const network = /from '(node:)?(net|http|https|http2)'/
    expect(filesWhere((source) => network.test(source))).toEqual(['host/forwards.ts'])
    expect(filesWhere((source) => /\.listen\(\s*\{?\s*(port|0|\d)/.test(source))).toEqual(['host/forwards.ts'])
  })

  it('S6: mints no bearer token and writes no --mcp-config, only sweeping the ones an earlier version left', () => {
    expect(filesWhere((source) => /Bearer|Authorization/.test(source))).toEqual([])
    expect(filesWhere((source) => source.includes('mcpConfigDir'))).toEqual(['index.ts', 'paths.ts'])

    const index = mainSources().get('index.ts') ?? ''
    const uses = index.match(/.*\bmcpConfigDir\b.*/g) ?? []
    expect(uses).toHaveLength(2)
    expect(uses[0]).toMatch(/^import .*from '\.\/paths'$/)
    expect(uses[1]?.trim()).toBe('cleanStaleMcpConfigs(mcpConfigDir)')
  })

  it('S21: serves no agents family, route or environment for it, and puts none in a launch: only the host does', () => {
    expect(mainSources().size).toBeGreaterThan(20)
    // The family's name, its route, its tools and the two variables that carry a
    // session's token and address to `floti agent`. Main is told whether sessions
    // may start agents and within which limits (`hostSettingsFor`), and that is
    // all of it that main knows.
    const family = /floti-agents|\/mcp\/agents|agents_(start|list|stop|send|wait|read|report)|FLOTI_AGENT_(TOKEN|URL)|floti agent/
    expect(filesWhere((source) => family.test(source))).toEqual([])
  })
})
