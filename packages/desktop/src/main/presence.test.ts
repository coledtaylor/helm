import { describe, expect, it } from 'vitest'
import { PRESENCE_EXIT, createPresenceCheck, presenceArgs, windowsHandle, type PresenceDeps } from './presence'

const FLOTI = 'C:\\Program Files\\Helm\\resources\\floti.exe'

function check(code: number | null | Error, platform: NodeJS.Platform = 'win32') {
  const runs: Array<{ binary: string; args: readonly string[] }> = []
  const logged: string[] = []
  const handle = Buffer.alloc(8)
  handle.writeBigUInt64LE(131844n)
  const deps: PresenceDeps = {
    platform,
    binary: () => FLOTI,
    windowHandle: () => handle,
    run: (binary, args) => {
      runs.push({ binary, args })
      return code instanceof Error ? Promise.reject(code) : Promise.resolve({ code })
    },
    log: (line) => logged.push(line)
  }
  return { presence: createPresenceCheck(deps), runs, logged }
}

describe('confirming presence on this computer', () => {
  it('S13: runs floti presence over the window with the reason, and reads its answer from its exit status', async () => {
    const answers = []
    for (const code of [PRESENCE_EXIT.confirmed, PRESENCE_EXIT.declined, PRESENCE_EXIT.unavailable]) {
      const { presence, runs } = check(code)
      answers.push(await presence.confirm('Approve a device on build box'))
      expect(runs).toEqual([
        {
          binary: FLOTI,
          args: ['presence', '--window', '131844', 'Approve a device on build box']
        }
      ])
    }
    expect(answers).toEqual(['confirmed', 'declined', 'unavailable'])
  })

  it('S13: names no window where the OS check takes none', async () => {
    const { presence, runs } = check(PRESENCE_EXIT.confirmed, 'darwin')
    await presence.confirm('Revoke a phone')
    expect(runs[0]?.args).toEqual(['presence', 'Revoke a phone'])
  })

  it('S13: a floti that cannot run or ends otherwise is presence that cannot be confirmed', async () => {
    const missing = check(new Error('spawn ENOENT'))
    expect(await missing.presence.confirm('why')).toBe('unavailable')
    expect(missing.logged[0]).toContain('could not be run')
    const killed = check(null)
    expect(await killed.presence.confirm('why')).toBe('unavailable')
  })

  it('reads a window handle of either width, and none', () => {
    const narrow = Buffer.alloc(4)
    narrow.writeUInt32LE(4242)
    expect(windowsHandle(narrow)).toBe('4242')
    expect(windowsHandle(null)).toBeNull()
    expect(presenceArgs('a reason', null)).toEqual(['presence', 'a reason'])
  })
})
