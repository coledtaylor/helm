import type { RepoRemote } from './types'

/**
 * `git remote get-url origin` -> `owner/name`, or nothing.
 *
 * Nothing is the common answer and not a failure: most directories Helm scans
 * are not GitHub repositories, and a remote pointing at a company GitLab is a
 * perfectly good remote that this surface has no business fetching from. So a
 * non-match returns null rather than throwing, and the caller records "not
 * GitHub" against the repo and moves on.
 *
 * The forms are git's, not a URL library's. `git@github.com:owner/repo.git` is
 * scp syntax, which `new URL` reads as the scheme `git@github.com:` - so it is
 * rewritten into a URL first, and everything after that is one parse rather
 * than five regular expressions that each have to agree about `.git`.
 */

/** github.com and its `www.` alias, and nothing else. */
const HOSTS = new Set(['github.com', 'www.github.com'])

/**
 * What GitHub allows in the two segments.
 *
 * Checked rather than assumed, because the slug is interpolated into a `gh
 * --repo` argument: a segment carrying a slash or a space would either be a
 * different repository or a second argument. `gh` is spawned without a shell,
 * so this is not a quoting question - it is about not silently fetching
 * something other than what the remote named.
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const NAME = /^[A-Za-z0-9._-]+$/

/**
 * scp-like syntax, which is what `git clone git@github.com:o/r.git` leaves in
 * the config. Anchored on a host that contains no slash, so a Windows path
 * (`C:\repos\x`) cannot be mistaken for one.
 */
const SCP = /^(?:([^@/\\:]+)@)?([^/\\:]+):(?!\/)(.+)$/

export function parseGitHubRemote(remote: string): RepoRemote | null {
  const url = remote.trim()
  if (url === '') return null

  let parsed: URL
  try {
    const scp = SCP.exec(url)
    parsed = new URL(scp === null ? url : `ssh://${scp[2] ?? ''}/${scp[3] ?? ''}`)
  } catch {
    return null
  }

  // `git://` and `ssh://` are as legitimate here as `https://`; anything else -
  // `file:`, and whatever a hand-edited config might hold - is not a remote
  // this surface can fetch from.
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null
  // `parsed.hostname` rather than `host`, so a port does not defeat the check,
  // and lower-cased because a host name is case-insensitive and a scanned
  // config can carry any spelling. An exact set, not a suffix test: a suffix
  // test matches `github.com.example.net`.
  if (!HOSTS.has(parsed.hostname.toLowerCase())) return null

  const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
  if (segments.length !== 2) return null

  const owner = segments[0] ?? ''
  // Only a trailing `.git` is dropped. A repository may legitimately be called
  // `foo.github` or `.github`, and stripping the extension anywhere would
  // rename it.
  const name = (segments[1] ?? '').replace(/\.git$/, '')
  if (!OWNER.test(owner) || !NAME.test(name)) return null

  return { url: withoutCredentials(url, parsed), owner, name, slug: `${owner}/${name}` }
}

/**
 * The remote URL with any embedded credential taken out of it.
 *
 * `https://<token>@github.com/o/r` is a working remote and a stored secret, and
 * this URL is written to the database and shown in a tooltip. Helm holds no
 * GitHub credential, which has to mean it does not keep one it found lying in a
 * git config either. The `git@` of scp syntax is an ssh user rather than a
 * secret and is left alone - it never reaches `parsed` in the first place.
 */
function withoutCredentials(url: string, parsed: URL): string {
  if (parsed.username === '' && parsed.password === '') return url
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/]*@/, '$1')
}
