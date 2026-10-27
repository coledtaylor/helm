// electron-builder's afterPack hook (electron-builder.yml). It runs once the app
// is laid out and before electron-builder signs it, so a file it changes is
// one the signature covers.
//
// For macOS it gives node-pty's spawn-helper under app.asar.unpacked its
// execute bit (see spawn-helper.mjs): electron-builder copies the file with
// the mode the package published, and without the bit the app can start no
// terminal. Every other platform it leaves alone.

import { join } from 'node:path'
import { makeSpawnHelpersExecutable, spawnHelpers } from './spawn-helper.mjs'

/** node-pty as the packaged app loads it: unpacked beside the asar, in the bundle's Resources. */
export function packagedNodePty(context) {
  return join(context.packager.getResourcesDir(context.appOutDir), 'app.asar.unpacked', 'node_modules', 'node-pty')
}

export default function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const nodePty = packagedNodePty(context)
  // No helper at all is a package that cannot start a terminal: fail the build
  // here, naming where it looked, rather than ship it.
  if (spawnHelpers(nodePty).length === 0) {
    throw new Error(`afterPack: no node-pty spawn-helper under ${join(nodePty, 'prebuilds')}, so the app could start no terminal`)
  }
  for (const helper of makeSpawnHelpersExecutable(nodePty)) console.log(`  afterPack: made ${helper} executable`)
}
