// A fake `ssh` for tests: `node ssh.mjs [-o <option>]... <target> <line>...`.
//
// It takes ssh's argv as Floti passes it, records it, and runs the line (the
// words after the target, joined with spaces, as ssh sends them) "on the
// other computer", which is this one, in the test's own folders, carrying
// standard input and output unchanged (`runLine` in common.mjs). It never
// touches ~/.ssh or reaches a network.
//
// FAKE_SSH_FAIL plays one of ssh's failures instead, with ssh's own message
// on standard error and its exit status, 255:
//
// - `denied`: `<target>: Permission denied (publickey,password).`
// - `unresolved`: `ssh: Could not resolve hostname <host>: Name or service not known`
// - `timeout`: `ssh: connect to host <host> port 22: Connection timed out`
// - `password`: a host that wants a password. With `-o BatchMode=yes` ssh
//   asks nobody and fails as `denied` does; without it, it writes the prompt
//   `<target>'s password: ` and waits for an answer on standard input, as a
//   real ssh does on its terminal, failing once standard input closes.

import { record, runLine } from './common.mjs'

const argv = process.argv.slice(2)
const options = []
let at = 0
while (at < argv.length && argv[at].startsWith('-')) {
  const flag = argv[at]
  if (flag === '-o' && at + 1 < argv.length) {
    options.push(argv[at + 1])
    at += 2
  } else if (flag.startsWith('-o') && flag.length > 2) {
    options.push(flag.slice(2))
    at += 1
  } else {
    process.stderr.write(`ssh: illegal option -- ${flag.replace(/^-+/, '')}\n`)
    process.exit(255)
  }
}
const target = argv[at]
const line = argv.slice(at + 1).join(' ')
record({ program: 'ssh', argv, options, target: target ?? null, line })

if (target === undefined) {
  process.stderr.write('usage: ssh [-o option] destination [command [argument ...]]\n')
  process.exit(255)
}

const host = target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target
const batch = options.some((option) => /^batchmode[= ]yes$/i.test(option.trim()))

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(255)
}

switch (process.env.FAKE_SSH_FAIL) {
  case 'denied':
    fail(`${target}: Permission denied (publickey,password).`)
    break
  case 'unresolved':
    fail(`ssh: Could not resolve hostname ${host}: Name or service not known`)
    break
  case 'timeout':
    fail(`ssh: connect to host ${host} port 22: Connection timed out`)
    break
  case 'password':
    if (batch) fail(`${target}: Permission denied (publickey,password).`)
    process.stderr.write(`${target}'s password: `)
    process.stdin.resume()
    process.stdin.on('end', () => fail(`${target}: Permission denied (publickey,password).`))
    break
  default:
    runLine(line)
}
