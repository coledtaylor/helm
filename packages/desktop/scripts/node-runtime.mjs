// The Node runtime the local host runs plugin services on, fetched at build
// time and staged beside `floti` by stage-floti.mjs. The app never fetches it:
// Helm contacts nothing on its own except the update check.
//
// node-runtime.json pins the version and, for each platform a release is built
// on, the archive and its SHA-256 from that release's SHASUMS256.txt. A
// downloaded archive is untrusted until its hash matches the pin, so nothing is
// extracted before that, and a mismatch fails the build.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const PIN_FILE_NAME = 'node-runtime.json'
export const PIN_FILE = resolve(import.meta.dirname, PIN_FILE_NAME)

const ARCHIVE_SUFFIXES = ['.zip', '.tar.gz']

/** The pin file, read as it is. */
export function readPins(file = PIN_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * The pinned archive for `platform`-`arch`, with where Node's binary and
 * LICENSE sit inside it. Throws naming the platform when the pin file has
 * none for it.
 */
export function pinFor(pins, platform, arch) {
  const key = `${platform}-${arch}`
  const entry = pins.platforms?.[key]
  if (entry === undefined) {
    const known = Object.keys(pins.platforms ?? {}).join(', ')
    throw new Error(`${PIN_FILE_NAME} pins no Node runtime for ${key} (it pins ${known || 'none'})`)
  }
  const suffix = ARCHIVE_SUFFIXES.find((ending) => entry.archive.endsWith(ending))
  if (suffix === undefined) throw new Error(`${PIN_FILE_NAME}: ${entry.archive} is neither a .zip nor a .tar.gz`)
  const top = entry.archive.slice(0, -suffix.length)
  return {
    platform: key,
    version: pins.version,
    archive: entry.archive,
    sha256: entry.sha256.toLowerCase(),
    url: `https://nodejs.org/dist/v${pins.version}/${entry.archive}`,
    binary: entry.binary,
    members: { binary: `${top}/${entry.binary}`, license: `${top}/LICENSE` }
  }
}

/** The SHA-256 of `file`, in lowercase hex. */
export async function sha256Of(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/**
 * Throws, naming the expected and actual checksum, unless `file` hashes to
 * the pin's SHA-256.
 */
export async function verifyArchive(file, pin) {
  const actual = await sha256Of(file)
  if (actual !== pin.sha256) {
    throw new Error(`${pin.archive} does not match its pin: expected SHA-256 ${pin.sha256}, got ${actual}`)
  }
}

/** Downloads `url` to `dest`, through a partial file so an interrupted download never looks finished. */
export async function download(url, dest) {
  const response = await fetch(url)
  if (!response.ok || response.body === null) {
    throw new Error(`Could not download ${url}: ${String(response.status)} ${response.statusText}`)
  }
  const partial = `${dest}.partial`
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
    renameSync(partial, dest)
  } finally {
    rmSync(partial, { force: true })
  }
}

/**
 * A verified copy of the pinned archive in `cacheDir`: the one already there
 * when it still matches, else a fresh download. A download that does not match
 * is deleted and the call throws.
 */
export async function obtainArchive(pin, cacheDir, fetchArchive = download) {
  mkdirSync(cacheDir, { recursive: true })
  const file = join(cacheDir, pin.archive)
  if (existsSync(file)) {
    try {
      await verifyArchive(file, pin)
      return { file, reused: true }
    } catch {
      rmSync(file, { force: true })
    }
  }
  await fetchArchive(pin.url, file)
  try {
    await verifyArchive(file, pin)
  } catch (error) {
    rmSync(file, { force: true })
    throw error
  }
  return { file, reused: false }
}

/**
 * The system tar, which reads both archive kinds. On Windows that is the one
 * Windows ships, which reads zip; Git Bash's GNU tar, earlier on PATH there,
 * does not.
 */
export function tarProgram(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return 'tar'
  return join(env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows', 'System32', 'tar.exe')
}

/**
 * Extracts only Node's binary and LICENSE from a verified archive into a
 * fresh, empty folder under `cacheDir`, and stages them in `stagedDir`
 * (`node.exe` or `bin/node`, executable, and `LICENSE`), replacing what was
 * there. The extraction folder is removed once staged.
 */
export function extractAndStage(pin, archive, cacheDir, stagedDir, tar = tarProgram()) {
  const work = mkdtempSync(join(cacheDir, 'extract-'))
  try {
    const members = [pin.members.binary, pin.members.license]
    const run = spawnSync(tar, ['-xf', archive, '-C', work, ...members], { stdio: ['ignore', 'inherit', 'inherit'] })
    if (run.error !== undefined) throw new Error(`Could not run ${tar} to extract ${pin.archive}: ${run.error.message}`)
    if (run.status !== 0) throw new Error(`${tar} could not extract Node from ${pin.archive} (exit ${String(run.status)})`)
    for (const member of members) {
      if (!existsSync(join(work, member))) throw new Error(`${pin.archive} has no ${member}`)
    }

    rmSync(stagedDir, { recursive: true, force: true })
    const binary = join(stagedDir, pin.binary)
    mkdirSync(dirname(binary), { recursive: true })
    copyFileSync(join(work, pin.members.binary), binary)
    chmodSync(binary, 0o755)
    copyFileSync(join(work, pin.members.license), join(stagedDir, 'LICENSE'))
    return { binary, license: join(stagedDir, 'LICENSE') }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Stages the pinned Node for `platform`-`arch` in `stagedDir`, downloading
 * its archive into `cacheDir` unless a verified one is already there.
 */
export async function stageNode({
  cacheDir,
  stagedDir,
  platform = process.platform,
  arch = process.arch,
  pins = readPins(),
  fetchArchive = download,
  tar = tarProgram()
}) {
  const pin = pinFor(pins, platform, arch)
  const { file, reused } = await obtainArchive(pin, cacheDir, fetchArchive)
  const staged = extractAndStage(pin, file, cacheDir, stagedDir, tar)
  return { pin, archive: file, reused, ...staged }
}
