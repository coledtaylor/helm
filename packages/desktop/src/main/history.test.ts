import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  archiveStateOf,
  openStore,
  readArchivedConversation,
  readHistorySessions,
  type ArchiveStats,
  type HistorySummary,
  type Store
} from '@helm/core'
import {
  appendPrompts,
  appendTranscript,
  claudeTree,
  sessionUuid,
  type ClaudeTree,
  type IpcHandler
} from '../../test/history-fixture'
import type { HistoryIndex, HistoryIndexDeps } from './history'
import type { IpcContext } from './ipc'
import type { Services } from './services'

const handlers = vi.hoisted(() => new Map<string, IpcHandler>())
vi.mock('electron', async () => (await import('../../test/history-fixture')).electronRecordingIpc(handlers))

/**
 * Flipped by a test that needs a machine where `fs.watch` is not available;
 * `live` holds every watcher opened and not yet closed.
 */
const fsWatch = vi.hoisted(() => ({ unavailable: false, live: new Set<object>() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const watch = (...args: Parameters<typeof actual.watch>): ReturnType<typeof actual.watch> => {
    if (fsWatch.unavailable) throw new Error('fs.watch is not available on this platform')
    const watcher = actual.watch(...args)
    fsWatch.live.add(watcher)
    const close = watcher.close.bind(watcher)
    watcher.close = () => {
      fsWatch.live.delete(watcher)
      close()
    }
    return watcher
  }
  return { ...actual, default: { ...actual, watch }, watch }
})

/**
 * The session index and the transcript archive in the main process
 * (`main/history.ts`, `main/archive.ts`), over `.claude` trees on disk: what
 * they read, when they notice a change nobody told them about, and that they
 * never write a byte of Claude's.
 */

const T0 = Date.UTC(2026, 8, 1, 9, 0, 0)
const HOUR = 3_600_000
const GB = 1024 ** 3

let root: string
let createHistoryIndex: (deps: HistoryIndexDeps) => HistoryIndex
const cleanups: Array<() => void> = []

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'helm history-'))
  // Read when the modules load, so in place before they are imported.
  Object.assign(process.env, {
    PORTABLE_EXECUTABLE_DIR: join(root, 'app'),
    USERPROFILE: join(root, 'home'),
    HOME: join(root, 'home')
  })
  delete process.env['CLAUDE_CONFIG_DIR']
  ;({ createHistoryIndex } = await import('./history'))
})

