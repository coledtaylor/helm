import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NormalizedExec } from '@coledtaylor/helm-plugin-sdk/manifest'

vi.mock('electron', async () => (await import('../../../test/electron')).electronFake())

const { programEnv, readExecRequest, resolveProgram, runProgram } = await import('./exec')
const { PluginCallError } = await import('./errors')

/**
 * `helm.exec`: a declared program run with the page's arguments as an array
 * and no shell - a batch file through cmd's quoting, a timeout ending the
 * whole tree, and an environment without the variables that are Helm's own.
 * Everything runs from a folder with spaces in its path.
 */

const node = process.execPath
let root: string
let dir: string

/** A script that says what it was given, as JSON. */
const ECHO = `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: { MINE: process.env.MINE ?? null, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null, CLAUDECODE: process.env.CLAUDECODE ?? null, NODE_OPTIONS: process.env.NODE_OPTIONS ?? null } }))`

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'helm plugin exec-'))
  dir = join(root, 'my plugin')
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'echo.mjs'), ECHO)
  writeFileSync(join(dir, 'fail.mjs'), `process.stderr.write('bad things'); process.stdout.write('some'); process.exit(3)`)
  // Starts a grandchild that would outlive a kill of its parent alone, says
  // its pid, and then waits forever.
  writeFileSync(
    join(dir, 'tree.mjs'),
    `import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
process.stdout.write(String(child.pid) + '\\n')
setInterval(() => {}, 1000)`
  )
  writeFileSync(join(dir, 'bin', 'echo args.cmd'), `@echo off\r\n"${node}" "${join(dir, 'echo.mjs')}" %*\r\n`)
  writeFileSync(join(root, 'outside.cmd'), '@echo off\r\n')
  mkdirSync(join(root, 'path bin'))
  writeFileSync(join(root, 'path bin', 'helmtool.cmd'), `@echo off\r\n"${node}" "${join(dir, 'echo.mjs')}" %*\r\n`)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const spec = (command: string, args: string[] = [], env: Record<string, string> = {}): NormalizedExec => ({ command, args, env })
const run = (exec: NormalizedExec, args: string[] = [], options: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {}) =>
  runProgram({
    dir,
    spec: exec,
    env: options.env ?? {},
    request: { args, stdin: null, timeoutMs: options.timeoutMs ?? 30_000 },
    signal: options.signal ?? new AbortController().signal
  })

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

describe('programEnv', () => {
  it("drops what is Helm's own and keeps the rest, the declared values on top", () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    vi.stubEnv('VITE_DEV_SERVER_URL', 'http://localhost:5173')
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli')
    vi.stubEnv('NODE_OPTIONS', '--inspect')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('HELM_TEST_KEPT', 'yes')
    const env = programEnv({ MINE: 'declared', HELM_TEST_KEPT: 'overridden' })
    for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'NODE_OPTIONS', 'NODE_ENV']) {
      expect(env[name]).toBeUndefined()
    }
    expect(env['MINE']).toBe('declared')
    expect(env['HELM_TEST_KEPT']).toBe('overridden')
    expect(env['PATH'] ?? env['Path']).toBeTruthy()
  })
})

describe('resolveProgram', () => {
  it('takes an absolute path as it is', () => {
    expect(resolveProgram(dir, node)).toEqual({ file: node, program: node, batch: false })
  })

  it('finds a path with a slash inside the plugin folder, and runs a batch file through cmd', () => {
    const resolved = resolveProgram(dir, 'bin/echo args.cmd')
    expect(resolved).toMatchObject({ program: join(dir, 'bin', 'echo args.cmd'), batch: true })
    expect(resolved?.file.toLowerCase()).toMatch(/cmd\.exe$/)
  })

  it('refuses a path that leaves the folder, and one that is not there', () => {
    expect(resolveProgram(dir, '../outside.cmd')).toBeNull()
    expect(resolveProgram(dir, 'bin/nothing.exe')).toBeNull()
    expect(resolveProgram(dir, join(root, 'nothing.exe'))).toBeNull()
  })

  it('looks a bare name up on PATH, with PATHEXT', () => {
    vi.stubEnv('PATH', [join(root, 'path bin'), process.env['PATH'] ?? ''].join(delimiter))
    const found = resolveProgram(dir, 'helmtool')
    // Spelled with PATHEXT's case; the file system does not care.
    expect(found?.program.toLowerCase()).toBe(join(root, 'path bin', 'helmtool.cmd').toLowerCase())
    expect(found?.batch).toBe(true)
    expect(resolveProgram(dir, 'helm-no-such-tool-anywhere')).toBeNull()
  })
})

