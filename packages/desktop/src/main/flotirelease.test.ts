import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, inject, it } from 'vitest'
import { RUN_ROOT } from '../../../../test/run-root'
import {
  RELEASE_TARGETS,
  STAGED_SUMS_NAME,
  binaryFacts,
  binaryProblem,
  desktopVersion,
  formatSums,
  parseSums,
  releaseFileName,
  releaseFileNames,
  releaseFilesProblem,
  sha256Of,
  stagePrebuilt,
  sumsFileName,
  targetFor,
  targetNamed,
  versionProblem,
  writeSums
} from '../../scripts/floti-release.mjs'

/**
 * The floti files a release carries (scripts/floti-release.mjs): their names,
 * the header check each build passes on its own runner in
 * .github/workflows/floti.yml, the SHA-256 list beside them, and the staging
 * of the release's file into the desktop's resources.
 */

const VERSION = '3.0.0'

/** A PE file's first bytes, with `machine` in its COFF header. */
function pe(machine: number): Uint8Array {
  const bytes = new Uint8Array(0x100)
  const view = new DataView(bytes.buffer)
  bytes.set([0x4d, 0x5a])
  view.setUint32(0x3c, 0x80, true)
  view.setUint32(0x80, 0x50450000, false)
  view.setUint16(0x84, machine, true)
  return bytes
}

/** A 64-bit Mach-O file's first bytes. */
function macho(cputype: number): Uint8Array {
  const bytes = new Uint8Array(32)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0xfeedfacf, true)
  view.setUint32(4, cputype, true)
  return bytes
}

/**
 * A 64-bit little-endian ELF file with a program interpreter or not, and a
 * dynamic section that needs a shared library or not, as a static-pie file
 * has one that needs none.
 */
function elf(machine: number, { interpreter, needed }: { interpreter: boolean; needed: boolean }): Uint8Array {
  const phoff = 64
  const phentsize = 56
  const headers: { type: number; offset: number; size: number }[] = [{ type: 1, offset: 0, size: 0 }]
  const dynamicAt = 0x200
  if (interpreter) headers.push({ type: 3, offset: 0x1c0, size: 28 })
  headers.push({ type: 2, offset: dynamicAt, size: 48 })
  const bytes = new Uint8Array(0x300)
  const view = new DataView(bytes.buffer)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  view.setUint16(18, machine, true)
  view.setBigUint64(32, BigInt(phoff), true)
  view.setUint16(54, phentsize, true)
  view.setUint16(56, headers.length, true)
  headers.forEach((header, i) => {
    const at = phoff + i * phentsize
    view.setUint32(at, header.type, true)
    view.setBigUint64(at + 8, BigInt(header.offset), true)
    view.setBigUint64(at + 32, BigInt(header.size), true)
  })
  // DT_FLAGS_1 (or DT_NEEDED), then DT_NULL.
  view.setBigInt64(dynamicAt, needed ? 1n : 0x6ffffffbn, true)
  view.setBigInt64(dynamicAt + 16, 0n, true)
  return bytes
}

const STATIC = { interpreter: false, needed: false }

