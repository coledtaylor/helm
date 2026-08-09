import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EMPTY_INVENTORY, type Project } from '../types'
import { openStore, type Store } from './db'
import { knownMigrations } from './migrate'
import { cacheProjects, readCachedProjects } from './projects'
import {
  finishSession,
  readSessions,
  reconcileRunningSessions,
  runningSessionNames,
  startSession
} from './sessions'
import { readSettings, writeSetting, writeSettings } from './settings'

let dir: string
let store: Store

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'helm-store-'))
  store = openStore({ file: join(dir, 'helm.db') })
})

afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

const project = (overrides: Partial<Project> = {}): Project => ({
  path: join(dir, 'repos', 'alpha'),
  name: 'alpha',
  kind: 'repo',
  harnessPath: dir,
  hasClaudeDir: true,
  inventory: { ...EMPTY_INVENTORY, skills: 7, agents: 16, commands: 20, claudeMd: true },
  git: { branch: 'main', detached: false, dirty: 3, ahead: 1, behind: 0 },
  ...overrides
})

describe('openStore', () => {
  it('creates the file and applies every migration', () => {
    expect(existsSync(store.file)).toBe(true)
    expect(store.migrations.applied).toEqual(knownMigrations())
    expect(knownMigrations().length).toBeGreaterThan(0)
  })

  it('creates every declared table', () => {
    const names = store.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name)

    expect(names).toEqual(
      expect.arrayContaining([
        'profiles',
        'projects',
        'config_snapshots',
        'app_settings',
        'sessions'
      ])
    )
  })

  it('runs in WAL mode', () => {
    const [mode] = store.raw.pragma('journal_mode') as Array<{ journal_mode: string }>
    expect(mode?.journal_mode).toBe('wal')
  })

  it('is idempotent: reopening applies nothing and loses nothing', () => {
    writeSetting(store, 'theme', 'dark')
    store.close()

    const reopened = openStore({ file: join(dir, 'helm.db') })
    try {
      expect(reopened.migrations.applied).toEqual([])
      expect(reopened.migrations.alreadyApplied).toEqual(knownMigrations())
      expect(readSettings(reopened).theme).toBe('dark')
    } finally {
      reopened.close()
    }
  })
})

describe('settings', () => {
  it('returns defaults for an empty database', () => {
    expect(readSettings(store)).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips every value type in AppSettings', () => {
    writeSettings(store, {
      theme: 'light',
      scanRoots: [dir, join(dir, 'other')],
      windowBounds: { width: 1280, height: 820, x: 40, y: 60 },
      firstRunCompletedAt: '2026-08-09T12:00:00.000Z'
    })

    expect(readSettings(store)).toEqual({
      theme: 'light',
      scanRoots: [dir, join(dir, 'other')],
      windowBounds: { width: 1280, height: 820, x: 40, y: 60 },
      firstRunCompletedAt: '2026-08-09T12:00:00.000Z'
    })
  })

  it('survives a restart', () => {
    writeSettings(store, { theme: 'dark', scanRoots: [dir] })
    store.close()

    const reopened = openStore({ file: join(dir, 'helm.db') })
    try {
      expect(readSettings(reopened)).toMatchObject({ theme: 'dark', scanRoots: [dir] })
    } finally {
      reopened.close()
    }
  })

  it('ignores keys it does not recognise instead of surfacing them', () => {
    store.raw
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('legacyKey', '1', '')")
      .run()

    expect(readSettings(store)).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to the default for a value that is not valid JSON', () => {
    store.raw
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('theme', '{oops', '')")
      .run()

    expect(readSettings(store).theme).toBe(DEFAULT_SETTINGS.theme)
  })
})

