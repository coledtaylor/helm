import { PLACEHOLDER_PATTERN } from '@helm/plugin-sdk/manifest'
import { PluginCallError } from './errors'

/**
 * Where `{{key}}` is replaced by a secret, and how the value is written there.
 *
 * Pure: the secret itself arrives through `reveal`, which is where permission
 * is decided (see `secrets.ts`). What this file owns is the spelling, because
 * a value put into a URL, a JSON body and a header each has to be escaped for
 * that place - a token with a `"` in it pasted raw into JSON is a request the
 * server cannot parse, and one with a newline pasted into a header is a second
 * header.
 */

/** Returns the value for a key, or throws `PluginCallError('secret')`. */
export type Reveal = (key: string) => string

/** `{{key}}` as typed, or as `new URL` percent-encodes the braces in a path. */
const URL_PLACEHOLDER = /(?:\{\{|%7B%7B)([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(?:\}\}|%7D%7D)/gi

function has(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0
  const found = pattern.test(text)
  pattern.lastIndex = 0
  return found
}

/** Every placeholder in `text`, replaced by `reveal`'s answer passed through `encode`. */
function replaceAll(text: string, pattern: RegExp, reveal: Reveal, encode: (value: string) => string): string {
  return text.replace(pattern, (_match, key: string) => encode(reveal(key)))
}

/**
 * A request URL with its secrets in place.
 *
 * Only after the origin: a placeholder in the scheme, host or port would let a
 * secret decide where a request goes, which is the one thing the host check
 * has to have settled before any secret is read.
 */
export function substituteUrl(url: URL, reveal: Reveal): URL {
  if (has(url.host, URL_PLACEHOLDER)) {
    throw new PluginCallError('invalid', 'a secret may not be used in the host of a URL')
  }
  const rest = url.pathname + url.search
  if (!has(rest, URL_PLACEHOLDER)) return url
  return new URL(`${url.protocol}//${url.host}${replaceAll(rest, URL_PLACEHOLDER, reveal, encodeURIComponent)}`)
}

/** Header values with their secrets in place. A name is never substituted. */
export function substituteHeaders(headers: ReadonlyArray<readonly [string, string]>, reveal: Reveal): Array<[string, string]> {
  return headers.map(([name, value]) => {
    if (!has(value, PLACEHOLDER_PATTERN)) return [name, value]
    const filled = replaceAll(value, PLACEHOLDER_PATTERN, reveal, (secret) => {
      if (/[\r\n\0]/.test(secret)) {
        throw new PluginCallError('secret', 'a secret with a line break cannot be sent in a header')
      }
      return secret
    })
    return [name, filled]
  })
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * A request body with its secrets in place, escaped for the body's type: a
 * JSON string's escapes for JSON, form encoding for a form, and the value as
 * it is for any other text. A body that is not UTF-8 text is binary and is
 * sent untouched.
 */
export function substituteBody(body: Uint8Array | null, contentType: string | null, reveal: Reveal): Uint8Array | null {
  if (body === null || body.length === 0) return body
  let text: string
  try {
    text = UTF8.decode(body)
  } catch {
    return body
  }
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (type === 'application/x-www-form-urlencoded') {
    if (!has(text, URL_PLACEHOLDER)) return body
    return new TextEncoder().encode(replaceAll(text, URL_PLACEHOLDER, reveal, encodeURIComponent))
  }
  if (!has(text, PLACEHOLDER_PATTERN)) return body
  const json = type === 'application/json' || type.endsWith('+json')
  return new TextEncoder().encode(
    replaceAll(text, PLACEHOLDER_PATTERN, reveal, (value) => (json ? JSON.stringify(value).slice(1, -1) : value))
  )
}

/** An environment for a program, its `{{key}}`s replaced. */
export function substituteEnv(env: Record<string, string>, reveal: Reveal): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    out[name] = replaceAll(value, PLACEHOLDER_PATTERN, reveal, (secret) => secret)
  }
  return out
}
