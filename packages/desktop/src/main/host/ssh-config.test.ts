import { mkdir, mkdtemp, readdir as listFolder, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, inject, it } from 'vitest'
import { RUN_ROOT } from '../../../../../test/run-root'
import { nodeSshConfigFiles, readSshConfigHosts, type SshConfigFiles } from './ssh-config'

/** The real files, with every file opened and every folder listed recorded. */
function recorded(): SshConfigFiles & { opened: string[]; listed: string[] } {
  const opened: string[] = []
  const listed: string[] = []
  return {
    opened,
    listed,
    readFile: (path) => {
      opened.push(path)
      return nodeSshConfigFiles.readFile(path)
    },
    readdir: (path) => {
      listed.push(path)
      return nodeSshConfigFiles.readdir(path)
    }
  }
}

/** A home folder of the test's own, with an `.ssh` folder holding `files`. */
async function home(files: Record<string, string>): Promise<{ home: string; ssh: string }> {
  const root = await mkdtemp(join(inject(RUN_ROOT), 'ssh config '))
  const ssh = join(root, '.ssh')
  await mkdir(ssh, { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(ssh, name, '..'), { recursive: true })
    await writeFile(join(ssh, name), text)
  }
  return { home: root, ssh }
}

/** Every file's size and time, to show nothing there was written. */
async function snapshot(folder: string): Promise<string[]> {
  const entries = await listFolder(folder, { recursive: true })
  return Promise.all(
    entries.sort().map(async (name) => {
      const info = await stat(join(folder, name))
      return `${name} ${String(info.size)} ${String(info.mtimeMs)}`
    })
  )
}

describe('the Host names in ~/.ssh/config, read from a fixture folder', () => {
  it('S3, S4: lists the config’s and its includes’ Host names, opening only those files and writing nothing', async () => {
    const { home: dir, ssh } = await home({
      config: 'Include config.d/*.conf\nHost build-box\n  HostName 10.0.0.2\nHost *\n  ServerAliveInterval 30\nInclude ~/.ssh/extra\n',
      'config.d/work.conf': 'Host studio-mac homelab\nHost build-box\n',
      'config.d/notes.txt': 'Host not-included\n',
      extra: 'Host lab\nInclude config\n',
      id_ed25519: 'PRIVATE KEY',
      known_hosts: 'build-box ssh-ed25519 AAAA'
    })
    const before = await snapshot(ssh)
    const files = recorded()
    expect(await readSshConfigHosts(ssh, dir, files)).toEqual({
      found: true,
      hosts: ['build-box', 'studio-mac', 'homelab', 'lab']
    })
    const slash = (path: string): string => path.replace(/\\/g, '/')
    expect(files.opened.map(slash).sort()).toEqual(
      [join(ssh, 'config'), join(ssh, 'config.d', 'work.conf'), join(ssh, 'extra')].map(slash).sort()
    )
    expect(files.listed.map(slash)).toEqual([slash(join(ssh, 'config.d'))])
    expect(await snapshot(ssh)).toEqual(before)
  })

  it('S4: with no config, says none was found and opens nothing else', async () => {
    const { home: dir, ssh } = await home({ id_ed25519: 'PRIVATE KEY' })
    const files = recorded()
    expect(await readSshConfigHosts(ssh, dir, files)).toEqual({ found: false, hosts: [] })
    expect(files.opened).toHaveLength(1)
  })

  it('S4: a config with only wildcard Hosts lists none', async () => {
    const { home: dir, ssh } = await home({ config: 'Host *\n  User me\nHost *.corp\n' })
    expect(await readSshConfigHosts(ssh, dir)).toEqual({ found: true, hosts: [] })
  })
})
