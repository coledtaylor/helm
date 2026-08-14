import type { BrowserWindow } from 'electron'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Check } from './fidelity'
import type { CheckContext } from './sessionscheck'
import { screenshot, sendMouse, sleep } from './bridge'
import { dataDir } from './paths'

/**
 * Does everything you can click look like something you can click?
 *
 * Two claims, and both are about *every* control rather than a named few:
 * a clickable thing shows the pointer cursor, and it changes appearance when
 * the pointer is on it. Three named probes live in `design-shot --only=states`
 * and they are worth keeping - they are cheap and they print colours - but
 * three probes cannot answer "all", and "all" is what the failure was. Tailwind
 * v4 gates every `hover:` utility behind `@media (hover: hover)`; on a machine
 * where Chromium finds no fine pointer that query never matches and **every**
 * hover state in the app dies at once, silently, with the tokens resolving and
 * the classes present and the rules in the stylesheet. Nothing that samples
 * three elements distinguishes that from three unlucky ones.
 *
 * So this walks the main views, enumerates every control on each, and puts a
 * real pointer on each one in turn. Not a rule scrape: `document.styleSheets`
 * throws `SecurityError` on `file://` and returns an empty list that reads
 * exactly like "no rules matched", which is how the original bug survived one
 * investigation. A `sendInputEvent` mouse move and two `getComputedStyle` reads
 * cannot lie about what a person would see.
 *
 * Every element carries its own positive control - `el.matches(':hover')` and
 * an `elementFromPoint` containment test - because a synthesised pointer that
 * never lands reports "no change" for everything on screen, which is
 * indistinguishable from everything being broken. And the *probe* carries one
 * too: two controls are planted before the walk, one that must be flagged and
 * one that must pass, on the packaging-check principle that an auditor is not
 * believed until it has been made to fail.
 *
 * One thing here is not clickable and is measured anyway: a drag handle. It
 * takes a resize cursor rather than a pointer, so it is outside the claim
 * above by what it is - but "outside the claim" and "measured by nothing" are
 * different states, and AFF-6 is the second one closed.
 *
 * Costs: no `claude` sessions, no network, roughly a minute and a half. It
 * navigates the app and stamps a `data-aff-id` on what it measures; both are
 * undone before it returns.
 *
 * `pnpm affordance-check` -> helm-data/affordance-report.json
 */

/** The groups `--only=` can name. The one authority for the list. */
const GROUPS = ['cursor', 'hover', 'quiet', 'resize'] as const
type Group = (typeof GROUPS)[number]

/**
 * What counts as clickable.
 *
 * Native elements and ARIA roles only. A `<div onClick>` is invisible from
 * here - React attaches synthetic handlers at the root, so `el.onclick` is null
 * on all of them - and that gap is covered the only way it can be, by the
 * lint-side rule that a click handler goes on a `<button>`. The two `<div
 * onClick>` in the app today are event-delegation containers for rendered HTML
 * (a markdown body, a pull-request body); the clickable things inside them are
 * anchors, which this selector does reach.
 */
const CLICKABLE = [
  'button',
  '[role="button"]',
  '[role="tab"]',
  '[role="option"]',
  'a[href]',
  'select',
  'summary',
  'input[type="checkbox"]',
  'input[type="radio"]'
].join(',')

/**
 * What must **not** look clickable, and what it should say instead.
 *
 * The `quiet` group exists because the cheap way to pass `cursor` is
 * `* { cursor: pointer }`, and a pointer over a paragraph is the same lie in
 * the other direction. A disabled control is the interesting case: it is still
 * a `<button>`, so whatever rule grants the pointer has to know the difference.
 */
const QUIET: Array<{ name: string; sel: string; want: readonly string[] }> = [
  { name: 'text input', sel: 'input[type="text"], input[type="search"]', want: ['text'] },
  { name: 'textarea', sel: 'textarea', want: ['text'] },
  { name: 'disabled button', sel: 'button:disabled', want: ['default', 'not-allowed', 'auto'] },
  { name: 'disabled select', sel: 'select:disabled', want: ['default', 'not-allowed', 'auto'] }
]

/**
 * Things you drag rather than click, and the cursor each one owes.
 *
 * A resize handle is not in `CLICKABLE` and must not be: `cursor: pointer` on
 * one would be a wrong cursor adopted to satisfy this file, which is the
 * failure `quiet` exists to catch pointing the other way. But leaving it out
 * and stopping there would put it in the coverage gap AFF-2 is named for -
 * measured by nothing, reported by nothing - so the claim is made here instead,
 * in the only form that is true of it: a separator shows the resize cursor its
 * own orientation calls for, and responds to the pointer like everything else.
 *
 * The orientation is the separator's own, not the drag's. `aria-orientation`
 * describes the line - a vertical line between two side-by-side panes, which
 * is dragged left and right (`col-resize`); a horizontal line between two
 * stacked ones, dragged up and down (`ns-resize`). Written out here rather
 * than read from the app, so this is a second opinion about the pairing and
 * not the app agreeing with itself.
 */
