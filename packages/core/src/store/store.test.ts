import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  LOCAL_HOST_KEY,
  PINNED_PROJECTS_MAX,
  isProjectPinned,
  quitEndsSessions,
  sessionLabel,
  withProjectPinned,
  type AppSettings
} from '../types'
import { openStore, type Store } from './db'
import { knownMigrations } from './migrate'
import { sessions } from './schema'
import { reconcileRunningSessions } from './sessions'
import {
  readSettings,
  validateSetting,
  writeSetting,
  writeSettings,
  SettingsValidationError
} from './settings'

/** A folder the rows name. Nothing is made there: the rows are only data. */
const dir = join(tmpdir(), 'helm-store')
let store: Store

// The rows are about the store, not the file it lives in, so they live in
// memory; the tests about the file make one (`withFile`).
beforeEach(() => {
  store = openStore({ file: ':memory:' })
})

afterEach(() => {
  store.close()
})

/**
 * Runs `test` against a store on a database file in a new temp folder, for
 * the tests about the file itself, and removes the folder afterwards. The
 * test may close the store and reopen the file.
 */
async function withFile(test: (file: string, onFile: Store) => void): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'helm-store-'))
  const file = join(folder, 'helm.db')
  const onFile = openStore({ file })
  try {
    test(file, onFile)
  } finally {
    if (onFile.raw.open) onFile.close()
    await rm(folder, { recursive: true, force: true })
  }
}

describe('openStore', () => {
  it('creates the file and applies every migration', async () => {
    await withFile((file, onFile) => {
      expect(onFile.file).toBe(file)
      expect(existsSync(file)).toBe(true)
      expect(onFile.migrations.applied).toEqual(knownMigrations())
      expect(knownMigrations().length).toBeGreaterThan(0)
    })
  })

  it('applies every migration to a database in memory too', () => {
    expect(store.migrations.applied).toEqual(knownMigrations())
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
        'sessions',
        'history_prompts',
        'history_sessions',
        'history_index'
      ])
    )
  })

  it('runs in WAL mode', async () => {
    await withFile((_file, onFile) => {
      const [mode] = onFile.raw.pragma('journal_mode') as Array<{ journal_mode: string }>
      expect(mode?.journal_mode).toBe('wal')
    })
  })

  it('is idempotent: reopening applies nothing and loses nothing', async () => {
    await withFile((file, onFile) => {
      writeSetting(onFile, 'theme', 'dark')
      onFile.close()

      const reopened = openStore({ file })
      try {
        expect(reopened.migrations.applied).toEqual([])
        expect(reopened.migrations.alreadyApplied).toEqual(knownMigrations())
        expect(readSettings(reopened).theme).toBe('dark')
      } finally {
        reopened.close()
      }
    })
  })
})

