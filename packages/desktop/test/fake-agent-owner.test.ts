import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PATIENCE } from '../../../test/patience'
import { createWorld, disposeWorld, FAKE_AGENT_OWNER_FILE, repoRoot, type FakeClaudeLog, type World } from './world'

/**
 * A fake agent ends once the test process that owns it is gone, and only
 * then: its parent going changes nothing. The owner here is a process of the
 * test's own, ended by the test, standing in for a test process that crashed.
 */

const FAKE_CLAUDE = join(repoRoot(), 'test', 'fake-agents', 'claude-code.mjs')

let world: World
const started: ChildProcess[] = []
const strays: number[] = []

beforeEach(() => {
  world = createWorld()
})

afterEach(async () => {
  // A fake writes its run log as it exits, so the world goes only once every
  // process the test started has.
  const exits = started
    .filter((child) => child.exitCode === null && child.signalCode === null)
    .map((child) => once(child, 'exit'))
  for (const child of started) child.kill()
  for (const pid of strays) if (isRunning(pid)) process.kill(pid)
  await Promise.all(exits)
  await vi.waitFor(() => expect(strays.filter(isRunning)).toEqual([]), { timeout: PATIENCE })
  started.length = 0
  strays.length = 0
  disposeWorld(world)
})

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function startNode(args: string[], configDir = world.claudeDir): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: world.projects.alpha,
    env: { ...world.env, CLAUDE_CONFIG_DIR: configDir },
    stdio: 'pipe'
  })
  started.push(child)
  return child
}

/** A process that runs until it is ended, made the owner of every fake whose config folder is `configDir`. */
function startOwner(configDir: string): ChildProcess {
  const owner = startNode(['-e', 'setInterval(() => {}, 1 << 30)'])
  mkdirSync(configDir, { recursive: true })
  // Nearer the fake's config folder than the world's own file, so it is the one found.
  writeFileSync(join(configDir, FAKE_AGENT_OWNER_FILE), String(owner.pid))
  return owner
}

async function runLogOf(pid: number, configDir = world.claudeDir): Promise<FakeClaudeLog> {
  const file = join(configDir, 'fake-agent', `${String(pid)}.json`)
  await vi.waitFor(() => expect(existsSync(file), `the fake ${String(pid)} wrote its run log`).toBe(true), {
    timeout: PATIENCE
  })
  return JSON.parse(readFileSync(file, 'utf8')) as FakeClaudeLog
}

describe('a fake agent', () => {
  it('exits, with the child it started, once the test process that owns it is gone', async () => {
    const owner = startOwner(world.claudeDir)
    const fake = startNode([FAKE_CLAUDE])
    let output = ''
    fake.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    await runLogOf(fake.pid as number)

    fake.stdin?.write('/child\r')
    let child = 0
    await vi.waitFor(
      () => {
        const match = /child (\d+)/.exec(output)
        expect(match, 'the fake named the child it started').not.toBeNull()
        child = Number(match?.[1])
      },
      { timeout: PATIENCE }
    )
    expect(isRunning(child)).toBe(true)
    strays.push(child)

    // Its input is still open, so nothing but its owner going can end it.
    const exited = once(fake, 'exit')
    owner.kill()
    const [code] = await exited
    expect(code).toBe(0)
    expect((await runLogOf(fake.pid as number)).exitCode).toBe(0)
    await vi.waitFor(() => expect(isRunning(child), "the fake's child exited").toBe(false), { timeout: PATIENCE })
  })

  it('keeps running after its parent exits, for as long as its owner runs', async () => {
    // This one is owned by this test process, as createWorld made it. Its
    // parent starts it detached, so that it can outlive the parent on
    // Windows too, and exits. Its input is a holder's, which this test keeps
    // open: Node closes a child's input pipe when the child exits, so the
    // parent's own would end the fake's input with it.
    const parentScript = `const { spawn } = require('node:child_process')
      const fake = spawn(process.execPath, [${JSON.stringify(FAKE_CLAUDE)}], { stdio: ['inherit', 'ignore', 'ignore'], detached: true })
      process.stdout.write('fake ' + String(fake.pid) + '\\n', () => process.exit(0))`
    const holder = startNode([
      '-e',
      `const { spawn } = require('node:child_process')
       const parent = spawn(process.execPath, ['-e', ${JSON.stringify(parentScript)}], { stdio: ['inherit', 'pipe', 'ignore'] })
       parent.stdout.pipe(process.stdout, { end: false })
       parent.on('exit', (code) => process.stdout.write('parent ' + String(code) + '\\n'))
       setInterval(() => {}, 1 << 30)`
    ])
    let printed = ''
    holder.stdout?.on('data', (chunk: Buffer) => (printed += chunk.toString()))
    await vi.waitFor(() => expect(printed).toMatch(/parent 0\n/), { timeout: PATIENCE })
    const orphan = Number(/fake (\d+)/.exec(printed)?.[1])
    expect(orphan).toBeGreaterThan(0)
    strays.push(orphan)
    await runLogOf(orphan)

    // The barrier: a second fake, polling on the same interval, whose owner
    // is ended after the first fake's parent was. Once it has seen its owner
    // go, the first has had as long to react to its parent going.
    const otherConfig = join(world.root, 'other config')
    const owner = startOwner(otherConfig)
    const other = startNode([FAKE_CLAUDE], otherConfig)
    await runLogOf(other.pid as number, otherConfig)
    const exited = once(other, 'exit')
    owner.kill()
    await exited

    expect(isRunning(orphan), 'the fake whose owner still runs').toBe(true)
  })
})
