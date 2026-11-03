import { readdir, readFile } from 'node:fs/promises'
import {
  firstSeen,
  globSegmentMatcher,
  includePath,
  isGlobSegment,
  parseSshConfig,
  SSH_INCLUDE_DEPTH,
  type SshConfigHosts
} from '@helm/core/types'

/**
 * The Host names in the user's `~/.ssh/config`, for the add-a-host dialog.
 *
 * Opens `config` in the folder it is given and the files its Include lines
 * name (globs expanded by listing the folders they name), each once, and no
 * other file. Reads nothing in them but Host and Include lines
 * (`parseSshConfig`), and writes nothing anywhere. Keys, `known_hosts` and the
 * rest of `~/.ssh` are never opened.
 */

/** What the reader may do in the user's folders: read a file, or list a folder an Include glob names. */
export interface SshConfigFiles {
  /** The file's text, or null when it is not there or is not a file. */
  readFile(path: string): Promise<string | null>
  /** The names in a folder, or null when it is not there. */
  readdir(path: string): Promise<string[] | null>
}

/** The real files, read as the user can read them. */
export const nodeSshConfigFiles: SshConfigFiles = {
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  },
  readdir: async (path) => {
    try {
      return await readdir(path)
    } catch {
      return null
    }
  }
}

const slashed = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

/** The paths a written path names, its glob segments expanded in name order as glob(3) does. */
async function expand(path: string, files: SshConfigFiles): Promise<string[]> {
  const [first = '', ...rest] = path.split('/')
  let bases = [first]
  for (const segment of rest) {
    if (segment === '') continue
    if (!isGlobSegment(segment)) {
      bases = bases.map((base) => `${base}/${segment}`)
      continue
    }
    const matches = globSegmentMatcher(segment)
    const next: string[] = []
    for (const base of bases) {
      const names = (await files.readdir(base === '' ? '/' : base)) ?? []
      for (const name of [...names].sort()) if (matches(name)) next.push(`${base}/${name}`)
    }
    bases = next
  }
  return bases
}

/** The Host names of `<sshFolder>/config` and the files it includes, in the order first seen. */
export async function readSshConfigHosts(
  sshFolder: string,
  home: string,
  files: SshConfigFiles = nodeSshConfigFiles
): Promise<SshConfigHosts> {
  const folder = slashed(sshFolder)
  const config = `${folder}/config`
  const seen = new Set<string>()
  const hosts: string[] = []
  let found = false

  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > SSH_INCLUDE_DEPTH || seen.has(path)) return
    seen.add(path)
    const text = await files.readFile(path)
    if (text === null) return
    if (path === config) found = true
    const lines = parseSshConfig(text)
    hosts.push(...lines.hosts)
    for (const written of lines.includes) {
      for (const included of await expand(includePath(written, folder, slashed(home)), files)) {
        await visit(included, depth + 1)
      }
    }
  }

  await visit(config, 0)
  return { found, hosts: firstSeen(hosts) }
}
