import type { RemoteHost } from '@helm/core/types'
import { flotiBinary, hostEnvironment, type HostPlaces, type LauncherDeps } from './launcher'

/**
 * What `floti doctor` checks besides this PC's host: the hosts on other
 * computers this device added. Helm tells floti at start and on every change
 * to them, by running `floti doctor --record` with them as JSON on standard
 * input, under the environment its own host runs with, so `floti doctor` run
 * in a terminal finds them in the same data folder. Each one carries its
 * name, how it is reached, the full path of floti there when one was given,
 * and the client folder Helm keeps for it, whose pinned host key the doctor
 * checks it by. Nothing in it is secret, and the host process never reads it.
 */

/** One host as `floti doctor --record` takes it. */
export interface DoctorHost {
  id: string
  name: string
  transport: RemoteHost['transport']
  floti?: string
  folder: string
}

/** The hosts as `floti doctor --record` takes them, each with the client folder kept for it. */
export function doctorHosts(hosts: readonly RemoteHost[], folderOf: (id: string) => string): DoctorHost[] {
  return hosts.map((host) => ({
    id: host.id,
    name: host.name,
    transport: host.transport,
    ...(host.floti !== undefined ? { floti: host.floti } : {}),
    folder: folderOf(host.id)
  }))
}

export type DoctorRecordDeps = Pick<LauncherDeps, 'platform' | 'env' | 'tmpdir' | 'exists' | 'spawn'>

/**
 * Runs `floti doctor --record` with `hosts`. Resolves once it has exited,
 * rejecting with what it wrote on standard error when it did not record them.
 */
export function recordDoctorHosts(
  places: HostPlaces,
  deps: DoctorRecordDeps,
  hosts: readonly DoctorHost[]
): Promise<void> {
  return new Promise((done, fail) => {
    const floti = flotiBinary(places, deps)
    if (!deps.exists(floti)) {
      fail(new Error(`floti is not at ${floti}.`))
      return
    }
    const child = deps.spawn(floti, ['doctor', '--record'], {
      env: hostEnvironment(places, deps),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let said = ''
    child.stderr?.on('data', (chunk: Buffer) => (said += chunk.toString()))
    child.stdout?.resume()
    child.once('error', fail)
    child.once('exit', (code) => {
      if (code === 0) done()
      else fail(new Error(said.trim() || `floti doctor --record exited with ${String(code)}.`))
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(JSON.stringify(hosts))
  })
}
