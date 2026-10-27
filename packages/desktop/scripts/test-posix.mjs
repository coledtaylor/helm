// `pnpm test:posix`: the tests of the code that differs between Windows, macOS
// and Linux, run where that code is the POSIX one.
//
// On macOS and Linux they run natively, in this checkout. On Windows they run
// under Linux in WSL: the working tree is mirrored into a Linux-side folder
// (node_modules, .git and build output left out), installed there when the
// lockfile has changed since the last install, and the tests run in that copy.
// The copy has to be Linux-side: a tree on /mnt/c has no POSIX permissions or
// symlinks to test, and its node_modules hold Windows native modules.
//
//   pnpm test:posix                       the default set below
//   pnpm test:posix <file> [<file> ...]   these test files instead
//
// WSL needs Node 22 or later (on PATH, or under ~/.local/node) and rsync. pnpm
// is the version package.json pins, run through npx when it is not installed.

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * The default set, repository-relative: processes and ports, overlay links,
 * ending a process tree, and data directories.
 */
export const POSIX_TESTS = [
  'packages/desktop/src/main/processes.test.ts',
  'packages/desktop/src/main/resources.test.ts',
  'packages/core/src/launch/overlay.test.ts',
  'packages/desktop/src/main/treekill.test.ts',
  'packages/desktop/src/main/plugins/exec.test.ts',
  'packages/desktop/src/main/plugins/service.test.ts',
  'packages/desktop/src/main/sessions.shutdown.test.ts',
  'packages/desktop/src/main/datadirs.test.ts'
]

/** Where the tests run on this OS, and which files. */
export function posixTestPlan(platform, args) {
  const files = args.length > 0 ? args.map((file) => file.replaceAll('\\', '/')) : POSIX_TESTS
  return { where: platform === 'win32' ? 'wsl' : 'native', files }
}

/**
 * The Linux-side folder a checkout is mirrored into, under ~/.cache/helm-posix:
 * one per checkout, so two worktrees never overwrite each other's copy.
 */
export function mirrorName(root) {
  const id = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 8)
  return `${win32.basename(root).replace(/[^A-Za-z0-9._-]/g, '_')}-${id}`
}

/** The pnpm version package.json pins (`packageManager`). */
export function pinnedPnpm(packageJson) {
  const match = /^pnpm@(\d+\.\d+\.\d+)/.exec(packageJson.packageManager ?? '')
  if (!match) throw new Error('package.json does not pin pnpm in packageManager')
  return match[1]
}

// Run by bash in WSL, from a file. $1 is the checkout's Windows path, $2
// the mirror's name, $3 the pinned pnpm, and the rest the test files.
export const WSL_SCRIPT = String.raw`set -euo pipefail
src_win=$1 mirror=$2 pnpm_version=$3
shift 3
# WSL appends the Windows PATH; a node.exe or pnpm.cmd from there would run the
# tests on Windows again.
PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd: -)
if [ -x "$HOME/.local/node/bin/node" ]; then PATH="$HOME/.local/node/bin:$PATH"; fi
export PATH
if ! command -v node >/dev/null; then
  echo 'test:posix: WSL has no Node. Install Node 22 or later there, on PATH or under ~/.local/node.' >&2
  exit 2
fi
if ! command -v rsync >/dev/null; then
  echo 'test:posix: WSL has no rsync. Install it there (apt install rsync).' >&2
  exit 2
fi
src=$(wslpath -a "$src_win")
dest="$HOME/.cache/helm-posix/$mirror"
mkdir -p "$dest"
echo "test:posix: mirroring $src into $dest"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude /reports --exclude /.posix-lock-hash \
  --exclude /packages/desktop/out --exclude /packages/desktop/dist --exclude /packages/desktop/release \
  "$src/" "$dest/"
cd "$dest"
lock=$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$(cat .posix-lock-hash 2>/dev/null || true)" != "$lock" ]; then
  echo 'test:posix: the lockfile changed since the last install; installing'
  run_pnpm() {
    if command -v pnpm >/dev/null && [ "$(pnpm -v)" = "$pnpm_version" ]; then
      pnpm "$@"
    else
      npx --yes "pnpm@$pnpm_version" "$@"
    fi
  }
  # The tests never start Electron, so its binary is not downloaded.
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 run_pnpm install --frozen-lockfile
  printf '%s' "$lock" > .posix-lock-hash
fi
echo "test:posix: running under $(uname -sr), Node $(node -v)"
exec node node_modules/vitest/vitest.mjs run "$@"
`

function run(command, args, options) {
  return new Promise((resolveRun) => {
    const { relay = false, ...spawnOptions } = options
    const child = spawn(command, args, spawnOptions)
    if (relay) {
      child.stdout.pipe(process.stdout)
      child.stderr.pipe(process.stderr)
    }
    child.on('error', (error) => {
      console.error(`test:posix: could not run ${command}: ${error.message}`)
      resolveRun(2)
    })
    child.on('exit', (code, signal) => resolveRun(code ?? (signal ? 1 : 0)))
  })
}

async function main() {
  const plan = posixTestPlan(process.platform, process.argv.slice(2))
  if (plan.where === 'native') {
    const vitest = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')
    return run(process.execPath, [vitest, 'run', ...plan.files], { cwd: REPO_ROOT, stdio: 'inherit' })
  }
  if (!existsSync(join(REPO_ROOT, 'pnpm-lock.yaml'))) {
    console.error(`test:posix: no pnpm-lock.yaml in ${REPO_ROOT}`)
    return 2
  }
  const pnpm = pinnedPnpm(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')))
  // The script goes to WSL as a file, WSL gets no stdin, and its output is
  // relayed rather than inherited: handed a stdin pipe, even an ended one, or
  // this process's own stdout when that is a pipe, wsl.exe was seen to end the
  // run with exit 139.
  const dir = mkdtempSync(join(tmpdir(), 'helm-test-posix-'))
  try {
    const script = join(dir, 'run.sh')
    writeFileSync(script, WSL_SCRIPT.replaceAll('\r\n', '\n'))
    let wslScript
    try {
      wslScript = execFileSync('wsl.exe', ['-e', 'wslpath', '-a', script.replaceAll('\\', '/')], {
        encoding: 'utf8',
        windowsHide: true
      }).trim()
    } catch (error) {
      console.error(`test:posix: WSL did not answer (${error.message.split('\n')[0]}). Install WSL with Ubuntu.`)
      return 2
    }
    const root = REPO_ROOT.replaceAll('\\', '/')
    return await run('wsl.exe', ['-e', 'bash', '-l', wslScript, root, mirrorName(REPO_ROOT), pnpm, ...plan.files], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      relay: true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
