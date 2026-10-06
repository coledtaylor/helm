/**
 * `window.helm`, typed. Reference it once in a plugin:
 *
 *   /// <reference types="@coledtaylor/helm-plugin-sdk/global" />
 */
import type { HelmBridge } from './types'

declare global {
  interface Window {
    readonly helm: HelmBridge
  }
  const helm: HelmBridge
}

export {}
