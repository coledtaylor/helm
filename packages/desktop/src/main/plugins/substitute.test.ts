import { describe, expect, it } from 'vitest'
import { PluginCallError } from './errors'
import { substituteBody, substituteEnv, substituteHeaders, substituteUrl, type Reveal } from './substitute'

/**
 * Where `{{key}}` becomes a secret, and how the value is spelled there: each
 * place escapes it its own way, and a placeholder that would let a secret pick
 * where a request goes is refused before anything is read.
 */

const VALUES: Record<string, string> = {
  token: 'abc 123/&?=',
  quote: 'say "hi"\\now',
  plain: 'p1'
}

const reveal: Reveal = (key) => {
  const value = VALUES[key]
  if (value === undefined) throw new PluginCallError('secret', `no ${key}`)
  return value
}

/** Records every key asked for, so a test can show nothing was read. */
function recording(): { reveal: Reveal; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    reveal: (key) => {
      asked.push(key)
      return reveal(key)
    }
  }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const text = (data: Uint8Array | null): string | null => (data === null ? null : new TextDecoder().decode(data))

describe('substituteUrl', () => {
  it('fills a placeholder in the query, encoded for a URL', () => {
    const out = substituteUrl(new URL('https://api.example.com/items?key={{token}}'), reveal)
    expect(out.href).toBe('https://api.example.com/items?key=abc%20123%2F%26%3F%3D')
  })

  it('fills a placeholder in the path, where the URL parser has already percent-encoded the braces', () => {
    const url = new URL('https://api.example.com/{{plain}}/items')
    expect(url.pathname).toBe('/%7B%7Bplain%7D%7D/items')
    expect(substituteUrl(url, reveal).pathname).toBe('/p1/items')
  })

  it('returns the same URL, and reads nothing, when there is no placeholder', () => {
    const { reveal: counted, asked } = recording()
    const url = new URL('https://api.example.com/items?q=1')
    expect(substituteUrl(url, counted)).toBe(url)
    expect(asked).toEqual([])
  })

  it('refuses a placeholder in the host before any secret is read', () => {
    const { reveal: counted, asked } = recording()
    const url = new URL('https://{{plain}}.example.com/')
    expect(() => substituteUrl(url, counted)).toThrow(PluginCallError)
    try {
      substituteUrl(url, counted)
    } catch (error) {
      expect((error as PluginCallError).code).toBe('invalid')
    }
    expect(asked).toEqual([])
  })

  it('passes the refusal of a secret through as the call error', () => {
    expect(() => substituteUrl(new URL('https://api.example.com/?k={{missing}}'), reveal)).toThrow('no missing')
  })
})

describe('substituteHeaders', () => {
  it('fills values and never names', () => {
    const out = substituteHeaders(
      [
        ['authorization', 'Bearer {{plain}}'],
        ['x-{{plain}}', 'kept']
      ],
      reveal
    )
    expect(out).toEqual([
      ['authorization', 'Bearer p1'],
      ['x-{{plain}}', 'kept']
    ])
  })

  it('refuses a secret with a line break, which would be a second header', () => {
    const broken: Reveal = () => 'one\r\nx-injected: two'
    expect(() => substituteHeaders([['authorization', '{{plain}}']], broken)).toThrow(/line break/)
  })
})

describe('substituteBody', () => {
  it('escapes a value for a JSON string', () => {
    const out = substituteBody(bytes('{"q":"{{quote}}"}'), 'application/json; charset=utf-8', reveal)
    expect(JSON.parse(text(out)!)).toEqual({ q: 'say "hi"\\now' })
  })

  it('escapes for any +json type too', () => {
    const out = substituteBody(bytes('{"q":"{{quote}}"}'), 'application/vnd.api+json', reveal)
    expect(JSON.parse(text(out)!)).toEqual({ q: 'say "hi"\\now' })
  })

  it('form-encodes a value in a form body, braces typed or already encoded', () => {
    const typed = substituteBody(bytes('a=1&key={{token}}'), 'application/x-www-form-urlencoded', reveal)
    expect(new URLSearchParams(text(typed)!).get('key')).toBe('abc 123/&?=')
    const encoded = substituteBody(bytes('key=%7B%7Bplain%7D%7D'), 'application/x-www-form-urlencoded', reveal)
    expect(text(encoded)).toBe('key=p1')
  })

  it('puts the value as it is into other text', () => {
    expect(text(substituteBody(bytes('token: {{token}}'), 'text/plain', reveal))).toBe('token: abc 123/&?=')
    expect(text(substituteBody(bytes('{{plain}}'), null, reveal))).toBe('p1')
  })

  it('sends a body that is not UTF-8 untouched, and reads nothing for it', () => {
    const { reveal: counted, asked } = recording()
    const binary = new Uint8Array([0xff, 0xfe, 0x7b, 0x7b, 0x70, 0x7d, 0x7d])
    expect(substituteBody(binary, 'application/octet-stream', counted)).toBe(binary)
    expect(asked).toEqual([])
  })

  it('returns the same body when there is nothing to fill', () => {
    const body = bytes('{"q":1}')
    expect(substituteBody(body, 'application/json', reveal)).toBe(body)
    expect(substituteBody(null, 'application/json', reveal)).toBeNull()
  })
})

describe('substituteEnv', () => {
  it('fills every variable, the value as it is', () => {
    expect(substituteEnv({ TOKEN: '{{token}}', BOTH: '{{plain}}-{{plain}}', NONE: 'x' }, reveal)).toEqual({
      TOKEN: 'abc 123/&?=',
      BOTH: 'p1-p1',
      NONE: 'x'
    })
  })
})
