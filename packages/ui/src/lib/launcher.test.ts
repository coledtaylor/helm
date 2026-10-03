import { describe, expect, it } from 'vitest'
import type { Profile, Project } from '@helm/core/types'
import { folderName, homePath, launchSentence, profileFor, rankProjects, type SentencePart } from './launcher'

const HARNESS = 'C:\\Users\\someone\\.harness\\dev'
const repo = (name: string): string => `${HARNESS}\\repos\\${name}`

function project(path: string, name = folderName(path)): Project {
  return {
    path,
    name,
    kind: 'repo',
    harnessPath: HARNESS,
    hasClaudeDir: false,
    inventory: { skills: [], agents: [], commands: [], hooks: [], mcpServers: [], claudeMd: false } as never,
    git: null
  }
}

let nextId = 1
function profile(patch: Partial<Profile> & Pick<Profile, 'name'>): Profile {
  return {
    id: nextId++,
    root: HARNESS,
    overlays: [],
    access: [],
    model: null,
    effort: null,
    permissionMode: null,
    agent: null,
    mcp: [],
    openingPrompt: null,
    pinnedOrder: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...patch
  }
}

/** The sentence as text, with mono parts in backticks. */
const read = (parts: readonly SentencePart[]): string =>
  parts.map((part) => (part.mono ? `\`${part.text}\`` : part.text)).join('')

describe('rankProjects', () => {
  const timeclick = project(repo('timeclick'))
  const builder = project(repo('TimeClick-Builder'))
  const reporting = project(repo('timeclick-reporting'))
  const helm = project(repo('helm'))
  const overtime = project(repo('overtime'))
  const all = [helm, reporting, builder, timeclick, overtime]

  it('lists everything by when it was last worked in when nothing is typed, then by name', () => {
    const recency = new Map([
      [reporting.path.toLowerCase(), 300],
      [helm.path.toLowerCase(), 500]
    ])
    expect(rankProjects(all, '  ', recency).map((m) => m.project.name)).toEqual([
      'helm',
      'timeclick-reporting',
      'overtime',
      'timeclick',
      'TimeClick-Builder'
    ])
  })

  it('puts a name that starts with the query before one that contains it, and marks where', () => {
    const recency = new Map([[overtime.path.toLowerCase(), 900]])
    const ranked = rankProjects(all, 'Time', recency)
    expect(ranked.map((m) => [m.project.name, m.hit])).toEqual([
      ['timeclick', [0, 4]],
      ['TimeClick-Builder', [0, 4]],
      ['timeclick-reporting', [0, 4]],
      // Recency orders within a tier, never across one.
      ['overtime', [4, 8]]
    ])
  })

  it('falls back to the path, with either separator, and drops what matches nothing', () => {
    const ranked = rankProjects(all, 'repos/hel', new Map())
    expect(ranked.map((m) => [m.project.name, m.hit])).toEqual([['helm', null]])
    expect(rankProjects(all, 'nothing like it', new Map())).toEqual([])
  })
})

