import type { Locator, Page } from '@playwright/test'
import { COOKIE, COPIED, POPUP_CODE, startBrowserFixture, type BrowserFixture } from './browser-fixture'
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

/** The Browser tab's own strip of pages. */
const pages = (ui: Page): Locator => ui.getByRole('tablist', { name: 'Browser tabs' })

/** A pane's strip of tabs - sessions, projects, the Browser tab. */
const paneTabs = (scope: Page | Locator): Locator => scope.getByRole('tablist', { name: 'Open tabs' })

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

/** Whether the web contents at `prefix` hold keyboard focus, which is where keystrokes would go. */
const pageFocused = (helm: Helm, prefix: string): Promise<boolean> =>
  helm.app.evaluate(
    ({ webContents }, at) => webContents.getAllWebContents().some((wc) => wc.getURL().startsWith(at) && wc.isFocused()),
    prefix
  )

/**
 * Give the page at `prefix` keyboard focus, as clicking into it does.
 * Playwright's click is synthesized input and moves no focus between web
 * contents, so a test that needs the page to hold the keys says so by hand.
 */
const focusPage = (helm: Helm, prefix: string): Promise<void> =>
  helm.app.evaluate(({ webContents }, at) => {
    webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(at))?.focus()
  }, prefix)

/**
 * A key pressed in the page at `prefix`, the way a person's arrives: through
 * Electron's input path, which is where Helm reads the browser's keys and
 * where Chromium takes Escape out of fullscreen. Playwright's keyboard goes
 * round both, so a test of either could not use it.
 */
const pressInPage = (
  helm: Helm,
  prefix: string,
  keyCode: string,
  modifiers: Array<'control' | 'shift'> = []
): Promise<void> =>
  helm.app.evaluate(
    async ({ webContents }, { at, key, mods }) => {
      const wc = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(at))
      if (wc === undefined) throw new Error(`no page at ${at}`)
      wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods })
      if (key.length === 1 && !mods.includes('control')) wc.sendInputEvent({ type: 'char', keyCode: key, modifiers: mods })
      wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods })
      await new Promise((resolve) => setTimeout(resolve, 50))
    },
    { at: prefix, key: keyCode, mods: modifiers }
  )

/** Whether each browser view in the app window is on screen. */
const viewsShown = (helm: Helm): Promise<boolean[]> =>
  helm.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.contentView.children.flatMap((view) =>
      'webContents' in view ? [view.getVisible()] : []
    )
  )

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

  // Ctrl+T: another page in the same Browser tab, with the caret in its address bar.
  await address(ui).press('Control+t')
  await expect(pages(ui).getByRole('tab')).toHaveText(['Helm fixture two', 'New tab'])
  await expect(pages(ui).getByRole('tab', { name: 'New tab' })).toHaveAttribute('aria-selected', 'true')
  await expect(address(ui)).toBeFocused()
  await expect(paneTabs(ui).getByRole('tab')).toHaveText(['Browser'])

  // Closing the Browser tab closes every page in it.
  await ui.getByRole('button', { name: 'Close Browser' }).click()
  await expect(paneTabs(ui).getByRole('tab', { name: 'Browser' })).toHaveCount(0)
  await expect
    .poll(() =>
      helm.app.evaluate(
        ({ webContents }, origin) => webContents.getAllWebContents().filter((wc) => wc.getURL().startsWith(origin)).length,
        fixture.http
      )
    )
    .toBe(0)
})

