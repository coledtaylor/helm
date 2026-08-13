// The `gh` the dev app is pointed at.
//
// `pnpm dev` runs against a copy of the real database, so its projects are the
// developer's own repositories - and the real `gh` would happily go and fetch
// their real pull requests. That is a network round trip per repository every
// five minutes for a window nobody is asking a question of, and it makes the
// pane's states hostage to whatever happens to be open on GitHub today: no way
// to look at a draft, a failing run or a patch over the cap without arranging
// one on a real repository.
//
// So dev gets `fake-gh.mjs` in its synthetic mode, which derives 0-3 stable
// pull requests from each slug. See the `synthesise` comment there.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const scriptsDir = resolve(import.meta.dirname)

/**
 * Writes dev's `gh` under `root` and returns the path to hand the app.
 *
 * A `.cmd` in front of the script, not the script itself: that is the shape a
 * real `gh` has on Windows when scoop or npm installed it, `CreateProcess`
 * cannot execute one, and `resolveGhCommand` has a branch that routes it
 * through `cmd.exe /c`. Pointing dev straight at an interpreter would leave the
 * branch that actually breaks unexercised in the app somebody is looking at.
 *
 * The script is **copied** beside the shim rather than run in place, so the one
 * absolute path baked into the batch file is inside the directory this function
 * owns and cannot move when the checkout does.
 */
export function writeDevGh(root, { states } = {}) {
  const dir = join(root, 'gh')
  mkdirSync(dir, { recursive: true })

  const source = join(scriptsDir, 'fake-gh.mjs')
  if (!existsSync(source)) throw new Error(`fake-gh.mjs is not at ${source}`)
  const script = join(dir, 'fake-gh.mjs')
  copyFileSync(source, script)

  const shim = join(dir, 'gh.cmd')
  writeFileSync(
    shim,
    [
      '@echo off',
      'setlocal',
      // Electron's own binary as the interpreter, under ELECTRON_RUN_AS_NODE:
      // the one node this workspace is certain exists.
      'set "ELECTRON_RUN_AS_NODE=1"',
      'set "HELM_FAKE_GH_SYNTHETIC=1"',
      ...(states ? [`set "HELM_FAKE_GH_STATES=${states}"`] : []),
      `"${electronBinary()}" "${script}" %*`,
      'exit /b %ERRORLEVEL%',
      ''
    ].join('\r\n')
  )
  return shim
}

function electronBinary() {
  // Resolved through the package rather than assumed, the way every driver in
  // this directory resolves it.
  return createRequire(import.meta.url)('electron')
}
