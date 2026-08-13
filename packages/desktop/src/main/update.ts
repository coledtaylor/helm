import { app, net, type BrowserWindow } from 'electron'
import {
  readSettings,
  writeSettings,
  UPDATE_CHECK_EVERY_MS,
  type AppSettings,
  type Store
} from '@helm/core'
import type { UpdateCheck } from '../shared/ipc'

/**
 * Updates, decided rather than automated. The reasoning is in
 * `docs/PACKAGING.md`; the short version is three facts about this build:
 *
 *   - It is unsigned. electron-updater's NSIS path replaces the installed app
 *     with a downloaded one, and an unsigned replacement puts a SmartScreen
 *     prompt in front of every update. An update mechanism whose happy path is
 *     a scary dialog is worse than none.
 *   - Half the artefacts cannot use it anyway. The portable exe has no install
 *     location to replace, so electron-updater covers the NSIS build only.
 *   - The app hosts long-lived `claude` sessions. A background updater that
 *     restarts the app is a background updater that ends someone's session.
 *
 * So: an explicit check that reads a version number and hands the user a link.
 * It downloads nothing and executes nothing. This is the only outbound request
 * the app makes, and it happens two ways and no others: at launch, at most once
 * a day, if the setting says so (`maybeCheckForUpdate`); and when a person
 * presses Check now in Settings (`checkForUpdate`, through `update:check`).
 * Never on a timer and never in the background.
 */

/** Where releases are published. Not a filesystem path and not a user's - the
 * project's own address, the same identity `appId` carries. */
export const RELEASES_API = 'https://api.github.com/repos/coledtaylor/helm/releases/latest'
export const RELEASES_PAGE = 'https://github.com/coledtaylor/helm/releases/latest'

const TIMEOUT_MS = 6000

/**
 * Where the tag comes from, and a seam for the checks to aim somewhere else.
 *
 * A function rather than a URL on purpose. Pointing this at a second address
 * would mean a check standing up an HTTP server, and this app has no inbound
 * listener anywhere in it - a claim worth keeping true. Replacing the source
 * instead leaves the request machinery alone and lets a driver produce the one
 * thing the network cannot be asked for on demand: a newer version, an older
 * one, and a failure, in that order, on a machine that is online.
 *
 * Not on the IPC contract, for the same reason `pointGh` is not: which address
 * Helm asks is not the window's to choose.
 */
let releaseSource: (() => Promise<string>) | null = null
let timesAsked = 0

export function pointReleases(source: (() => Promise<string>) | null): void {
  releaseSource = source
  timesAsked = 0
}

/** How many times the source has been asked since it was pointed. */
export function releasesAsked(): number {
  return timesAsked
}

function parseSemver(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** True only when `latest` is strictly higher, so a mangled tag never nags. */
export function isNewer(current: string, latest: string): boolean {
  const a = parseSemver(latest)
  const b = parseSemver(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

function fetchLatestTag(): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url: RELEASES_API })
    // GitHub rejects a request with no user agent, and the version identifies
    // which build asked - which is the entire payload of this request.
    request.setHeader('User-Agent', `Helm/${app.getVersion()}`)
    request.setHeader('Accept', 'application/vnd.github+json')

    const timer = setTimeout(() => {
      request.abort()
      reject(new Error(`no answer within ${String(TIMEOUT_MS)} ms`))
    }, TIMEOUT_MS)

    request.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        clearTimeout(timer)
        if (response.statusCode !== 200) {
          reject(new Error(`GitHub answered ${String(response.statusCode)}`))
          return
        }
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const tag =
            parsed !== null && typeof parsed === 'object'
              ? (parsed as Record<string, unknown>)['tag_name']
              : null
          if (typeof tag !== 'string') {
            reject(new Error('the answer carried no tag'))
            return
          }
          resolve(tag)
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
    request.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    request.end()
  })
}

/**
 * The launch check: ask, at most once a day, and only if the setting is on.
 *
 * Split from `checkForUpdate` rather than folded into it because they answer to
 * different callers. The channel is a person pressing something and must always
 * ask - a throttle there would make a deliberate act do nothing and say
 * nothing. This one is the app deciding on its own, and the whole reason it is
 * allowed to is that it is bounded.
 *
 * The timestamp is written **after** a successful answer, not before. Writing
 * it first would turn a fortnight offline into a fortnight of throttle with no
 * answer behind it; as written, a machine that could not reach GitHub asks
 * again on its next launch.
 */
export async function maybeCheckForUpdate(
  services: { settings: AppSettings; store: Store },
  win: BrowserWindow | null
): Promise<void> {
  if (!services.settings.updateCheck) return

  const last = services.settings.lastUpdateCheckAt
  const lastMs = last === null ? null : Date.parse(last)
  // `Number.isFinite` rather than trusting the row: the validator refuses an
  // unparseable instant on the way in, but a row written by another build is a
  // fact about the past, and NaN here would fail the comparison and mean
  // "never ask again".
  if (lastMs !== null && Number.isFinite(lastMs) && Date.now() - lastMs < UPDATE_CHECK_EVERY_MS) {
    return
  }

  const result = await checkForUpdate()
  if (result.error !== null) return

  writeSettings(services.store, { lastUpdateCheckAt: result.checkedAt })
  services.settings = readSettings(services.store)
  if (win && !win.isDestroyed()) win.webContents.send('update:checked', result)
}

/**
 * Ask now, whoever is asking and however recently anyone last did.
 *
 * Deliberately unthrottled. `maybeCheckForUpdate` is the bounded one, and the
 * bound is what earns the app the right to ask on its own. This one is only
 * ever reached because a person pressed something, and a deliberate act that
 * silently did nothing would be worse than no button at all.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = app.getVersion()
  const checkedAt = new Date().toISOString()
  try {
    timesAsked += 1
    const tag = await (releaseSource ?? fetchLatestTag)()
    const latest = tag.replace(/^v/i, '')
    return {
      current,
      latest,
      newer: isNewer(current, latest),
      url: RELEASES_PAGE,
      error: null,
      checkedAt
    }
  } catch (err) {
    // Offline is the expected case, not an exception: the answer is "could not
    // ask", said out loud, rather than a silent "up to date".
    return {
      current,
      latest: null,
      newer: false,
      url: RELEASES_PAGE,
      error: err instanceof Error ? err.message : String(err),
      checkedAt
    }
  }
}
