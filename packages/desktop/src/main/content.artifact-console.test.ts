import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { artifactConsoleEntries, attachArtifactConsole, clearArtifactConsole, type ArtifactConsoleEntry } from './content'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * What an HTML artifact logs, captured off the window's web contents: the
 * frame has an opaque origin, so the process hosting both is the only reader.
 */
describe('artifact console capture', () => {
  const window = { webContents: new EventEmitter() }
  const seen: ArtifactConsoleEntry[] = []
  attachArtifactConsole(window as unknown as BrowserWindow, (entry) => seen.push(entry))

  beforeEach(() => {
    clearArtifactConsole()
    seen.length = 0
  })

  it("keeps what an artifact frame logged, and nothing the app's own page logged", () => {
    window.webContents.emit('console-message', {
      level: 'error',
      message: 'chart failed',
      sourceId: 'helm-content://artifact/abc/report.html',
      lineNumber: 3
    })
    window.webContents.emit('console-message', {
      level: 'info',
      message: 'the app itself',
      sourceId: 'http://localhost:5173/src/main.tsx',
      lineNumber: 1
    })
    const expected = { level: 'error', message: 'chart failed', source: 'helm-content://artifact/abc/report.html', line: 3 }
    expect(seen).toEqual([expected])
    expect(artifactConsoleEntries()).toEqual([expected])
  })

  it('records an event in a shape it does not recognise rather than dropping it', () => {
    window.webContents.emit('console-message', { message: 'no source, no level' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.level).toBe('error')
    expect(seen[0]?.message).toContain('does not recognise')
  })
})
