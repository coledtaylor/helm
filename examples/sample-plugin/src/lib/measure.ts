/**
 * Measurement hooks for the spike. Not part of a plugin's shape.
 *
 * `instance` is minted once per page load, so a page that was reloaded shows a
 * new one. `busy` blocks this page's main thread, which is how the spike tells
 * whether a plugin can stall Helm: if the frame shares Helm's renderer process,
 * Helm stops painting for as long as the plugin spins.
 */
export const instance = Math.random().toString(36).slice(2, 8)

/** Loads of this page since its storage was created - a reload counts. */
export const loads = countLoad()

function countLoad(): number {
  const key = `loads:${location.pathname}`
  try {
    const next = Number(localStorage.getItem(key) ?? '0') + 1
    localStorage.setItem(key, String(next))
    return next
  } catch {
    return 0
  }
}

export function busy(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // Spinning on purpose: this is the stall being measured.
  }
}

// The spike driver asks for a stall from Helm's side rather than clicking into
// the frame, so it can time Helm's own frames across it.
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  const data = event.data as { type?: unknown; ms?: unknown }
  if (data.type === 'spike:busy' && typeof data.ms === 'number') busy(Math.min(data.ms, 10_000))
})
