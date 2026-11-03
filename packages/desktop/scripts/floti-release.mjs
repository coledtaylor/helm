// The `floti` files a release carries, and the checks each one passes before it
// is carried: one per OS and CPU the host runs on (RELEASE_TARGETS), named
// `floti-<version>-<os>-<cpu>`, with one `floti-<version>-SHA256SUMS` in
// sha256sum's format beside them. The desktop's install offer finds a host's
// build by these names, and checks the file against these sums.
//
// .github/workflows/floti.yml builds each target on its own native runner and
// runs this file twice:
//
//   node floti-release.mjs check <file> <target>
//     reads the file's header (PE, Mach-O or ELF) and refuses one built for
//     another OS or CPU, or a Linux file that is not statically linked, then
//     runs it and refuses unless `--version` and `version` name this version,
//     this OS and this CPU.
//
//   node floti-release.mjs sums <folder> <version>
//     refuses a folder that does not hold exactly the five release files, and
//     writes their SHA-256 list beside them.
//
// scripts/stage-floti.mjs uses `stagePrebuilt` to put one of these files in
// the desktop's resources in place of a local build.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Each OS and CPU a release carries floti for, named as the version line
 * (`crates/host/src/version.rs`) and the release's file names say them, with
 * the Rust target it is built for and Node's names for the same platform.
 */
export const RELEASE_TARGETS = Object.freeze([
  { name: 'windows-x64', os: 'windows', cpu: 'x64', triple: 'x86_64-pc-windows-msvc', platform: 'win32', arch: 'x64' },
  { name: 'windows-arm64', os: 'windows', cpu: 'arm64', triple: 'aarch64-pc-windows-msvc', platform: 'win32', arch: 'arm64' },
  { name: 'macos-arm64', os: 'macos', cpu: 'arm64', triple: 'aarch64-apple-darwin', platform: 'darwin', arch: 'arm64' },
  { name: 'linux-x64', os: 'linux', cpu: 'x64', triple: 'x86_64-unknown-linux-gnu', platform: 'linux', arch: 'x64' },
  { name: 'linux-arm64', os: 'linux', cpu: 'arm64', triple: 'aarch64-unknown-linux-gnu', platform: 'linux', arch: 'arm64' }
])

const DESKTOP_DIR = resolve(import.meta.dirname, '..')

/** Floti's version: the desktop's, as `packages/desktop/package.json` names it. */
export function desktopVersion(file = join(DESKTOP_DIR, 'package.json')) {
  const version = JSON.parse(readFileSync(file, 'utf8')).version
  if (typeof version !== 'string' || version === '') throw new Error(`${file} names no version`)
  return version
}

/** The target named `name`, or an error naming the ones there are. */
export function targetNamed(name) {
  const target = RELEASE_TARGETS.find((each) => each.name === name)
  if (target === undefined) {
    throw new Error(`no release target is named ${name}; they are ${RELEASE_TARGETS.map((each) => each.name).join(', ')}`)
  }
  return target
}

/** The target a Node `process.platform` and `process.arch` run, or null when no release carries one. */
export function targetFor(platform, arch) {
  return RELEASE_TARGETS.find((each) => each.platform === platform && each.arch === arch) ?? null
}

/** `floti-<version>-<os>-<cpu>`, with `.exe` on Windows. */
export function releaseFileName(version, target) {
  return `floti-${version}-${target.name}${target.os === 'windows' ? '.exe' : ''}`
}

/** `floti-<version>-SHA256SUMS`. */
export function sumsFileName(version) {
  return `floti-${version}-SHA256SUMS`
}

/** Every file a release of `version` carries for floti, sorted: the five builds and their sums. */
export function releaseFileNames(version) {
  return [...RELEASE_TARGETS.map((target) => releaseFileName(version, target)), sumsFileName(version)].sort()
}

const PE_MACHINES = { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'x86', 0x01c4: 'arm' }
const MACHO_CPUS = { 0x0100000c: 'arm64', 0x01000007: 'x64' }
const ELF_MACHINES = { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'x86', 0x28: 'arm' }

const PT_DYNAMIC = 2
const PT_INTERP = 3
const DT_NULL = 0n
const DT_NEEDED = 1n

/**
 * What an executable's header says it was built for: `{ os, cpu }`, and for
 * an ELF file also `linkage`, `static` when it names no program interpreter
 * and needs no shared library, `dynamic` otherwise. A file none of the three
 * formats describes gives `{ os: null }`.
 *
 * @param {Uint8Array} bytes
 */