describe('settings', () => {
  it('returns defaults for an empty database', () => {
    expect(readSettings(store)).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips every value type in AppSettings', () => {
    const written = {
      theme: 'light',
      themeDark: 'graphite',
      themeLight: 'my-theme',
      paneGap: 4,
      cornerRadius: 0,
      density: 'compact',
      accentColor: '#4fc3b4',
      scanRoots: [dir, join(dir, 'other')],
      pinnedProjects: [join(dir, 'alpha'), join(dir, 'beta')],
      windowBounds: { width: 1280, height: 820, x: 40, y: 60 },
      // Every pane kind, because the validator checks each one's own fields and
      // a strip of only the field-less kinds would not exercise them.
      paneLayout: {
        root: {
          axis: 'row',
          children: [
            {
              panes: [
                { kind: 'project', path: dir },
                { kind: 'history' },
                { kind: 'sessions' },
                { kind: 'session', id: 7 }
              ],
              activeId: `project:${dir}`
            },
            {
              axis: 'column',
              children: [
                { panes: [{ kind: 'config' }], activeId: null },
                { panes: [{ kind: 'settings' }], activeId: null }
              ],
              sizes: [0.7, 0.3]
            }
          ],
          sizes: [0.6, 0.4]
        },
        focused: 1
      },
      firstRunCompletedAt: '2026-08-09T12:00:00.000Z',
      claudePath: join(dir, 'claude.exe'),
      usageDisplay: 'cost',
      terminalFontFamily: 'Consolas',
      terminalFontSize: 17,
      terminalCursorStyle: 'bar',
      terminalCursorBlink: false,
      terminalScrollback: 2500,
      terminalShell: join(dir, 'pwsh.exe'),
      projectShellHeightPct: 42,
      filesWrap: true,
      railHidden: ['files', 'config'],
      transcriptArchiveMaxBytes: 256 * 1024 * 1024,
      updateCheck: false,
      lastUpdateCheckAt: '2026-08-11T20:04:06.641Z',
      browserReach: 'local',
      browserSearch: 'duckduckgo',
      browserMcp: false,
      browserMcpLocalOnly: true,
      restoreWithoutAsking: true,
      browserRecentUrls: ['http://localhost:3000/', 'https://example.com/docs'],
      browserProjectUrls: { [join(dir, 'alpha').toLowerCase()]: 'http://localhost:5173/' },
      sessionMcp: false,
      sessionAgents: false,
      agentChildrenPerParent: 6,
      agentSessionsPerHost: 12,
      agentDepth: 3,
      agentStartsPerParent: 20,
      agentHeavyPerHost: 2,
      showChildrenInParentTab: false,
      quitSessions: { local: 'keep' },
      hosts: [{ id: 'h1', name: 'build-box', transport: { kind: 'ssh', target: 'you@build-box' } }],
      profilesCopiedToHostAt: '2026-10-29T08:00:00.000Z',
      pluginsCopiedToHostAt: '2026-10-30T08:00:00.000Z'
    } satisfies AppSettings

    writeSettings(store, written)

    expect(readSettings(store)).toEqual(written)
    // Every key of the interface, not merely the ones this test remembered to
    // list: a key added without a line here would otherwise round-trip untested.
    expect(Object.keys(written).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })

  it('survives a restart', async () => {
    await withFile((file, onFile) => {
      writeSettings(onFile, { theme: 'dark', scanRoots: [dir] })
      onFile.close()

      const reopened = openStore({ file })
      try {
        expect(readSettings(reopened)).toMatchObject({ theme: 'dark', scanRoots: [dir] })
      } finally {
        reopened.close()
      }
    })
  })

  it('S2: ignores a stored run-sessions-in-the-local-host row an earlier version wrote, and takes the next write', () => {
    // An earlier version kept this switch; helm.db keeps its row and the host
    // is the only path whatever it says.
    store.raw
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('sessionsInHost', JSON.stringify(false), '')

    const settings = readSettings(store)
    expect(settings).not.toHaveProperty('sessionsInHost')
    const fresh = openStore({ file: ':memory:' })
    try {
      expect(settings).toEqual(readSettings(fresh))
    } finally {
      fresh.close()
    }
    expect(() => writeSettings(store, { theme: 'dark' })).not.toThrow()
    expect(readSettings(store).theme).toBe('dark')
  })

  it('has quitting end the sessions on this PC’s host until Settings keeps them, and keeps that choice across a restart', async () => {
    expect(quitEndsSessions(readSettings(store))).toBe(true)
    await withFile((file, onFile) => {
      writeSettings(onFile, { quitSessions: { [LOCAL_HOST_KEY]: 'keep' } })
      onFile.close()

      const reopened = openStore({ file })
      try {
        expect(readSettings(reopened).quitSessions).toEqual({ local: 'keep' })
        expect(quitEndsSessions(readSettings(reopened))).toBe(false)
        // A host on another computer with no entry of its own keeps them.
        expect(quitEndsSessions(readSettings(reopened), 'another host')).toBe(false)
      } finally {
        reopened.close()
      }
    })
  })

  it('S11: keeps each remote host’s quit choice on this device, Keep them running until set, while this PC’s still defaults to End', async () => {
    await withFile((file, onFile) => {
      const hosts = [
        { id: 'h-build', name: 'build-box', transport: { kind: 'ssh', target: 'build-box' } },
        { id: 'h-wsl', name: 'wsl', transport: { kind: 'command', program: 'wsl.exe', args: ['-d', 'Ubuntu', '--'] } }
      ] as const
      writeSettings(onFile, { hosts: [...hosts] })
      const fresh = readSettings(onFile)
      expect(quitEndsSessions(fresh)).toBe(true)
      expect(quitEndsSessions(fresh, 'h-build')).toBe(false)
      expect(quitEndsSessions(fresh, 'h-wsl')).toBe(false)

      // Changing one host's choice changes only that host's.
      writeSettings(onFile, { quitSessions: { ...fresh.quitSessions, 'h-build': 'end' } })
      onFile.close()

      const reopened = openStore({ file })
      try {
        const after = readSettings(reopened)
        expect(after.hosts).toEqual(hosts)
        expect(after.quitSessions).toEqual({ 'h-build': 'end' })
        expect(quitEndsSessions(after, 'h-build')).toBe(true)
        expect(quitEndsSessions(after, 'h-wsl')).toBe(false)
        expect(quitEndsSessions(after)).toBe(true)
      } finally {
        reopened.close()
      }
    })
  })

  it('ignores keys it does not recognise instead of surfacing them', () => {
    store.raw
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('legacyKey', '1', '')")
      .run()

    expect(readSettings(store)).toEqual(DEFAULT_SETTINGS)
  })

  it('S5: loads a host an earlier version saved with a role with the role dropped, and takes the next write', () => {
    const raw = store.raw.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    const host = {
      id: 'h-build',
      name: 'build-box',
      transport: { kind: 'ssh', target: 'build-box' }
    }
    raw.run('hosts', JSON.stringify([{ ...host, role: 'operator' }]), '')

    const settings = readSettings(store)
    expect(settings.hosts).toEqual([host])
    expect(() => writeSettings(store, { hosts: [...settings.hosts] })).not.toThrow()
    expect(readSettings(store).hosts).toEqual([host])
  })

  it('reads what an older build wrote for pull requests, and takes the next write', () => {
    const raw = store.raw.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    raw.run('railHidden', JSON.stringify(['pulls', 'config']), '')
    raw.run('prPollMinutes', JSON.stringify(15), '')
    raw.run('ghPath', JSON.stringify('C:\\tools\\gh.exe'), '')

    const settings = readSettings(store)
    // The rail no longer has a Pulls destination, and a list naming one would
    // be refused the next time anything on the rail was hidden.
    expect(settings.railHidden).toEqual(['config'])
    expect(settings).not.toHaveProperty('prPollMinutes')
    expect(settings).not.toHaveProperty('ghPath')
    expect(() => writeSettings(store, { railHidden: [...settings.railHidden, 'history'] })).not.toThrow()
    expect(readSettings(store).railHidden).toEqual(['config', 'history'])
  })

  describe('a pane layout written before panes were a tree', () => {
    const raw = (key: string, value: unknown): void => {
      store.raw
        .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run(key, JSON.stringify(value), '')
    }
    const HISTORY = { panes: [{ kind: 'history' }], activeId: 'history' }
    const CONFIG = { panes: [{ kind: 'config' }], activeId: null }

    it('reads two groups as the row they were, with the divider where it was left', () => {
      raw('paneLayout', { groups: [HISTORY, CONFIG], focused: 1 })
      raw('paneSplitPct', 62)

      expect(readSettings(store).paneLayout).toEqual({
        root: { axis: 'row', children: [HISTORY, CONFIG], sizes: [0.38, 0.62] },
        focused: 1
      })
    })

    it('reads two groups at the old default split when the divider was never moved', () => {
      raw('paneLayout', { groups: [HISTORY, CONFIG], focused: 0 })

      expect(readSettings(store).paneLayout).toEqual({
        root: { axis: 'row', children: [HISTORY, CONFIG], sizes: [0.55, 0.45] },
        focused: 0
      })
    })

    it('reads one group as that group, and the result is a layout the writer accepts', () => {
      raw('paneLayout', { groups: [HISTORY], focused: 0 })

      const { paneLayout } = readSettings(store)
      expect(paneLayout).toEqual({ root: HISTORY, focused: 0 })
      expect(validateSetting('paneLayout', paneLayout)).toBeNull()
    })

    it('reads a layout saved before there were other hosts as this PC’s, and keeps another host’s tabs with their host', () => {
      const before = { root: { panes: [{ kind: 'session', id: 5 }, { kind: 'project', path: 'C:\\a' }], activeId: null }, focused: 0 }
      raw('paneLayout', before)
      expect(readSettings(store).paneLayout).toEqual(before)

      const mixed = {
        root: {
          panes: [
            { kind: 'session', id: 5 },
            { kind: 'session', id: 5, host: 'h-build' },
            { kind: 'project', path: '/srv/app', host: 'h-build' },
            { kind: 'file', root: '/srv/app', path: '/srv/app/README.md', host: 'h-build' },
            { kind: 'plugin', plugin: 'sample', tab: 'detail', params: {}, title: null, host: 'h-build' }
          ],
          activeId: 'host:h-build/session:5'
        },
        focused: 0
      }
      expect(validateSetting('paneLayout', mixed)).toBeNull()
      writeSettings(store, { paneLayout: mixed as never })
      expect(readSettings(store).paneLayout).toEqual(mixed)
    })

    it('refuses a tab naming this PC’s key, an empty host, or a host on a tab that has none', () => {
      const one = (pane: Record<string, unknown>) => ({ root: { panes: [pane], activeId: null }, focused: 0 })
      expect(validateSetting('paneLayout', one({ kind: 'session', id: 5, host: 'local' }))).toMatch(/this PC/)
      expect(validateSetting('paneLayout', one({ kind: 'session', id: 5, host: '' }))).toMatch(/host/)
      expect(validateSetting('paneLayout', one({ kind: 'history', host: 'h-build' }))).toMatch(/no host/)
    })

    it('keeps how each parent tab arranges its children, and refuses an arrangement that is not one', () => {
      const withFamilies = (families: unknown) => ({
        root: { panes: [{ kind: 'session', id: 1 }], activeId: null },
        focused: 0,
        families
      })
      const arranged = withFamilies({
        'session:1': { order: [3, 4, 5], shrunk: [4], closed: [6], screens: [7] }
      })
      expect(validateSetting('paneLayout', arranged)).toBeNull()
      writeSettings(store, { paneLayout: arranged as never })
      expect(readSettings(store).paneLayout).toEqual(arranged)

      expect(validateSetting('paneLayout', withFamilies({}))).toBeNull()
      expect(validateSetting('paneLayout', withFamilies([]))).toMatch(/arrangements/)
      expect(validateSetting('paneLayout', withFamilies({ 'session:1': [] }))).toMatch(/arrangement for/)
      expect(validateSetting('paneLayout', withFamilies({ 'session:1': { order: 'x' } }))).toMatch(/order/)
      expect(validateSetting('paneLayout', withFamilies({ 'session:1': { shrunk: [0] } }))).toMatch(/shrunk/)
      expect(validateSetting('paneLayout', withFamilies({ 'session:1': { closed: [1.5] } }))).toMatch(/closed/)
      // More arrangements than the layout has tabs to hold them.
      expect(
        validateSetting('paneLayout', withFamilies({ 'session:1': { order: [2] }, 'session:2': { order: [3] } }))
      ).toMatch(/at most/)
    })

    it('reads a value that is neither shape as no layout, and no key for the old divider', () => {
      raw('paneLayout', { panes: [] })
      raw('paneSplitPct', 62)

      const settings = readSettings(store)
      expect(settings.paneLayout).toBeNull()
      expect(settings).not.toHaveProperty('paneSplitPct')
    })
  })

  it('falls back to the default for a value that is not valid JSON', () => {
    store.raw
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('theme', '{oops', '')")
      .run()

    expect(readSettings(store).theme).toBe(DEFAULT_SETTINGS.theme)
  })
})

/** Two groups to split, for the validator's split cases. */
const H = { panes: [{ kind: 'history' }], activeId: null }
const S = { panes: [{ kind: 'settings' }], activeId: null }

/** Splits nested `depth` deep, alternating axis, each beside one group. */
function nested(depth: number): unknown {
  let node: unknown = H
  for (let level = 0; level < depth; level += 1) {
    node = { axis: level % 2 === 0 ? 'row' : 'column', children: [node, S], sizes: [0.5, 0.5] }
  }
  return node
}

describe('settings validation', () => {
  /**
   * Every key, with a value that fits and one that does not.
   *
   * The good column is not decoration: a rejection test whose valid case is
   * never exercised cannot tell "the validator is right" from "the validator
   * refuses everything", which is the same trap CLAUDE.md's fixture rule
   * describes. Both columns run against the same key.
   */
  const cases: Array<{
    key: keyof typeof DEFAULT_SETTINGS
    good: unknown[]
    bad: unknown[]
  }> = [
    {
      key: 'theme',
      good: ['system', 'light', 'dark'],
      bad: ['purple', 'Dark', '', null, 1, ['dark'], { theme: 'dark' }]
    },
    {
      key: 'themeDark',
      good: ['nocturne', 'graphite', 'my-theme', 'a', 'x'.repeat(48)],
      bad: ['Nocturne', 'my theme', '-lead', 'trail-', 'two--dashes', '', 'x'.repeat(49), null, 1]
    },
    {
      key: 'themeLight',
      good: ['daylight', 'solarized-light-2'],
      bad: ['../daylight', 'day_light', null]
    },
    {
      key: 'paneGap',
      good: [2, 6, 12],
      bad: [1, 13, 6.5, '6', null]
    },
    {
      key: 'cornerRadius',
      good: [0, 3, 8],
      bad: [-1, 9, 3.5, '3px', null]
    },
    {
      key: 'density',
      good: ['comfortable', 'compact'],
      bad: ['Compact', 'cozy', null, 0]
    },
    {
      key: 'accentColor',
      good: [null, '#6ca6f5', '#000000'],
      bad: ['#6CA6F5', '#6ca6f', '#6ca6f5ff', 'rgb(1 2 3)', 'blue', '', 6, {}]
    },
    {
      key: 'usageDisplay',
      good: ['percent', 'cost', 'off'],
      bad: ['dollars', 'PERCENT', null, 0, ['off']]
    },
    {
      key: 'scanRoots',
      good: [[], [join(tmpdir(), 'a')], [join(tmpdir(), 'a'), join(tmpdir(), 'b')]],
      bad: [null, 'C:\\work', ['repos/helm'], ['../up'], [''], [17], [null]]
    },
    {
      key: 'pinnedProjects',
      // Absolute paths, as a set. Two spellings of one path is the interesting
      // rejection: the comparison is case-insensitive, so `C:\Repos\Api` and `c:\repos\api` would present
      // as two rows in a section where un-pinning either removes both. Mixed
      // case across *different* paths is fine and is in the good column.
      good: [
        [],
        [join(tmpdir(), 'alpha')],
        [join(tmpdir(), 'alpha'), join(tmpdir(), 'Beta')],
        [join(tmpdir(), 'a folder with spaces')]
      ],
      bad: [
        [join(tmpdir(), 'alpha'), join(tmpdir(), 'ALPHA')],
        [join(tmpdir(), 'alpha'), join(tmpdir(), 'alpha')],
        ['repos/helm'],
        ['../up'],
        [''],
        ['   '],
        [17],
        [null],
        join(tmpdir(), 'alpha'),
        null,
        {},
        Array.from({ length: PINNED_PROJECTS_MAX + 1 }, (_, i) => join(tmpdir(), `p${String(i)}`))
      ]
    },
    {
      key: 'claudePath',
      good: [null, join(tmpdir(), 'claude.exe')],
      bad: ['claude', 'bin\\claude.exe', '', 42, {}]
    },
    {
      key: 'windowBounds',
      good: [null, { width: 1280, height: 820 }, { width: 1280, height: 820, x: 40, y: 60 }],
      bad: [
        { width: 0, height: 820 },
        { width: -1280, height: 820 },
        { width: 1280 },
        { width: '1280', height: '820' },
        { width: 1280, height: 820, x: 'left', y: 60 },
        { width: Number.NaN, height: 820 },
        [1280, 820],
        'maximized'
      ]
    },
    {
      key: 'paneLayout',
      good: [
        null,
        { root: { panes: [], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'history' }], activeId: 'history' }, focused: 0 },
        {
          root: {
            axis: 'row',
            children: [
              {
                panes: [
                  { kind: 'project', path: 'C:\\work\\helm' },
                  { kind: 'pr', repoPath: 'C:\\work\\helm', number: 7 },
                  { kind: 'pulls' },
                  { kind: 'session', id: 12 }
                ],
                activeId: 'session:12'
              },
              {
                axis: 'column',
                children: [
                  { panes: [{ kind: 'config' }, { kind: 'content' }], activeId: null },
                  {
                    panes: [
                      { kind: 'settings' },
                      { kind: 'file', root: 'C:\\work\\helm', path: 'C:\\work\\helm\\README.md' }
                    ],
                    activeId: null
                  }
                ],
                sizes: [0.5, 0.5]
              },
              { panes: [{ kind: 'history' }], activeId: null }
            ],
            sizes: [0.4, 0.35, 0.25]
          },
          focused: 2
        },
        // A plugin's tab: bare, and with parameters and a title of its own.
        {
          root: {
            panes: [
              { kind: 'plugin', plugin: 'sample', tab: 'detail', params: {}, title: null },
              { kind: 'plugin', plugin: 'sample', tab: 'run', params: { run: 1234, live: true, name: 'a b' }, title: 'Run 1234' }
            ],
            activeId: null
          },
          focused: 0
        },
        // A plugin's one tab holding its pages, with the page in front named.
        {
          root: {
            panes: [
              {
                kind: 'plugin-pages',
                plugin: 'trackr',
                pages: [
                  { tab: 'view', params: {}, title: null },
                  { tab: 'view', params: { id: 'HELM-13' }, title: 'HELM-13' }
                ],
                active: 'plugin-page:trackr/view?{"id":"HELM-13"}'
              }
            ],
            activeId: 'plugin-pages:trackr'
          },
          focused: 0
        }
      ],
      bad: [
        // A plugin's pages tab with no pages, a page that is not one a
        // manifest could open, or a front page that is not a page id.
        { root: { panes: [{ kind: 'plugin-pages', plugin: 'trackr', pages: [], active: null }], activeId: null }, focused: 0 },
        {
          root: {
            panes: [{ kind: 'plugin-pages', plugin: 'trackr', pages: [{ tab: 'View', params: {}, title: null }], active: null }],
            activeId: null
          },
          focused: 0
        },
        {
          root: {
            panes: [{ kind: 'plugin-pages', plugin: 'trackr', pages: [{ tab: 'view', params: {}, title: null }], active: 3 }],
            activeId: null
          },
          focused: 0
        },
        // A plugin's tab with an id no manifest could have, a tab name with
        // capitals, parameters that are not a flat record, or an empty title.
        { root: { panes: [{ kind: 'plugin', plugin: 'Sample', tab: 'detail', params: {}, title: null }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'plugin', plugin: 'sample', tab: 'Detail', params: {}, title: null }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'plugin', plugin: 'sample', tab: 'run', params: { run: { id: 1 } }, title: null }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'plugin', plugin: 'sample', tab: 'run', params: [], title: null }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'plugin', plugin: 'sample', tab: 'run', title: null }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'plugin', plugin: 'sample', tab: 'run', params: {}, title: '' }], activeId: null }, focused: 0 },
        // Not a layout at all.
        [],
        'history',
        42,
        { focused: 0 },
        { root: null, focused: 0 },
        { root: [], focused: 0 },
        // The shape a layout had before panes were a tree. Read back, it is
        // upgraded (`upgradeSavedLayout`); written, it is a bug in the writer.
        { groups: [{ panes: [{ kind: 'history' }], activeId: 'history' }], focused: 0 },
        // The single strip that shape replaced.
        { panes: [{ kind: 'history' }], activeId: 'history' },
        // A split of fewer than two, across no axis, or with a share missing,
        // spare, zero, negative or not a number.
        { root: { axis: 'row', children: [{ panes: [{ kind: 'history' }], activeId: null }], sizes: [1] }, focused: 0 },
        {
          root: { axis: 'diagonal', children: [H, S], sizes: [0.5, 0.5] },
          focused: 0
        },
        { root: { axis: 'row', children: [H, S], sizes: [1] }, focused: 0 },
        { root: { axis: 'row', children: [H, S], sizes: [0.5, 0.25, 0.25] }, focused: 0 },
        { root: { axis: 'row', children: [H, S], sizes: [1, 0] }, focused: 0 },
        { root: { axis: 'row', children: [H, S], sizes: [1.5, -0.5] }, focused: 0 },
        { root: { axis: 'row', children: [H, S], sizes: [0.5, Number.NaN] }, focused: 0 },
        { root: { axis: 'row', children: [H, S], sizes: ['0.5', '0.5'] }, focused: 0 },
        { root: { axis: 'row', children: [H, S] }, focused: 0 },
        { root: { axis: 'row', children: [H, null], sizes: [0.5, 0.5] }, focused: 0 },
        // An empty group beside a full one: `toSaved` never writes one, so one
        // here is a writer that has stopped normalising.
        { root: { axis: 'row', children: [H, { panes: [], activeId: null }], sizes: [0.5, 0.5] }, focused: 0 },
        // Nested past any arrangement a person could make.
        { root: nested(40), focused: 0 },
        // A focus that names no group.
        { root: { panes: [], activeId: null }, focused: 1 },
        { root: { axis: 'row', children: [H, S], sizes: [0.5, 0.5] }, focused: 2 },
        { root: { panes: [], activeId: null }, focused: -1 },
        { root: { panes: [], activeId: null }, focused: 0.5 },
        { root: { panes: [], activeId: null } },
        { root: { activeId: null }, focused: 0 },
        // A kind this build does not have, which is the shape a renamed pane
        // would arrive in.
        { root: { panes: [{ kind: 'terminal' }], activeId: null }, focused: 0 },
        // A session is written down by its row id, and only by one; browser
        // tabs and the restore offer never are. See `SavedPane`.
        { root: { panes: [{ kind: 'session' }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'session', id: '1' }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'session', id: 0 }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'session', id: 1.5 }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'browser', id: 1 }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'browser' }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'restore' }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'project' }], activeId: null }, focused: 0 },
        // A file is read inside its project, so it is written down with both.
        { root: { panes: [{ kind: 'file', path: 'C:\\a\\b.ts' }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'file', root: 'C:\\a' }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'file', root: '', path: 'C:\\a\\b.ts' }], activeId: null }, focused: 0 },
        { root: { panes: [{ kind: 'project', path: '' }], activeId: null }, focused: 0 },
        { root: { panes: ['history'], activeId: null }, focused: 0 },
        // An id is compared against tabs, never parsed, so anything that is not
        // a string cannot match one.
        { root: { panes: [], activeId: 7 }, focused: 0 },
        // Longer than any workspace, counted across every group: a runaway list
        // is a bug, not an arrangement.
        {
          root: {
            axis: 'row',
            children: [
              { panes: Array.from({ length: 60 }, () => ({ kind: 'history' })), activeId: null },
              { panes: Array.from({ length: 41 }, () => ({ kind: 'history' })), activeId: null }
            ],
            sizes: [0.5, 0.5]
          },
          focused: 0
        }
      ]
    },
    {
      key: 'firstRunCompletedAt',
      good: [null, '2026-08-11T09:00:00.000Z'],
      bad: ['soon', '', 1786353684315, {}]
    },
    {
      key: 'terminalFontFamily',
      good: [null, 'Consolas', 'Cascadia Mono', 'MesloLGS NF'],
      bad: [
        '',
        '   ',
        // A stack, which would read as though it replaced the default one.
        'Fira Code, monospace',
        // Everything below ends a `font-family` declaration and starts
        // something else, inside an inline style xterm writes for us.
        'x; color: red',
        'x">',
        'x/*',
        42,
        ['Consolas']
      ]
    },
    {
      key: 'terminalFontSize',
      good: [8, 14, 32],
      bad: [7, 33, 0, -14, 14.5, '14', null, Number.NaN, Number.POSITIVE_INFINITY]
    },
    {
      key: 'terminalCursorStyle',
      good: ['block', 'underline', 'bar'],
      bad: ['beam', 'BLOCK', '', null, 0]
    },
    {
      key: 'terminalCursorBlink',
      good: [true, false],
      bad: ['true', 1, 0, null, {}]
    },
    {
      key: 'terminalScrollback',
      good: [500, 10_000, 200_000],
      bad: [499, 200_001, 0, -1, 1000.5, '10000', null]
    },
    {
      key: 'terminalShell',
      good: [null, join(tmpdir(), 'pwsh.exe'), join(tmpdir(), 'bin', 'bash')],
      bad: ['pwsh.exe', 'bin\\pwsh.exe', '', 42, {}]
    },
    {
      // A percentage of the project page's column. 51 is in the bad column
      // because the ceiling is the user's own ask - the project pane is never
      // the smaller half of its own page - and the non-finite cases are there
      // because this number becomes a `height`, where `NaN%` is a declaration
      // the style parser drops without a word.
      key: 'projectShellHeightPct',
      good: [10, 30, 50],
      bad: [9, 51, 0, -30, 100, 30.5, '30', null, Number.NaN, Number.POSITIVE_INFINITY]
    },
    {
      // Whether a file wraps. `'true'` and `1` are in the bad column because
      // this value is read straight into a class decision, where any truthy
      // string would switch wrapping on and `'false'` would too.
      key: 'filesWrap',
      good: [true, false],
      bad: ['true', 'false', 1, 0, null, {}, []]
    },
    {
      // `settings` is the one destination that may never be hidden, so it is
      // refused here rather than trusted to the rail's menu.
      key: 'railHidden',
      good: [
        [],
        ['history'],
        ['sessions', 'profiles', 'files', 'history', 'browser', 'config'],
        // A plugin's rail icon, by its prefixed id.
        ['plugin:sample', 'history']
      ],
      bad: [
        null,
        'history',
        ['settings'],
        ['content'],
        // Retired with the pull request surface; `readSettings` drops it.
        ['pulls'],
        ['history', 'history'],
        [1],
        [''],
        {},
        ['plugin:'],
        ['plugin:Sample'],
        ['plugin:sample', 'plugin:sample']
      ]
    },
    {
      // A byte count, and null is in the *bad* column deliberately: there is no
      // "no ceiling" for this key. The archive is always on and always bounded,
      // and an unbounded one is the state `helm.db` is not allowed to reach.
      key: 'transcriptArchiveMaxBytes',
      good: [1024, 1024 ** 3, 64 * 1024 ** 3],
      bad: [1023, 0, -1, 64 * 1024 ** 3 + 1, 1024.5, '1073741824', null, {}]
    },
    {
      key: 'updateCheck',
      good: [true, false],
      bad: ['true', 'false', 1, 0, null, {}, []]
    },
    {
      // `'never'` and `'soon'` are the interesting rejections: an unparseable
      // instant here would make every throttle comparison NaN, and NaN fails
      // every `>`, so one bad row would mean "never check again" rather than
      // "check now" - and it would do it silently.
      key: 'lastUpdateCheckAt',
      good: [null, '2026-08-11T20:04:06.641Z', '2026-08-11T14:04:06-06:00'],
      bad: ['never', 'soon', '', 0, 1786478646641, true, {}]
    },
    {
      key: 'browserReach',
      good: ['web', 'local'],
      bad: ['none', 'Web', 'loopback', '', null, true, ['web']]
    },
    {
      key: 'browserSearch',
      good: ['google', 'duckduckgo', 'bing', 'off'],
      bad: ['Google', 'yahoo', '', null, false, ['google']]
    },
    {
      // `'false'` is the interesting rejection for both, and it is the same one
      // `updateCheck` has: a row hand-edited into that string would switch the
      // endpoint **on** while the pane read it as off, since every non-empty
      // string is truthy.
      key: 'browserMcp',
      good: [true, false],
      bad: ['false', 'true', 0, 1, null, [], {}]
    },
    {
      key: 'browserMcpLocalOnly',
      good: [true, false],
      bad: ['false', 'true', 0, 1, null, [], {}]
    },
    {
      // And the same again for the session tools, which decide the same thing:
      // whether a route exists at all.
      key: 'sessionMcp',
      good: [true, false],
      bad: ['false', 'true', 0, 1, null, [], {}]
    },
    {
      // `'false'` would switch the family on while the pane read it as off.
      key: 'sessionAgents',
      good: [true, false],
      bad: ['false', 'true', 0, 1, null, [], {}]
    },
    {
      // Whole numbers inside the range the host accepts: the host refuses a
      // limit outside it, and its refusal would take the write's other settings
      // with it.
      key: 'agentChildrenPerParent',
      good: [1, 4, 32],
      bad: [0, -1, 33, 2.5, '4', null, NaN, Infinity, true, {}]
    },
    {
      key: 'agentSessionsPerHost',
      good: [1, 8, 128],
      bad: [0, -1, 129, 2.5, '8', null, NaN, Infinity, true, {}]
    },
    {
      key: 'agentDepth',
      good: [1, 2, 8],
      bad: [0, -1, 9, 1.5, '2', null, NaN, Infinity, true, {}]
    },
    {
      key: 'agentStartsPerParent',
      good: [1, 16, 1000],
      bad: [0, -1, 1001, 16.5, '16', null, NaN, Infinity, true, {}]
    },
    {
      key: 'agentHeavyPerHost',
      good: [1, 2, 8],
      bad: [0, -1, 9, 1.5, '1', null, NaN, Infinity, true, {}]
    },
    {
      // `'false'` would show the children while the pane read it as off.
      key: 'showChildrenInParentTab',
      good: [true, false],
      bad: ['false', 'true', 0, 1, null, [], {}]
    },
    {
      // A string that reads as off would reopen sessions unasked.
      key: 'restoreWithoutAsking',
      good: [true, false],
      bad: ['false', 'true', 0, 1, null, [], {}]
    },
    {
      // A choice that is neither would read as "end" and end sessions the user
      // meant to keep.
      key: 'quitSessions',
      good: [{}, { local: 'end' }, { local: 'keep' }, { local: 'end', 'SHA256:abc': 'keep' }],
      bad: [null, [], 'keep', { local: 'stop' }, { local: true }, { local: null }, { '': 'end' }, { ' ': 'keep' }]
    },
    {
      // A target that starts with a dash would reach ssh as an option, and a
      // host keyed `local` would take this PC's quit choice.
      key: 'hosts',
      good: [
        [],
        [{ id: 'a', name: 'build-box', transport: { kind: 'ssh', target: 'you@build-box' } }],
        [
          { id: 'a', name: 'build-box', transport: { kind: 'ssh', target: 'build-box' } },
          { id: 'b', name: 'wsl', transport: { kind: 'command', program: 'wsl.exe', args: ['-d', 'Ubuntu Dev'] } },
          { id: 'c', name: 'tunnel', transport: { kind: 'command', program: 'C:\\tools\\tunnel.exe', args: [] } }
        ]
      ],
      bad: [
        null,
        {},
        'build-box',
        [{ id: 'local', name: 'x', transport: { kind: 'ssh', target: 'x' } }],
        [{ id: '', name: 'x', transport: { kind: 'ssh', target: 'x' } }],
        [{ id: 'a', name: '', transport: { kind: 'ssh', target: 'x' } }],
        [{ id: 'a', name: ' x ', transport: { kind: 'ssh', target: 'x' } }],
        [{ id: 'a', name: 'This PC', transport: { kind: 'ssh', target: 'x' } }],
        [{ id: 'a', name: 'x', transport: { kind: 'ssh', target: '' } }],
        [{ id: 'a', name: 'x', transport: { kind: 'ssh', target: '-oProxyCommand=evil' } }],
        [{ id: 'a', name: 'x', transport: { kind: 'ssh', target: 'build box' } }],
        [{ id: 'a', name: 'x', transport: { kind: 'telnet', target: 'x' } }],
        [{ id: 'a', name: 'x', transport: { kind: 'command', program: '', args: [] } }],
        [{ id: 'a', name: 'x', transport: { kind: 'command', program: 'wsl.exe', args: [1] } }],
        [{ id: 'a', name: 'x', transport: { kind: 'command', program: 'wsl.exe' } }],
        [
          { id: 'a', name: 'x', transport: { kind: 'ssh', target: 'x' } },
          { id: 'a', name: 'y', transport: { kind: 'ssh', target: 'y' } }
        ],
        [
          { id: 'a', name: 'box', transport: { kind: 'ssh', target: 'x' } },
          { id: 'b', name: 'Box', transport: { kind: 'ssh', target: 'y' } }
        ],
        Array.from({ length: 33 }, (_, i) => ({ id: `h${String(i)}`, name: `h${String(i)}`, transport: { kind: 'ssh', target: 'x' } }))
      ]
    },
    {
      // A value that is not an instant would read as "copied" and never copy.
      key: 'profilesCopiedToHostAt',
      good: [null, '2026-10-29T08:00:00.000Z'],
      bad: ['yes', '', 0, true, {}]
    },
    {
      // A value that is not an instant would read as "copied" and never copy.
      key: 'pluginsCopiedToHostAt',
      good: [null, '2026-10-30T08:00:00.000Z'],
      bad: ['yes', '', 0, true, {}]
    },
    {
      // The interesting rejections are the ones that would put a row in the
      // dropdown that does nothing when clicked: a bare word, a relative path,
      // and `file:` - which the pane refuses to navigate to, so it must not be
      // offered one either.
      key: 'browserRecentUrls',
      good: [[], ['http://localhost:3000/'], ['https://example.com/a', 'http://127.0.0.1:8080/b']],
      bad: [
        null,
        'http://localhost:3000/',
        ['localhost:3000'],
        ['file:///C:/tmp/x.html'],
        ['/docs'],
        [''],
        [42],
        Array.from({ length: 11 }, (_, i) => `http://localhost:${String(3000 + i)}/`)
      ]
    },
    {
      key: 'browserProjectUrls',
      good: [
        {},
        { [join(tmpdir(), 'alpha').toLowerCase()]: 'http://localhost:5173/' },
        {
          [join(tmpdir(), 'alpha').toLowerCase()]: 'http://localhost:5173/',
          [join(tmpdir(), 'beta').toLowerCase()]: 'https://example.com/'
        }
      ],
      bad: [
        null,
        [],
        'http://localhost:5173/',
        // Not lower-cased, so two spellings of one project would each keep a
        // URL and the second would never be found.
        { [join(tmpdir(), 'Alpha')]: 'http://localhost:5173/' },
        { 'repos/alpha': 'http://localhost:5173/' },
        { [join(tmpdir(), 'alpha').toLowerCase()]: 'localhost:5173' },
        { [join(tmpdir(), 'alpha').toLowerCase()]: null }
      ]
    }
  ]

  /**
   * A key with no row above generates no test, and generates it silently.
   *
   * The table is an array, so nothing makes a missing key an error - it simply
   * produces one `it` fewer, in a file that already prints seventy of them. A
   * table like this went stale exactly that way when the content viewer's two
   * wrapping keys landed: both were validated, neither was probed, and the only
   * thing that noticed was a boolean buried in a check that takes minutes to
   * reach. This one cannot be a `Record<keyof AppSettings, ...>`, which would
   * fail to compile, so it is asserted instead - and here, where it costs a
   * second.
   */
  it('has a case for every key of AppSettings', () => {
    expect(cases.map((entry) => entry.key).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })

  for (const { key, good, bad } of cases) {
    it(`accepts every valid ${key} and rejects the rest`, () => {
      for (const value of good) {
        expect(validateSetting(key, value)).toBeNull()
        expect(() => writeSetting(store, key, value as never)).not.toThrow()
        expect(readSettings(store)[key]).toEqual(value)
      }

      for (const value of bad) {
        expect(validateSetting(key, value)).toContain(key)
        expect(() => writeSetting(store, key, value as never)).toThrow(SettingsValidationError)
      }
    })
  }

  it('leaves the stored value untouched when a write is rejected', () => {
    writeSetting(store, 'theme', 'dark')

    expect(() => writeSetting(store, 'theme', 'purple' as never)).toThrow(SettingsValidationError)
    expect(readSettings(store).theme).toBe('dark')

    const row = store.raw.prepare("SELECT value FROM app_settings WHERE key = 'theme'").get()
    expect((row as { value: string }).value).toBe('"dark"')
  })

  it('applies a patch as one edit: one bad key writes none of them', () => {
    writeSettings(store, { theme: 'dark', usageDisplay: 'cost' })

    expect(() =>
      writeSettings(store, { theme: 'light', usageDisplay: 'dollars' as never })
    ).toThrow(SettingsValidationError)

    expect(readSettings(store)).toMatchObject({ theme: 'dark', usageDisplay: 'cost' })
  })

  it('names every problem in the patch, not just the first', () => {
    let thrown: SettingsValidationError | null = null
    try {
      writeSettings(store, { theme: 'purple' as never, claudePath: 'claude' })
    } catch (err) {
      thrown = err as SettingsValidationError
    }

    expect(thrown?.problems).toHaveLength(2)
    expect(thrown?.message).toContain('theme')
    expect(thrown?.message).toContain('claudePath')
  })

  it('still ignores keys it does not recognise rather than rejecting the patch', () => {
    const after = writeSettings(store, {
      theme: 'light',
      // A key from a build that is not this one. Tolerated on the way in for
      // the same reason `readSettings` tolerates it on the way out.
      somethingLater: 'whatever'
    } as never)

    expect(after.theme).toBe('light')
    expect(store.raw.prepare("SELECT * FROM app_settings WHERE key = 'somethingLater'").get()).toBe(
      undefined
    )
  })

  it('accepts a settings object read straight back out of the database', () => {
    // The round trip that matters: whatever `readSettings` returns has to be
    // writable again, or a surface that reads, edits one field and writes the
    // whole object back would be rejected for values it never touched.
    writeSettings(store, {
      theme: 'dark',
      themeDark: 'graphite',
      themeLight: 'daylight',
      paneGap: 12,
      cornerRadius: 8,
      density: 'comfortable',
      accentColor: null,
      scanRoots: [dir],
      pinnedProjects: [join(dir, 'alpha')],
      windowBounds: { width: 1280, height: 820, x: 40, y: 60 },
      paneLayout: {
        root: { panes: [{ kind: 'project', path: dir }, { kind: 'config' }], activeId: 'config' },
        focused: 0
      },
      firstRunCompletedAt: '2026-08-11T09:00:00.000Z',
      claudePath: join(dir, 'claude.exe'),
      usageDisplay: 'off',
      terminalFontFamily: 'Cascadia Mono',
      terminalFontSize: 12,
      terminalCursorStyle: 'underline',
      terminalCursorBlink: false,
      terminalScrollback: 50_000,
      terminalShell: join(dir, 'cmd.exe'),
      projectShellHeightPct: 45,
      filesWrap: true,
      railHidden: ['browser'],
      transcriptArchiveMaxBytes: 512 * 1024 * 1024,
      updateCheck: true,
      lastUpdateCheckAt: null,
      browserReach: 'local',
      browserSearch: 'duckduckgo',
      browserMcp: false,
      browserMcpLocalOnly: true,
      restoreWithoutAsking: true,
      browserRecentUrls: ['http://localhost:3000/'],
      browserProjectUrls: { [join(dir, 'alpha').toLowerCase()]: 'http://localhost:5173/' },
      sessionMcp: false,
      sessionAgents: false,
      agentChildrenPerParent: 6,
      agentSessionsPerHost: 12,
      agentDepth: 3,
      agentStartsPerParent: 20,
      agentHeavyPerHost: 2,
      showChildrenInParentTab: false,
      quitSessions: { local: 'keep' },
      hosts: [{ id: 'h1', name: 'build-box', transport: { kind: 'ssh', target: 'you@build-box' } }],
      profilesCopiedToHostAt: null,
      pluginsCopiedToHostAt: null
    })

    expect(() => writeSettings(store, readSettings(store))).not.toThrow()
    expect(readSettings(store)).toEqual(DEFAULT_SETTINGS_SHAPE(dir))
  })
})

