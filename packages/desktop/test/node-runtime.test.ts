import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  obtainArchive,
  pinFor,
  readPins,
  stageNode,
  tarProgram,
  verifyArchive,
  type NodePins
} from '../scripts/node-runtime.mjs'

/**
 * The pinned Node runtime staged beside `floti`. Nothing here downloads: an
 * "archive" is a file the test writes under the run's root, and the download
 * is a stand-in that writes one.
 */

const CONTENT = 'not really a Node archive'
const CONTENT_SHA = createHash('sha256').update(CONTENT).digest('hex')
const OTHER_SHA = createHash('sha256').update('something else').digest('hex')

function pinsWith(sha256: string): NodePins {
  return {
    version: '24.0.0',
    platforms: { 'linux-x64': { archive: 'node-v24.0.0-linux-x64.tar.gz', sha256, binary: 'bin/node' } }
  }
}

function folder(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name} `))
}

describe('the pinned Node runtime', () => {
  it('pins a 64-hex SHA-256 archive for each platform a release is built on', () => {
    const pins = readPins()
    expect(pins.version).toMatch(/^24\.\d+\.\d+$/)
    expect(Object.keys(pins.platforms).sort()).toEqual(['darwin-arm64', 'linux-x64', 'win32-x64'])
    for (const [platform, entry] of Object.entries(pins.platforms)) {
      expect(entry.sha256, platform).toMatch(/^[0-9a-f]{64}$/)
      const ending = platform.startsWith('win32') ? '.zip' : '.tar.gz'
      expect(entry.archive, platform).toBe(`node-v${pins.version}-${platform.replace('win32', 'win')}${ending}`)
      expect(entry.binary, platform).toBe(platform.startsWith('win32') ? 'node.exe' : 'bin/node')
    }
  })

  it('names where the binary and LICENSE sit inside the archive', () => {
    const windows = pinFor(readPins(), 'win32', 'x64')
    const top = windows.archive.slice(0, -'.zip'.length)
    expect(windows.members).toEqual({ binary: `${top}/node.exe`, license: `${top}/LICENSE` })
    expect(windows.url).toBe(`https://nodejs.org/dist/v${windows.version}/${windows.archive}`)
    const mac = pinFor(readPins(), 'darwin', 'arm64')
    expect(mac.members.binary).toBe(`${mac.archive.slice(0, -'.tar.gz'.length)}/bin/node`)
  })

  it('refuses a platform the pin file does not list, naming it', () => {
    expect(() => pinFor(readPins(), 'freebsd', 'x64')).toThrow(/no Node runtime for freebsd-x64/)
    expect(() => pinFor(readPins(), 'darwin', 'x64')).toThrow(/darwin-x64/)
  })

  it('accepts an archive whose SHA-256 matches the pin', async () => {
    const file = join(folder('archive'), 'node.tar.gz')
    writeFileSync(file, CONTENT)
    await expect(verifyArchive(file, pinFor(pinsWith(CONTENT_SHA.toUpperCase()), 'linux', 'x64'))).resolves.toBeUndefined()
  })

  it('refuses an archive whose SHA-256 does not match, naming expected and actual', async () => {
    const file = join(folder('archive'), 'node.tar.gz')
    writeFileSync(file, CONTENT)
    const refused = verifyArchive(file, pinFor(pinsWith(OTHER_SHA), 'linux', 'x64'))
    await expect(refused).rejects.toThrow(`expected SHA-256 ${OTHER_SHA}, got ${CONTENT_SHA}`)
  })

  it('reuses a verified archive already downloaded, without downloading', async () => {
    const cache = folder('node runtime')
    const pin = pinFor(pinsWith(CONTENT_SHA), 'linux', 'x64')
    writeFileSync(join(cache, pin.archive), CONTENT)
    const fetches: string[] = []
    const got = await obtainArchive(pin, cache, (url) => {
      fetches.push(url)
      return Promise.resolve()
    })
    expect(got).toEqual({ file: join(cache, pin.archive), reused: true })
    expect(fetches).toEqual([])
  })

  it('downloads again in place of a cached archive that no longer matches', async () => {
    const cache = folder('node runtime')
    const pin = pinFor(pinsWith(CONTENT_SHA), 'linux', 'x64')
    writeFileSync(join(cache, pin.archive), 'a truncated download')
    const fetches: string[] = []
    const got = await obtainArchive(pin, cache, (url, dest) => {
      fetches.push(url)
      writeFileSync(dest, CONTENT)
      return Promise.resolve()
    })
    expect(got.reused).toBe(false)
    expect(fetches).toEqual([pin.url])
  })

  it('fails staging on a download that does not match, deleting it and extracting and staging nothing', async () => {
    const cache = folder('node runtime')
    const staged = join(folder('dist host'), 'node')
    const failed = stageNode({
      cacheDir: cache,
      stagedDir: staged,
      platform: 'linux',
      arch: 'x64',
      pins: pinsWith(OTHER_SHA),
      fetchArchive: (_url, dest) => {
        writeFileSync(dest, CONTENT)
        return Promise.resolve()
      },
      tar: join(cache, 'no tar here')
    })
    await expect(failed).rejects.toThrow(`expected SHA-256 ${OTHER_SHA}, got ${CONTENT_SHA}`)
    expect(readdirSync(cache), 'no download and no extraction folder are left').toEqual([])
    expect(existsSync(staged)).toBe(false)
  })

  it('fails staging on an unlisted platform before downloading anything', async () => {
    const cache = folder('node runtime')
    const fetches: string[] = []
    const failed = stageNode({
      cacheDir: cache,
      stagedDir: join(cache, 'node'),
      platform: 'linux',
      arch: 'arm64',
      pins: pinsWith(CONTENT_SHA),
      fetchArchive: (url) => {
        fetches.push(url)
        return Promise.resolve()
      }
    })
    await expect(failed).rejects.toThrow(/linux-arm64/)
    expect(fetches).toEqual([])
    expect(readdirSync(cache)).toEqual([])
  })

  it("extracts with Windows' own tar there, which reads zip, and the system tar elsewhere", () => {
    expect(tarProgram('win32', { SystemRoot: 'D:\\Windows' })).toBe(join('D:\\Windows', 'System32', 'tar.exe'))
    expect(tarProgram('linux', {})).toBe('tar')
    expect(tarProgram('darwin', {})).toBe('tar')
  })
})
