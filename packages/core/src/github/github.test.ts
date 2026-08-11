import { describe, expect, it } from 'vitest'
import { parseGhAuth, parseGhVersion, parsePullList, PR_LIST_FIELDS } from './parse'
import { parseGitHubRemote } from './remote'

describe('parseGitHubRemote', () => {
  const accepted: Array<{ remote: string; why: string }> = [
    { remote: 'https://github.com/coledtaylor/helm.git', why: 'https clone URL' },
    { remote: 'https://github.com/coledtaylor/helm', why: 'https without the extension' },
    { remote: 'http://github.com/coledtaylor/helm.git', why: 'http, which git still allows' },
    { remote: 'https://www.github.com/coledtaylor/helm', why: 'the www alias' },
    { remote: 'https://GitHub.com/coledtaylor/helm', why: 'a host is case-insensitive' },
    { remote: 'https://github.com/coledtaylor/helm.git/', why: 'a trailing slash' },
    { remote: 'git@github.com:coledtaylor/helm.git', why: 'scp syntax, what git clone leaves' },
    { remote: 'git@github.com:coledtaylor/helm', why: 'scp syntax without the extension' },
    { remote: 'ssh://git@github.com/coledtaylor/helm.git', why: 'a full ssh URL' },
    { remote: 'ssh://git@github.com:22/coledtaylor/helm.git', why: 'ssh with an explicit port' },
    { remote: 'git://github.com/coledtaylor/helm.git', why: 'the git protocol' },
    { remote: '  https://github.com/coledtaylor/helm.git  ', why: 'surrounding whitespace' }
  ]

  for (const { remote, why } of accepted) {
    it(`reads ${remote.trim()} (${why})`, () => {
      expect(parseGitHubRemote(remote)).toMatchObject({
        owner: 'coledtaylor',
        name: 'helm',
        slug: 'coledtaylor/helm'
      })
    })
  }

  const rejected: Array<{ remote: string; why: string }> = [
    { remote: '', why: 'no remote at all' },
    { remote: '   ', why: 'whitespace' },
    { remote: 'https://gitlab.com/coledtaylor/helm.git', why: 'a different forge' },
    { remote: 'https://bitbucket.org/coledtaylor/helm.git', why: 'a different forge' },
    { remote: 'git@gitlab.com:coledtaylor/helm.git', why: 'a different forge over ssh' },
    { remote: 'https://github.example.com/o/r.git', why: 'GitHub Enterprise is not github.com' },
    { remote: 'https://github.com.example.net/o/r', why: 'a host that merely starts with it' },
    { remote: 'https://mygithub.com/o/r', why: 'a host that merely ends with it' },
    { remote: 'https://github.com/coledtaylor', why: 'an owner with no repository' },
    { remote: 'https://github.com/', why: 'no path' },
    { remote: 'https://github.com/o/r/tree/main', why: 'a page, not a remote' },
    { remote: 'file:///C:/repos/helm', why: 'a local clone source' },
    { remote: 'C:\\repos\\helm', why: 'a Windows path' },
    { remote: '\\\\server\\share\\helm', why: 'a UNC path' },
    { remote: '../sibling', why: 'a relative path' },
    { remote: 'https://github.com/o wner/repo', why: 'a space in the owner' },
    { remote: 'https://github.com/-owner/repo', why: 'an owner GitHub would not issue' }
  ]

  for (const { remote, why } of rejected) {
    it(`rejects ${JSON.stringify(remote)} (${why})`, () => {
      expect(parseGitHubRemote(remote)).toBeNull()
    })
  }

  it('keeps a repository whose name legitimately ends in something else', () => {
    expect(parseGitHubRemote('https://github.com/acme/.github')).toMatchObject({ name: '.github' })
    expect(parseGitHubRemote('https://github.com/acme/dot.github.git')).toMatchObject({
      name: 'dot.github'
    })
  })

  it('reports the remote it was given, so a row can show where it came from', () => {
    expect(parseGitHubRemote('git@github.com:acme/web.git')?.url).toBe('git@github.com:acme/web.git')
  })

  it('does not keep a credential embedded in the remote', () => {
    const parsed = parseGitHubRemote('https://ghp_secrettokenvalue@github.com/acme/web.git')

    expect(parsed?.slug).toBe('acme/web')
    expect(parsed?.url).toBe('https://github.com/acme/web.git')
    expect(parsed?.url).not.toContain('ghp_')
  })
})