describe('readExecRequest', () => {
  it('reads arguments, stdin and a timeout, capped', () => {
    expect(readExecRequest(['a'], { stdin: 'in', timeoutMs: 10_000_000 })).toEqual({ args: ['a'], stdin: 'in', timeoutMs: 600_000 })
    expect(readExecRequest(undefined, undefined)).toEqual({ args: [], stdin: null, timeoutMs: 60_000 })
  })

  it.each([
    [[1], undefined],
    [['nul\0'], undefined],
    ['a', undefined],
    [[], 'fast'],
    [[], { stdin: 1 }],
    [[], { timeoutMs: -1 }],
    [Array.from({ length: 257 }, () => 'x'), undefined]
  ])('refuses %j %j', (args, options) => {
    expect(() => readExecRequest(args, options)).toThrow(PluginCallError)
  })
})

describe('runProgram', () => {
  it('runs in the plugin folder with the declared arguments first and its environment, and says what it wrote', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    vi.stubEnv('CLAUDECODE', '1')
    const result = await run(spec(node, ['echo.mjs', 'first']), ['second', 'with space'], { env: { MINE: 'mine' } })
    expect(result).toMatchObject({ exitCode: 0, stderr: '', timedOut: false })
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['first', 'second', 'with space'],
      cwd: dir,
      env: { MINE: 'mine', ELECTRON_RUN_AS_NODE: null, CLAUDECODE: null, NODE_OPTIONS: null }
    })
  })

  it('answers a non-zero exit as an answer, not a failure', async () => {
    expect(await run(spec(node, ['fail.mjs']))).toEqual({ exitCode: 3, stdout: 'some', stderr: 'bad things', timedOut: false })
  })

  it('hands a batch file its arguments intact through cmd, from a path with spaces', async () => {
    const args = ['a b', 'x&y', '(paren)', 'pipe|less', 'plain', '']
    const result = await run(spec('bin/echo args.cmd'), args)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).args).toEqual(args)
  })

  it('drops a double quote, which cmd cannot carry, rather than letting it end the line', async () => {
    const result = await run(spec('bin/echo args.cmd'), ['say"hi" & echo injected'])
    expect(JSON.parse(result.stdout).args).toEqual(['sayhi & echo injected'])
  })

  it('stops the whole tree at its timeout and says it timed out', async () => {
    const pending = run(spec(node, ['tree.mjs']), [], { timeoutMs: 1500 })
    const result = await pending
    expect(result).toMatchObject({ exitCode: null, timedOut: true })
    const grandchild = Number(result.stdout.trim())
    expect(grandchild).toBeGreaterThan(0)
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 5000 })
  })

  it('ends the program when the page cancels', async () => {
    const controller = new AbortController()
    const pending = run(spec(node, ['tree.mjs']), [], { signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
  })

  it('starts nothing for a call cancelled before the program was reached', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(run(spec(node, ['tree.mjs']), [], { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted'
    })
  })

  it('says a program that is not there was not found', async () => {
    await expect(run(spec('helm-no-such-tool-anywhere'))).rejects.toMatchObject({ code: 'not-found' })
    await expect(run(spec('bin/missing.exe'))).rejects.toMatchObject({ code: 'not-found' })
  })
})
