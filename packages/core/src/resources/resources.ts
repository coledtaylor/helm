import type { SessionPort, SessionProcess, SessionResources } from '../types'

/**
 * What a session is holding, derived from a snapshot of the machine.
 *
 * **Helm spawned the pty, so the tree under it is Helm's own process tree.**
 * That sentence is the entire argument for this file being in scope, and it is
 * worth stating here rather than only in a task description: nothing in Helm
 * may parse a session's output or infer anything from what a model said
 * (CLAUDE.md "Scope"), and none of this does. It asks the operating system for
 * the children of a process Helm started - a question any parent may ask about
 * its own children, and one Helm asks about nothing else.
 *
 * What it buys is the answer metadata cannot give. Knowing a session is running
 * in `repos/storefront` on `feat/cart` does not tell you it has a container up
 * and a dev server on 5173; the process tree does, and the ports are the more
 * useful half in practice, because two agents colliding on 5173 is more common
 * than two colliding on a container name. Docker specifically needs no
 * integration: `docker` is a child process with a command line, which is enough
 * to say "this session started a container" without Helm knowing anything about
 * Docker. Talking to a daemon would be a different feature.
 *
 * ## Why the machine is injected
 *
 * `packages/core` never imports Electron, and process enumeration is host
 * knowledge - so this file takes a snapshot rather than taking one. Same shape
 * `ShimWorld.probe` and `RegistryWorld.probe` have, for the same two reasons:
 * the platform call belongs to the host, and a test has to be able to arrange a
 * process tree, an unreadable command line and a failed socket query without
 * owning any of them.
 *
 * ## What a pass is honest about
 *
 * A pass is a **sample**, not a census. A session's tree contains whatever a
 * Bash call started and has not reaped; the long-lived children are the point
 * here and the short-lived ones are noise, but a pass that ran between two of
 * them saw neither. Nothing in this file implies otherwise, and `atMs` is
 * carried so a surface can say when it looked.
 *
 * Three failures are distinguished rather than merged, and the distinctions are
 * the reason the return shape is as nullable as it is:
 *
 *   - **The enumeration could not run at all** - `processes` and `ports` null.
 *   - **It ran and the session's own process was not in it** - `rootSeen`
 *     false, `processes` empty. A session that exited between the pass being
 *     scheduled and it running.
 *   - **It ran and the session has no children** - `rootSeen` true,
 *     `processes` holding one row, the root.
 *
 * "Could not look" and "nothing there" are different claims, and a surface that
 * merged them would tell somebody a session is holding nothing at exactly the
 * moment Helm had failed to ask.
 */

/**
 * One row of the host's process table.
 *
 * Deliberately four fields. Anything richer - memory, CPU, start time - is a
 * number that would have to be kept true, and none of it answers the question
 * this exists for.
 */
export interface ProcessRow {
  pid: number
  parentPid: number
  /** The image name, e.g. `node.exe`. */
  name: string
  /**
   * The full command line, or null where the host would not give it up.
   *
   * Null is the ordinary answer for a process the querying user may not open,
   * and **no elevation is ever assumed** to change that. Measured unelevated on
   * this machine: 159 of 277 processes returned null.
   */
  commandLine: string | null
}

/** One listening socket, and the pid holding it. */
export interface PortRow {
  pid: number
  port: number
  /** The local address it is bound to: `127.0.0.1`, `0.0.0.0`, `::1`, `::`. */
  address: string | null
}

/**
 * What the host managed to see in one pass.
 *
 * Each half is nullable on its own because each is a separate query that fails
 * separately: a machine can answer for processes and refuse for sockets, and a
 * tree with `ports: null` on every row is the honest rendering of that.
 */
export interface ProcessSnapshot {
  processes: readonly ProcessRow[] | null
  ports: readonly PortRow[] | null
  /** When the pass ran, epoch ms. */
  atMs: number
  /** How long the host's own query took, ms. For the budget, not for display. */
  durationMs: number
}

/** An empty snapshot: the answer for a host that could not be asked. */
export function noProcessSnapshot(atMs: number, durationMs = 0): ProcessSnapshot {
  return { processes: null, ports: null, atMs, durationMs }
}

/**
 * The pids in `root`'s tree, root first and then breadth-first.
 *
 * Two guards, and both are about a table that is not a tree. A process table is
 * a set of edges read at slightly different instants, so it can contain a cycle
 * - `System Idle Process` is its own parent at pid 0, and a pid reused between
 * two rows can produce one anywhere. `seen` bounds the walk whatever the edges
 * say. And a **pid of 0 is never followed**, because on Windows 0 is the parent
 * of anything whose real parent has exited, which would make the tree of a
 * reparented process the whole machine.
 */