const RESIZE_CURSOR: Record<string, readonly string[]> = {
  vertical: ['col-resize', 'ew-resize'],
  horizontal: ['row-resize', 'ns-resize']
}

/** What a drag handle looks like in the DOM. Two of them exist: the session
 * split's divider, and the project shell's. */
const RESIZERS = '[role="separator"][aria-orientation]'

/**
 * The views to walk, and the clicks that reach each from the chrome.
 *
 * What this does **not** reach is worth writing down, because a check's
 * coverage is a claim: the modal dialogs (new harness, confirm session), the
 * pull-request detail tabs, and the profile editor are all behind a state this
 * walk would have to create and then unwind, and a walk that leaves a dialog
 * open poisons every view after it. Their controls are covered only where they
 * share a recipe with something here - which, after `SEGMENT_ON` and
 * `Checkbox`, is most of them.
 */
const VIEWS: Array<{ name: string; open: readonly string[] | null; anchor: string }> = [
  // Nothing open. Reached by closing everything rather than by a click, hence
  // the null. Audited first, so the chrome that persists across every view -
  // sidebar, title bar, status bar - is measured here and deduped out of all
  // the rest.
  { name: 'welcome', open: null, anchor: 'aside nav button[title]' },
  { name: 'project', open: ['aside nav button[title]'], anchor: '[data-project-pane]' },
  { name: 'config', open: ['[data-open-config]'], anchor: '[data-config-scope]' },
  // The config console's other three views. One click further in, and the pane
  // that holds the app's only two label-wrapped checkboxes and its MCP form -
  // which is to say, the controls least like the ones on the seven top views.
  {
    name: 'config:effective',
    open: ['[data-open-config]', '[data-config-view="effective"]'],
    anchor: '[data-only-overridden]'
  },
  {
    name: 'config:mcp',
    open: ['[data-open-config]', '[data-config-view="mcp"]'],
    anchor: '[data-mcp-pane]'
  },
  {
    name: 'config:health',
    open: ['[data-open-config]', '[data-config-view="health"]'],
    anchor: '[data-run-doctor]'
  },
  { name: 'content', open: ['[data-open-content]'], anchor: '[data-content-scope]' },
  // The content pane's other mode, and it has to be its own row for the reason
  // the config console's three do: a file tree's rows are a control recipe that
  // exists nowhere else in the app, and the pane's default is the curated view,
  // so the walk above never draws one. AFF-2 is what says a control nothing
  // measured is uncovered rather than fine.
  {
    name: 'content:tree',
    open: ['[data-open-content]', '[data-content-view="tree"]'],
    anchor: '[data-content-tree]'
  },
  { name: 'history', open: ['[data-open-history]'], anchor: '[data-history-search]' },
  { name: 'pulls', open: ['[data-open-pulls]'], anchor: '[data-pulls-refresh]' },
  { name: 'settings', open: ['[data-open-settings]'], anchor: '[data-settings-pane]' }
]

/**
 * The project pane again, on a project that is one of the **scanned folders**.
 *
 * A view of its own because the panel that offers to remove a folder from Helm
 * is only drawn for a project whose own path is a scan root, and whether the
 * first row in somebody's tree happens to be one is a fact about their machine.
 * Left to chance, the control would be measured on the developer's machine and
 * on nobody else's, which is the coverage gap AFF-2 is named for wearing a
 * disguise: `perView` would say `project=31` either way.
 *
 * So the state is planted rather than hoped for. The folder is created under
 * this check's own data directory and added through the app's own
 * `roots:accept` - the channel the welcome pane's "add this one" button uses,
 * so the row arrives the way a user's would - and taken out again afterwards.
 *
 * The name has no backslash in it on purpose: the row is reached with a CSS
 * suffix match on its `title`, and a Windows path in a selector is a string of
 * escapes.
 */
const PLANTED_ROOT_DIRNAME = 'affordance scanned folder'
const PLANTED_ROOT_VIEW = {
  name: 'project:root',
  open: [`aside nav button[title$="${PLANTED_ROOT_DIRNAME}"]`],
  anchor: '[data-project-remove-root]'
} as const

/** Where the pointer rests between measurements: a corner of the title bar
 * drag region, which is not a control and never has been. */
const PARK = { x: 2, y: 2 }

interface Spot {
  /** `data-aff-id`, how the element is found again after the pointer moves. */
  id: number
  view: string
  label: string
  path: string
  tag: string
  disabled: boolean
  /** `aria-orientation`, for the separators. Empty for everything else. */
  orient: string
}

