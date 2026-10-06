import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { bearerOf, callTool, readMcpConfig, rpc } from '../test/mcp-client'
import { claudeRunIn, expect, startSession, test, typeLine } from './helm'

/** A page the session drives, and one only the user may look at. */
const PAGES: Record<string, string> = {
  '/agent': `<!doctype html><html><head><title>Agent fixture</title></head>
<body style="margin:0;background:#2f6f4f;color:#fff">
<h1>Waiting</h1>
<button onclick="document.title='Clicked';document.querySelector('h1').textContent='Clicked';console.log('clicked-token')">Change title</button>
<input aria-label="Name" value="old">
</body></html>`,
  '/user': `<!doctype html><html><head><title>User page</title></head><body><p>Only the user's</p></body></html>`,
  // A page of the user's to share: a select, something that answers a hover,
  // text that arrives late, a link away and enough height to scroll.
  '/shared': `<!doctype html><html><head><title>Shared page</title></head>
<body style="margin:0;font:16px sans-serif;background:#fff">
<h1>Shared page</h1>
<select id="pick" aria-label="Pick" onchange="document.getElementById('picked').textContent = 'picked ' + this.value">
<option value="1">One</option><option value="2">Two</option></select>
<p id="picked">picked 1</p>
<div id="hoverme" style="width:200px;height:60px;background:#ddd" onmouseenter="document.getElementById('hovered').textContent = 'hovered'">Hover me</div>
<p id="hovered">not hovered</p>
<button onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Ready now'; document.body.append(p) }, 400)">Load later</button>
<a href="/agent">To the agent page</a>
<div style="height:3000px"></div>
</body></html>`
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Serves `PAGES` on 127.0.0.1, which every reach posture lets a tool open. */
async function servePages(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const page = PAGES[req.url ?? '']
    res.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page ?? 'not here')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

test('a session drives a browser tab of its own through its tools, and loses them when it ends', async ({
  helm,
  world
}) => {
  const pages = await servePages()
  try {
    const { window } = helm
    await startSession(window, 'alpha')
    const pane = window.getByRole('region', { name: 'First pane' })

    // The user opens a tab of their own.
    await window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Browser', exact: true }).click()
    const address = window.getByRole('textbox', { name: 'Address' })
    await address.fill(`${pages.origin}/user`)
    await address.press('Enter')
    await expect(window.getByRole('tab', { name: 'User page' })).toBeVisible()

    // What the session was told: where its tools are, and the token that is its identity.
    const run = await claudeRunIn(world, world.projects.alpha)
    const config = readMcpConfig(run.argv[run.argv.indexOf('--mcp-config') + 1] ?? '')
    const browser = config.mcpServers['helm-browser']
    const sessions = config.mcpServers['helm-sessions']
    if (browser === undefined || sessions === undefined) throw new Error(`incomplete config: ${JSON.stringify(config)}`)
    const token = bearerOf(browser)

    expect((await rpc(browser.url, null, 'tools/list')).status).toBe(401)

    // It opens a tab, which appears in the Browser tab under the session's
    // name - behind the user's page, which stays in front.
    const opened = await callTool(browser.url, token, 'browser_open', { url: `${pages.origin}/agent` })
    expect(opened.isError).toBe(false)
    expect(opened.text).toContain('title: Agent fixture')
    const agentTab = window.getByRole('tab', { name: /^Agent fixture/ })
    await expect(agentTab).toBeVisible()
    await expect(agentTab.getByText('alpha', { exact: true })).toBeVisible()
    await expect(agentTab).toHaveAttribute('aria-selected', 'false')
    await expect(window.getByRole('tab', { name: 'User page' })).toHaveAttribute('aria-selected', 'true')

    /** A PNG of the page: its pixel size read from the PNG itself, and the size the tool said. */
    const screenshot = async (): Promise<{ png: Buffer; size: number[]; said: number[] }> => {
      const shot = await callTool(browser.url, token, 'browser_screenshot')
      expect(shot.images[0]?.mimeType).toBe('image/png')
      const png = Buffer.from(shot.images[0]?.data ?? '', 'base64')
      expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE)
      const said = /(\d+)x(\d+)\.$/.exec(shot.text)
      return { png, size: [png.readUInt32BE(16), png.readUInt32BE(20)], said: [Number(said?.[1]), Number(said?.[2])] }
    }
    const before = await screenshot()

    // Reads it, and clicks by the ref the snapshot gave.
    const snapshot = await callTool(browser.url, token, 'browser_snapshot')
    const ref = /- button "Change title".*\[ref=([\d.]+)\]/.exec(snapshot.text)?.[1]
    expect(ref, snapshot.text).toBeDefined()
    expect((await callTool(browser.url, token, 'browser_click', { ref })).isError).toBe(false)
    await expect(window.getByRole('tab', { name: /^Clicked/ })).toBeVisible()
    const heading = await callTool(browser.url, token, 'browser_evaluate', {
      expression: "document.querySelector('h1').textContent"
    })
    expect(heading.text).toBe('Clicked')
    await expect.poll(async () => (await callTool(browser.url, token, 'browser_console')).text).toContain('clicked-token')

    // Types over a field's value with real keys, and presses one more.
    const field = /- input "Name".*\[ref=([\d.]+)\]/.exec(snapshot.text)?.[1]
    expect(field, snapshot.text).toBeDefined()
    expect((await callTool(browser.url, token, 'browser_type', { ref: field, text: 'Hello', clear: true })).isError).toBe(false)
    expect((await callTool(browser.url, token, 'browser_press', { key: 'Backspace' })).isError).toBe(false)
    await expect
      .poll(async () => (await callTool(browser.url, token, 'browser_evaluate', { expression: "document.querySelector('input').value" })).text)
      .toBe('Hell')

    // A fresh PNG of the page, not of the window: the page's own size in device pixels.
    const after = await screenshot()
    expect(after.png.equals(before.png)).toBe(false)
    expect(after.size).toEqual(after.said)
    const viewport = await callTool(browser.url, token, 'browser_evaluate', {
      expression: '[innerWidth, innerHeight].map((side) => Math.round(side * devicePixelRatio)).join("x")'
    })
    expect(after.size.join('x')).toBe(viewport.text)

    // The user's tab is listed, and cannot be read.
    const tabs = (await callTool(browser.url, token, 'browser_tabs')).text
    const userBlock = tabs.split(/\n(?=#)/).find((block) => block.includes(`${pages.origin}/user`)) ?? ''
    expect(userBlock).toContain('opened by the user')
    const userTab = Number(/^#(\d+) /.exec(userBlock)?.[1])
    const peek = await callTool(browser.url, token, 'browser_snapshot', { tab: userTab })
    expect(peek.isError).toBe(true)
    expect(peek.text).toContain('opened by the user')
    expect(peek.text).not.toContain("Only the user's")

    // The session tools know which session is asking.
    const listing = await callTool(sessions.url, token, 'sessions_list')
    expect(listing.text).toContain(`#${String(run.pid)}  "alpha"  (this session)`)

    // The session ends: its token is refused, and its tab stays, still under its name.
    await window.getByRole('tab', { name: /^alpha, / }).click()
    await typeLine(pane, '/exit')
    await expect(window.getByRole('tab', { name: 'alpha, ended' })).toBeVisible()
    await expect.poll(async () => (await rpc(browser.url, token, 'tools/list')).status).toBe(401)
    expect((await rpc(sessions.url, token, 'tools/list')).status).toBe(401)
    await window.getByRole('tab', { name: 'Browser', exact: true }).click()
    const kept = window.getByRole('tab', { name: /^Clicked/ })
    await expect(kept).toBeVisible()
    await expect(kept.getByText('alpha', { exact: true })).toBeVisible()
  } finally {
    await pages.close()
  }
})

test('the user shares a page with a session, which reads and drives it until the share is taken back or the session ends', async ({
  helm,
  world
}) => {
  const pages = await servePages()
  try {
    const { window } = helm
    await startSession(window, 'alpha')
    const pane = window.getByRole('region', { name: 'First pane' })
    const run = await claudeRunIn(world, world.projects.alpha)
    const browser = readMcpConfig(run.argv[run.argv.indexOf('--mcp-config') + 1] ?? '').mcpServers['helm-browser']
    if (browser === undefined) throw new Error('the session was given no browser tools')
    const token = bearerOf(browser)
    const tool = (name: string, args: Record<string, unknown> = {}) => callTool(browser.url, token, name, args)
    const evaluate = async (expression: string): Promise<string> => (await tool('browser_evaluate', { expression })).text

    // The user's page, not yet shared: listed, and closed to the session.
    await window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Browser', exact: true }).click()
    const address = window.getByRole('textbox', { name: 'Address' })
    await address.fill(`${pages.origin}/shared`)
    await address.press('Enter')
    const pageTab = window.getByRole('tab', { name: /^Shared page/ })
    await expect(pageTab).toBeVisible()
    const refused = await tool('browser_text')
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('This session has no browser tab yet')

    // Shared from the bar, with the session picked by name.
    await window.getByRole('button', { name: 'Share with a session' }).click()
    await window.getByRole('menu', { name: 'Share' }).getByRole('menuitemcheckbox', { name: /alpha/ }).click()
    const note = window.getByRole('note')
    await expect(note).toHaveText('Shared with “alpha”: that session can read and drive this page.Stop sharing')
    await expect(pageTab.getByText('shared', { exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Shared with alpha' })).toBeVisible()

    // With no tab named, the shared page is the one meant.
    const text = await tool('browser_text')
    expect(text.isError).toBe(false)
    expect(text.text).toContain('Shared page')
    expect(text.text).toContain('picked 1')
    expect((await tool('browser_tabs')).text).toContain('opened by the user, shared with you')

    // A select chosen by its label, with the page's own change handler run.
    expect((await tool('browser_select', { selector: '#pick', values: ['Two'] })).text).toBe('Chose "Two" in "#pick".')
    expect(await evaluate("document.getElementById('picked').textContent")).toBe('picked 2')

    // A hover, with nothing pressed.
    expect((await tool('browser_hover', { selector: '#hoverme' })).isError).toBe(false)
    await expect.poll(() => evaluate("document.getElementById('hovered').textContent")).toBe('hovered')

    // Text that arrives late is waited for.
    expect((await tool('browser_click', { selector: 'button' })).isError).toBe(false)
    expect((await tool('browser_wait_for', { text: 'Ready now', timeout: 5 })).text).toMatch(/^"Ready now" appeared after /)

    // The wheel turns the right way, by as much as it was asked to.
    const scrolled = await tool('browser_scroll', { dy: 600 })
    expect(scrolled.text).toMatch(/^Scrolled the page down 600px\. It is at 600 of \d+ down/)
    expect(await evaluate('Math.round(window.scrollY)')).toBe('600')
    expect((await tool('browser_scroll', { dy: -600 })).text).toMatch(/^Scrolled the page up 600px\. It is at 0 of /)

    // Away and back again.
    expect((await tool('browser_navigate', { url: `${pages.origin}/agent` })).text).toContain('title: Agent fixture')
    const back = await tool('browser_navigate', { go: 'back' })
    expect(back.text).toContain(`url: ${pages.origin}/shared`)
    expect(back.text).toContain('title: Shared page')

    // It is still the user's to close.
    const closing = await tool('browser_close', { tab: Number(/^tab: (\d+)$/m.exec(back.text)?.[1]) })
    expect(closing.isError).toBe(true)
    expect(closing.text).toContain('closing it is theirs')
    await expect(pageTab).toBeVisible()

    // Taken back from the note above the page: the session is refused again.
    await note.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(note).toHaveCount(0)
    await expect(pageTab.getByText('shared', { exact: true })).toHaveCount(0)
    const unshared = await tool('browser_text')
    expect(unshared.isError).toBe(true)
    expect(unshared.text).toContain('is not shared with this session')

    // A tab of the session's own scrolls too, though nobody is looking at it.
    const own = await tool('browser_open', { url: `${pages.origin}/shared` })
    expect(own.isError).toBe(false)
    expect((await tool('browser_scroll', { dy: 500 })).text).toMatch(/^Scrolled the page down 500px/)
    expect(await evaluate('Math.round(window.scrollY)')).toBe('500')
    expect((await tool('browser_close')).isError).toBe(false)

    // Shared again, then the session ends, and the share goes with it.
    await pageTab.click()
    await window.getByRole('button', { name: 'Share with a session' }).click()
    await window.getByRole('menu', { name: 'Share' }).getByRole('menuitemcheckbox', { name: /alpha/ }).click()
    await expect(note).toBeVisible()
    await window.getByRole('tab', { name: /^alpha, / }).click()
    await typeLine(pane, '/exit')
    await expect(window.getByRole('tab', { name: 'alpha, ended' })).toBeVisible()
    await window.getByRole('tab', { name: 'Browser', exact: true }).click()
    await expect(pageTab).toBeVisible()
    await expect(window.getByRole('note')).toHaveCount(0)
    await expect(pageTab.getByText('shared', { exact: true })).toHaveCount(0)
  } finally {
    await pages.close()
  }
})
