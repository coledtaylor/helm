import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { probe, sleep, waitFor } from './bridge'
import type { HostConnection, HostStream } from './host/client'
import { connectLocalHost, createLocalHostLink } from './host/desktop'
import type { ScreenProbe } from '../shared/protocol'
import { firstDifference } from './screen-compare'

/**
 * C10: what a client attaching to a session already running in the local
 * host is drawn - the host's redraw - against what a terminal that watched
 * the session from its start shows.
 *
 * The session runs on the host's `shell` backend, never an agent. A small
 * program in it draws the cases the redraw has to carry: true colour, the
 * 256-colour palette, wide and combining characters, each attribute, a
 * wrapped line, then the alternate screen with the cursor left where it put
 * it. The spike's terminal follows the session's stream from its first byte;
 * at each point a fresh terminal, configured the same, is attached to the
 * running session and given only what the host sends it. The two are
 * compared cell by cell - characters, widths, colours, attributes - and by
 * cursor, and again after the session and both terminals are resized.
 */

export interface HostRedrawCheck {
  id: 'C10'
  criterion: string
  title: string
  ok: boolean
  detail: Record<string, unknown>
  notes: string[]
}

interface Ctx {
  win: BrowserWindow
  dataDir: string
  cols: number
  rows: number
  windowsBuild: number | undefined
}

const ESC = '\x1b'
const RESIZED = { cols: 120, rows: 34 }

/**
 * The program the session runs. It draws the main screen and waits for a
 * line; then the alternate screen, drawn again on the next line at the size
 * that line gives; on the line after it leaves the alternate screen and exits.
 * Each step ends with a marker the driver waits for, assembled when it runs
 * so the echoed command line never holds one.
 */
const PATTERN = String.raw`
const E = '\x1b'
const out = (text) => process.stdout.write(text)
const marker = (name) => out(['C10', name].join(':'))
const size = () => (process.stdout.isTTY ? process.stdout.getWindowSize() : [80, 24])

function main() {
  out(E + '[38;2;199;21;133mviolet' + E + '[0m ' + E + '[48;2;17;199;91m' + E + '[38;2;255;255;255mjade' + E + '[0m ')
  out(E + '[38;5;208mpalette208' + E + '[0m ' + E + '[48;5;27mpalette27bg' + E + '[0m\r\n')
  out('wide 中文 🚀 combining é ä ñ\r\n')
  out(E + '[1mbold' + E + '[0m ' + E + '[3mitalic' + E + '[0m ' + E + '[4munderline' + E + '[0m ')
  out(E + '[7minverse' + E + '[0m ' + E + '[2mdim' + E + '[0m ' + E + '[1;3;4;38;2;231;118;7mall' + E + '[0m\r\n')
  let wrapped = ''
  for (let i = 0; wrapped.length < size()[0] + 37; i++) wrapped += String(i % 10)
  out(wrapped + '\r\n')
  marker('MAIN')
  out('\r\n')
}

function alternate([cols, rows]) {
  out(E + '[?1049h' + E + '[H' + E + '[2J')
  out(E + '[1;1H' + E + '[48;2;30;30;60m' + ' '.repeat(cols) + E + '[0m')
  out(E + '[1;2H' + E + '[1;38;2;255;215;0mHEADER ' + cols + 'x' + rows + E + '[0m')
  out(E + '[4;6H' + E + '[3;38;5;45m中文 wide 🚀' + E + '[0m')
  out(E + '[6;6H' + E + '[4mcafé' + E + '[0m ' + E + '[7m inverse ' + E + '[0m ' + E + '[2mdim' + E + '[0m')
  out(E + '[' + rows + ';1H' + E + '[48;2;199;21;133m' + ' '.repeat(cols - 1) + E + '[0m')
  out(E + '[' + (rows - 2) + ';3H')
  marker('ALT:' + cols + 'x' + rows)
  out(E + '[12;34H')
}

let step = 0
let line = ''
main()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (text) => {
  for (const char of text) {
    // A line ends in a line feed, after a carriage return on Windows: one step each.

    if (char !== '\n') {
      line += char
      continue
    }
    // The driver says the size it gave the terminal: Node does not always
    // hear of a resize, and the screen it draws must fit the new one.
    const given = /(\d+)x(\d+)/.exec(line)
    line = ''
    step += 1
    if (step <= 2) alternate(given === null ? size() : [Number(given[1]), Number(given[2])])
    else {
      out(E + '[?1049l')
      process.exit(0)
    }
  }
})
`

async function untilMarker(text: () => string, marker: string, timeoutMs = 20_000): Promise<boolean> {
  return waitFor(() => text().includes(marker), timeoutMs, 50)
}

/** A fresh terminal attached to the running session, drawn from what the host sends; its screen. */
async function redrawnScreen(ctx: Ctx, id: number, cols: number, rows: number): Promise<ScreenProbe> {
  await probe(ctx.win, {
    op: 'mirrorOpen',
    cols,
    rows,
    ...(ctx.windowsBuild === undefined ? {} : { windowsBuild: ctx.windowsBuild })
  })
  const decoder = new TextDecoder('utf-8')
  let writes = Promise.resolve<unknown>(undefined)
  let received = 0
  let lastAt = Date.now()
  // A second client, through a bridge of its own, as another window or device would attach.
  const other = await connectLocalHost(() => undefined)
  const stream = other.connection.openStream(
    'session:data',
    { id },
    {
      data: (bytes) => {
        received += bytes.length
        lastAt = Date.now()
        const text = decoder.decode(bytes, { stream: true })
        if (text !== '') writes = writes.then(() => probe(ctx.win, { op: 'mirrorWrite', data: text }))
      }
    }
  )
  try {
    // The redraw comes first and the session is idle, so it has all come once nothing more does.
    await waitFor(() => received > 0 && Date.now() - lastAt > 500, 10_000, 50)
    await writes
    return await probe<ScreenProbe>(ctx.win, { op: 'mirrorScreen' })
  } finally {
    stream.close()
    await other.stop()
    await probe(ctx.win, { op: 'mirrorClose' })
  }
}