/** What the round-trip test above expects, spelled out away from the writer. */
const DEFAULT_SETTINGS_SHAPE = (dir: string): typeof DEFAULT_SETTINGS => ({
  theme: 'dark',
  themeDark: 'graphite',
  themeLight: 'daylight',
  paneGap: 12,
  cornerRadius: 8,
  density: 'comfortable',
  accentColor: null,
  scanRoots: [dir],
  pinnedProjects: [join(dir, 'alpha')],
  windowBounds: { width: 1280, height: 820, x: 40, y: 60 },
  paneLayout: {
    root: { panes: [{ kind: 'project', path: dir }, { kind: 'config' }], activeId: 'config' },
    focused: 0
  },
  firstRunCompletedAt: '2026-08-11T09:00:00.000Z',
  claudePath: join(dir, 'claude.exe'),
  usageDisplay: 'off',
  terminalFontFamily: 'Cascadia Mono',
  terminalFontSize: 12,
  terminalCursorStyle: 'underline',
  terminalCursorBlink: false,
  terminalScrollback: 50_000,
  terminalShell: join(dir, 'cmd.exe'),
  projectShellHeightPct: 45,
  filesWrap: true,
  railHidden: ['browser'],
  transcriptArchiveMaxBytes: 512 * 1024 * 1024,
  updateCheck: true,
  lastUpdateCheckAt: null,
  browserReach: 'local',
  browserSearch: 'duckduckgo',
  browserMcp: false,
  browserMcpLocalOnly: true,
  restoreWithoutAsking: true,
  browserRecentUrls: ['http://localhost:3000/'],
  browserProjectUrls: { [join(dir, 'alpha').toLowerCase()]: 'http://localhost:5173/' },
  sessionMcp: false,
  sessionAgents: false,
  agentChildrenPerParent: 6,
  agentSessionsPerHost: 12,
  agentDepth: 3,
  agentStartsPerParent: 20,
  agentHeavyPerHost: 2,
  showChildrenInParentTab: false,
  quitSessions: { local: 'keep' },
  hosts: [{ id: 'h1', name: 'build-box', transport: { kind: 'ssh', target: 'you@build-box' } }],
  profilesCopiedToHostAt: null,
  pluginsCopiedToHostAt: null
})

