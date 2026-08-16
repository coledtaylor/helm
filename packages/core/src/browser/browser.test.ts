import { describe, expect, it } from 'vitest'
import {
  agentReach,
  browserReachAllows,
  isLoopbackUrl,
  resolveBrowserAddress
} from './reach'

describe('agentReach', () => {
  /*
   * The whole of the M17 reach rule, as a truth table.
   *
   * All four combinations, because the interesting one is `web` + on: the pane
   * may go anywhere and the agent may not, which is the only cell where the two
   * settings disagree and therefore the only one a broken intersection would
   * still get right by accident.
   */
  const cases: Array<{
    reach: 'web' | 'local'
    localOnly: boolean
    remote: boolean
    loopback: boolean
  }> = [
    { reach: 'web', localOnly: false, remote: true, loopback: true },
    { reach: 'web', localOnly: true, remote: false, loopback: true },
    { reach: 'local', localOnly: false, remote: false, loopback: true },
    { reach: 'local', localOnly: true, remote: false, loopback: true }
  ]

  for (const entry of cases) {
    it(`${entry.reach} + ${entry.localOnly ? 'localOnly' : 'anywhere'} allows what the narrower of the two allows`, () => {
      const restrictions = agentReach(entry.reach, entry.localOnly)
      expect(browserReachAllows('http://example.com/', ...restrictions).allowed).toBe(entry.remote)
      expect(browserReachAllows('http://localhost:3000/', ...restrictions).allowed).toBe(
        entry.loopback
      )
    })
  }

  it('never widens the pane: an agent restriction is added, never substituted', () => {
    // The failure this rules out is the plausible one - reading
    // `browserMcpLocalOnly: false` as "the agent may go anywhere" and dropping
    // the pane's own setting on the floor.
    expect(agentReach('local', false)).toEqual(['local'])
    expect(browserReachAllows('http://example.com/', ...agentReach('local', false)).allowed).toBe(
      false
    )
  })

  it('refuses a non-http scheme whatever the two settings say', () => {
    for (const restrictions of [agentReach('web', false), agentReach('local', true)]) {
      expect(browserReachAllows('file:///C:/x.html', ...restrictions).allowed).toBe(false)
    }
  })
})

describe('browserReachAllows', () => {
  it('allows http and https anywhere on the wide posture', () => {
    expect(browserReachAllows('http://example.com/', 'web').allowed).toBe(true)
    expect(browserReachAllows('https://example.com/a?b=c#d', 'web').allowed).toBe(true)
    expect(browserReachAllows('http://localhost:3000/', 'web').allowed).toBe(true)
  })

  it('refuses every scheme that is not http or https, on either posture', () => {
    for (const url of [
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'helm-content://artifact/abc/index.html',
      'ftp://example.com/',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'about:blank'
    ]) {
      expect(browserReachAllows(url, 'web').allowed, url).toBe(false)
      expect(browserReachAllows(url, 'local').allowed, url).toBe(false)
    }
  })

  it('confines the narrow posture to this machine', () => {
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1:8080/', 'http://[::1]:5173/']) {
      expect(browserReachAllows(url, 'local').allowed, url).toBe(true)
    }
    for (const url of ['http://example.com/', 'https://github.com/', 'http://127.0.0.2:3000/']) {
      expect(browserReachAllows(url, 'local').allowed, url).toBe(false)
    }
  })

  /**
   * The property M17 depends on, and the reason this is one function rather
   * than two: an agent navigation passes its own restriction alongside the
   * setting, and is allowed only where both allow it. Written as a test because
   * "the two intersect" is the whole of the composition contract, and the place
   * it would break is a second copy of the rule.
   */
  it('intersects: a URL is allowed only where every restriction allows it', () => {
    expect(browserReachAllows('http://example.com/', 'web', 'local').allowed).toBe(false)
    expect(browserReachAllows('http://example.com/', 'local', 'web').allowed).toBe(false)
    expect(browserReachAllows('http://localhost:3000/', 'web', 'local').allowed).toBe(true)
    // No restrictions at all still refuses a scheme the pane cannot open.
    expect(browserReachAllows('file:///C:/x.html').allowed).toBe(false)
    expect(browserReachAllows('http://example.com/').allowed).toBe(true)
  })

  it('gives a whole sentence for every refusal', () => {
    const scheme = browserReachAllows('file:///C:/x.html', 'web')
    expect(scheme.problem).toContain('http and https')
    const reach = browserReachAllows('http://example.com/', 'local')
    expect(reach.problem).toContain('example.com')
    expect(reach.problem).toContain('Settings')
  })

  it('refuses a string that is not a URL rather than throwing', () => {
    expect(browserReachAllows('not a url', 'web').allowed).toBe(false)
    expect(browserReachAllows('', 'web').allowed).toBe(false)
  })
})

