/**
 * How Helm says the local host could not be reached, wherever that is found
 * out: main's own link (`main/host/launcher.ts`) and a Helm page's own
 * connection (`renderer/src/app/host/link.ts`) end the same sentence the same
 * way, naming the setting that turns the host off.
 */

/** The setting, as its row in Settings names it. */
export const TURN_OFF = 'turn off “Run sessions in the local host” in Settings to use Helm’s own sessions.'

/** `sentence`, with its full stop dropped, followed by the way out. */
export function unreachable(sentence: string): string {
  return `${sentence.trim().replace(/\.$/, '')}; ${TURN_OFF}`
}
