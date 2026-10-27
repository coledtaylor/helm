// Types for after-pack.mjs, so electron-builder's afterPack hook can be tested from TypeScript.

/** The part of electron-builder's AfterPackContext the hook reads. */
export interface AfterPackContext {
  appOutDir: string
  electronPlatformName: string
  packager: { getResourcesDir(appOutDir: string): string }
}

export function packagedNodePty(context: AfterPackContext): string
export default function afterPack(context: AfterPackContext): void
