import { app, net } from 'electron'
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
 * So: an explicit check, run only when asked, that reads a version number and
 * hands the user a link. It downloads nothing and executes nothing. This is the
 * only outbound request the app makes, and it does not happen on a timer, at
 * startup, or in the background.
 */

/** Where releases are published. Not a filesystem path and not a user's - the
 * project's own address, the same identity `appId` carries. */
export const RELEASES_API = 'https://api.github.com/repos/coledtaylor/helm/releases/latest'
export const RELEASES_PAGE = 'https://github.com/coledtaylor/helm/releases/latest'

const TIMEOUT_MS = 6000

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

export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = app.getVersion()
  const checkedAt = new Date().toISOString()
  try {
    const tag = await fetchLatestTag()
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