interface Reading {
  cursor: string
  /** The element and its own descendants. */
  self: string
  /** Its parent and its siblings, each by its own style - the `peer-hover`
   * shape, where the thing that changes is not inside the thing hovered. */
  near: string
  /** Chromium's own answer to "is the pointer on this". The positive control. */
  hot: boolean
  /** The centre of the element, in window coordinates. */
  x: number
  y: number
  /** Whether `elementFromPoint` at that centre lands on it or inside it. */
  onTop: boolean
}

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  return (await win.webContents.executeJavaScript(expression, true)) as T
}

async function click(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false; el.click(); return true })()`
  )
}

/**
 * Plants the scanned folder `PLANTED_ROOT_VIEW` needs, and returns the view.
 *
 * Two ordinary subdirectories in it and no project marker anywhere, so
 * discovery lists the folder itself - one row, which is both what the folder
 * rule says and what makes the row findable by name. Null if the row never
 * arrives, and the walk then reports the view as unreached rather than
 * silently skipping it: a plant that failed is a control nothing measured.
 */
async function plantScannedFolder(
  win: BrowserWindow,
  dataDir: string
): Promise<(typeof PLANTED_ROOT_VIEW) | null> {
  const root = join(dataDir, 'affordance-fixtures', PLANTED_ROOT_DIRNAME)
  rmSync(join(dataDir, 'affordance-fixtures'), { recursive: true, force: true })
  for (const child of ['docs', 'src']) mkdirSync(join(root, child), { recursive: true })

  await js<unknown>(win, `window.helm.invoke('roots:accept', { path: ${JSON.stringify(root)} })`)
  await js<unknown>(win, `window.helm.invoke('discovery:scan', { includeGit: false })`)

  const deadline = Date.now() + 30_000
  for (;;) {
    const there = await js<boolean>(
      win,
      `document.querySelector(${JSON.stringify(PLANTED_ROOT_VIEW.open[0])}) !== null`
    ).catch(() => false)
    if (there) return PLANTED_ROOT_VIEW
    if (Date.now() > deadline) {
      console.error(`affordance-check: planted root never appeared in the tree: ${root}`)
      return null
    }
    await sleep(400)
  }
}

/** Takes the planted root back out, through the same channel the pane uses. */
async function unplantScannedFolder(win: BrowserWindow, dataDir: string): Promise<void> {
  const root = join(dataDir, 'affordance-fixtures', PLANTED_ROOT_DIRNAME)
  await js<unknown>(win, `window.helm.invoke('roots:remove', { path: ${JSON.stringify(root)} })`).catch(
    () => null
  )
  rmSync(join(dataDir, 'affordance-fixtures'), { recursive: true, force: true })
}

/** Every open tab closed, so `welcome` is a state the walk can get back to. */
async function closeAllTabs(win: BrowserWindow): Promise<void> {
  await js<void>(
    win,
    `(() => { for (const el of document.querySelectorAll('[role="tablist"] button[aria-label^="Close "]'))
        el.click() })()`
  )
}

/**
 * The JavaScript that reads one element, shared by the resting and hovered
 * passes so the two cannot drift.
 *
 * Kept as a function declaration injected per call rather than installed once
 * on `window`: a reload between views would take an installed helper with it
 * and the failure would look like the app, not the probe.
 */
const READ_FN = `
  const props = (n) => {
    const c = getComputedStyle(n)
    return [c.backgroundColor, c.color, c.borderTopColor, c.borderBottomColor,
      c.borderLeftColor, c.opacity, c.textDecorationLine, c.boxShadow,
      c.outlineColor, c.backgroundImage, c.filter, c.transform].join('|')
  }
  const read = (el) => {
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    const kin = []
    for (const s of el.parentElement ? el.parentElement.children : []) {
      if (s !== el) kin.push(s)
      if (kin.length >= 12) break
    }
    return {
      cursor: getComputedStyle(el).cursor,
      self: [el, ...[...el.querySelectorAll('*')].slice(0, 30)].map(props).join(';'),
      near: [el.parentElement, ...kin].filter(Boolean).map(props).join(';'),
      hot: el.matches(':hover'),
      x, y,
      onTop: hit !== null && (hit === el || el.contains(hit))
    }
  }