describe('the floti files a release carries', () => {
  it('names a build for each of Windows x64 and arm64, macOS Apple Silicon and Linux x64 and arm64, and their sums', () => {
    expect(RELEASE_TARGETS.map((target) => target.name)).toEqual(['windows-x64', 'windows-arm64', 'macos-arm64', 'linux-x64', 'linux-arm64'])
    expect(releaseFileNames(VERSION)).toEqual([
      'floti-3.0.0-SHA256SUMS',
      'floti-3.0.0-linux-arm64',
      'floti-3.0.0-linux-x64',
      'floti-3.0.0-macos-arm64',
      'floti-3.0.0-windows-arm64.exe',
      'floti-3.0.0-windows-x64.exe'
    ])
  })

  it('finds the build for the platform this desktop runs on, and none for one no release carries', () => {
    expect(targetFor('win32', 'x64')?.name).toBe('windows-x64')
    expect(targetFor('darwin', 'arm64')?.name).toBe('macos-arm64')
    expect(targetFor('linux', 'arm64')?.name).toBe('linux-arm64')
    expect(targetFor('darwin', 'x64')).toBeNull()
    expect(targetFor('freebsd', 'arm64')).toBeNull()
    expect(() => targetNamed('freebsd-arm64')).toThrow(/they are windows-x64, windows-arm64/)
  })

  it('reads floti its version from the desktop', () => {
    expect(desktopVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe("S1: each build is checked to be for its own OS and CPU, and the Linux builds to be statically linked", () => {
  it('takes a build whose header names its target', () => {
    expect(binaryProblem(pe(0x8664), targetNamed('windows-x64'))).toBeNull()
    expect(binaryProblem(pe(0xaa64), targetNamed('windows-arm64'))).toBeNull()
    expect(binaryProblem(macho(0x0100000c), targetNamed('macos-arm64'))).toBeNull()
    expect(binaryProblem(elf(0x3e, STATIC), targetNamed('linux-x64'))).toBeNull()
    expect(binaryProblem(elf(0xb7, STATIC), targetNamed('linux-arm64'))).toBeNull()
  })

  it('refuses a build for another CPU or OS, naming what it is', () => {
    expect(binaryProblem(pe(0x8664), targetNamed('windows-arm64'))).toBe('it is built for windows x64, not windows arm64')
    expect(binaryProblem(macho(0x01000007), targetNamed('macos-arm64'))).toBe('it is built for macos x64, not macos arm64')
    expect(binaryProblem(elf(0xb7, STATIC), targetNamed('linux-x64'))).toBe('it is built for linux arm64, not linux x64')
    expect(binaryProblem(elf(0x3e, STATIC), targetNamed('windows-x64'))).toBe('it is built for linux x64, not windows x64')
    expect(binaryProblem(new Uint8Array(64), targetNamed('linux-x64'))).toBe('it is not a Windows, macOS or Linux executable')
  })

  it('refuses a Linux build with a program interpreter or a shared library it needs', () => {
    const dynamic = 'it is dynamically linked: it names a program interpreter or needs a shared library'
    expect(binaryFacts(elf(0x3e, { interpreter: true, needed: true })).linkage).toBe('dynamic')
    expect(binaryProblem(elf(0x3e, { interpreter: true, needed: false }), targetNamed('linux-x64'))).toBe(dynamic)
    expect(binaryProblem(elf(0x3e, { interpreter: false, needed: true }), targetNamed('linux-x64'))).toBe(dynamic)
  })

  it('reads the Node running this test as built for this OS and CPU, and dynamically linked on Linux', () => {
    const target = targetFor(process.platform, process.arch)
    if (target === null) return
    const facts = binaryFacts(readFileSync(process.execPath))
    expect({ os: facts.os, cpu: facts.cpu }).toEqual({ os: target.os, cpu: target.cpu })
    if (target.os === 'linux') expect(facts.linkage).toBe('dynamic')
  })

  it('takes a build that says this version, this OS and this CPU, and refuses one that says another', () => {
    const target = targetNamed('linux-arm64')
    expect(versionProblem({ short: 'floti 3.0.0\n', line: 'floti 3.0.0 protocol 1.0 linux arm64\n' }, VERSION, target)).toBeNull()
    expect(versionProblem({ short: 'floti 2.9.0\n', line: 'floti 3.0.0 protocol 1.0 linux arm64' }, VERSION, target)).toBe(
      'floti --version printed "floti 2.9.0", not "floti 3.0.0"'
    )
    expect(versionProblem({ short: 'floti 3.0.0', line: 'floti 3.0.0 protocol 1.0 linux x64' }, VERSION, target)).toBe(
      'floti version printed "floti 3.0.0 protocol 1.0 linux x64", not "floti 3.0.0 protocol <version> linux arm64"'
    )
    expect(versionProblem({ short: 'floti 3.0.0', line: 'floti 3.0.0' }, VERSION, target)).toMatch(/^floti version printed "floti 3.0.0"/)
  })
})

describe('S2: the release carries the five builds with their SHA-256s, or nothing', () => {
  it('writes the sums in sha256sum format, and reads them back', () => {
    const entries = [
      { name: 'floti-3.0.0-linux-x64', sha256: 'a'.repeat(64) },
      { name: 'floti-3.0.0-windows-x64.exe', sha256: 'b'.repeat(64) }
    ]
    const text = formatSums(entries)
    expect(text).toBe(`${'a'.repeat(64)}  floti-3.0.0-linux-x64\n${'b'.repeat(64)}  floti-3.0.0-windows-x64.exe\n`)
    expect(parseSums(text)).toEqual(entries)
    expect(parseSums(`${'c'.repeat(64)} *floti-3.0.0-macos-arm64\r\n`)).toEqual([{ name: 'floti-3.0.0-macos-arm64', sha256: 'c'.repeat(64) }])
    expect(() => parseSums('not a sum\n')).toThrow('"not a sum" is not a sha256sum line')
  })

  it('refuses a set of files missing a build, or holding one that is not a release file', () => {
    const builds = releaseFileNames(VERSION).filter((name) => name !== sumsFileName(VERSION))
    expect(releaseFilesProblem(builds, VERSION, { withSums: false })).toBeNull()
    expect(releaseFilesProblem([...builds, sumsFileName(VERSION)], VERSION, { withSums: true })).toBeNull()
    expect(releaseFilesProblem(builds, VERSION, { withSums: true })).toBe('missing floti-3.0.0-SHA256SUMS')
    expect(releaseFilesProblem(builds.slice(1), VERSION, { withSums: false })).toBe('missing floti-3.0.0-linux-arm64')
    expect(releaseFilesProblem([...builds, 'floti-2.9.0-linux-x64'], VERSION, { withSums: false })).toBe(
      'not a release file: floti-2.9.0-linux-x64'
    )
  })

  it('lists the SHA-256 of each of the five builds in a folder, and writes nothing for a folder missing one', async () => {
    const folder = await mkdtemp(join(inject(RUN_ROOT), 'floti release '))
    const contents = new Map(RELEASE_TARGETS.map((target, i) => [releaseFileName(VERSION, target), `build ${i}`]))
    const [first] = contents.keys()
    for (const [name, text] of contents) if (name !== first) writeFileSync(join(folder, name), text)

    expect(() => writeSums(folder, VERSION)).toThrow(`missing ${first}`)
    expect(existsSync(join(folder, sumsFileName(VERSION)))).toBe(false)

    writeFileSync(join(folder, first!), contents.get(first!)!)
    const file = writeSums(folder, VERSION)
    expect(file).toBe(join(folder, 'floti-3.0.0-SHA256SUMS'))
    const listed = parseSums(readFileSync(file, 'utf8'))
    expect(listed.map((entry) => entry.name)).toEqual([...contents.keys()].sort())
    for (const entry of listed) expect(entry.sha256).toBe(sha256Of(Buffer.from(contents.get(entry.name)!)))
  })
})

describe("the desktop takes its own floti from the release's files", () => {
  async function release() {
    const folder = await mkdtemp(join(inject(RUN_ROOT), 'floti prebuilt '))
    const prebuilt = join(folder, 'floti-3.0.0-linux-x64')
    const bytes = elf(0x3e, STATIC)
    writeFileSync(prebuilt, bytes)
    const sums = join(folder, 'floti-3.0.0-SHA256SUMS')
    writeFileSync(sums, formatSums([{ name: 'floti-3.0.0-linux-x64', sha256: sha256Of(bytes) }]))
    return { folder, prebuilt, sums, bytes }
  }
  const LINUX = { version: VERSION, platform: 'linux', arch: 'x64' }

  it('stages the build and its sums as floti and floti-SHA256SUMS', async () => {
    const { folder, prebuilt, sums, bytes } = await release()
    const stagedDir = join(folder, 'dist-host')
    const staged = stagePrebuilt({ prebuilt, sums, stagedDir, ...LINUX })
    expect(staged.binary).toBe(join(stagedDir, 'floti'))
    expect(staged.sums).toBe(join(stagedDir, STAGED_SUMS_NAME))
    expect(readFileSync(staged.binary)).toEqual(Buffer.from(bytes))
    expect(readFileSync(staged.sums!, 'utf8')).toBe(readFileSync(sums, 'utf8'))
    if (process.platform !== 'win32') expect(statSync(staged.binary).mode & 0o111).toBe(0o111)
  })

  it('removes sums an earlier run staged when it is given none', async () => {
    const { folder, prebuilt, sums } = await release()
    const stagedDir = join(folder, 'dist-host')
    stagePrebuilt({ prebuilt, sums, stagedDir, ...LINUX })
    expect(stagePrebuilt({ prebuilt, stagedDir, ...LINUX }).sums).toBeNull()
    expect(existsSync(join(stagedDir, STAGED_SUMS_NAME))).toBe(false)
  })

  it('refuses a build for another platform, one the sums do not describe, and a platform no release carries', async () => {
    const { folder, prebuilt, sums } = await release()
    const stagedDir = join(folder, 'dist-host')
    expect(() => stagePrebuilt({ prebuilt, sums, stagedDir, version: VERSION, platform: 'linux', arch: 'arm64' })).toThrow(
      'is not floti for linux-arm64: it is built for linux x64, not linux arm64'
    )
    writeFileSync(sums, formatSums([{ name: 'floti-3.0.0-linux-x64', sha256: '0'.repeat(64) }]))
    expect(() => stagePrebuilt({ prebuilt, sums, stagedDir, ...LINUX })).toThrow(`lists ${'0'.repeat(64)} for floti-3.0.0-linux-x64`)
    writeFileSync(sums, '')
    expect(() => stagePrebuilt({ prebuilt, sums, stagedDir, ...LINUX })).toThrow('does not list floti-3.0.0-linux-x64')
    expect(() => stagePrebuilt({ prebuilt, stagedDir, version: VERSION, platform: 'darwin', arch: 'x64' })).toThrow(
      'no release carries floti for darwin x64'
    )
    expect(existsSync(join(stagedDir, 'floti'))).toBe(false)
  })
})
