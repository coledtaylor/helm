import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { SDK_DIR } from './fixtures'

/**
 * The template's page scripts, run the way a plugin page runs them: classic
 * scripts, in a global where Helm's bridge is already defined.
 *
 * The bridge is installed the way `plugin-runtime/bridge.ts` installs it -
 * non-configurable - and that is the whole point of this file. A top-level
 * `const helm` or `let helm` in a classic script collides with a
 * non-configurable global and is a SyntaxError, so the page's HTML shows and
 * none of its script runs. `validate` cannot see that; running the file can.
 */

interface Element {
  textContent: string
  type: string
  className: string
  append: () => void
  addEventListener: () => void
}

function page(params: Record<string, number>): { run: (file: string) => void; calls: string[]; text: () => string[] } {
  const calls: string[] = []
  const elements: Element[] = []
  const element = (): Element => {
    const made: Element = { textContent: '', type: '', className: '', append: () => undefined, addEventListener: () => undefined }
    elements.push(made)
    return made
  }
  const bridge = Object.freeze({
    context: { plugin: 'hello', surface: 'panel', name: 'main', params },
    theme: { kind: 'dark' },
    visible: true,
    tabs: { open: () => Promise.resolve() },
    surface: {
      setTitle: (title: string | null) => {
        calls.push(`setTitle ${String(title)}`)
      }
    },
    on: (event: string) => {
      calls.push(`on ${event}`)
      return () => undefined
    }
  })
  const context = createContext({
    document: { getElementById: element, createElement: element },
    bridge
  })
  runInContext(
    "Object.defineProperty(globalThis, 'helm', { value: bridge, enumerable: true, configurable: false, writable: false }); globalThis.window = globalThis",
    context
  )
  return {
    calls,
    text: () => elements.map((made) => made.textContent).filter((text) => text !== ''),
    run: (file) => {
      runInContext(readFileSync(join(SDK_DIR, 'template', 'pages', file), 'utf8'), context, { filename: file })
    }
  }
}

describe('the template pages', () => {
  it('run as classic scripts beside the bridge: the panel listens and says where it is', () => {
    const panel = page({})
    expect(() => panel.run('panel.js')).not.toThrow()
    expect(panel.calls).toEqual(['on action', 'on theme'])
    expect(panel.text()).toContain('hello, panel, dark theme')
  })

  it('run as classic scripts beside the bridge: the tab titles itself from its parameters', () => {
    const tab = page({ n: 2 })
    expect(() => tab.run('tab.js')).not.toThrow()
    expect(tab.calls).toContain('setTitle Page 2')
    expect(tab.text()).toContain('Page 2')
  })
})