describe('pinned projects', () => {
  const a = 'C:\\Repos\\Api'
  const b = 'C:\\Repos\\web'

  it('matches a path however it was spelled', () => {
    // Windows paths are case-insensitive, and the two places this list meets
    // the tree - the Pinned section and the harness group a pinned project is
    // *left out* of - both compare with `toLowerCase`. If this did not, a pin
    // written in one casing would print the project twice.
    expect(isProjectPinned([a], 'c:\\repos\\api')).toBe(true)
    expect(isProjectPinned(['c:\\repos\\api'], a)).toBe(true)
    expect(isProjectPinned([a], 'C:\\Repos\\Api2')).toBe(false)
    expect(isProjectPinned([], a)).toBe(false)
  })

  it('adds and removes, sorted, so the value does not depend on click order', () => {
    expect(withProjectPinned([], b, true)).toEqual([b])
    expect(withProjectPinned([b], a, true)).toEqual([a, b])
    expect(withProjectPinned([a, b], a, false)).toEqual([b])
  })

  it('never leaves a second spelling of the same project behind', () => {
    expect(withProjectPinned([a], 'c:\\repos\\api', false)).toEqual([])
    expect(withProjectPinned([a], 'c:\\repos\\api', true)).toEqual(['c:\\repos\\api'])
  })

  it('leaves the list it was given alone', () => {
    const held = [a]
    expect(withProjectPinned(held, b, true)).toEqual([a, b])
    expect(held).toEqual([a])
  })

  it('produces a list the validator accepts', () => {
    // The toggle and the validator have to agree about what a set is: a helper
    // that could produce two spellings would build a value nothing can write.
    // Absolute on this OS, which the validator asks of every path.
    let held: string[] = []
    for (const path of ['/Repos/Api', '/Repos/web', '/repos/api', '/Repos/WEB'].map((p) => resolve(p))) {
      held = withProjectPinned(held, path, true)
      expect(validateSetting('pinnedProjects', held)).toBeNull()
    }
    expect(held).toHaveLength(2)
  })
})

