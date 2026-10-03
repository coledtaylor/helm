import type { Locator, Page } from '@playwright/test'
import { COOKIE, POPUP_CODE, startBrowserFixture, type BrowserFixture } from './browser-fixture'
import { expect, test, type Helm } from './helm'

/**
 * The browser pane: a page loads, the page is held to Helm's posture, and what
 * it stores outlives the app. Detail is in `main/browser.test.ts` and the
 * pane's component tests; these are the workflows through the real window.
 *
 * The page itself is a native view, not part of the window's DOM. Once it has
 * loaded, Playwright sees it as a page of its own (`pageAt`).
 */

let fixture: BrowserFixture

test.beforeAll(async () => {
  fixture = await startBrowserFixture()
})

test.afterAll(async () => {
  await fixture.close()
})

const address = (ui: Page): Locator => ui.getByRole('textbox', { name: 'Address' })

/** The rail's Browser: the existing browser tab, or a new one. */
async function showBrowser(ui: Page): Promise<void> {
  await ui.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Browser' }).click()
  await expect(address(ui)).toBeVisible()
}

async function go(ui: Page, url: string): Promise<void> {
  await address(ui).fill(url)
  await address(ui).press('Enter')
}

/** The browser view's own page, once it is at an address starting with `prefix`. */
async function pageAt(helm: Helm, prefix: string): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(() => {
      found = helm.app.windows().find((candidate) => candidate.url().startsWith(prefix))
      return found !== undefined
    })
    .toBe(true)
  return found as Page
}

/** Chromium windows the process holds - the app's own, and any popup. */
const windowCount = (helm: Helm): Promise<number> =>
  helm.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

/** The tab's problem line, by what it says. */
const problem = (ui: Page, saying: string | RegExp): Locator =>
  ui.getByRole('status').filter({ hasText: saying })

test('browsing: a page loads in a browser tab, and back and forward move through what was visited', async ({
  helm
}) => {
  const ui = helm.window
  const one = `${fixture.http}/`
  const two = `${fixture.http}/two`

  await showBrowser(ui)
  await go(ui, one)
  await expect(ui.getByRole('tab', { name: /Helm fixture one/ })).toBeVisible()
  await expect(address(ui)).toHaveValue(one)
  const page = await pageAt(helm, fixture.http)
  await expect(page).toHaveTitle('Helm fixture one')

  // A link in the page, clicked in the page.
  await page.getByRole('link', { name: 'Two' }).click()
  await expect(address(ui)).toHaveValue(two)
  await expect(ui.getByRole('tab', { name: /Helm fixture two/ })).toBeVisible()

  await ui.getByRole('button', { name: 'Back' }).click()
  await expect(address(ui)).toHaveValue(one)
  await expect(page).toHaveTitle('Helm fixture one')
  await ui.getByRole('button', { name: 'Forward' }).click()
  await expect(address(ui)).toHaveValue(two)
  await expect(page).toHaveTitle('Helm fixture two')
})

test('posture: a page has no Node and no Helm, _blank makes a tab, a sign-in popup is a real window, and the app window stays put', async ({
  helm
}) => {
  const ui = helm.window
  await showBrowser(ui)
  await go(ui, `${fixture.http}/posture`)
  const page = await pageAt(helm, `${fixture.http}/posture`)
  await expect(page).toHaveTitle('Helm fixture posture')
  expect(
    await page.evaluate(() => [typeof process, typeof require, typeof (window as { helm?: unknown }).helm])
  ).toEqual(['undefined', 'undefined', 'undefined'])
  const windows = await windowCount(helm)

  // target=_blank: a Helm tab, not a window.
  await page.getByRole('link', { name: 'Open two in a new tab' }).click()
  await expect(ui.getByRole('tab', { name: /Helm fixture two/ })).toBeVisible()
  expect(await windowCount(helm)).toBe(windows)

  // window.open with features: a real popup with a live handle and a working
  // window.opener, which hands back a code and closes itself.
  await ui.getByRole('tab', { name: /Helm fixture posture/ }).click()
  const opening = helm.app.waitForEvent('window')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const popup = await opening
  await expect(page.getByRole('status')).toHaveText(`signed in with ${POPUP_CODE}`)
  await expect.poll(() => popup.isClosed()).toBe(true)
  await expect.poll(() => windowCount(helm)).toBe(windows)
  expect(await page.evaluate(() => (window as unknown as { __popup: Window }).__popup.closed)).toBe(true)
  await expect(ui.getByRole('tab', { name: /Helm fixture popup/ })).toHaveCount(0)

  // The app's own window opens nothing and cannot be navigated away.
  const opened = `${fixture.http}/app-window-open`
  expect(await ui.evaluate((url) => window.open(url, 'x', 'width=300') === null, opened)).toBe(true)
  const escape = `${fixture.http}/app-window-escape`
  const before = ui.url()
  await ui.evaluate(() => {
    ;(window as unknown as { __stillHere: boolean }).__stillHere = true
  })
  // The page sets its own location, and Chromium's own events say how that
  // ended: a navigation that started and stopped loading without committing.
  const committed = await helm.app.evaluate(
    ({ BrowserWindow }, url) =>
      new Promise<string[]>((resolve) => {
        const wc = BrowserWindow.getAllWindows().find((candidate) => candidate.getParentWindow() === null)!.webContents
        const arrived: string[] = []
        let started = false
        wc.on('did-start-navigation', (details) => {
          if (details.isMainFrame && details.url === url) started = true
        })
        wc.on('did-navigate', (_event, to) => arrived.push(to))
        wc.on('did-stop-loading', () => {
          if (started) resolve(arrived)
        })
        void wc.executeJavaScript(`location.href = ${JSON.stringify(url)}`)
      }),
    escape
  )
  expect(committed).toEqual([])
  expect(ui.url()).toBe(before)
  expect(await ui.evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere)).toBe(true)
  expect(fixture.requests).not.toContain(escape)
  expect(fixture.requests).not.toContain(opened)
  expect(await windowCount(helm)).toBe(windows)
})

