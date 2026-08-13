// Drives the dev app that is already open, from outside it.
//
// `pnpm design-shot` is the sanctioned way to *look* at the app, and it stays
// that: it walks every main view in both themes, in a run of its own, and its
// PNGs are what a design review argues over. What it cannot do is answer a
// question about the app you have open right now - click this, then what;
// what does the pane say when the fetch fails - because it drives its own
// process through a fixed itinerary and exits.
//
// That gap is real. The fixture bug where every row of the Files view read
// "No patch for this file in what was fetched" was invisible in the list and
// obvious two clicks in, and two clicks in is not somewhere design-shot goes.
//
// So: `pnpm dev --drive` opens Chromium's remote debugging port, and this
// talks to it.
//
//   pnpm dev --drive                          # in one terminal
//   node scripts/drive-dev.mjs text           # what the window says
//   node scripts/drive-dev.mjs click "Pull requests"
//   node scripts/drive-dev.mjs eval "document.title"
//   node scripts/drive-dev.mjs shot pulls.png
//
// `--port=` if the app said a different one.
//
// **Read-only by nature and not by promise.** `eval` runs whatever it is given
// in the renderer, which is the whole point and also the reason this is a
// script somebody runs rather than anything the app exposes: the port is off
// unless asked for, it is loopback, and the dev app has its own database. Do
// not add a flag that turns it on for `dev:live`.

const args = process.argv.slice(2)
const portArg = args.find((a) => a.startsWith('--port='))
const port = portArg ? portArg.slice('--port='.length) : '9333'
const rest = args.filter((a) => !a.startsWith('--port='))
const [command, ...params] = rest

if (command === undefined) {
  usage()
  process.exit(2)
}

/**
 * The app's own page, not devtools' and not the spike harness's.
 *
 * Matched on the entry rather than "the first page": a window with devtools
 * open lists two targets, and evaluating in the wrong one reports an empty
 * document that reads exactly like a window that has not painted.
 */
async function pageTarget() {
  let listed
  try {
    listed = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch (err) {
    console.error(
      `nothing is listening on 127.0.0.1:${port}.\n` +
        'Start the app with `pnpm dev --drive`, which is what opens the port.'
    )
    console.error(String(err))
    process.exit(1)
  }
  const pages = listed.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
  const app = pages.find((t) => !t.url.includes('spike')) ?? pages[0]
  if (app === undefined) {
    console.error(`no app page among: ${listed.map((t) => `${t.type} ${t.url}`).join(', ')}`)
    process.exit(1)
  }
  return app
}

/** One CDP round trip. Opened and closed per command; nothing here is a session. */
async function send(method, params = {}) {
  const target = await pageTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  const answer = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000)
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timer)
      resolve(message)
    })
    ws.send(JSON.stringify({ id: 1, method, params }))
  })
  ws.close()

  if (answer.error) {
    console.error(`${method}: ${answer.error.message ?? JSON.stringify(answer.error)}`)
    process.exit(1)
  }
  return answer.result
}

/**
 * Evaluates in the renderer and returns the value.
 *
 * `awaitPromise`, because half of what is worth asking is "click this, wait,
 * then tell me" - and an expression that returns a promise would otherwise
 * come back as the string `[object Promise]`, which looks like an answer.
 */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    const thrown = result.exceptionDetails.exception?.description
    console.error(thrown ?? result.exceptionDetails.text)
    process.exit(1)
  }
  return result.result?.value
}

function print(value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

switch (command) {
  case 'eval': {
    if (params[0] === undefined) fail('eval needs an expression')
    print(await evaluate(params[0]))
    break
  }

  case 'text': {
    // Blank lines dropped: the panes are laid out with a lot of empty grid, and
    // a wall of them buries the sentence you are looking for.
    print(
      await evaluate(
        "document.body.innerText.split('\\n').map(l => l.trim()).filter(Boolean).join('\\n')"
      )
    )
    break
  }

  case 'controls': {
    print(
      await evaluate(
        "[...document.querySelectorAll('button, a, [role=tab]')]" +
          ".map(e => e.textContent.trim().replace(/\\s+/g, ' ')).filter(Boolean)"
      )
    )
    break
  }

  /**
   * Clicks by visible text, and says what it clicked.
   *
   * A real `.click()` on the element the text belongs to, not a synthesised
   * pointer at coordinates: the pane layout moves, and a check that clicks a
   * point is a check that silently starts clicking something else. Reporting
   * the full label back is what catches a substring matching the wrong control.
   */
  case 'click': {
    if (params[0] === undefined) fail('click needs some text to match')
    const label = JSON.stringify(params[0])
    const what = await evaluate(`(() => {
      const hit = [...document.querySelectorAll('button, a, [role=tab]')]
        .find(e => (e.textContent || '').includes(${label}))
      if (!hit) return null
      hit.click()
      return (hit.textContent || '').trim().replace(/\\s+/g, ' ')
    })()`)
    if (what === null) fail(`nothing clickable contains ${params[0]}`)
    console.log(`clicked: ${what}`)
    break
  }

  /**
   * A PNG of the web contents.
   *
   * `Page.captureScreenshot` rather than anything that goes through the window
   * manager: it is the renderer's own pixels, so it works with the window
   * behind something else, and it is the same capture `design-shot` makes
   * (`webContents.capturePage`) - which means an edge measured here and an edge
   * measured there are the same edge.
   */
  case 'shot': {
    const file = params[0] ?? 'dev.png'
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    const { writeFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const out = resolve(file)
    writeFileSync(out, Buffer.from(data, 'base64'))
    console.log(out)
    break
  }

  default:
    fail(`unknown command ${command}`)
}

function fail(why) {
  console.error(why)
  usage()
  process.exit(2)
}

function usage() {
  console.error(
    [
      'usage: node scripts/drive-dev.mjs <command> [args] [--port=9333]',
      '',
      '  text                 everything the window says, blank lines dropped',
      '  controls             every button, link and tab, by label',
      '  click "<text>"       click the first control whose label contains it',
      '  eval "<expression>"  evaluate in the renderer; promises are awaited',
      '  shot [file.png]      a PNG of the web contents',
      '',
      'The app must be running as `pnpm dev --drive`, which opens the port.'
    ].join('\n')
  )
}
