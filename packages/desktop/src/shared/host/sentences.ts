/**
 * How Helm says the local host could not be reached, wherever that is found
 * out: main's own link (`main/host/launcher.ts`) and a Helm page's own
 * connection (`renderer/src/app/host/link.ts`) end the sentence the same way,
 * at its cause.
 */

/** `sentence` as one sentence: trimmed, ending in a single full stop. */
export function unreachable(sentence: string): string {
  return `${sentence.trim().replace(/\.$/, '')}.`
}
