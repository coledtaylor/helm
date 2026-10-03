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
  '/user': `<!doctype html><html><head><title>User page</title></head><body><p>Only the user's</p></body></html>`
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

    // It opens a tab, which appears in the window under the session's name.
    const opened = await callTool(browser.url, token, 'browser_open', { url: `${pages.origin}/agent` })
    expect(opened.isError).toBe(false)
    expect(opened.text).toContain('title: Agent fixture')
    const agentTab = window.getByRole('tab', { name: /^Agent fixture/ })
    await expect(agentTab).toBeVisible()
    await expect(agentTab.getByText('alpha', { exact: true })).toBeVisible()

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
    const kept = window.getByRole('tab', { name: /^Clicked/ })
    await expect(kept).toBeVisible()
    await expect(kept.getByText('alpha', { exact: true })).toBeVisible()
  } finally {
    await pages.close()
  }
})