export function binaryFacts(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = (offset, size) => offset >= 0 && offset + size <= bytes.byteLength

  if (at(0, 0x40) && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const pe = view.getUint32(0x3c, true)
    if (at(pe, 6) && view.getUint32(pe, false) === 0x50450000) {
      const machine = view.getUint16(pe + 4, true)
      return { os: 'windows', cpu: PE_MACHINES[machine] ?? `machine 0x${machine.toString(16)}` }
    }
    return { os: null }
  }

  if (at(0, 8) && view.getUint32(0, true) === 0xfeedfacf) {
    const cpu = view.getUint32(4, true)
    return { os: 'macos', cpu: MACHO_CPUS[cpu] ?? `cputype 0x${cpu.toString(16)}` }
  }
  if (at(0, 4) && view.getUint32(0, false) === 0xcafebabe) return { os: 'macos', cpu: 'universal' }

  if (at(0, 64) && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    // 64-bit little-endian is every Linux target a release carries.
    if (bytes[4] !== 2 || bytes[5] !== 1) return { os: 'linux', cpu: 'not 64-bit little-endian' }
    const machine = view.getUint16(18, true)
    const cpu = ELF_MACHINES[machine] ?? `machine 0x${machine.toString(16)}`
    const phoff = Number(view.getBigUint64(32, true))
    const phentsize = view.getUint16(54, true)
    const phnum = view.getUint16(56, true)
    let interpreter = false
    let needed = false
    for (let i = 0; i < phnum; i++) {
      const header = phoff + i * phentsize
      if (!at(header, 56)) return { os: 'linux', cpu, linkage: 'unreadable' }
      const type = view.getUint32(header, true)
      if (type === PT_INTERP) interpreter = true
      if (type === PT_DYNAMIC) {
        const offset = Number(view.getBigUint64(header + 8, true))
        const size = Number(view.getBigUint64(header + 32, true))
        for (let entry = offset; entry + 16 <= offset + size && at(entry, 16); entry += 16) {
          const tag = view.getBigInt64(entry, true)
          if (tag === DT_NULL) break
          if (tag === DT_NEEDED) needed = true
        }
      }
    }
    return { os: 'linux', cpu, linkage: interpreter || needed ? 'dynamic' : 'static' }
  }

  return { os: null }
}

/**
 * Why an executable is not the release file for `target`, or null when its
 * header names the target's OS and CPU and, on Linux, says it is statically
 * linked.
 */
export function binaryProblem(bytes, target) {
  const facts = binaryFacts(bytes)
  if (facts.os === null) return 'it is not a Windows, macOS or Linux executable'
  if (facts.os !== target.os || facts.cpu !== target.cpu) {
    return `it is built for ${facts.os} ${facts.cpu}, not ${target.os} ${target.cpu}`
  }
  if (target.os === 'linux' && facts.linkage !== 'static') {
    return 'it is dynamically linked: it names a program interpreter or needs a shared library'
  }
  return null
}

/**
 * Why what `floti --version` and `floti version` printed is not this
 * version's build for `target`, or null when both name it.
 */
export function versionProblem({ short, line }, version, target) {
  const shortSaid = short.trim()
  if (shortSaid !== `floti ${version}`) return `floti --version printed "${shortSaid}", not "floti ${version}"`
  const lineSaid = line.trim()
  const words = lineSaid.split(' ')
  const expected = ['floti', version, 'protocol', words[3] ?? '', target.os, target.cpu]
  const fits = words.length === 6 && words[3] !== '' && words.every((word, i) => word === expected[i])
  if (!fits) return `floti version printed "${lineSaid}", not "floti ${version} protocol <version> ${target.os} ${target.cpu}"`
  return null
}

/** The SHA-256 of a file, as lower-case hex. */
export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** sha256sum's text format: one `<hex>  <name>` line per file, in the order given. */
export function formatSums(entries) {
  return entries.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join('')
}

/** The names and SHA-256s a sha256sum list holds, in its order. A line it cannot read is an error. */
export function parseSums(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.replace(/\r$/, ''))
      if (match === null) throw new Error(`"${line}" is not a sha256sum line`)
      return { sha256: match[1], name: match[2] }
    })
}

/**
 * Why a folder's file names are not a release's floti files, or null when
 * they are exactly the five builds of `version`, with or without their sums.
 */
