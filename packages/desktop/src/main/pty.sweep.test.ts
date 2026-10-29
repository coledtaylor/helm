import type * as ChildProcess from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSession, killSession, spawnSession } from './pty'
import { PATIENCE } from '../../../../test/patience'

const require = createRequire(import.meta.url)
/** The module object node-pty calls `fork` on, so a spy here sees its calls. */
const childProcess = require('node:child_process') as typeof ChildProcess

/**
 * node-pty's own Windows kill forks `conpty_console_list_agent` to attach to the
 * shell's console by pid and kill every process listed there. A closed tab's
 * tree is already gone by then, so that pid names nobody, or a process that
 * took the number since, and its list can hold the process that hosts the
 * sessions. Under vitest that is the worker, which then exits unexpectedly.
 * The tree kill is what ends a session's processes, so the sweep is never run.
 */
describe.runIf(process.platform === 'win32')('closing a Windows session', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts no console sweep that could end a process outside the tree', async () => {
    const { WindowsTerminal } = require('node-pty/lib/windowsTerminal') as {
      WindowsTerminal: { prototype: { kill: (signal?: string) => void } }
    }
    const fork = vi.spyOn(childProcess, 'fork')
    const released = vi.spyOn(WindowsTerminal.prototype, 'kill')
    let output = ''
    let exited = false

    spawnSession({
      id: 'sweep',
      file: process.execPath,
      args: ['-e', "process.stdout.write('up\\n'); setInterval(() => undefined, 1000)"],
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      onData: (chunk) => {
        output += chunk
      },
      onExit: () => {
        exited = true
      }
    })
    await vi.waitFor(() => expect(output).toContain('up'), { timeout: PATIENCE })

    killSession('sweep')
    await vi.waitFor(
      () => {
        expect(exited).toBe(true)
        expect(released).toHaveBeenCalled()
      },
      { timeout: PATIENCE }
    )

    expect(getSession('sweep')).toBeUndefined()
    const sweeps = fork.mock.calls.filter(([modulePath]) => String(modulePath).includes('conpty_console_list_agent'))
    expect(sweeps).toEqual([])
  })
})
