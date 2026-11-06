/**
 * `floti` in a version 2 background module, typed. Reference it once in the
 * background's own code, checked apart from the pages (a tsconfig of its
 * own, or a `/// <reference>` in a plain `.js` module):
 *
 *   /// <reference types="@coledtaylor/helm-plugin-sdk/background" />
 *
 * The module runs in the host's isolate, not in a window, so there is no
 * `window` here: `floti` is a global of the module's own, with the calls that
 * need a window typed as rejecting (`FlotiBackground`).
 */
import type { FlotiBackground } from './types.js'

declare global {
  /** What the host gives a version 2 background module. */
  const floti: FlotiBackground
}

export {}