export function releaseFilesProblem(names, version, { withSums }) {
  const expected = releaseFileNames(version).filter((name) => withSums || name !== sumsFileName(version))
  const have = new Set(names)
  const missing = expected.filter((name) => !have.has(name))
  const extra = [...have].filter((name) => !expected.includes(name)).sort()
  const problems = []
  if (missing.length > 0) problems.push(`missing ${missing.join(', ')}`)
  if (extra.length > 0) problems.push(`not a release file: ${extra.join(', ')}`)
  return problems.length > 0 ? problems.join('; ') : null
}

/**
 * Writes `floti-<version>-SHA256SUMS` into `folder`, which must hold exactly
 * the five builds of `version`, and returns its path.
 */
export function writeSums(folder, version) {
  const problem = releaseFilesProblem(readdirSync(folder), version, { withSums: false })
  if (problem !== null) throw new Error(`${folder} is not the five floti builds of ${version}: ${problem}`)
  const entries = RELEASE_TARGETS.map((target) => releaseFileName(version, target))
    .sort()
    .map((name) => ({ name, sha256: sha256Of(readFileSync(join(folder, name))) }))
  const file = join(folder, sumsFileName(version))
  writeFileSync(file, formatSums(entries))
  return file
}

/** The name a staged sums list is carried under in the desktop's resources. */
export const STAGED_SUMS_NAME = 'floti-SHA256SUMS'

/**
 * Puts the release's floti for this platform in `stagedDir` as `floti` or
 * `floti.exe`, in place of a local build, after checking that its header is
 * this platform's and that the sums list names it, under its release name,
 * with its SHA-256. With a sums list the list goes beside it as
 * `floti-SHA256SUMS`; without one, any list an earlier run staged is removed,
 * so a build never carries sums that do not describe its floti.
 */
export function stagePrebuilt({ prebuilt, sums, stagedDir, version, platform = process.platform, arch = process.arch }) {
  const target = targetFor(platform, arch)
  if (target === null) throw new Error(`no release carries floti for ${platform} ${arch}`)
  const bytes = readFileSync(prebuilt)
  const problem = binaryProblem(bytes, target)
  if (problem !== null) throw new Error(`${prebuilt} is not floti for ${target.name}: ${problem}`)

  const name = target.os === 'windows' ? 'floti.exe' : 'floti'
  mkdirSync(stagedDir, { recursive: true })
  const stagedSums = join(stagedDir, STAGED_SUMS_NAME)
  if (sums === undefined) {
    rmSync(stagedSums, { force: true })
  } else {
    const releaseName = releaseFileName(version, target)
    const listed = parseSums(readFileSync(sums, 'utf8')).find((entry) => entry.name === releaseName)
    if (listed === undefined) throw new Error(`${sums} does not list ${releaseName}`)
    const sha256 = sha256Of(bytes)
    if (listed.sha256 !== sha256) {
      throw new Error(`${prebuilt} has SHA-256 ${sha256}, but ${sums} lists ${listed.sha256} for ${releaseName}`)
    }
    copyFileSync(sums, stagedSums)
  }
  const binary = join(stagedDir, name)
  copyFileSync(prebuilt, binary)
  // A workflow artifact does not keep the execute bit.
  if (target.os !== 'windows') chmodSync(binary, 0o755)
  return { binary, sums: sums === undefined ? null : stagedSums, target }
}

function check(file, targetName) {
  const target = targetNamed(targetName)
  const version = desktopVersion()
  const header = binaryProblem(readFileSync(file), target)
  if (header !== null) throw new Error(`${file} is not floti for ${target.name}: ${header}`)
  const run = (args) => execFileSync(resolve(file), args, { encoding: 'utf8', windowsHide: true })
  const said = { short: run(['--version']), line: run(['version']) }
  const problem = versionProblem(said, version, target)
  if (problem !== null) throw new Error(`${file}: ${problem}`)
  console.log(`${basename(file)}: floti ${version} for ${target.os} ${target.cpu}${target.os === 'linux' ? ', statically linked' : ''}`)
  console.log(said.line.trim())
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2)
  try {
    if (command === 'check' && rest.length === 2) {
      check(rest[0], rest[1])
    } else if (command === 'sums' && rest.length === 2) {
      const file = writeSums(rest[0], rest[1])
      console.log(`Wrote ${file}:`)
      process.stdout.write(readFileSync(file, 'utf8'))
    } else {
      console.error('usage: node floti-release.mjs check <file> <target> | sums <folder> <version>')
      process.exit(2)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
