// A `gh` that answers from a directory of fixtures and writes down every
// question it was asked.
//
// `pnpm pr-check` needs a GitHub whose answers it wrote itself. Not because
// the real one is unavailable - the live phase uses it - but because the
// things this milestone has to prove are things a real repository cannot be
// made to do on demand: a pull request whose title changes between two passes,
// an authentication that fails, a payload that is not JSON, and a `pr checkout`
// whose invocation can be read back argument by argument.
//
// It is reached the way a real one would be: through a `.cmd` shim, because
// scoop and npm both install gh as a batch file on Windows and
// `resolveGhCommand` has a branch for exactly that. The driver aims the pulls
// service at the shim with `pointGh`, which is a method on the service and
// deliberately not a channel on the IPC contract - which binary the pull
// requests come from is not the window's to choose.
//
// Everything it does is real except the network. `pr checkout` really runs
// `git`, in the directory it was invoked from, and moves the tree - so the
// branch the driver reads back afterwards is one git reports rather than one
// this script claimed.
//
//   $HELM_FAKE_GH_HOME/
//     behaviour.json   what to do this time; re-read per invocation
//     list/<owner>__<name>.json          `gh pr list --json ...` output
//     view/<owner>__<name>__<n>.json     `gh pr view <n> --json ...` output
//     invocations.jsonl                  every call: argv, cwd, exit code

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.HELM_FAKE_GH_HOME ?? ''
const args = process.argv.slice(2)

if (home === '') {
  writeSync(2, 'fake-gh: HELM_FAKE_GH_HOME is not set\n')
  process.exit(90)
}

/** Re-read per invocation, so the driver can change the answer between passes. */
function behaviour() {
  const file = join(home, 'behaviour.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

const slugFile = (dir, slug, suffix = '') =>
  join(home, dir, `${slug.replace('/', '__')}${suffix}.json`)

/** What was asked, before what was answered - a call that crashes still logged. */
function log(entry) {
  appendFileSync(
    join(home, 'invocations.jsonl'),
    `${JSON.stringify({ at: Date.now(), argv: args, cwd: process.cwd(), ...entry })}\n`
  )
}

function out(text, code = 0) {
  // `writeSync` rather than `console.log`: stdout to a pipe is asynchronous on
  // Windows, and `process.exit` immediately after a `console.log` truncates it.
  if (text !== '') writeSync(1, text)
  log({ exit: code, bytes: text.length })
  process.exit(code)
}

function fail(text, code = 1) {
  writeSync(2, text.endsWith('\n') ? text : `${text}\n`)
  log({ exit: code, stderr: text.trim() })
  process.exit(code)
}

/** `--repo owner/name` out of an argv, wherever gh put it. */
function flag(name) {
  const at = args.indexOf(name)
  return at >= 0 ? (args[at + 1] ?? '') : ''
}

const how = behaviour()

if (args[0] === '--version') {
  out(`${how.version ?? 'gh version 2.86.0 (fixture)'}\nhttps://github.com/cli/cli\n`)
}

if (args[0] === 'auth' && args[1] === 'status') {
  // The one signal Helm is allowed to read about a GitHub sign-in is this exit
  // code. Nothing here writes a token and nothing in Helm reads one.
  if (how.auth === 'unauthenticated') {
    fail('You are not logged into any GitHub hosts. To log in, run: gh auth login')
  }
  out('github.com\n  - Logged in to github.com account fixture (keyring)\n')
}

if (args[0] === 'pr' && args[1] === 'list') {
  const slug = flag('--repo')
  if (how.list === 'error') fail(how.listError ?? 'HTTP 503: the fixture is unwell')
  if (how.list === 'invalid-json') out('<!DOCTYPE html>\n<html>a login page, not JSON</html>\n')

  const file = slugFile('list', slug)
  if (!existsSync(file)) {
    fail(`could not resolve to a Repository with the name '${slug}'`)
  }
  out(readFileSync(file, 'utf8'))
}

if (args[0] === 'pr' && args[1] === 'view') {
  const slug = flag('--repo')
  const number = args[2] ?? ''
  if (how.view === 'error') fail(how.viewError ?? 'HTTP 503: the fixture is unwell')

  const file = slugFile('view', slug, `__${number}`)
  if (!existsSync(file)) fail(`no pull requests found for ${slug}#${number}`)
  out(readFileSync(file, 'utf8'))
}

if (args[0] === 'pr' && args[1] === 'checkout') {
  const slug = flag('--repo')
  const number = args[2] ?? ''
  if (how.checkout === 'error') fail(how.checkoutError ?? 'failed to run git: exit status 128')

  // The branch comes out of the same list fixture the pane was painted from,
  // so the name the driver expects and the name the tree ends up on have one
  // source rather than two.
  const file = slugFile('list', slug)
  if (!existsSync(file)) fail(`could not resolve to a Repository with the name '${slug}'`)
  const pulls = JSON.parse(readFileSync(file, 'utf8'))
  const pull = pulls.find((entry) => String(entry.number) === String(number))
  if (pull === undefined) fail(`no pull request found for ${slug}#${number}`)

  // `-B` rather than `-b`: a second checkout of the same pull request is the
  // normal case in a driver, and gh's own behaviour there is to end up on the
  // branch either way.
  const git = spawnSync('git', ['checkout', '-B', pull.headRefName], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true
  })
  if (git.status !== 0) {
    fail(`failed to run git: ${(git.stderr ?? '').trim() || String(git.error ?? 'unknown')}`, 1)
  }
  out(`Switched to branch '${pull.headRefName}'\n`)
}

fail(`unknown command\n\nUsage: gh <command> <subcommand> [flags]\n`, 2)
