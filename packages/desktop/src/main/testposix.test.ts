import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  POSIX_TESTS,
  REPO_ROOT,
  WSL_SCRIPT,
  mirrorName,
  pinnedPnpm,
  posixTestPlan
} from '../../scripts/test-posix.mjs'

/**
 * `pnpm test:posix`: the processes-and-ports, overlay, process-tree and
 * data-directory tests, run under Linux in WSL from Windows and natively on
 * macOS and Linux.
 */

describe('the POSIX test command', () => {
  it('runs the processes-and-ports, overlay, process-tree and data-directory tests, each of which exists', () => {
    expect(POSIX_TESTS).toEqual(
      expect.arrayContaining([
        'packages/desktop/src/main/processes.test.ts',
        'packages/core/src/launch/overlay.test.ts',
        'packages/desktop/src/main/treekill.test.ts',
        'packages/desktop/src/main/datadirs.test.ts'
      ])
    )
    for (const file of POSIX_TESTS) expect(existsSync(join(REPO_ROOT, file)), file).toBe(true)
  })

  it('runs them under Linux in WSL on Windows, and natively on macOS and Linux', () => {
    expect(posixTestPlan('win32', [])).toEqual({ where: 'wsl', files: POSIX_TESTS })
    expect(posixTestPlan('darwin', [])).toEqual({ where: 'native', files: POSIX_TESTS })
    expect(posixTestPlan('linux', [])).toEqual({ where: 'native', files: POSIX_TESTS })
  })

  it('runs the files it is given instead, with Windows separators made POSIX', () => {
    expect(posixTestPlan('win32', ['packages\\core\\src\\launch\\overlay.test.ts'])).toEqual({
      where: 'wsl',
      files: ['packages/core/src/launch/overlay.test.ts']
    })
  })

  it('mirrors each checkout into a Linux-side folder of its own', () => {
    const one = mirrorName('C:\\work\\helm')
    expect(one).toMatch(/^helm-[0-9a-f]{8}$/)
    expect(mirrorName('C:\\Work\\Helm')).not.toBe(mirrorName('D:\\other\\helm'))
    expect(mirrorName('C:\\Users\\me\\my repos\\helm (2)')).toMatch(/^helm__2_-[0-9a-f]{8}$/)
  })

  it('installs in the mirror only when the lockfile changed, with the pinned pnpm and no Electron download', () => {
    expect(pinnedPnpm({ packageManager: 'pnpm@10.28.0' })).toBe('10.28.0')
    expect(() => pinnedPnpm({})).toThrow(/packageManager/)
    expect(WSL_SCRIPT).toContain('sha256sum pnpm-lock.yaml')
    expect(WSL_SCRIPT).toContain('.posix-lock-hash')
    expect(WSL_SCRIPT).toContain('ELECTRON_SKIP_BINARY_DOWNLOAD=1 run_pnpm install --frozen-lockfile')
    expect(WSL_SCRIPT).not.toContain('${')
  })
})