test('refusals: a file address, a certificate off loopback, and an address beyond "This machine only" each get a sentence', async ({
  helm
}) => {
  const ui = helm.window
  await showBrowser(ui)
  await go(ui, `${fixture.http}/`)
  await expect(ui.getByRole('tab', { name: /Helm fixture one/ })).toBeVisible()

  await go(ui, 'file:///C:/Windows/win.ini')
  await expect(problem(ui, 'http and https')).toBeVisible()
  await expect(address(ui)).toHaveValue(`${fixture.http}/`)

  // One self-signed certificate: accepted on loopback, refused on 127.0.0.2,
  // with nothing to click through.
  await go(ui, `${fixture.httpsLoopback}/two`)
  await expect(ui.getByRole('tab', { name: /Helm fixture two/ })).toBeVisible()
  await go(ui, `${fixture.httpsNamed}/`)
  await expect(problem(ui, 'certificate Helm will not accept')).toBeVisible()
  expect(fixture.requests.filter((request) => request.startsWith(fixture.httpsNamed))).toEqual([])

  // This machine only.
  await ui.getByRole('button', { name: 'Settings' }).click()
  await ui.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Browser', exact: true }).click()
  await ui.getByRole('combobox', { name: 'Where the browser pane may go' }).selectOption('local')
  await showBrowser(ui)
  await go(ui, `${fixture.httpNamed}/two`)
  await expect(problem(ui, 'This machine only')).toContainText(fixture.httpNamed.replace('http://', ''))
  expect(fixture.requests.filter((request) => request.startsWith(fixture.httpNamed))).toEqual([])

  // Loopback still loads, and a popup beyond the reach is refused on the tab that asked.
  await go(ui, `${fixture.http}/posture`)
  const page = await pageAt(helm, `${fixture.http}/posture`)
  await expect(page).toHaveTitle('Helm fixture posture')
  await page.getByRole('button', { name: 'Sign in elsewhere' }).click()
  await expect(page.getByRole('status')).toHaveText('popup refused')
  await expect(problem(ui, 'This machine only')).toBeVisible()
  expect(await windowCount(helm)).toBe(1)
  expect(fixture.requests.filter((request) => request.startsWith(fixture.httpNamed))).toEqual([])
})

test('persistence: a cookie a page sets is kept in the browser profile, apart from the app, and survives a restart', async ({
  helm,
  relaunch
}) => {
  const jars = (app: Helm): Promise<{ browser: string[]; app: string[] }> =>
    app.app.evaluate(async ({ BrowserWindow, session }, name) => {
      const browser = await session.fromPartition('persist:helm-browser').cookies.get({ name })
      const own = await BrowserWindow.getAllWindows()[0]!.webContents.session.cookies.get({ name })
      return { browser: browser.map((cookie) => cookie.value), app: own.map((cookie) => cookie.value) }
    }, COOKIE.name)

  await showBrowser(helm.window)
  await go(helm.window, `${fixture.http}/cookie`)
  await expect(helm.window.getByRole('tab', { name: /Helm fixture cookie/ })).toBeVisible()
  await expect.poll(() => jars(helm)).toEqual({ browser: [COOKIE.value], app: [] })

  const next = await relaunch()
  await expect.poll(() => jars(next)).toEqual({ browser: [COOKIE.value], app: [] })
  const asked = fixture.requests.length
  await showBrowser(next.window)
  await go(next.window, `${fixture.http}/two`)
  const page = await pageAt(next, `${fixture.http}/two`)
  await expect(page).toHaveTitle('Helm fixture two')
  expect(await page.evaluate(() => document.cookie)).toContain(`${COOKIE.name}=${COOKIE.value}`)
  // And it went over the wire with the request.
  const sent = fixture.requests.findIndex((request, at) => at >= asked && request === `${fixture.http}/two`)
  expect(fixture.cookies[sent]).toContain(`${COOKIE.name}=${COOKIE.value}`)
})