`

/**
 * Enumerate what `selector` matches on screen, stamping each so it can be found
 * again after the pointer has moved.
 *
 * Takes the selector rather than assuming `CLICKABLE` because the walk asks two
 * different questions of two different sets - what claims to be clickable, and
 * what claims to be draggable - and the enumeration, the visibility filter and
 * the dedupe are the same job for both.
 */
async function collect(
  win: BrowserWindow,
  view: string,
  seen: string[],
  selector: string = CLICKABLE
): Promise<Spot[]> {
  return js<Spot[]>(
    win,
    `(() => {
      const seen = new Set(${JSON.stringify(seen)})
      const out = []
      let n = 0
      const pathOf = (el) => {
        const parts = []
        for (let e = el; e && e !== document.body && parts.length < 6; e = e.parentElement) {
          const i = e.parentElement ? [...e.parentElement.children].indexOf(e) : 0
          parts.unshift(e.tagName.toLowerCase() + ':' + i)
        }
        return parts.join('>')
      }
      for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue
        const r = el.getBoundingClientRect()
        if (r.width < 3 || r.height < 3) continue
        if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue
        const label = (el.getAttribute('aria-label') || el.title ||
          (el.textContent || '').trim() || el.tagName).replace(/\\s+/g, ' ').slice(0, 44)
        const path = pathOf(el)
        // Deduped across views by structural position *and* label together:
        // the sidebar and title bar are on screen in all seven, and auditing
        // them seven times costs a minute and proves nothing new. A collision
        // needs the same position and the same name, which is the same control.
        const key = path + '|' + label
        if (seen.has(key)) continue
        seen.add(key)
        el.setAttribute('data-aff-id', String(n))
        out.push({
          id: n++,
          view: ${JSON.stringify(view)},
          label, path,
          tag: el.tagName.toLowerCase() + (el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : ''),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          orient: el.getAttribute('aria-orientation') || ''
        })
      }
      return out
    })()`
  ).catch(() => [])
}

/**
 * Put the pointer on one element and read it before and after.
 *
 * The resting read happens with the pointer already parked, so "after" is never
 * a tint left over from wherever the last click put it.
 */
async function measure(
  win: BrowserWindow,
  id: number
): Promise<{ rest: Reading; hover: Reading } | null> {
  const find = `(() => {
    ${READ_FN}
    const el = document.querySelector('[data-aff-id="' + ${id} + '"]')
    return el ? read(el) : null
  })()`

  const rest = await js<Reading | null>(win, find).catch(() => null)
  if (rest === null) return null
  await sendMouse(win, 'mouseMove', rest.x, rest.y)
  // 150ms is Tailwind's `transition-colors` default, so a shorter wait reads a
  // control mid-fade and calls a slow hover a missing one.
  await sleep(190)
  const hover = await js<Reading | null>(win, find).catch(() => null)
  await sendMouse(win, 'mouseMove', PARK.x, PARK.y)
  await sleep(45)
  if (hover === null) return null
  return { rest, hover }
}

type Tier = 'self' | 'near' | 'none'

function tierOf(rest: Reading, hover: Reading): Tier {
  if (rest.self !== hover.self) return 'self'
  if (rest.near !== hover.near) return 'near'
  return 'none'
}

/**
 * Prove the probe discriminates before believing anything it says.
 *
 * Two controls planted on the canvas: one with no hover rule and an inline
 * `cursor: default` that no stylesheet rule can outrank, one with both. The
 * probe has to fail the first and pass the second. A run where both pass is a
 * probe that says yes to everything; a run where both fail is a pointer that
 * never landed. Either way the audit behind it is worthless, so this is
 * checked first and the walk is skipped if it does not hold.
 */
async function proveProbe(win: BrowserWindow): Promise<Check> {
  await js<void>(
    win,
    `(() => {
      document.querySelector('[data-aff-plant]')?.remove()
      const host = document.createElement('div')
      host.setAttribute('data-aff-plant', '')
      host.style.cssText = 'position:fixed;left:340px;bottom:80px;z-index:99999;display:flex;gap:8px'
      const style = document.createElement('style')
      style.textContent =
        '#aff-yes{background:#334;color:#fff;padding:10px 16px;cursor:pointer}' +
        '#aff-yes:hover{background:#7a6;}'
      host.appendChild(style)
      // Inline cursor and no :hover rule of any kind. Inline beats a stylesheet
      // rule, so this stays an arrow however the app grants the pointer.
      host.insertAdjacentHTML('beforeend',
        '<button type="button" id="aff-no" style="background:#334;color:#fff;padding:10px 16px;cursor:default">no</button>' +
        '<button type="button" id="aff-yes">yes</button>')
      document.body.appendChild(host)
    })()`
  )
  await sleep(120)

  const readPlant = async (which: string): Promise<{ tier: Tier; cursor: string; hot: boolean } | null> => {
    const find = `(() => {
      ${READ_FN}
      const el = document.querySelector('#aff-${which}')
      return el ? read(el) : null
    })()`
    const rest = await js<Reading | null>(win, find).catch(() => null)
    if (rest === null) return null
    await sendMouse(win, 'mouseMove', rest.x, rest.y)
    await sleep(190)
    const hover = await js<Reading | null>(win, find).catch(() => null)
    await sendMouse(win, 'mouseMove', PARK.x, PARK.y)
    await sleep(45)
    if (hover === null) return null
    return { tier: tierOf(rest, hover), cursor: hover.cursor, hot: hover.hot }
  }

  const no = await readPlant('no')
  const yes = await readPlant('yes')
  await js<void>(win, `document.querySelector('[data-aff-plant]')?.remove()`)

  const landed = (no?.hot ?? false) && (yes?.hot ?? false)
  const ok =
    landed &&
    no?.tier === 'none' &&
    no?.cursor === 'default' &&
    yes?.tier === 'self' &&
    yes?.cursor === 'pointer'

  return {
    id: 'AFF-1',
    criterion: 'The probe catches a dead control and clears a live one',
    title: 'Planted controls: the one with no hover and no pointer is flagged, the one with both passes',
    ok,
    detail: { landed, dead: no, live: yes },
    notes: [
      landed
        ? 'the synthesised pointer reached both planted controls'
        : 'POINTER NEVER LANDED - every finding below would be about this driver, not the app',
      `dead control: tier=${no?.tier ?? '?'} cursor=${no?.cursor ?? '?'} (want none/default)`,
      `live control: tier=${yes?.tier ?? '?'} cursor=${yes?.cursor ?? '?'} (want self/pointer)`
    ]
  }
}

export async function runAffordanceChecks(
  ctx: CheckContext,
  shotDir: string,
  only?: readonly string[]
): Promise<Check[]> {
  const asked = only && only.length > 0 ? only : GROUPS
  const wanted = new Set<Group>(asked.filter((a): a is Group => (GROUPS as readonly string[]).includes(a)))
  for (const a of asked) {
    if (!(GROUPS as readonly string[]).includes(a)) console.error(`affordance-check: no such group: ${a}`)
  }
  const { win } = ctx
  const checks: Check[] = []

  await sendMouse(win, 'mouseMove', PARK.x, PARK.y)
  await sleep(200)

  const proof = await proveProbe(win)
  checks.push(proof)
  console.log(`${proof.ok ? 'PASS' : 'FAIL'}  ${proof.id}  ${proof.title}`)
  for (const n of proof.notes) console.log(`      ${n}`)
  if (!proof.ok) {
    checks.push({
      // audit: optional - only reached when the planted probe failed, so a
      // healthy run has no AFF-0 and `report-audit.mjs` must not want one.
      id: 'AFF-0',
      criterion: 'The walk ran',
      title: 'The audit was skipped: the probe did not prove itself',
      ok: false,
      detail: {},
      notes: ['fix AFF-1 first - an audit from a probe that cannot discriminate is worse than none']
    })
    return checks
  }

  // -------------------------------------------------------------------------
  // The walk. `quiet` needs the views opened too, so the navigation is outside
  // the group tests and only the measuring is inside them.
  // -------------------------------------------------------------------------

  const seen: string[] = []
  const seenResizers: string[] = []
  const resizers: Array<Spot & { cursor: string; tier: Tier; want: string }> = []
  const perView: Array<{ view: string; found: number }> = []
  const noPointer: Array<Spot & { cursor: string }> = []
  const noHover: Array<Spot & { tier: Tier }> = []
  const nearOnly: Array<Spot & { tier: Tier }> = []
  const blocked: Spot[] = []
  const vanished: Spot[] = []
  const quiet: Array<{ view: string; name: string; label: string; cursor: string; want: string }> = []
  let measured = 0

  // The one view whose state has to be arranged rather than clicked to. It is
  // appended rather than sitting in `VIEWS` because the table is a constant and
  // this entry only exists once the folder behind it does.
  const planted = await plantScannedFolder(win, dataDir)
  const views = planted === null ? [...VIEWS, PLANTED_ROOT_VIEW] : [...VIEWS, planted]

  for (const view of views) {
    if (view.open === null) await closeAllTabs(win)
    else {
      let reached = true
      for (const step of view.open) {
        if (!(await click(win, step))) {
          console.error(`affordance-check: could not open ${view.name} - no ${step}`)
          reached = false
          break
        }
        await sleep(450)
      }
      if (!reached) {
        perView.push({ view: view.name, found: -1 })
        continue
      }
    }
    await sleep(700)

    // The view says it is on screen, rather than the count standing in for it.
    // A count is the wrong witness: `config:health` legitimately holds one
    // control until the doctor has run, so any floor high enough to catch a
    // pane that never opened also fails a pane that opened and is simply
    // small. The anchor is the thing that is only there when the view is.
    if (!(await js<boolean>(win, `document.querySelector(${JSON.stringify(view.anchor)}) !== null`).catch(() => false))) {
      console.error(`affordance-check: ${view.name} did not paint - no ${view.anchor}`)
      perView.push({ view: view.name, found: -1 })
      continue
    }

    if (wanted.has('quiet')) {
      for (const q of QUIET) {
        const found = await js<Array<{ label: string; cursor: string }>>(
          win,
          `[...document.querySelectorAll(${JSON.stringify(q.sel)})]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 3 && r.height > 3 })
            .slice(0, 6)
            .map((el) => ({
              label: (el.getAttribute('aria-label') || el.placeholder || el.title ||
                (el.textContent || '').trim() || el.tagName).replace(/\\s+/g, ' ').slice(0, 40),
              cursor: getComputedStyle(el).cursor
            }))`
        ).catch(() => [])
        for (const f of found) {
          if (q.want.includes(f.cursor)) continue
          quiet.push({ view: view.name, name: q.name, label: f.label, cursor: f.cursor, want: q.want.join('|') })
        }
      }
    }

    const unstamp = (): Promise<void> =>
      js<void>(
        win,
        `(() => { for (const el of document.querySelectorAll('[data-aff-id]')) el.removeAttribute('data-aff-id') })()`
      )

    if (wanted.has('cursor') || wanted.has('hover')) {
      const spots = await collect(win, view.name, seen)
      for (const s of spots) seen.push(`${s.path}|${s.label}`)
      perView.push({ view: view.name, found: spots.length })
      console.log(`affordance-check: ${view.name} - ${spots.length} new controls`)

      for (const spot of spots) {
        const m = await measure(win, spot.id)
        if (m === null) {
          vanished.push(spot)
          continue
        }
        if (!m.hover.hot || !m.hover.onTop) {
          // Covered by something, scrolled under a sticky header, or moved. Not
          // a finding about the app, and not a pass either - counted and named.
          blocked.push(spot)
          continue
        }
        measured++
        if (wanted.has('cursor') && m.hover.cursor !== 'pointer' && !spot.disabled) {
          noPointer.push({ ...spot, cursor: m.hover.cursor })
        }
        if (wanted.has('hover')) {
          const tier = tierOf(m.rest, m.hover)
          if (tier === 'none') noHover.push({ ...spot, tier })
          else if (tier === 'near') nearOnly.push({ ...spot, tier })
        }
      }

      await unstamp()
    }

    // The drag handles, stamped after the controls have given their ids back so
    // the two passes cannot claim the same one.
    if (wanted.has('resize')) {
      const handles = await collect(win, view.name, seenResizers, RESIZERS)
      for (const s of handles) seenResizers.push(`${s.path}|${s.label}`)
      for (const spot of handles) {
        const m = await measure(win, spot.id)
        if (m === null) {
          vanished.push(spot)
          continue
        }
        if (!m.hover.hot || !m.hover.onTop) {
          blocked.push(spot)
          continue
        }
        const want = RESIZE_CURSOR[spot.orient] ?? []
        resizers.push({
          ...spot,
          cursor: m.hover.cursor,
          tier: tierOf(m.rest, m.hover),
          want: want.join('|')
        })
      }
      await unstamp()
    }
  }

  const shot = await screenshot(win, shotDir, 'affordance-last-view.png').catch(() => null)

  // -------------------------------------------------------------------------
  /**
   * A row in its **selected** state, which the walk above cannot speak for.
   *
   * The walk enumerates whatever is on each view and takes the first of each
   * recipe, and a sidebar holding twenty-five projects offers it twenty-four
   * unselected rows before the one that is selected. So "0 dead" above is a
   * statement about unselected rows, and the selected branch of the same
   * component was free to have no hover recipe at all - which, on five
   * components, is exactly what it had.
   *
   * Measured on itself rather than on a tier, deliberately. `near` would pass
   * this row for the wrong reason: its pin star fades in beside it on
   * `group-hover`, so a row that answers nothing of its own still scores a
   * change on a sibling. That is the masking that kept this invisible - the
   * finding was originally reported as one dead hover and stopped being
   * reported at all when the star arrived, without the row changing.
   */
  let selectedRow: {
    tier: Tier
    label: string
    restBg: string
    hoverBg: string
    /** Chromium's own answer to "the pointer is on this". The positive control. */
    hot: boolean
  } | null = null
  if (wanted.has('hover')) {
    await closeAllTabs(win)
    await sleep(300)
    // The tree is put back to the top first, and that is not tidiness. The walk
    // clicks rows wherever they are, `el.click()` scrolls the last one into
    // view, and a first row left scrolled off the top still answers
    // `aria-current` and still reports a box - at coordinates the pointer then
    // lands nowhere near. Both readings come back identical, which is exactly
    // what a dead hover looks like. Found when a view added to the end of the
    // walk left the sidebar scrolled to its foot and turned this probe red with
    // nothing wrong in the app. `hot` below is the second half of the same fix.
    await js<void>(
      win,
      `(() => { const nav = document.querySelector('aside nav'); if (nav) nav.scrollTop = 0 })()`
    ).catch(() => undefined)
    await sleep(200)
    await click(win, 'aside nav button[title]')
    await sleep(900)
    // ...and then the row itself is put where the pointer can reach it. The
    // scroll above is where the row *was* clicked from; this is about where it
    // ends up, since opening a project can move the tree under it.
    await js<void>(
      win,
      `(() => { const el = document.querySelector('aside [aria-current="true"]')
        if (el) el.scrollIntoView({ block: 'center' }) })()`
    ).catch(() => undefined)
    await sleep(300)
    const find = `(() => {
      ${READ_FN}
      const el = document.querySelector('aside [aria-current="true"]')
      return el ? { ...read(el), label: el.textContent?.slice(0, 60) ?? '' } : null
    })()`
    const rest = await js<(Reading & { label: string }) | null>(win, find).catch(() => null)
    if (rest !== null) {
      await sendMouse(win, 'mouseMove', rest.x, rest.y)
      await sleep(190)
      const hover = await js<(Reading & { label: string }) | null>(win, find).catch(() => null)
      await sendMouse(win, 'mouseMove', PARK.x, PARK.y)
      await sleep(45)
      if (hover !== null) {
        selectedRow = {
          tier: tierOf(rest, hover),
          label: rest.label,
          hot: hover.hot && hover.onTop,
          // The first field `props()` joins is `backgroundColor`, which is the
          // property this recipe moves. Named in the report so a failure says
          // "these two are the same colour" rather than "the tier was none".
          restBg: rest.self.split('|')[0] ?? '',
          hoverBg: hover.self.split('|')[0] ?? ''
        }
      }
    }
  }

  // The verdicts
  // -------------------------------------------------------------------------

  const unreached = perView.filter((p) => p.found < 0)
  checks.push({
    id: 'AFF-2',
    criterion: 'The walk reached every view and measured a real number of controls',
    title: `Every main view enumerated (${measured} controls measured across ${views.length} views)`,
    // The count floor is on the *total*, not per view. It is the guard against
    // the shape of failure PROF-4 had: a walk that reached nothing at all still
    // reports every claim below as passed, having checked nothing.
    ok: unreached.length === 0 && measured > 40,
    detail: { perView, measured, blocked: blocked.length, vanished: vanished.length },
    notes: [
      perView.map((p) => `${p.view}=${p.found}`).join('  '),
      ...unreached.map((p) => `${p.view} never painted - its controls went unmeasured`),
      `${blocked.length} skipped as covered or off-screen, ${vanished.length} re-rendered away mid-measurement`,
      ...blocked.slice(0, 8).map((b) => `blocked: ${b.view} ${b.tag} "${b.label}"`),
      ...vanished.slice(0, 8).map((b) => `vanished: ${b.view} ${b.tag} "${b.label}"`)
    ]
  })

  if (wanted.has('cursor')) {
    checks.push({
      id: 'AFF-3',
      criterion: 'Every clickable control shows the pointer cursor',
      title: `Pointer cursor on all ${measured} measured controls (${noPointer.length} without)`,
      ok: noPointer.length === 0,
      detail: { without: noPointer },
      notes:
        noPointer.length === 0
          ? ['every enabled control computed cursor: pointer']
          : noPointer.slice(0, 40).map((n) => `${n.view}  ${n.tag}  "${n.label}"  cursor: ${n.cursor}  @ ${n.path}`)
    })
  }

  if (wanted.has('hover')) {
    /**
     * The one control allowed to answer on a peer rather than on itself.
     *
     * An active tab is drawn continuous with the pane below it - same fill,
     * hairline on three sides, a 1px overlap that erases the island's top
     * border. A fill that moved under the pointer would break exactly the join
     * that makes it read as the front of the pane, so its own tone is pinned on
     * purpose, and what answers instead is its close button going from
     * `opacity-60` to full. That is visible, it is inside the tab to look at,
     * and it is a sibling only in the DOM - a button cannot be nested in a
     * button.
     *
     * Held as an assertion rather than the count-in-a-note this used to be.
     * `nearOnly` was informational, and informational is how six of them sat
     * there while the shape that produced them - an `active ? … : 'hover:…'`
     * ternary that drops the hover recipe in the selected branch - was also
     * live on five list-row components, where nothing redraws to cover it.
     * That was found by reading the six, not by the check, which is the wrong
     * way round. Now: a control that answers only on a peer has to be a tab.
     */
    const peerNotATab = nearOnly.filter((spot) => spot.tag !== 'button[tab]')
    checks.push({
      id: 'AFF-4',
      criterion: 'Every clickable control changes appearance under the pointer, and on itself',
      title: `Hover response on all ${measured} measured controls (${noHover.length} dead, ${peerNotATab.length} answering only on a peer)`,
      // `measured` is the floor, by AFF-6's argument: nothing dead and nothing
      // peer-only is also what a walk that reached no controls at all reports.
      ok: noHover.length === 0 && peerNotATab.length === 0 && measured > 0,
      detail: { dead: noHover, nearOnly, peerNotATab },
      notes: [
        `${nearOnly.length} responded on a sibling or the parent rather than themselves`,
        ...(peerNotATab.length === 0
          ? ['all of them active tabs, which is the one recipe that answers that way deliberately']
          : peerNotATab
              .slice(0, 40)
              .map((n) => `${n.view}  ${n.tag}  "${n.label}"  peer-only  @ ${n.path}`)),
        ...(noHover.length === 0
          ? ['every measured control changed at least one computed property under the pointer']
          : noHover.slice(0, 40).map((n) => `${n.view}  ${n.tag}  "${n.label}"  @ ${n.path}`))
      ]
    })
  }

  if (wanted.has('hover')) {
    checks.push({
      id: 'AFF-7',
      criterion: 'A selected row still answers the pointer, and on itself',
      title: `The selected sidebar row changes its own fill under the pointer (${selectedRow?.tier ?? 'not found'})`,
      // `null` fails. Nothing selected means the click never opened a project,
      // and a probe that reports green because it could not find its subject is
      // the shape CLAUDE.md names as worse than no check.
      // `hot` is required as well as the tier, so "the pointer never arrived"
      // cannot go on presenting itself as "the tint is dead" - the two are
      // indistinguishable from the colours alone, and the walk has carried this
      // control on every element it measures for exactly that reason.
      ok: selectedRow !== null && selectedRow.hot && selectedRow.tier === 'self',
      detail: { selectedRow },
      notes: [
        selectedRow === null
          ? 'no [aria-current="true"] row in the sidebar - the project never opened, so nothing was measured'
          : `rest ${selectedRow.restBg} -> hover ${selectedRow.hoverBg}`,
        ...(selectedRow !== null && !selectedRow.hot
          ? ['the pointer never landed on the row - this says nothing about the tint']
          : []),
        'The tier has to be `self`. `near` is what this row scores when it has',
        'no hover recipe of its own, because its pin star fades in beside it.',
        'The recipe is `ROW_SELECTED_GROUP` in ui/src/lib/rows.ts; putting the',
        'row back to a bare `bg-accent-soft` is what makes this go red.'
      ]
    })
  }

  if (wanted.has('quiet')) {
    checks.push({
      id: 'AFF-5',
      criterion: 'Nothing that is not clickable claims to be',
      title: `Text fields and disabled controls keep their own cursor (${quiet.length} wrong)`,
      ok: quiet.length === 0,
      detail: { wrong: quiet },
      notes:
        quiet.length === 0
          ? ['text inputs read "text", disabled controls do not read "pointer"']
          : quiet.slice(0, 30).map((q) => `${q.view}  ${q.name}  "${q.label}"  cursor: ${q.cursor}  want: ${q.want}`)
    })
  }

  if (wanted.has('resize')) {
    const wrong = resizers.filter(
      (r) => !(RESIZE_CURSOR[r.orient] ?? []).includes(r.cursor) || r.tier === 'none'
    )
    checks.push({
      id: 'AFF-6',
      criterion: 'A drag handle shows the resize cursor its orientation calls for, and responds to the pointer',
      title: `Resize handles carry a resize cursor (${String(resizers.length)} found, ${String(wrong.length)} wrong)`,
      // The floor is the discriminating half. `[role="separator"]` matching
      // nothing is exactly what a handle that stopped being one looks like,
      // and a check reporting green over an empty set is the shape CLAUDE.md
      // names: worse than no check.
      ok: wrong.length === 0 && resizers.length > 0,
      detail: { handles: resizers, expected: RESIZE_CURSOR, selector: RESIZERS },
      notes: [
        ...resizers.map(
          (r) => `${r.view}  ${r.orient}  "${r.label}"  cursor: ${r.cursor} (want ${r.want})  hover: ${r.tier}`
        ),
        resizers.length === 0
          ? `NOTHING MATCHED ${RESIZERS} - either the handles are gone or they stopped being separators`
          : 'a handle is deliberately not in the clickable set: `cursor: pointer` on one would be',
        'the wrong cursor adopted to satisfy this file, which is the failure the',
        '`quiet` group exists for pointing the other way. This is the claim that',
        'is true of it instead, so it is measured rather than merely exempt.',
        'The walk never opens a session, so the split divider is usually absent',
        'and the project shell’s handle is the one this finds.'
      ]
    })
  }

  // The planted folder goes back out. The data directory is this check's own
  // and is re-seeded from the real database each run, so this is tidiness
  // rather than safety - but a run that leaves a root behind is a run whose
  // next `--only=` invocation starts from a state it did not choose.
  await unplantScannedFolder(win, dataDir)

  if (shot !== null) console.log(`affordance-check: ${shot.file}`)
  return checks
}
