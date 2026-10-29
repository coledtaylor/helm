import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { descendantsIn, POSIX_OWN_GROUP, treeKill } from './treekill'
import { PATIENCE } from '../../../../test/patience'

/**
 * Ending a process with everything it started, on the OS running the tests: a
 * program that starts a child, which starts a grandchild of its own.
 */

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'helm tree kill-'))
  // Says the pids of its child and grandchild, then waits forever.
  writeFileSync(
    join(root, 'leaf.mjs'),
    `process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000)`
  )
  writeFileSync(
    join(root, 'middle.mjs'),
    `import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
spawn(process.execPath, [fileURLToPath(new URL('./leaf.mjs', import.meta.url))],{ stdio: ['ignore', 'inherit', 'ignore'] })
process.stdout.write(String(process.pid) + '\\n')
setInterval(() => {}, 1000)`
  )
  writeFileSync(
    join(root, 'top.mjs'),
    `import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
spawn(process.execPath, [fileURLToPath(new URL('./middle.mjs', import.meta.url))],{ stdio: ['ignore', 'inherit', 'ignore'] })
setInterval(() => {}, 1000)`
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Starts the tree and waits for both descendants to say who they are. */
async function startTree(options: { detached: boolean }): Promise<{ top: ChildProcess; below: number[] }> {
  const top = spawn(process.execPath, [join(root, 'top.mjs')], { stdio: ['ignore', 'pipe', 'ignore'], ...options })
  const below: number[] = []
  await new Promise<void>((resolve, reject) => {
    let text = ''
    top.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      const pids = text.split('\n').filter((line) => /^\d+$/.test(line))
      if (pids.length >= 2) {
        below.push(...pids.map(Number))
        resolve()
      }
    })
    top.once('exit', () => reject(new Error('the tree exited before it started')))
  })
  return { top, below }
}

describe('descendantsIn', () => {
  it('walks a ps table from a root, nearest first, through a cycle and never into pid 1', () => {
    const table = ['  1     0', ' 10     1', ' 11    10', ' 12    11', ' 13    10', ' 20     1', ' 30    31', ' 31    30'].join('\n')
    expect(descendantsIn(table, 10)).toEqual([11, 13, 12])
    expect(descendantsIn(table, 30)).toEqual([31])
    expect(descendantsIn(table, 1)).toEqual([10, 20, 11, 13, 12])
  })
})

describe('treeKill', () => {
  for (const sync of [true, false]) {
    it(`ends a program and all of its children (${sync ? 'at quit' : 'while running'})`, async () => {
      const { top, below } = await startTree(POSIX_OWN_GROUP)
      const all = [top.pid ?? -1, ...below]
      expect(all.every(alive)).toBe(true)
      treeKill(top.pid ?? -1, sync)
      await vi.waitFor(() => expect(all.filter(alive)).toEqual([]), { timeout: PATIENCE })
    })
  }

  it('says when the kill has been carried out, once, before returning only at quit', async () => {
    for (const sync of [true, false]) {
      const { top, below } = await startTree(POSIX_OWN_GROUP)
      const all = [top.pid ?? -1, ...below]
      let calls = 0
      treeKill(top.pid ?? -1, sync, () => {
        calls += 1
      })
      expect(calls).toBe(sync ? 1 : 0)
      await vi.waitFor(() => expect(calls).toBe(1), { timeout: PATIENCE })
      await vi.waitFor(() => expect(all.filter(alive)).toEqual([]), { timeout: PATIENCE })
      expect(calls).toBe(1)
    }
  })

  it('says it is done at once for a pid that names no process', () => {
    for (const sync of [true, false]) {
      let calls = 0
      treeKill(0, sync, () => {
        calls += 1
      })
      expect(calls).toBe(1)
    }
  })

  it.runIf(process.platform !== 'win32')(
    'ends the children of a program that leads no process group of its own',
    async () => {
      const { top, below } = await startTree({ detached: false })
      const all = [top.pid ?? -1, ...below]
      treeKill(top.pid ?? -1, true)
      await vi.waitFor(() => expect(all.filter(alive)).toEqual([]), { timeout: PATIENCE })
    }
  )
})