async function liveScreen(ctx: Ctx): Promise<ScreenProbe> {
  await probe(ctx.win, { op: 'flush' })
  return probe<ScreenProbe>(ctx.win, { op: 'screen' })
}

export async function checkHostRedraw(
  win: BrowserWindow,
  dataDir: string,
  cols: number,
  rows: number,
  windowsBuild: number | undefined
): Promise<HostRedrawCheck> {
  const ctx: Ctx = { win, dataDir, cols, rows, windowsBuild }
  const notes: string[] = []
  const log: string[] = []
  const link = createLocalHostLink(
    () => ({}),
    (line) => log.push(line)
  )
  const comparisons: Record<string, string | null> = {}
  let stream: HostStream | null = null
  let sessionId: number | null = null
  let connection: HostConnection | null = null
  try {
    connection = await link.connection()
    const host = connection
    // A clean terminal at the session's grid: what earlier checks drew is not the session's.
    win.webContents.send('term:write', `${ESC}c`)
    win.webContents.send('term:resize', { cols, rows })
    await probe(win, { op: 'flush' })

    const row = await host.request('session:start', {
      cwd: homedir(),
      projectPath: null,
      name: 'fidelity C10',
      backend: 'shell',
      profileId: null,
      overlays: null,
      extraFolders: null,
      model: null,
      effort: null,
      agent: null,
      permissionMode: null,
      openingPrompt: null,
      cols,
      rows
    })
    const id = row.id
    sessionId = id
    const decoder = new TextDecoder('utf-8')
    let seen = ''
    stream = host.openStream(
      'session:data',
      { id },
      {
        data: (bytes) => {
          const text = decoder.decode(bytes, { stream: true })
          if (text === '') return
          seen += text
          win.webContents.send('term:write', text)
        }
      }
    )
    const live = stream
    const type = (text: string): void => {
      live.write(new TextEncoder().encode(text))
    }

    const script = join(dataDir, 'fidelity-c10.cjs')
    writeFileSync(script, PATTERN, 'utf8')
    const node = process.platform === 'win32' ? 'node.exe' : 'node'
    // Once the shell has said anything, it is reading its input.
    await waitFor(() => seen.length > 0, 15_000, 50)
    await sleep(500)
    type(`${node} "${script}"\r`)

    const compare = async (name: string, marker: string, size: { cols: number; rows: number }): Promise<void> => {
      if (!(await untilMarker(() => seen, marker))) {
        const shown = await liveScreen(ctx)
        const text = shown.cells
          .map((cells) =>
            cells
              .map((cell) => cell.chars || ' ')
              .join('')
              .trimEnd()
          )
          .filter((line) => line !== '')
        comparisons[name] = `the session never drew ${marker}; its screen showed ${JSON.stringify(text)}`
        return
      }
      // Whatever follows the marker - the cursor's last move - lands too.
      await sleep(400)
      const before = await liveScreen(ctx)
      const redrawn = await redrawnScreen(ctx, id, size.cols, size.rows)
      comparisons[name] = firstDifference(before, redrawn)
    }

    await compare('main screen', 'C10:MAIN', { cols, rows })
    type(`${String(cols)}x${String(rows)}\r`)
    await compare('alternate screen', `C10:ALT:${String(cols)}x${String(rows)}`, { cols, rows })

    await host.request('session:resize', { id, cols: RESIZED.cols, rows: RESIZED.rows })
    win.webContents.send('term:resize', RESIZED)
    await sleep(500)
    type(`${String(RESIZED.cols)}x${String(RESIZED.rows)}\r`)
    await compare('alternate screen after a resize', `C10:ALT:${String(RESIZED.cols)}x${String(RESIZED.rows)}`, RESIZED)
    type('\r')
  } catch (error) {
    notes.push(`The check could not finish: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    stream?.close()
    if (connection !== null && sessionId !== null) {
      await connection.request('session:close', { id: sessionId, force: true }).catch(() => undefined)
    }
    await link.stop()
  }

  const names = ['main screen', 'alternate screen', 'alternate screen after a resize']
  const ok = notes.length === 0 && names.every((name) => name in comparisons && comparisons[name] === null)
  for (const name of names) {
    const found = comparisons[name]
    if (found === undefined) notes.push(`${name}: not compared.`)
    else if (found === null)
      notes.push(`${name}: the redrawn terminal matches the live one, cell for cell, cursor included.`)
    else notes.push(`${name}: ${found}`)
  }
  return {
    id: 'C10',
    criterion: 'A client attaching to a running session sees what a client that watched it from the start sees',
    title: 'The host’s redraw matches the live terminal, before and after a resize',
    ok,
    detail: {
      grid: `${String(cols)}x${String(rows)}`,
      resizedTo: `${String(RESIZED.cols)}x${String(RESIZED.rows)}`,
      backend: 'shell',
      comparisons,
      host: log
    },
    notes
  }
}
