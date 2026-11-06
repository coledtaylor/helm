import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { SDK_DIR } from './fixtures'

/**
 * The template's scripts, run the way a version 2 plugin runs them: its pages
 * as classic scripts, in a global where the bridge is already defined as
 * `floti`, and its background module beside a stand-in for the `floti` the
 * host gives it.
 *
 * The bridge is installed the way `plugin-runtime/bridge.ts` installs it -
 * non-configurable - and that is the whole point of the page tests. A
 * top-level `const floti` or `let floti` in a classic script collides with a
 * non-configurable global and is a SyntaxError, so the page's HTML shows and
 * none of its script runs. `validate` cannot see that; running the file can.
 */

interface Element {
  textContent: string
  type: string
  className: string
  append: () => void
  addEventListener: (event: string, listener: () => void) => void
  click: () => void
}

/** A BroadcastChannel that hands what is posted on it to the test, and lets the test post to it. */
interface Channels {
  posted: Array<{ name: string; data: unknown }>
  deliver: (name: string, data: unknown) => void
  BroadcastChannel: new (name: string) => unknown
}

function channels(): Channels {
  const posted: Channels['posted'] = []
  const listening: Array<{ name: string; listener: (event: { data: unknown }) => void }> = []
  return {
    posted,
    deliver: (name, data) => {
      for (const entry of listening) if (entry.name === name) entry.listener({ data })
    },
    BroadcastChannel: class {
      constructor(readonly name: string) {}
      postMessage(data: unknown): void {
        posted.push({ name: this.name, data })
      }
      addEventListener(event: string, listener: (event: { data: unknown }) => void): void {
        if (event === 'message') listening.push({ name: this.name, listener })
      }
    }
  }
}

function page(params: Record<string, number>): {
  run: (file: string) => void
  calls: string[]
  text: () => string[]
  click: (id: string) => void
  channels: Channels
} {
  const calls: string[] = []
  const elements: Element[] = []
  const byId = new Map<string, Element>()
  const element = (): Element => {
    const listeners: Array<() => void> = []
    const made: Element = {
      textContent: '',
      type: '',
      className: '',
      append: () => undefined,
      addEventListener: (event, listener) => {
        if (event === 'click') listeners.push(listener)
      },
      click: () => {
        for (const listener of listeners) listener()
      }
    }
    elements.push(made)
    return made
  }
  const getElementById = (id: string): Element => {
    const found = byId.get(id) ?? element()
    byId.set(id, found)
    return found
  }
  const bridge = Object.freeze({
    apiVersion: 2,
    context: { plugin: 'hello', surface: 'panel', name: 'main', params },
    theme: { kind: 'dark' },
    visible: true,
    tabs: {
      open: (tab: string, tabParams: Record<string, number>) => {
        calls.push(`tabs.open ${tab} ${JSON.stringify(tabParams)}`)
        return Promise.resolve()
      }
    },
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
  const broadcast = channels()
  const context = createContext({
    document: { getElementById, createElement: element },
    BroadcastChannel: broadcast.BroadcastChannel,
    bridge
  })
  runInContext(
    "Object.defineProperty(globalThis, 'floti', { value: bridge, enumerable: true, configurable: false, writable: false }); globalThis.window = globalThis",
    context
  )
  return {
    calls,
    channels: broadcast,
    text: () => elements.map((made) => made.textContent).filter((text) => text !== ''),
    click: (id) => {
      getElementById(id).click()
    },
    run: (file) => {
      runInContext(readFileSync(join(SDK_DIR, 'template', 'pages', file), 'utf8'), context, { filename: file })
    }
  }
}

describe('the template pages', () => {
  it('S3: run as classic scripts beside floti: the panel listens and says where it is', () => {
    const panel = page({})
    expect(() => panel.run('panel.js')).not.toThrow()
    expect(panel.calls).toEqual(['on action', 'on theme'])
    expect(panel.text()).toContain('hello, panel, dark theme')
  })

  it('S3: the panel opens a tab through floti and tells the background on its channel', () => {
    const panel = page({})
    panel.run('panel.js')
    panel.click('open')
    expect(panel.calls).toContain('tabs.open page {"n":1}')
    expect(panel.channels.posted).toEqual([{ name: 'tabs', data: { opened: true } }])
  })

  it('S3: run as classic scripts beside floti: the tab titles itself from its parameters', () => {
    const tab = page({ n: 2 })
    expect(() => tab.run('tab.js')).not.toThrow()
    expect(tab.calls).toContain('setTitle Page 2')
    expect(tab.text()).toContain('Page 2')
  })
})

describe('the template background module', () => {
  it('S3: runs beside the floti a background gets, sets its status, and counts opened tabs on the badge', () => {
    const calls: string[] = []
    const broadcast = channels()
    // What the host gives a background module, and nothing else: no window or document.
    const floti = Object.freeze({
      apiVersion: 2,
      context: { plugin: 'hello', surface: 'background', name: 'background', params: {} },
      visible: false,
      status: {
        set: (item: { text: string }) => {
          calls.push(`status ${item.text}`)
          return Promise.resolve()
        }
      },
      badge: {
        set: (count: number | null) => {
          calls.push(`badge ${String(count)}`)
          return Promise.resolve()
        }
      }
    })
    const context = createContext({ floti, BroadcastChannel: broadcast.BroadcastChannel })
    const source = readFileSync(join(SDK_DIR, 'template', 'background', 'main.js'), 'utf8')
    // A module with no imports or exports runs as a strict script does.
    expect(source).not.toMatch(/^\s*(import|export)\b/m)
    runInContext(`'use strict';\n${source}`, context, { filename: 'background/main.js' })
    expect(calls).toEqual(['status My plugin'])

    broadcast.deliver('tabs', { opened: true })
    broadcast.deliver('tabs', { something: 'else' })
    broadcast.deliver('tabs', { opened: true })
    expect(calls).toEqual(['status My plugin', 'badge 1', 'badge 2'])
  })
})
