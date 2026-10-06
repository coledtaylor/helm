// @ts-check
/**
 * `window.helm`, for the SDK's own helpers. Read when a helper is used rather
 * than when it is imported, so importing one outside Helm - in a test, or in
 * a build that renders on the server - does not throw.
 *
 * @returns {import('./types').HelmBridge}
 */
export function bridge() {
  const helm = /** @type {{ helm?: import('./types').HelmBridge }} */ (/** @type {unknown} */ (globalThis)).helm
  if (helm === undefined) throw new Error('window.helm is missing: this page is not being served by Helm')
  return helm
}
