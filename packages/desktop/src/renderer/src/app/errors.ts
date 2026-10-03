/**
 * The sentence main threw, as the window should show it.
 *
 * Electron rejects a renderer's `invoke` with the main process's error wrapped
 * twice - `Error invoking remote method '<channel>': Error: <message>` - and
 * both wrappers are about the transport, not about what went wrong.
 */
export function readable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')
}
