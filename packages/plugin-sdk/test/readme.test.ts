import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SDK_DIR } from './fixtures'

/**
 * The README is the authoring guide npm shows. These hold it to what the SDK
 * ships: what an author looking up the background, the bridge or apiVersion
 * finds there.
 */

const README = readFileSync(join(SDK_DIR, 'README.md'), 'utf8').replace(/\r\n/g, '\n')

/** The text of one `## ` or `### ` section, up to the next heading at its level or above. */
function section(heading: string): string {
  const start = README.indexOf(`\n${heading}\n`)
  if (start === -1) throw new Error(`the README has no "${heading}"`)
  const level = heading.split(' ')[0]!.length
  const rest = README.slice(start + heading.length + 2)
  const next = rest.search(new RegExp(`^#{1,${String(level)}} `, 'm'))
  return next === -1 ? rest : rest.slice(0, next)
}

describe('the README', () => {
  it('S6: documents both API versions, says version 1 still loads, and how to move a plugin over', () => {
    const versions = section('## API versions')
    expect(versions).toContain('`window.floti`')
    expect(versions).toContain('`floti-plugin://<id>/`')
    expect(versions).toContain('`helm-plugin://<id>/`')
    expect(versions).toContain('A version 1\nplugin still loads and works as it did')
    const moving = section('### Moving a version 1 plugin to version 2')
    expect(moving).toContain('"apiVersion": 2')
    expect(moving).toContain('`floti.fetch(...)`')
    expect(moving).toContain('`@coledtaylor/helm-plugin-sdk/background`')
  })

  it("S6: documents the background as a module in the host's isolate, with what it can and cannot reach", () => {
    const background = section('### Background')
    expect(background).toContain('V8 isolate of its own')
    expect(background).toContain('What it can reach:')
    expect(background).toContain('What it cannot:')
    for (const reached of ['`BroadcastChannel`', '`setTimeout`', '`floti`', 'relative path']) expect(background).toContain(reached)
    for (const refused of ['`localStorage`', 'no global `fetch`', 'no file\n  system', '`floti.open`']) expect(background).toContain(refused)
  })

  it('S6: documents the floti bridge, its apiVersion, and the types for a page and a background', () => {
    const bridge = section('## The bridge: `window.floti`')
    expect(bridge).toContain('`window.helm` on every page of a version 1')
    expect(bridge).toContain('| `apiVersion` | `2` for `window.floti`, `1` for `window.helm`. |')
    const types = section('## TypeScript')
    expect(types).toContain('FlotiBridge')
    expect(types).toContain('FlotiBackground')
    expect(types).toContain('/// <reference types="@coledtaylor/helm-plugin-sdk/background" />')
    // The manifest table names both versions.
    expect(section('## The manifest')).toContain('Required. `2`, or `1`')
  })
})
