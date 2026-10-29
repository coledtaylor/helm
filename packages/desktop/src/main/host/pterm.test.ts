import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import { createHostPtermHost } from './pterm'
import { createTerminalStreams } from './streams'

function world() {
  const connection = new FakeConnection()
  let next = 1
  connection.answer('pterm:open', (request) => ({
    id: next++,
    shell: request.shell ?? '/bin/sh',
    requested: null,
    problem: null
  }))
  const link = fakeLink(connection)
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const streams = createTerminalStreams({
    connection: () => link.current(),
    deliver: (channel, id, data) => emitted.push({ channel, payload: { id, data } }),
    log: () => undefined
  })
  const pterm = createHostPtermHost({
    link,
    streams,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    log: () => undefined
  })
  return { connection, pterm, emitted, streams }
}

describe('plain terminals through the local host', () => {
  it('opens a project’s shell on the host, carries its terminal, and reopens it by folder', async () => {
    const w = world()
    const opened = await w.pterm.open({ path: '/work/app', cols: 100, rows: 30 })

    expect(w.connection.payloads('pterm:open')).toEqual([
      { path: '/work/app', cols: 100, rows: 30, shell: null, separate: false }
    ])
    expect(opened).toEqual({ id: 1, shell: '/bin/sh', requested: null, problem: null })
    w.connection.streamsFor('pterm:data', 1)[0]?.send('$ ')
    expect(w.emitted).toContainEqual({ channel: 'pterm:data', payload: { id: 1, data: '$ ' } })

    await expect(w.pterm.open({ path: '/WORK/app', cols: 100, rows: 30 })).resolves.toMatchObject({ id: 1 })
    expect(w.connection.payloads('pterm:open')).toHaveLength(1)

    // A terminal tab's shell is one of its own.
    await expect(w.pterm.open({ path: '/work/app', cols: 100, rows: 30, separate: true })).resolves.toMatchObject({
      id: 2
    })
  })

  it('types into the shell, resizes it and closes it on the host', async () => {
    const w = world()
    await w.pterm.open({ path: '/work/app', cols: 80, rows: 24 })
    w.pterm.input(1, 'echo hi\r')
    w.pterm.resize(1, 120, 40)
    w.pterm.close(1)

    expect(w.connection.streamsFor('pterm:data', 1)[0]?.text()).toBe('echo hi\r')
    expect(w.connection.payloads('pterm:resize')).toEqual([{ id: 1, cols: 120, rows: 40 }])
    expect(w.connection.payloads('pterm:close')).toEqual([{ id: 1 }])
    expect(w.pterm.list()).toEqual([])
  })

  it('tells the window when the host’s shell exits, and forgets it', async () => {
    const w = world()
    await w.pterm.open({ path: '/work/app', cols: 80, rows: 24 })
    w.connection.push('pterm:exit', { id: 1, exitCode: 0 })

    expect(w.emitted).toContainEqual({ channel: 'pterm:exit', payload: { id: 1, exitCode: 0 } })
    expect(w.pterm.list()).toEqual([])
    expect(w.connection.streamsFor('pterm:data', 1)[0]?.closed).toBe(true)
  })

  it('gives a page that has just loaded the terminal tabs’ shells it had, one each, then opens new ones', async () => {
    const w = world()
    await w.pterm.open({ path: '/work/app', cols: 80, rows: 24, separate: true })
    await w.pterm.open({ path: '/work/app', cols: 80, rows: 24, separate: true })
    w.pterm.windowLoading()

    await expect(w.pterm.open({ path: '/work/app', cols: 80, rows: 24, separate: true })).resolves.toMatchObject({
      id: 1
    })
    await expect(w.pterm.open({ path: '/work/app', cols: 80, rows: 24, separate: true })).resolves.toMatchObject({
      id: 2
    })
    await expect(w.pterm.open({ path: '/work/app', cols: 80, rows: 24, separate: true })).resolves.toMatchObject({
      id: 3
    })
    expect(w.connection.payloads('pterm:open')).toHaveLength(3)
  })

  it('lists the host’s shells for the pickers', async () => {
    const w = world()
    w.connection.answer('pterm:shells', () => [{ path: '/bin/bash', name: 'bash', label: 'Bash', args: [] }])

    await expect(w.pterm.detected()).resolves.toEqual([{ path: '/bin/bash', name: 'bash', label: 'Bash', args: [] }])
  })
})