test('posture: a page has no Node and no Helm, _blank and window.open make pages that keep their opener, a sign-in popup is a real window, and the app window stays put', async ({
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

  // target=_blank: a page in the Browser tab - not a window, and not a tab
  // among the panes' own.
  await page.getByRole('link', { name: 'Open two in a new tab' }).click()
  await expect(pages(ui).getByRole('tab', { name: /Helm fixture two/ })).toBeVisible()
  await expect(paneTabs(ui).getByRole('tab')).toHaveText(['Browser'])
  expect(await windowCount(helm)).toBe(windows)

  // A plain window.open: a page too, with a live handle and window.opener, so a
  // sign-in run in a tab hands back its code and closes itself - and the page
  // that was waiting for it comes back to the front.
  await pages(ui).getByRole('tab', { name: /Helm fixture posture/ }).click()
  await page.getByRole('button', { name: 'Sign in in a tab' }).click()
  await expect(page.getByRole('status')).toHaveText(`signed in with ${POPUP_CODE}`)
  await expect(pages(ui).getByRole('tab', { name: /Helm fixture opened/ })).toHaveCount(0)
  await expect(pages(ui).getByRole('tab', { name: /Helm fixture posture/ })).toHaveAttribute('aria-selected', 'true')
  expect(await windowCount(helm)).toBe(windows)

  // window.open with features: a real popup with a live handle and a working
  // window.opener, which hands back a code and closes itself.
  await page.evaluate(() => {
    document.getElementById('status')!.textContent = 'signed out'
  })
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

test('find in page: the caret stays in the find field while typing, and the count says how many matches', async ({
  helm
}) => {
  const ui = helm.window
  const url = `${fixture.http}/find`

  await showBrowser(ui)
  await go(ui, url)
  await expect(await pageAt(helm, url)).toHaveTitle('Helm fixture find')

  // Loading the page gave it keyboard focus. A real click on the window takes
  // focus back to the window's own web contents; Playwright's click is
  // synthesized input and moves nothing, so that half is done here by hand.
  // Without it the page holds focus from the start and the checks below prove
  // nothing.
  await helm.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((win) => win.getParentWindow() === null)!.webContents.focus()
  )
  expect(await pageFocused(helm, url)).toBe(false)

  await ui.getByRole('button', { name: 'Find in page' }).click()
  const field = ui.getByRole('textbox', { name: 'Find in page' })
  const count = ui.locator('[data-browser-find-count]')
  await expect(field).toBeFocused()

  // Key by key, the way a person types: every keystroke is a search.
  await field.pressSequentially('needle', { delay: 50 })
  await expect(field).toHaveValue('needle')
  await expect(count).toHaveText('1 / 3')
  await expect(field).toBeFocused()
  expect(await pageFocused(helm, url)).toBe(false)

  // Enter steps forward, Shift+Enter back, and the caret never leaves.
  await field.press('Enter')
  await expect(count).toHaveText('2 / 3')
  await field.press('Shift+Enter')
  await expect(count).toHaveText('1 / 3')
  await expect(field).toBeFocused()
  expect(await pageFocused(helm, url)).toBe(false)

  // A word the page does not contain says so.
  await field.fill('haystacks')
  await expect(count).toHaveText('no matches')

  // Escape closes the field and gives the page the caret back.
  await field.press('Escape')
  await expect(field).toHaveCount(0)
  await expect.poll(() => pageFocused(helm, url)).toBe(true)
})

test("the keyboard: the browser's keys work with the caret in the page, and every other key is the page's", async ({
  helm
}) => {
  const ui = helm.window
  const url = `${fixture.http}/tools`
  await showBrowser(ui)
  await go(ui, url)
  const page = await pageAt(helm, url)
  await expect(page).toHaveTitle('Helm fixture tools')
  const keys = (): Promise<string[]> => page.evaluate(() => (window as unknown as { keys: string[] }).keys)

  // Typed into the page, each of these is the browser's: Main takes it before
  // the page sees it and the window answers.
  await pressInPage(helm, url, 'f', ['control'])
  const find = ui.getByRole('textbox', { name: 'Find in page' })
  await expect(find).toBeFocused()
  await find.press('Escape')
  await expect.poll(() => pageFocused(helm, url)).toBe(true)

  await pressInPage(helm, url, 'l', ['control'])
  await expect(address(ui)).toBeFocused()

  await pressInPage(helm, url, 't', ['control'])
  await expect(pages(ui).getByRole('tab')).toHaveText(['Helm fixture tools', 'New tab'])
  await expect(address(ui)).toBeFocused()

  // A key that is not the browser's reaches the page, and none of the above did.
  await pressInPage(helm, url, 'a')
  await pressInPage(helm, url, 'a', ['control'])
  expect(await keys()).toEqual(['a', 'Control+a'])

  await pages(ui).getByRole('tab', { name: /Helm fixture tools/ }).click()
  await pressInPage(helm, url, 'w', ['control'])
  await expect(pages(ui).getByRole('tab')).toHaveText(['New tab'])

  // Ctrl+Shift+T, from the window's side this time, brings it back where it was.
  await address(ui).press('Control+Shift+T')
  await expect(pages(ui).getByRole('tab')).toHaveText(['Helm fixture tools', 'New tab'])
  await expect(pages(ui).getByRole('tab', { name: /Helm fixture tools/ })).toHaveAttribute('aria-selected', 'true')
  await expect(await pageAt(helm, url)).toHaveTitle('Helm fixture tools')
})

test('the address list: the page stands down for it and stays down, so a remembered address takes the click', async ({
  helm
}) => {
  const ui = helm.window
  const two = `${fixture.http}/two`
  const find = `${fixture.http}/find`
  await showBrowser(ui)
  await go(ui, two)
  await expect(await pageAt(helm, two)).toHaveTitle('Helm fixture two')
  await go(ui, find)
  await expect(await pageAt(helm, find)).toHaveTitle('Helm fixture find')
  await expect.poll(() => viewsShown(helm)).toEqual([true])

  await address(ui).click()
  const list = ui.locator('[data-browser-recent]')
  await expect(list).toBeVisible()
  await expect.poll(() => viewsShown(helm)).toEqual([false])
  // And it stays down while the list is open. The page is a native view over
  // the window, so a view that came back for a moment would be under the
  // pointer instead of the list, and a person's click would go to the page.
  // (Playwright clicks the window's own document and cannot tell.)
  for (let look = 0; look < 12; look += 1) {
    expect(await viewsShown(helm), `look ${String(look)}`).toEqual([false])
    await ui.waitForTimeout(100)
  }

  await list.locator(`[data-browser-recent-url="${two}"]`).click()
  await expect(list).toHaveCount(0)
  await expect(address(ui)).toHaveValue(two)
  await expect.poll(() => viewsShown(helm)).toEqual([true])
})

test('the menu: zoom, width, DevTools and clearing data are behind More, opened over a still of the page', async ({
  helm
}) => {
  const ui = helm.window
  const url = `${fixture.http}/two`
  await showBrowser(ui)
  await go(ui, url)
  await expect(await pageAt(helm, url)).toHaveTitle('Helm fixture two')
  await expect.poll(() => viewsShown(helm)).toEqual([true])

  await ui.getByRole('button', { name: 'More' }).click()
  const menu = ui.getByRole('menu', { name: 'Browser' })
  await expect(menu).toBeVisible()
  // The page is off the screen for the menu, and a picture of it is where it was.
  await expect.poll(() => viewsShown(helm)).toEqual([false])
  await expect(ui.locator('[data-browser-still]')).toHaveCount(1)

  await menu.getByRole('menuitem', { name: /Zoom in/ }).click()
  await expect(menu).toHaveCount(0)
  await expect.poll(() => viewsShown(helm)).toEqual([true])
  await expect(ui.locator('[data-browser-still]')).toHaveCount(0)
  // The zoom is said in the address bar, and a click there puts it back.
  const chip = ui.getByRole('button', { name: 'Zoom 110%, back to actual size' })
  await expect(chip).toBeVisible()
  const level = (): Promise<number | undefined> =>
    helm.app.evaluate(
      ({ webContents }, at) => webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(at))?.getZoomLevel(),
      url
    )
  expect(await level()).toBe(0.5)
  await chip.click()
  await expect(chip).toHaveCount(0)
  expect(await level()).toBe(0)
})

test('permissions: a page may write the clipboard and take the whole screen, and Escape gives the screen back', async ({
  helm
}) => {
  const ui = helm.window
  const url = `${fixture.http}/tools`
  await showBrowser(ui)
  await go(ui, url)
  const page = await pageAt(helm, url)
  const status = page.getByRole('status')
  const clipboard = (): Promise<string> => helm.app.evaluate(({ clipboard: board }) => board.readText())
  const screen = (): Promise<{ full: boolean; content: Electron.Rectangle; view: Electron.Rectangle }> =>
    helm.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      const view = win.contentView.children.find((child) => 'webContents' in child)!
      return { full: win.isFullScreen(), content: win.getContentBounds(), view: view.getBounds() }
    })

  // This writes the clipboard of the machine the tests run on, so what was
  // there is put back.
  const kept = await clipboard()
  try {
    await focusPage(helm, url)
    await page.getByRole('button', { name: 'Copy' }).click()
    await expect(status).toHaveText('copied')
    expect(await clipboard()).toBe(COPIED)
    // Reading it is still refused: a clipboard holds passwords.
    expect(await page.evaluate(() => navigator.clipboard.readText().then(() => 'read', () => 'refused'))).toBe(
      'refused'
    )
  } finally {
    await helm.app.evaluate(({ clipboard: board }, text) => board.writeText(text), kept)
  }

  await focusPage(helm, url)
  await page.getByRole('button', { name: 'Go full screen' }).click()
  await expect(status).toHaveText('fullscreen')
  // The whole window, the strip of the title bar included.
  await expect
    .poll(async () => {
      const now = await screen()
      return now.full && now.view.x === 0 && now.view.y === 0 && now.view.width === now.content.width
    })
    .toBe(true)

  await pressInPage(helm, url, 'Escape')
  await expect(status).toHaveText('left fullscreen')
  await expect.poll(async () => (await screen()).full).toBe(false)
  // Back in its pane, clear of the title bar.
  await expect.poll(async () => (await screen()).view.y).toBeGreaterThan(36)
})

