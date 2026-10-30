/**
 * The tables Helm's own tool families are listed from.
 *
 * Each family Helm serves itself (`helm-browser`, `helm-sessions`) is told to a
 * session from one JSON table in `crates/host/src/server/`, because the local
 * host serves the same family to the sessions it runs, and a session must be
 * told the same thing by either: the user's `mcp__helm-*` permission rules name
 * these tools. What each tool *does* stays here, by name, and is paired with
 * the table once.
 */

/** One tool as a session is told about it: everything but what it does. */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** A family's table: the server's name and route, its instructions, and its tools. */
export interface ToolTable {
  name: string
  path: string
  instructions: string
  tools: readonly ToolSpec[]
}

/**
 * Each tool in `specs` with what it does, in the table's order. Throws naming
 * every tool that is in the table with nothing to run it, or has a run and no
 * entry in the table: either would be a tool listed that cannot answer, or one
 * that answers and is never listed. `family` names the table in that sentence.
 */
export function pairTools<R>(
  family: string,
  specs: readonly ToolSpec[],
  runs: Readonly<Record<string, R>>
): Array<ToolSpec & { run: R }> {
  const listed = new Set(specs.map((spec) => spec.name))
  const unrun = specs.filter((spec) => !Object.hasOwn(runs, spec.name)).map((spec) => spec.name)
  const unlisted = Object.keys(runs).filter((name) => !listed.has(name))
  if (unrun.length > 0 || unlisted.length > 0) {
    throw new Error(
      [
        unrun.length > 0 ? `in the ${family} tool table with nothing to run them: ${unrun.join(', ')}` : '',
        unlisted.length > 0 ? `run but not in the ${family} tool table: ${unlisted.join(', ')}` : ''
      ]
        .filter((part) => part !== '')
        .join('; ')
    )
  }
  return specs.map((spec) => ({ ...spec, run: runs[spec.name] as R }))
}