function treeOf(root: number, byParent: ReadonlyMap<number, ProcessRow[]>): number[] {
  const order: number[] = [root]
  const seen = new Set<number>([root])
  for (let i = 0; i < order.length; i++) {
    const pid = order[i]
    if (pid === undefined || pid <= 0) continue
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      order.push(child.pid)
    }
  }
  return order
}

/**
 * The ports held by a set of pids, one row per pid and port.
 *
 * Deduplicated on `(pid, port)` rather than on the whole tuple, because a
 * server routinely binds one port once per address family and two rows reading
 * `5173` would look like two servers. The addresses are kept as a list instead,
 * sorted, so "loopback only" and "every interface" stay distinguishable - which
 * is the difference that decides whether somebody else on the network can reach
 * an agent's dev server.
 */
function portsOf(
  pids: ReadonlySet<number>,
  rows: readonly PortRow[],
  nameOf: (pid: number) => string
): SessionPort[] {
  const byKey = new Map<string, SessionPort>()
  for (const row of rows) {
    if (!pids.has(row.pid)) continue
    if (!Number.isFinite(row.port) || row.port <= 0) continue
    const key = `${String(row.pid)}:${String(row.port)}`
    let found = byKey.get(key)
    if (found === undefined) {
      found = { port: row.port, pid: row.pid, process: nameOf(row.pid), addresses: [] }
      byKey.set(key, found)
    }
    if (row.address !== null && row.address !== '' && !found.addresses.includes(row.address)) {
      found.addresses.push(row.address)
    }
  }
  const ports = [...byKey.values()]
  for (const port of ports) port.addresses.sort()
  return ports.sort((a, b) => a.port - b.port || a.pid - b.pid)
}

/**
 * What one session is holding, out of one snapshot of the machine.
 *
 * `rootPid` is the **pty's** pid rather than the one in the session's registry
 * record, and the difference is measured rather than theoretical: through a
 * `.cmd` shim the pty is `cmd.exe` and `claude.exe` registers under its own pid
 * beneath it. Rooting here covers both, and it is the pid Helm holds without
 * having to read anything.
 */
export function sessionResources(
  id: number,
  rootPid: number,
  snapshot: ProcessSnapshot
): SessionResources {
  if (snapshot.processes === null) {
    return {
      id,
      rootPid,
      processes: null,
      rootSeen: false,
      ports: null,
      opaque: 0,
      atMs: snapshot.atMs
    }
  }

  const byPid = new Map<number, ProcessRow>()
  const byParent = new Map<number, ProcessRow[]>()
  for (const row of snapshot.processes) {
    if (!Number.isFinite(row.pid) || row.pid <= 0) continue
    byPid.set(row.pid, row)
    const siblings = byParent.get(row.parentPid)
    if (siblings === undefined) byParent.set(row.parentPid, [row])
    else siblings.push(row)
  }

  const rootSeen = byPid.has(rootPid)
  const order = rootSeen ? treeOf(rootPid, byParent) : []
  const inTree = new Set(order)

  const ports =
    snapshot.ports === null
      ? null
      : portsOf(inTree, snapshot.ports, (pid) => byPid.get(pid)?.name ?? String(pid))

  // Ports per process, so the tree can carry them where they are held. Null all
  // the way down when the socket query itself failed - an empty list there
  // would be a claim that this process is listening on nothing.
  const held = new Map<number, number[]>()
  for (const port of ports ?? []) {
    const list = held.get(port.pid)
    if (list === undefined) held.set(port.pid, [port.port])
    else list.push(port.port)
  }

  const depth = new Map<number, number>([[rootPid, 0]])
  const processes: SessionProcess[] = []
  let opaque = 0
  for (const pid of order) {
    const row = byPid.get(pid)
    if (row === undefined) continue
    const own = depth.get(pid) ?? 0
    for (const child of byParent.get(pid) ?? []) {
      if (inTree.has(child.pid) && !depth.has(child.pid)) depth.set(child.pid, own + 1)
    }
    if (row.commandLine === null) opaque++
    processes.push({
      pid: row.pid,
      parentPid: row.parentPid,
      name: row.name,
      commandLine: row.commandLine,
      depth: own,
      ports: ports === null ? null : (held.get(pid) ?? []).slice().sort((a, b) => a - b)
    })
  }

  return { id, rootPid, processes, rootSeen, ports, opaque, atMs: snapshot.atMs }
}