afterEach(() => {
  fsWatch.unavailable = false
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

interface Case {
  dir: string
  tree: ClaudeTree
  db: string
  store: Store
  alpha: string
  beta: string
}

/** A `.claude` tree, two project folders and a database of its own. */
function newCase(): Case {
  const dir = mkdtempSync(join(root, 'case-'))
  const alpha = join(dir, 'alpha')
  const beta = join(dir, 'beta')
  mkdirSync(alpha)
  mkdirSync(beta)
  const db = join(dir, 'helm.db')
  const c = { dir, tree: claudeTree(join(dir, '.claude')), db, store: openStore({ file: db }), alpha, beta }
  cleanups.push(() => c.store.close())
  return c
}

interface Watched {
  index: HistoryIndex
  summaries: HistorySummary[]
  archives: ArchiveStats[]
}

function indexOf(c: Case, deps: Partial<HistoryIndexDeps> = {}): Watched {
  const summaries: HistorySummary[] = []
  const archives: ArchiveStats[] = []
  const index = createHistoryIndex({
    store: c.store,
    home: c.tree.dir,
    maxBytes: () => GB,
    onHistoryChange: (summary) => summaries.push(summary),
    onArchiveChange: (stats) => archives.push(stats),
    ...deps
  })
  cleanups.push(() => index.stop())
  return { index, summaries, archives }
}

/** Text that does not compress to nothing, so a ceiling has something to bite on. */
const bulk = (words: number): string => Array.from({ length: words }, () => randomUUID()).join(' ')

describe('the session index', () => {
  it('counts what a plain read of history.jsonl and projects/ finds', () => {
    const c = newCase()
    const ids = [1, 2, 3, 4].map(sessionUuid)
    const gone = join(c.dir, 'deleted-project')
    appendPrompts(c.tree, [
      { sessionId: ids[0] as string, project: c.alpha, display: 'one', at: T0 },
      { sessionId: ids[0] as string, project: c.alpha, display: 'two', at: T0 + 1 },
      { sessionId: ids[1] as string, project: c.alpha.toUpperCase(), display: 'three', at: T0 + 2 },
      { sessionId: ids[2] as string, project: c.beta, display: 'four', at: T0 + 3 },
      { sessionId: ids[3] as string, project: gone, display: 'five', at: T0 + 4 }
    ])
    appendTranscript(c.tree, { sessionId: ids[0] as string, cwd: c.alpha }, [{ role: 'user', text: 'one', at: T0 }])
    appendTranscript(c.tree, { sessionId: ids[3] as string, cwd: gone }, [{ role: 'user', text: 'five', at: T0 }])

    const summary = indexOf(c).index.history.refresh()

    // A plain read of the same two places, sharing nothing with the index.
    const lines = readFileSync(c.tree.historyFile, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { sessionId: string; project: string })
    const sessions = new Map(lines.map((line) => [line.sessionId, line.project]))
    const transcripts = new Set(
      readdirSync(c.tree.projectsDir).flatMap((dir) =>
        readdirSync(join(c.tree.projectsDir, dir)).map((name) => name.replace(/\.jsonl$/, ''))
      )
    )
    const resumable = [...sessions].filter(([id, project]) => transcripts.has(id) && existsSync(project))
    expect([sessions.size, lines.length, resumable.length]).toEqual([4, 5, 1])

    expect(summary).toMatchObject({
      sessions: sessions.size,
      prompts: lines.length,
      projects: new Set(lines.map((line) => line.project.toLowerCase())).size,
      resumable: resumable.length,
      historyFile: c.tree.historyFile
    })
  })

  it('indexes a prompt another claude appends within seconds, with no refresh asked for', async () => {
    const c = newCase()
    appendPrompts(c.tree, [{ sessionId: sessionUuid(1), project: c.alpha, display: 'already here', at: T0 }])
    const { index, summaries } = indexOf(c)
    expect(index.start().sessions).toBe(1)

    appendPrompts(c.tree, [{ sessionId: sessionUuid(2), project: c.beta, display: 'from a terminal', at: T0 + HOUR }])

    await vi.waitFor(() => expect(summaries.at(-1)?.sessions).toBe(2), { timeout: 10_000 })
    expect(readHistorySessions(c.store).sessions.map((s) => s.title)).toEqual(['from a terminal', 'already here'])
  })

  it('falls back to a stat poll every four seconds where fs.watch is not available', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    fsWatch.unavailable = true
    const c = newCase()
    appendPrompts(c.tree, [{ sessionId: sessionUuid(1), project: c.alpha, display: 'already here', at: T0 }])
    const { index, summaries } = indexOf(c)
    index.start()
    // The first tick has nothing to compare the file's size with yet.
    vi.advanceTimersByTime(4000 + 150)
    const before = summaries.length

    appendPrompts(c.tree, [{ sessionId: sessionUuid(2), project: c.beta, display: 'from a terminal', at: T0 + HOUR }])
    vi.advanceTimersByTime(3900)
    expect(summaries.length).toBe(before)
    vi.advanceTimersByTime(100 + 150)
    expect(summaries.at(-1)?.sessions).toBe(2)
  })

  it('reads the tree CLAUDE_CONFIG_DIR names, and not the one in the home directory', () => {
    const c = newCase()
    const home = join(c.dir, 'home')
    const atHome = claudeTree(join(home, '.claude'))
    const configured = claudeTree(join(c.dir, 'configured'))
    const [homeId, configuredId] = [sessionUuid(1), sessionUuid(2)] as [string, string]
    appendPrompts(atHome, [{ sessionId: homeId, project: c.alpha, display: 'in ~/.claude', at: T0 }])
    appendTranscript(atHome, { sessionId: homeId, cwd: c.alpha }, [{ role: 'user', text: 'in ~/.claude', at: T0 }])
    appendPrompts(configured, [{ sessionId: configuredId, project: c.alpha, display: 'in the configured tree', at: T0 }])
    appendTranscript(configured, { sessionId: configuredId, cwd: c.alpha }, [
      { role: 'user', text: 'in the configured tree', at: T0 }
    ])

    const saved = { USERPROFILE: process.env['USERPROFILE'], HOME: process.env['HOME'] }
    Object.assign(process.env, { USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: configured.dir })
    cleanups.push(() => {
      Object.assign(process.env, saved)
      delete process.env['CLAUDE_CONFIG_DIR']
    })

    // No `home`: the app passes none unless a driver points it somewhere.
    const { index } = indexOf(c, { home: undefined })
    index.history.refresh()

    expect(index.history.file).toBe(configured.historyFile)
    expect(readHistorySessions(c.store).sessions.map((s) => s.sessionId)).toEqual([configuredId])
    expect(archiveStateOf(c.store, configuredId)).toBe('archived')
    expect(archiveStateOf(c.store, homeId)).toBeNull()
  })
})

describe('stopping', () => {
  it('lets go of every watch and timer, the archive watch included, so nothing writes once the store is closed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const c = newCase()
    const watching = fsWatch.live.size
    const { index } = indexOf(c)
    index.start()
    // The session index watches history.jsonl and the archive watches
    // projects/, and a timer is already waiting on a pass.
    expect(fsWatch.live.size - watching).toBe(2)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    index.stop()
    expect(fsWatch.live.size).toBe(watching)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the transcript archive', () => {
  it('archives, on the start-up pass, a conversation that ended while Helm was closed', () => {
    const c = newCase()
    const id = sessionUuid(1)
    appendPrompts(c.tree, [{ sessionId: id, project: c.alpha, display: 'what is in the lockfile', at: T0 }])
    appendTranscript(c.tree, { sessionId: id, cwd: c.alpha }, [
      { role: 'user', text: 'what is in the lockfile', at: T0 },
      { role: 'assistant', text: 'Two pinned versions.', at: T0 + 1000 }
    ])

    indexOf(c).index.start()

    const kept = readArchivedConversation(c.store, id)
    expect(kept?.state).toBe('archived')
    expect(kept?.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'what is in the lockfile'],
      ['assistant', 'Two pinned versions.']
    ])
  })

  it('archives a transcript written while it runs from the watch over projects/, with no refresh asked for', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const c = newCase()
    const { index } = indexOf(c)
    index.start()
    const armed = vi.getTimerCount()

    // A session talking without submitting a prompt: its transcript grows and
    // `history.jsonl` does not, so only the watch over `projects/` can see it.
    const id = sessionUuid(1)
    appendTranscript(c.tree, { sessionId: id, cwd: c.alpha }, [
      { role: 'user', text: 'keep going', at: T0 },
      { role: 'assistant', text: 'Still working on it.', at: T0 + 1000 }
    ])
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(armed + 1), { interval: 10 })
    expect(archiveStateOf(c.store, id)).toBeNull()

    // At most one pass per fifteen seconds, deferred rather than dropped.
    vi.advanceTimersByTime(15_000)
    expect(readArchivedConversation(c.store, id)?.messages.map((m) => m.text)).toEqual([
      'keep going',
      'Still working on it.'
    ])
  })

  it('honours a ceiling written through settings:write on the next pass', async () => {
    const c = newCase()
    const { createServices } = await import('./services')
    const { registerIpc } = await import('./ipc')
    const services: Services = createServices()
    cleanups.push(() => services.store.close())

    const ids = [1, 2, 3].map(sessionUuid) as [string, string, string]
    ids.forEach((id, i) => {
      appendPrompts(c.tree, [{ sessionId: id, project: c.alpha, display: `conversation ${String(i)}`, at: T0 + i * HOUR }])
      appendTranscript(c.tree, { sessionId: id, cwd: c.alpha }, [
        { role: 'user', text: bulk(60), at: T0 + i * HOUR },
        { role: 'assistant', text: bulk(60), at: T0 + i * HOUR + 1000 }
      ])
    })
    const { index } = indexOf(c, {
      store: services.store,
      maxBytes: () => services.settings.transcriptArchiveMaxBytes
    })
    registerIpc({
      services,
      window: () => null,
      history: index.history,
      archive: index.archive,
      themes: { onChange: () => undefined }
    } as unknown as IpcContext)
    const invoke = (channel: string, payload?: unknown): unknown => {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`${channel} is not registered`)
      return handler(payload)
    }

    index.history.refresh()
    const held = invoke('archive:stats') as ArchiveStats
    expect(held.sessions).toBe(3)
    const oldest = readArchivedConversation(services.store, ids[0])?.storedBytes ?? 0
    expect(oldest).toBeGreaterThan(1024)
    // Room for everything but the oldest conversation, so exactly that one has to go.
    const ceiling = held.storedBytes - Math.floor(oldest / 2)

    invoke('settings:write', { transcriptArchiveMaxBytes: ceiling })
    index.history.refresh()

    expect(ids.map((id) => archiveStateOf(services.store, id))).toEqual(['evicted', 'archived', 'archived'])
    expect(invoke('archive:stats')).toMatchObject({ sessions: 2, evictedSessions: 1, maxBytes: ceiling })
    expect((invoke('archive:stats') as ArchiveStats).storedBytes).toBeLessThanOrEqual(ceiling)
  })

  it('leaves the .claude tree byte for byte as it was, on a full pass from cleared cursors', () => {
    const c = newCase()
    const ids = [1, 2].map(sessionUuid) as [string, string]
    appendPrompts(c.tree, [
      { sessionId: ids[0], project: c.alpha, display: 'first', at: T0 },
      { sessionId: ids[1], project: c.beta, display: 'second', at: T0 + HOUR }
    ])
    appendTranscript(c.tree, { sessionId: ids[0], cwd: c.alpha }, [{ role: 'user', text: 'first', at: T0 }])
    const second = appendTranscript(c.tree, { sessionId: ids[1], cwd: c.beta }, [
      { role: 'user', text: 'second', at: T0 + HOUR },
      { role: 'assistant', text: 'An answer.', at: T0 + HOUR }
    ])
    // What else lives in the tree: a subagent's transcript and a settings file.
    mkdirSync(join(second.replace(/\.jsonl$/, ''), 'subagents'), { recursive: true })
    writeFileSync(join(second.replace(/\.jsonl$/, ''), 'subagents', 'agent-1.jsonl'), '{}\n')
    writeFileSync(join(c.tree.dir, 'settings.json'), '{"model":"opus"}\n')

    const before = snapshot(c.tree.dir)
    expect(before.length).toBeGreaterThanOrEqual(5)

    const { index } = indexOf(c)
    index.history.refresh()
    index.archive.sweep()
    expect(readHistorySessions(c.store).total).toBe(2)
    expect(archiveStateOf(c.store, ids[1])).toBe('archived')

    expect(snapshot(c.tree.dir)).toEqual(before)
  })

  it('keeps a conversation whose transcript was deleted, across a restart, identical and searchable', () => {
    const c = newCase()
    const id = sessionUuid(1)
    appendPrompts(c.tree, [{ sessionId: id, project: c.alpha, display: 'name the mascot', at: T0 }])
    const transcript = appendTranscript(c.tree, { sessionId: id, cwd: c.alpha }, [
      { role: 'user', text: 'name the mascot', at: T0 },
      { role: 'assistant', text: 'How about a quokka?', at: T0 + 1000 }
    ])
    indexOf(c).index.history.refresh()
    const before = readArchivedConversation(c.store, id)
    expect(before?.messages).toHaveLength(2)

    // Claude Code reaps the transcript, and Helm is closed and opened again.
    c.store.close()
    rmSync(transcript)
    c.store = openStore({ file: c.db })
    indexOf(c).index.history.refresh()

    expect(readArchivedConversation(c.store, id)).toEqual(before)
    expect(readHistorySessions(c.store).sessions.find((s) => s.sessionId === id)).toMatchObject({
      transcriptFile: null,
      archive: 'archived'
    })
    expect(readHistorySessions(c.store, { search: 'quokka', scope: 'messages' }).sessions.map((s) => s.sessionId)).toEqual([id])
    expect(readHistorySessions(c.store, { search: 'quokka', scope: 'prompts' }).total).toBe(0)
  })
})

/** Every file under a directory: path, size, modification time and content hash. */
function snapshot(dir: string): Array<[string, number, number, string]> {
  const files: Array<[string, number, number, string]> = []
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const stats = statSync(full)
      const sha = createHash('sha256').update(readFileSync(full)).digest('hex')
      files.push([relative(dir, full), stats.size, stats.mtimeMs, sha])
    }
  }
  walk(dir)
  return files.sort((a, b) => a[0].localeCompare(b[0]))
}