describe('project cache', () => {
  it('round-trips a project including its inventory and git state', () => {
    cacheProjects(store, [project()])

    const [cached] = readCachedProjects(store)
    expect(cached).toMatchObject({
      name: 'alpha',
      kind: 'repo',
      hasClaudeDir: true,
      inventory: { skills: 7, agents: 16, commands: 20 },
      git: { branch: 'main', dirty: 3, ahead: 1 }
    })
    expect(cached?.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('upserts on path rather than duplicating', () => {
    cacheProjects(store, [project()])
    cacheProjects(store, [project({ git: { branch: 'main', detached: false, dirty: 0, ahead: 0, behind: 0 } })])

    const cached = readCachedProjects(store)
    expect(cached).toHaveLength(1)
    expect(cached[0]?.git?.dirty).toBe(0)
  })

  it('stores a null git state for a directory that is not a repo', () => {
    cacheProjects(store, [project({ git: null })])
    expect(readCachedProjects(store)[0]?.git).toBeNull()
  })
})

describe('session log', () => {
  const started = (name = 'alpha'): ReturnType<typeof startSession> =>
    startSession(store, {
      name,
      cwd: join(dir, 'repos', 'alpha'),
      projectPath: join(dir, 'repos', 'alpha'),
      argv: ['-n', name]
    })

  it('records a session as running from the moment it is spawned', () => {
    const session = started()

    expect(session).toMatchObject({
      name: 'alpha',
      status: 'running',
      argv: ['-n', 'alpha'],
      endedAt: null,
      durationMs: null,
      exitCode: null
    })
    expect(session.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('records the exit code and a measured duration when it ends', () => {
    const session = started()
    const ended = finishSession(store, session.id, { exitCode: 0 })

    expect(ended).toMatchObject({ id: session.id, status: 'exited', exitCode: 0 })
    expect(ended?.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Measured, not guessed: a real duration is small here but never negative,
    // which is the failure mode of subtracting two different clocks.
    expect(ended?.durationMs).toBeGreaterThanOrEqual(0)
    expect(ended?.durationMs).toBeLessThan(60_000)
  })

  it('keeps a non-zero exit code rather than flattening it to a failure flag', () => {
    const session = started()
    expect(finishSession(store, session.id, { exitCode: 130 })?.exitCode).toBe(130)
  })

  it('ignores a second finish, so a shutdown sweep cannot overwrite a real exit', () => {
    const session = started()
    finishSession(store, session.id, { exitCode: 0 })

    expect(finishSession(store, session.id, { exitCode: null })).toBeNull()
    expect(readSessions(store)[0]?.exitCode).toBe(0)
  })

  it('reconciles sessions left running by a host that did not survive them', () => {
    const alive = started('alpha')
    const ended = started('beta')
    finishSession(store, ended.id, { exitCode: 0 })

    expect(reconcileRunningSessions(store)).toBe(1)

    const rows = readSessions(store)
    expect(rows.find((r) => r.id === alive.id)).toMatchObject({
      status: 'lost',
      endedAt: null,
      durationMs: null
    })
    // The one that ended cleanly keeps its outcome.
    expect(rows.find((r) => r.id === ended.id)).toMatchObject({ status: 'exited', exitCode: 0 })
  })

  it('lists newest first and filters by status and project', () => {
    const first = started('alpha')
    const second = started('beta')
    startSession(store, { name: 'gamma', cwd: dir, projectPath: null })
    finishSession(store, first.id, { exitCode: 0 })

    expect(readSessions(store).map((s) => s.id)).toEqual([
      expect.any(Number),
      second.id,
      first.id
    ])
    expect(readSessions(store, { status: 'running' }).map((s) => s.name)).toEqual([
      'gamma',
      'beta'
    ])
    expect(
      readSessions(store, { projectPath: join(dir, 'repos', 'alpha') }).map((s) => s.name)
    ).toEqual(['beta', 'alpha'])
  })

  it('reports the names a new session has to be unique against', () => {
    const one = started('alpha')
    started('alpha 2')
    finishSession(store, one.id, { exitCode: 0 })

    expect(runningSessionNames(store)).toEqual(['alpha 2'])
  })
})
