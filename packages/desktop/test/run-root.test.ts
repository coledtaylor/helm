import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, inject, it, vi } from 'vitest'
import config from '../../../vitest.config'
import { PATIENCE } from '../../../test/patience'
import { holdRunRoot, RUN_ROOT, RUN_ROOT_PREFIX } from '../../../test/run-root'
import type { CrashReport } from './crash-run/crash.fixture'
import { electronFake } from './electron'
import { repoRoot } from './world'

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

describe("a vitest run's root", () => {
  it('is set up by every project', () => {
    const test = config.test ?? {}
    expect(test.globalSetup).toEqual(['test/run-root.ts'])
    const projects = (test.projects ?? []) as { extends?: unknown; test?: { name?: string; globalSetup?: unknown } }[]
    expect(projects.map((project) => project.test?.name)).toEqual(['core', 'ui', 'desktop', 'sdk', 'sdk-svelte'])
    for (const project of projects) {
      expect(project.extends, `${String(project.test?.name)} extends the root config`).toBe(true)
      expect(project.test?.globalSetup, `${String(project.test?.name)} keeps the root's setup`).toBeUndefined()
    }
  })

  it('is the temp folder of every test, and of every process a test starts', async () => {
    const root = inject(RUN_ROOT)
    expect(basename(root).startsWith(RUN_ROOT_PREFIX)).toBe(true)
    expect(statSync(root).isDirectory()).toBe(true)
    expect(tmpdir()).toBe(root)
    const child = spawn(process.execPath, ['-e', "process.stdout.write(require('node:os').tmpdir())"], {
      stdio: ['ignore', 'pipe', 'inherit']
    })
    let printed = ''
    child.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()))
    await once(child, 'exit')
    expect(printed).toBe(root)
  })

  it("holds the faked Electron app's folders", () => {
    const app = electronFake()['app'] as { getPath: (name: string) => string }
    const userData = app.getPath('userData')
    expect(dirname(dirname(userData))).toBe(inject(RUN_ROOT))
    expect(statSync(userData).isDirectory()).toBe(true)
  })

  it('is removed once its last hold is released, and the temp folder is put back', async () => {
    // In this worker no hold is taken yet, so this one makes a root of its
    // own, inside the run's.
    const outer = tmpdir()
    const first = await holdRunRoot()
    const second = await holdRunRoot()
    try {
      expect(second.root).toBe(first.root)
      expect(dirname(first.root)).toBe(outer)
      expect(tmpdir()).toBe(first.root)
      mkdtempSync(join(tmpdir(), 'a test folder '))

      await first.release()
      await first.release()
      expect(existsSync(first.root), 'a hold is still taken').toBe(true)
      expect(tmpdir()).toBe(first.root)
    } finally {
      await second.release()
    }
    expect(existsSync(first.root)).toBe(false)
    expect(tmpdir()).toBe(outer)
  })

  it('is removed with the world and the fake agent in it when a worker crashes', { timeout: PATIENCE * 3 }, async () => {
    const report = join(mkdtempSync(join(tmpdir(), 'crash report ')), 'report.json')
    const env: NodeJS.ProcessEnv = { ...process.env, HELM_CRASH_REPORT: report }
    // This worker's own variables would make the run below think it is one.
    for (const name of Object.keys(env)) if (name.startsWith('VITEST') || name === 'TEST') delete env[name]
    const run = spawn(
      process.execPath,
      [
        join(repoRoot(), 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--config',
        join(repoRoot(), 'packages', 'desktop', 'test', 'crash-run', 'vitest.config.ts')
      ],
      { cwd: repoRoot(), env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let output = ''
    run.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    run.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const [code] = (await once(run, 'exit')) as [number | null]

    expect(existsSync(report), `the crashed test reported what it made:\n${output}`).toBe(true)
    const crash = JSON.parse(readFileSync(report, 'utf8')) as CrashReport
    expect(code, `the run failed for its crashed worker:\n${output}`).not.toBe(0)
    expect(output).toMatch(/exited unexpectedly|Worker exited|crashed/i)
    // The world's root is a real path and the run's is not (macOS's /var).
    expect(basename(dirname(crash.world))).toBe(basename(crash.root))
    expect(existsSync(crash.world), `the world is gone:\n${output}`).toBe(false)
    expect(existsSync(crash.root), `the run's root is gone:\n${output}`).toBe(false)
    await vi.waitFor(() => expect(isRunning(crash.fake), 'the fake claude exited').toBe(false), { timeout: PATIENCE })
  })
})