// ---------------------------------------------------------------------------

/** One entry shaped exactly as gh 2.86.0 prints it, verified against a live PR. */
const LIVE_ENTRY = {
  additions: 304,
  author: { id: 'MDQ6VXNlcjQ3Mzk0MjAw', is_bot: false, login: 'BagToad', name: 'Kynan Ware' },
  baseRefName: 'trunk',
  changedFiles: 86,
  createdAt: '2026-08-10T23:12:16Z',
  deletions: 254,
  headRefName: 'bagtoad/probable-funicular',
  isDraft: false,
  labels: [],
  number: 14128,
  reviewDecision: 'REVIEW_REQUIRED',
  state: 'OPEN',
  title: "Isolate tests from the local machine's configuration",
  updatedAt: '2026-08-10T23:53:03Z',
  url: 'https://github.com/cli/cli/pull/14128'
}

describe('parsePullList', () => {
  it('asks for every field the list view paints', () => {
    // The list is what the fetch actually sends, so a field the pane reads and
    // the request does not ask for would arrive undefined at runtime only.
    for (const field of [
      'number',
      'title',
      'url',
      'author',
      'state',
      'isDraft',
      'headRefName',
      'baseRefName',
      'createdAt',
      'updatedAt',
      'additions',
      'deletions',
      'changedFiles',
      'reviewDecision',
      'labels'
    ]) {
      expect(PR_LIST_FIELDS.split(',')).toContain(field)
    }
  })

  it('reads an entry in the shape gh actually prints', () => {
    const [pull] = parsePullList(JSON.stringify([LIVE_ENTRY]))

    expect(pull).toEqual({
      number: 14128,
      title: "Isolate tests from the local machine's configuration",
      url: 'https://github.com/cli/cli/pull/14128',
      author: 'BagToad',
      authorIsBot: false,
      state: 'OPEN',
      isDraft: false,
      headRefName: 'bagtoad/probable-funicular',
      baseRefName: 'trunk',
      createdAt: Date.parse('2026-08-10T23:12:16Z'),
      updatedAt: Date.parse('2026-08-10T23:53:03Z'),
      additions: 304,
      deletions: 254,
      changedFiles: 86,
      reviewDecision: 'REVIEW_REQUIRED',
      labels: []
    })
  })

  it('takes label names and leaves GitHub’s colours behind', () => {
    const [pull] = parsePullList(
      JSON.stringify([
        {
          ...LIVE_ENTRY,
          labels: [
            { id: 'LA_1', name: 'dependencies', description: '', color: '0366d6' },
            { id: 'LA_2', name: 'go', description: '', color: '16e2e2' }
          ]
        }
      ])
    )

    expect(pull?.labels).toEqual(['dependencies', 'go'])
  })

  it('recognises a bot from the flag and from the login prefix', () => {
    const pulls = parsePullList(
      JSON.stringify([
        { ...LIVE_ENTRY, number: 1, author: { is_bot: true, login: 'app/dependabot' } },
        { ...LIVE_ENTRY, number: 2, author: { login: 'app/renovate' } },
        { ...LIVE_ENTRY, number: 3, author: { is_bot: false, login: 'coledtaylor' } }
      ])
    )

    expect(pulls.map((p) => p.authorIsBot)).toEqual([true, true, false])
  })

  it('treats an absent review requirement as no decision rather than a chip', () => {
    const pulls = parsePullList(
      JSON.stringify([
        { ...LIVE_ENTRY, number: 1, reviewDecision: '' },
        { ...LIVE_ENTRY, number: 2, reviewDecision: 'APPROVED' },
        { ...LIVE_ENTRY, number: 3, reviewDecision: 'SOMETHING_NEW' }
      ])
    )

    expect(pulls.map((p) => p.reviewDecision)).toEqual([null, 'APPROVED', null])
  })

  it('orders by most recent activity, whatever order gh printed', () => {
    const pulls = parsePullList(
      JSON.stringify([
        { ...LIVE_ENTRY, number: 1, updatedAt: '2026-08-01T00:00:00Z' },
        { ...LIVE_ENTRY, number: 2, updatedAt: '2026-08-09T00:00:00Z' },
        { ...LIVE_ENTRY, number: 3, updatedAt: '2026-08-05T00:00:00Z' }
      ])
    )

    expect(pulls.map((p) => p.number)).toEqual([2, 3, 1])
  })

  it('keeps a row whose timestamp it cannot read, with no age rather than a wrong one', () => {
    const [pull] = parsePullList(JSON.stringify([{ ...LIVE_ENTRY, updatedAt: 'whenever' }]))

    expect(pull?.number).toBe(14128)
    expect(pull?.updatedAt).toBeNull()
  })

  it('fills a missing field rather than losing the pull request', () => {
    const [pull] = parsePullList(JSON.stringify([{ number: 7 }]))

    expect(pull).toMatchObject({
      number: 7,
      title: '',
      author: '',
      additions: 0,
      labels: [],
      reviewDecision: null
    })
  })

  it('drops an entry with no number, which is the one field that identifies it', () => {
    expect(parsePullList(JSON.stringify([{ title: 'nameless' }, LIVE_ENTRY]))).toHaveLength(1)
    expect(parsePullList(JSON.stringify([null, 'string', 42]))).toEqual([])
  })

  it('reads an empty list and an empty answer as no pull requests', () => {
    expect(parsePullList('[]')).toEqual([])
    expect(parsePullList('   ')).toEqual([])
  })

  it('refuses a payload that is not a list, rather than showing it as empty', () => {
    // A repository with no PRs and a gh that printed a diagnostic must not look
    // the same on screen.
    expect(() => parsePullList('gh: could not resolve to a Repository')).toThrow(/not JSON/)
    expect(() => parsePullList('{"message":"Not Found"}')).toThrow(/an object/)
    expect(() => parsePullList('null')).toThrow(/null/)
  })
})

