// @ts-check
/**
 * The page's bridge, for the SDK's own helpers: `window.floti` in a version 2
 * page, `window.helm` in a version 1 page. A page has one of the two, and
 * both have the same calls. Read when a helper is used rather than when it is
 * imported, so importing one outside Helm - in a test, or in a build that
 * renders on the server - does not throw.
 *
 * @returns {import('./types').PluginBridge}
 */
export function bridge() {
  const page = /** @type {{ floti?: import('./types').FlotiBridge, helm?: import('./types').HelmBridge }} */ (
    /** @type {unknown} */ (globalThis)
  )
  const found = page.floti ?? page.helm
  if (found === undefined) {
    throw new Error('window.floti and window.helm are both missing: this page is not being served by Helm')
  }
  return found
}
