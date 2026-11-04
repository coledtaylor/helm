// A fake `wsl.exe` for tests: `node wsl.mjs <arguments>`.
//
// It never starts the real wsl.exe or touches a real distro. It plays:
//
// - `--list --quiet`: the distros FAKE_WSL_DISTROS names (comma-separated),
//   one per line. With none named it writes wsl.exe's own "no installed
//   distributions" text and fails, as wsl.exe does.
// - `--version`: wsl.exe's version text, WSL 3.0.3.0.
// - `-d <distro> -- <words>`: the words after `--` are the distro shell's
//   line, joined with spaces (a word with a blank in it is put back in
//   double quotes, as it was written on wsl.exe's command line), run "in the
//   distro", which is this computer, in the test's own folders, as the fake
//   ssh runs a line (`runLine` in common.mjs). A line of the form
//   `eval "$(echo <base64> | base64 -d)"` is decoded and the decoded line
//   run. The distro is Linux, so `uname -sm` answers FAKE_SSH_SYSTEM, or
//   `Linux x86_64`. A distro FAKE_WSL_DISTROS does not name fails with
//   wsl.exe's own words: `There is no distribution with the supplied name.`
//   then `Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND`.
//
// FAKE_WSL_NOT_INSTALLED plays a PC where WSL is not installed: every run
// writes wsl.exe's line saying so, with how to install it, and fails.
//
// What wsl.exe itself writes is UTF-16LE with no byte-order mark, as wsl.exe
// writes to a pipe, or UTF-8 when WSL_UTF8=1, as with the real one. The fake
// ssh does not carry WSL_UTF8 to the other computer, as a real ssh does not.
// Every run is recorded in FAKE_SSH_LOG with program `wsl`.

import { record, runLine } from './common.mjs'

const argv = process.argv.slice(2)
const distros = (process.env.FAKE_WSL_DISTROS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)

/** Writes `text` as wsl.exe does: UTF-8 with WSL_UTF8=1, UTF-16LE otherwise. */
function wslWrite(stream, text) {
  const crlf = text.replace(/\r?\n/g, '\r\n')
  stream.write(process.env.WSL_UTF8 === '1' ? Buffer.from(crlf, 'utf8') : Buffer.from(crlf, 'utf16le'))
}

function fail(text, code = 1) {
  wslWrite(process.stderr, text)
  process.exitCode = code
}

/**
 * The line a distro's shell would read from `words`, as written on wsl.exe's
 * command line. Where the line was written as is (this PC's wsl.exe on
 * Windows, or a line the fake ssh split as Windows' cmd would hand it on),
 * Node split it, so a word with a blank in it was in double quotes and is put
 * back in them. Where there is no wsl.exe (macOS and Linux, in tests only) the
 * line arrives as one argument, and is that argument.
 */
function lineOf(words) {
  if (words.length === 1) return words[0]
  return words.map((word) => (/[ \t]/.test(word) ? `"${word}"` : word)).join(' ')
}

/** `line`, or the line its `eval "$(echo <base64> | base64 -d)"` form holds. */
function decoded(line) {
  const wrapped = /^eval "\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d\)"$/.exec(line)
  return wrapped ? Buffer.from(wrapped[1], 'base64').toString('utf8') : line
}

const separator = argv.indexOf('--')
const before = separator === -1 ? argv : argv.slice(0, separator)
const at = before.indexOf('-d')
const distro = at === -1 ? null : (before[at + 1] ?? null)
const line = separator === -1 ? null : decoded(lineOf(argv.slice(separator + 1)))
record({ program: 'wsl', argv, distro, line })

if (process.env.FAKE_WSL_NOT_INSTALLED) {
  fail(
    "The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.\nFor more information please visit https://aka.ms/wslinstall\n"
  )
} else if (before.includes('--list') || before.includes('-l')) {
  if (distros.length === 0) {
    fail(
      "Windows Subsystem for Linux has no installed distributions.\nYou can resolve this by installing a distribution with the instructions below:\n\nUse 'wsl.exe --list --online' to list available distributions\nand 'wsl.exe --install <Distro>' to install.\n"
    )
  } else {
    wslWrite(process.stdout, distros.map((name) => `${name}\n`).join(''))
  }
} else if (before.includes('--version')) {
  wslWrite(
    process.stdout,
    'WSL version: 3.0.3.0\nKernel version: 6.6.87.2-1\nWSLg version: 1.0.66\nWindows version: 10.0.26100.1\n'
  )
} else if (distro === null || line === null) {
  fail('Invalid command line argument: ' + argv.join(' ') + "\nPlease use 'wsl.exe --help' to get a list of supported arguments.\n")
} else if (!distros.includes(distro)) {
  fail('There is no distribution with the supplied name.\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\n')
} else {
  process.env.FAKE_SSH_SYSTEM ||= 'Linux x86_64'
  runLine(line)
}
