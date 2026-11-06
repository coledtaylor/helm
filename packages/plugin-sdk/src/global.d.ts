/**
 * The page bridges, typed. Reference it once in a plugin's pages:
 *
 *   /// <reference types="@coledtaylor/helm-plugin-sdk/global" />
 *
 * A page gets one of the two: `window.floti` at apiVersion 2, `window.helm`
 * at apiVersion 1. Use the one your manifest's version gives you. A version 2
 * background module references `@coledtaylor/helm-plugin-sdk/background`
 * instead, for the `floti` it runs with.
 */
import type { FlotiBridge, HelmBridge } from './types.js'

declare global {
  interface Window {
    /** The bridge in a version 2 page. */
    readonly floti: FlotiBridge
    /** The bridge in a version 1 page. */
    readonly helm: HelmBridge
  }
  /** The bridge in a version 2 page. */
  const floti: FlotiBridge
  /** The bridge in a version 1 page. */
  const helm: HelmBridge
}

export {}