describe('isLoopbackUrl', () => {
  it('knows the three spellings and nothing else', () => {
    expect(isLoopbackUrl('http://localhost/')).toBe(true)
    expect(isLoopbackUrl('https://LOCALHOST:8443/')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.1:3000/')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:3000/')).toBe(true)
    // Deliberately narrow: a wider rule is a wider hole, and a certificate
    // exception is what hangs off this.
    expect(isLoopbackUrl('http://127.0.0.2:3000/')).toBe(false)
    expect(isLoopbackUrl('http://localhost.example.com/')).toBe(false)
    expect(isLoopbackUrl('http://notlocalhost/')).toBe(false)
    expect(isLoopbackUrl('nonsense')).toBe(false)
  })
})

describe('resolveBrowserAddress', () => {
  it('turns a bare port into a dev server on this machine', () => {
    expect(resolveBrowserAddress('3000').url).toBe('http://localhost:3000/')
    expect(resolveBrowserAddress('  5173 ').url).toBe('http://localhost:5173/')
    expect(resolveBrowserAddress('1').url).toBe('http://localhost:1/')
    expect(resolveBrowserAddress('65535').url).toBe('http://localhost:65535/')
  })

  it('refuses a number that is not a port', () => {
    expect(resolveBrowserAddress('0').url).toBeNull()
    expect(resolveBrowserAddress('70000').url).toBeNull()
  })

  it('keeps a URL that already is one', () => {
    expect(resolveBrowserAddress('https://example.com/docs').url).toBe('https://example.com/docs')
    expect(resolveBrowserAddress('http://127.0.0.1:8080/a?b=c').url).toBe('http://127.0.0.1:8080/a?b=c')
  })

  it('adds http to a host that has no scheme', () => {
    expect(resolveBrowserAddress('example.com').url).toBe('http://example.com/')
    expect(resolveBrowserAddress('localhost:3000/app').url).toBe('http://localhost:3000/app')
    expect(resolveBrowserAddress('127.0.0.1:8080').url).toBe('http://127.0.0.1:8080/')
  })

  /**
   * `localhost:3000` is the single most common thing anybody types here, and
   * `new URL` reads it as the scheme `localhost:` with an opaque path - which
   * is correct and is exactly wrong for an address bar. The refusal that shape
   * produced was "Helm's browser opens http and https pages only, and this is
   * localhost", which is a sentence that makes no sense to read.
   */
  it('reads host:port as a host and a port, not as a scheme', () => {
    expect(resolveBrowserAddress('localhost:3000').url).toBe('http://localhost:3000/')
    expect(resolveBrowserAddress('localhost:8080?q=1').url).toBe('http://localhost:8080/?q=1')
    expect(resolveBrowserAddress('example.com:8443/x').url).toBe('http://example.com:8443/x')
    // Still a scheme when it is one.
    expect(resolveBrowserAddress('https://localhost:3000/').url).toBe('https://localhost:3000/')
    expect(resolveBrowserAddress('mailto:someone@example.com').url).toBeNull()
  })

  /**
   * The posture, as a test. The address bar never hands anything to a search
   * engine, so a word is a refusal rather than a query - and the message says
   * so, because a bar that silently did nothing would be worse than one that
   * searched.
   */
  it('never searches: a word is refused with a sentence', () => {
    for (const typed of ['helm desktop shell', 'hello', 'what is a webcontentsview']) {
      const answer = resolveBrowserAddress(typed)
      expect(answer.url, typed).toBeNull()
      expect(answer.problem, typed).toContain('never searches')
    }
  })

  it('refuses a scheme the pane cannot open, naming it', () => {
    const answer = resolveBrowserAddress('file:///C:/tmp/report.html')
    expect(answer.url).toBeNull()
    expect(answer.problem).toContain('file')
  })

  it('asks for something rather than nothing when the bar is empty', () => {
    expect(resolveBrowserAddress('   ').url).toBeNull()
    expect(resolveBrowserAddress('').problem).toContain('Type an address')
  })
})
