import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { inject } from 'vitest'
import type { TestProject } from 'vitest/node'
import { describe, expect, it } from 'vitest'
import { electronFake } from './electron'
import setup, { ELECTRON_FAKE_ROOT } from './electron-setup'

describe("the faked Electron app's folders", () => {
  it('are working folders in a temporary folder of this run', async () => {
    const root = inject(ELECTRON_FAKE_ROOT)
    expect(dirname(root)).toBe(tmpdir())
    expect(basename(root)).toMatch(/^helm-electron-fake-./)
    const app = electronFake()['app'] as { getPath: (name: string) => string }
    const userData = app.getPath('userData')
    expect(userData).toBe(join(root, 'userData'))
    expect((await stat(userData)).isDirectory()).toBe(true)
  })

  it("are removed when the run ends, leaving everything else in the temp folder, Node's compile cache included", async () => {
    const compileCache = join(tmpdir(), 'node-compile-cache')
    const compileCacheBefore = existsSync(compileCache)
    const other = await mkdtemp(join(tmpdir(), 'helm-electron-fake-'))
    try {
      let provided: string | undefined
      const project = {
        provide: (key: string, value: string) => {
          if (key === ELECTRON_FAKE_ROOT) provided = value
        }
      } as unknown as TestProject
      const teardown = await setup(project)
      expect(provided).toBeDefined()
      const root = provided as string
      expect(root).not.toBe(other)
      expect(existsSync(root)).toBe(true)
      await mkdtemp(join(root, 'an app folder '))

      await teardown()

      expect(existsSync(root)).toBe(false)
      expect(existsSync(other)).toBe(true)
      expect(existsSync(inject(ELECTRON_FAKE_ROOT))).toBe(true)
      expect(existsSync(compileCache)).toBe(compileCacheBefore)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})