describe('parseGhAuth', () => {
  it('reads a sign-in from the exit code alone', () => {
    expect(parseGhAuth({ exitCode: 0, stdout: '', stderr: '' })).toEqual({
      authenticated: true,
      message: null
    })
  })

  it('reads a non-zero exit as not signed in, whichever stream gh used', () => {
    const onStderr = parseGhAuth({
      exitCode: 1,
      stdout: '',
      stderr: '  \nYou are not logged into any GitHub hosts.\n'
    })
    const onStdout = parseGhAuth({
      exitCode: 1,
      stdout: 'You are not logged into any GitHub hosts.',
      stderr: ''
    })

    expect(onStderr).toEqual({
      authenticated: false,
      message: 'You are not logged into any GitHub hosts.'
    })
    expect(onStdout).toEqual(onStderr)
  })

  it('reports "not signed in" for a gh that could not be run at all', () => {
    expect(parseGhAuth({ exitCode: null, stdout: '', stderr: '' })).toEqual({
      authenticated: false,
      message: null
    })
  })
})

describe('parseGhVersion', () => {
  it('takes the first line, which is the one with the number on it', () => {
    expect(parseGhVersion('gh version 2.86.0 (2026-01-21)\nhttps://github.com/cli/cli\n')).toBe(
      'gh version 2.86.0 (2026-01-21)'
    )
  })

  it('reports nothing for nothing', () => {
    expect(parseGhVersion('')).toBeNull()
    expect(parseGhVersion('\n\n')).toBeNull()
  })
})