describe('profileFor', () => {
  const dev = profile({ name: 'dev', overlays: [HARNESS] })
  const timeclickProfile = profile({ name: 'Timeclick', root: repo('timeclick'), overlays: [HARNESS, repo('timeclick')] })
  const builderProfile = profile({ name: 'Timeclick Builder', overlays: [HARNESS, repo('timeclick'), repo('TimeClick-Builder')] })
  const cloud = profile({
    name: 'tc-cloud',
    overlays: [HARNESS, repo('timeclick'), repo('timeclick-ui'), repo('timeclick-reporting')]
  })
  const cash = profile({ name: 'CashApp', overlays: [HARNESS, `${HARNESS}\\tools\\cashflow`] })
  const profiles = [cloud, builderProfile, cash, dev, timeclickProfile]

  it('picks the profile composing the fewest folders among those about the folder', () => {
    expect(profileFor(HARNESS, profiles)?.name).toBe('dev')
    expect(profileFor(repo('timeclick'), profiles)?.name).toBe('Timeclick')
    expect(profileFor(repo('TimeClick-Builder'), profiles)?.name).toBe('Timeclick Builder')
    expect(profileFor(repo('timeclick-ui'), profiles)?.name).toBe('tc-cloud')
    // An overlay is enough: this profile runs at the harness root.
    expect(profileFor(`${HARNESS}\\TOOLS\\cashflow`, profiles)?.name).toBe('CashApp')
  })

  it('starts a folder no profile is about with none', () => {
    expect(profileFor(repo('helm'), profiles)).toBeNull()
    expect(profileFor(repo('helm'), [])).toBeNull()
  })

  it('breaks a tie with the profile rooted there, then the pinned order, then the name', () => {
    const at = repo('vibecast')
    const rooted = profile({ name: 'zeta', root: at, overlays: [HARNESS] })
    const overlaid = profile({ name: 'alpha', overlays: [at] })
    expect(profileFor(at, [overlaid, rooted])?.name).toBe('zeta')

    const second = profile({ name: 'a second', overlays: [HARNESS, at], pinnedOrder: 2 })
    const first = profile({ name: 'b first', overlays: [HARNESS, at], pinnedOrder: 1 })
    const unpinned = profile({ name: 'a unpinned', overlays: [HARNESS, at] })
    expect(profileFor(at, [unpinned, second, first])?.name).toBe('b first')
    expect(profileFor(at, [unpinned, profile({ name: 'B', overlays: [HARNESS, at] })])?.name).toBe('a unpinned')
  })
})

describe('homePath', () => {
  it('writes a path under the home directory from ~, and leaves anything else alone', () => {
    expect(homePath(repo('timeclick'), 'C:\\Users\\someone')).toBe('~\\.harness\\dev\\repos\\timeclick')
    expect(homePath('c:\\users\\SOMEONE\\x', 'C:\\Users\\someone\\')).toBe('~\\x')
    expect(homePath('C:\\Users\\someone', 'C:\\Users\\someone')).toBe('~')
    expect(homePath('C:\\Users\\someone-else\\x', 'C:\\Users\\someone')).toBe('C:\\Users\\someone-else\\x')
    expect(homePath('D:\\work', null)).toBe('D:\\work')
  })
})

describe('launchSentence', () => {
  const home = 'C:\\Users\\someone'

  it('names the program and the folder, and nothing else for a plain launch', () => {
    expect(read(launchSentence({ cwd: repo('helm'), home, profile: null, permissionMode: null, resume: null }))).toBe(
      'Runs `claude` in `~\\.harness\\dev\\repos\\helm`.'
    )
    expect(read(launchSentence({ cwd: repo('helm'), home, profile: null, permissionMode: 'plan', resume: null }))).toBe(
      'Runs `claude` in `~\\.harness\\dev\\repos\\helm` with `--permission-mode plan`.'
    )
  })

  it('names the profile, what it composes and grants, every flag, and the opening prompt', () => {
    const p = profile({
      name: 'Timeclick',
      overlays: [HARNESS, repo('timeclick'), repo('timeclick-ui')],
      access: [HARNESS, repo('timeclick'), repo('hawkeye')],
      model: 'opus',
      effort: 'xhigh',
      agent: 'reviewer',
      openingPrompt: ' /recap '
    })
    expect(read(launchSentence({ cwd: repo('timeclick'), home, profile: p, permissionMode: 'auto', resume: null }))).toBe(
      'Runs `claude` in `~\\.harness\\dev\\repos\\timeclick` with the Timeclick profile, composing `dev`, `timeclick` and `timeclick-ui`, with access to `hawkeye`, and `--model opus --effort xhigh --permission-mode auto --agent reviewer`. It opens by saying `/recap`.'
    )
  })

  it('says a conversation is being reopened, and drops the opening prompt a resume does not send', () => {
    const p = profile({ name: 'dev', overlays: [HARNESS], openingPrompt: '/recap' })
    expect(
      read(launchSentence({ cwd: repo('timeclick'), home, profile: p, permissionMode: null, resume: 'payroll export fix' }))
    ).toBe('Reopens “payroll export fix” with `claude --resume` in `~\\.harness\\dev\\repos\\timeclick` with the dev profile, composing `dev`.')
  })
})