/**
 * The session log an earlier version of Helm wrote while it ran sessions in its
 * own process. Nothing writes it now; a row it left claiming to be running is
 * marked lost once, at the next start, and the rest stay as they were.
 */
describe('session log left by an earlier version', () => {
  const row = (values: Partial<typeof sessions.$inferInsert> & { name: string }): number =>
    store.db
      .insert(sessions)
      .values({ cwd: dir, argv: [], status: 'running', ...values })
      .returning({ id: sessions.id })
      .get().id
  interface Outcome {
    status: string
    endedAt: string | null
    durationMs: number | null
    exitCode: number | null
  }
  const outcome = (id: number): Outcome =>
    store.raw
      .prepare(
        'SELECT status, ended_at AS endedAt, duration_ms AS durationMs, exit_code AS exitCode FROM sessions WHERE id = ?'
      )
      .get(id) as Outcome

  it('marks sessions left running as lost, with no guessed end, and leaves an ended one as it was', () => {
    const alive = row({ name: 'alpha' })
    const ended = row({ name: 'beta', status: 'exited', exitCode: 0 })

    expect(reconcileRunningSessions(store).map((lost) => lost.record.id)).toEqual([alive])
    expect(outcome(alive)).toEqual({ status: 'lost', endedAt: null, durationMs: null, exitCode: null })
    expect(outcome(ended)).toMatchObject({ status: 'exited', exitCode: 0 })
  })

  it('hands back what it reconciled, with the conversation each was last in and its mode, once', () => {
    row({ name: 'plain', claudeSessionId: 'c-plain' })
    const cleared = row({
      name: 'cleared',
      claudeSessionId: 'c-first',
      lastClaudeSessionId: 'c-after-clear',
      permissionMode: 'plan'
    })
    row({ name: 'old row' })

    const lost = reconcileRunningSessions(store)
    expect(lost.map((l) => [l.record.name, l.conversationId, l.permissionMode])).toEqual([
      ['plain', 'c-plain', null],
      ['cleared', 'c-after-clear', 'plan'],
      ['old row', null, null]
    ])
    expect(lost[1]?.record).toMatchObject({ id: cleared, status: 'lost', claudeSessionId: 'c-first' })
    // Once each: the next start finds nothing claiming to run.
    expect(reconcileRunningSessions(store)).toEqual([])
  })

  it('reads a permission mode it does not know as none', () => {
    row({ name: 'a', permissionMode: 'yolo' })
    expect(reconcileRunningSessions(store)[0]?.permissionMode).toBeNull()
  })

  it('keeps the label a lost tab had, so it is still called what the user named it', () => {
    row({ name: 'alpha', label: 'PR review' })
    const [lost] = reconcileRunningSessions(store)
    expect(lost?.record).toMatchObject({ name: 'alpha', label: 'PR review' })
    expect(sessionLabel(lost!.record)).toBe('PR review')
  })
})
