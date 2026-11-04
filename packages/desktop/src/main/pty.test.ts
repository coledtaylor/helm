import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activePty, ptyEnv, spawnPty } from './pty'
import { PATIENCE } from '../../../../test/patience'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ptyEnv', () => {
  it('tells a hosted program the terminal shows hyperlinks, whatever Helm inherited', () => {
    expect(ptyEnv().FORCE_HYPERLINK).toBe('1')

    // The pane opens them either way; a program told otherwise would only
    // print its links as plain text.
    vi.stubEnv('FORCE_HYPERLINK', '0')
    expect(ptyEnv().FORCE_HYPERLINK).toBe('1')
  })
})

/**
 * The one terminal the spike page modes (selftest, fidelity, claude-check)
 * drive. The program ends itself once it has echoed one line, so the test
 * never calls `killPty`: on Windows node-pty's own kill sweeps the console by
 * pid, which can reach the test worker. A failed run's pty closes with the
 * worker, which ends the program with it.
 */
describe('the spike page terminal', () => {
  it('S11: runs its single terminal, sends its output to the page and records both directions of the wire', async () => {
    const sent: string[] = []
    const win = {
      webContents: {
        send: (channel: string, chunk: string) => {
          if (channel === 'term:write') sent.push(chunk)
        }
      }
    } as unknown as BrowserWindow

    const handle = spawnPty(win, {
      file: process.execPath,
      args: [
        '-e',
        "process.stdout.write('up\\n'); process.stdin.once('data', (d) => { process.stdout.write('got:' + String(d).trim() + '\\n'); process.exit(0) })"
      ],
      cols: 80,
      rows: 24,
      cwd: process.cwd()
    })
    expect(activePty()).toBe(handle)

    await vi.waitFor(() => expect(handle.output()).toContain('up'), { timeout: PATIENCE })
    handle.pty.write('ping\r')

    await vi.waitFor(
      () => {
        expect(handle.output()).toContain('got:ping')
        expect(handle.exited()).toBe(0)
      },
      { timeout: PATIENCE }
    )
    expect(handle.input()).toBe('ping\r')
    expect(handle.chunks()).toEqual(['ping\r'])
    expect(sent.join('')).toBe(handle.output())
  })
})