test('dragging: the page stands down while the Browser tab is dragged, and is drawn where the tab lands', async ({
  helm
}) => {
  const ui = helm.window
  const first = ui.getByRole('region', { name: 'First pane' })
  const second = ui.getByRole('region', { name: 'Second pane' })
  const viewShown = (): Promise<boolean[]> => viewsShown(helm)

  await ui.locator('[data-rail="settings"]').click()
  await showBrowser(ui)
  await go(ui, `${fixture.http}/`)
  await expect(pages(ui).getByRole('tab', { name: /Helm fixture one/ })).toBeVisible()
  const tab = paneTabs(ui).getByRole('tab', { name: 'Browser' })
  await expect.poll(viewShown).toEqual([true])

  // By hand, to look while it is held over the first pane's right side: the
  // page is off the screen, and the part of the pane it would take is drawn.
  const box = (await first.boundingBox())!
  await tab.hover()
  await ui.mouse.down()
  await ui.mouse.move(box.x + box.width - 12, box.y + box.height / 2, { steps: 6 })
  await expect(first.locator('[data-pane-drop-preview]')).toHaveAttribute('data-pane-drop-preview', 'right')
  await expect.poll(viewShown).toEqual([false])
  await ui.mouse.up()
  await expect(paneTabs(second).getByRole('tab')).toHaveText(['Browser'])
  await expect(second.getByRole('tab', { name: /Helm fixture one/ })).toBeVisible()
  await expect.poll(viewShown).toEqual([true])

  // Back into the first pane's middle: the second, emptied, goes - its strip
  // with it, before the drag that strip started could hear itself end.
  await tab.dragTo(first, { targetPosition: { x: box.width / 4, y: box.height / 2 } })
  await expect(ui.getByRole('region', { name: /pane$/ })).toHaveCount(1)
  await expect.poll(viewShown).toEqual([true])
  // The drag is over, so nothing is left lying over the pane to catch a click.
  await first.getByRole('tab', { name: 'Settings' }).click()
  await expect.poll(viewShown).toEqual([false])
  await first.getByRole('tab', { name: 'Browser' }).click()
  await expect.poll(viewShown).toEqual([true])
  await address(ui).click()
  await expect(address(ui)).toBeFocused()
})
