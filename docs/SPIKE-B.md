# Spike B: Portable Packaging with Native Modules - VERDICT: GO

Ran 2026-08-08 on Windows 11, Electron 43.3.0 (Node 24.18.1, ABI 148),
electron-builder 26.15.3. ClickUp task: 868knyagj.

Both native modules survive portable packaging. The packaged portable exe passed
every check when run from `Downloads\Helm Test With Spaces\` (path with spaces,
no admin, no installer): SQLite WAL read/write, interactive pwsh in xterm.js via
ConPTY (including input synthesized as real renderer key events), pty+xterm
resize reflected inside the shell, and the real `claude` 2.1.225 TUI rendering
to its input prompt.

## The surprise: no ABI rebuild exists in this config

The assumed risk was "native addons must be rebuilt against Electron's ABI".
That is no longer true for either module:

- **better-sqlite3 13.0.3** has `gypfile: false`, no install script, and ships
  N-API prebuilds at `prebuilds/<platform>-<arch>.node`. Loads unchanged in
  Electron.
- **node-pty 1.1.0** ships N-API prebuilds at `prebuilds/win32-x64/` including
  its own ConPTY backend (`conpty.node`, `conpty/conpty.dll`,
  `conpty/OpenConsole.exe`) and winpty fallback (`winpty-agent.exe`,
  `winpty.dll`). Its binary loader checks `build/Release`, `build/Debug`, then
  `prebuilds/`.

Consequently `electron-builder.yml` sets **`npmRebuild: false`**. This is not
just an optimization - running `@electron/rebuild` actively **breaks** the
build: it tries to compile node-pty from source and dies on the winpty
`GetCommitHash.bat` gyp bug (`'GetCommitHash.bat' is not recognized...`). Do
not add `electron-builder install-app-deps` or `postinstall` rebuilds back.

**Version note:** node-pty 1.0.0 (previous `latest`) has no prebuilds and
cannot be compiled by node-gyp on this machine at all. 1.1.0 is the floor.

## asar / asarUnpack

```yaml
asarUnpack:
  - '**/node_modules/better-sqlite3/**'
  - '**/node_modules/node-pty/**'
```

Both modules must be unpacked: `process.dlopen` cannot load `.node` files from
inside the asar archive, and node-pty's helper *executables* (OpenConsole.exe,
winpty-agent.exe) must exist as real files to be spawned. electron-builder
signs the unpacked helper exes automatically.

## Portable mode data location

The portable launcher extracts the app to `%TEMP%\<random>\` and sets
`PORTABLE_EXECUTABLE_DIR` to the directory containing the exe. `src/main/index.ts`
detects that env var and redirects `userData` to `<exe dir>\helm-data\` -
verified: `helm.db` (WAL), screenshots, and the selftest report all landed
beside the exe; nothing was written to `%APPDATA%`.

`process.execPath` in portable mode points at the temp extraction, so **never
derive app paths from execPath** - use `PORTABLE_EXECUTABLE_DIR` (portable) or
`app.getPath('userData')` (installed).

## Selftest harness

`Helm.exe --selftest` runs the whole proof unattended and exits 0/1: SQLite
roundtrip, pwsh marker echo, renderer-synthesized keystrokes, resize
verification (`[Console]::WindowWidth` inside the shell after
`pty.resize(120,30)`), then launches `claude`, auto-dismisses startup gates
(folder trust, MCP enablement) and waits for the version banner. Evidence goes
to `helm-data/spike-report.json` + `helm-data/screenshots/*.png`.

Two lessons encoded there for future TUI automation:

1. Claude's TUI interleaves cursor/style sequences *inside words* and positions
   text without emitting spaces - match against an ANSI-stripped buffer with
   `\s*`-tolerant regexes (`/Claude\s*Code\s*v\d/`).
2. Startup can present interactive gates (trust prompt, MCP server enablement)
   before the input prompt; a host must expect arbitrary dialogs, not a fixed
   startup sequence.

## Builds

- `npm run dist:win` → `dist-app/Helm-0.0.1-portable.exe` (~95 MB) and
  `Helm-0.0.1-setup.exe` (NSIS one-click, per-user, no elevation).
- Reproducible from clean checkout: `npm ci && npm run dist:win` - no build
  tools, Python, or compiler needed (nothing compiles).

## Implications for Helm

- M7 (portable packaging) is de-risked; this config is the seed.
- Keep node-pty pinned >=1.1.0 and better-sqlite3 >=13; revisit `npmRebuild`
  only if a future dependency lacks N-API prebuilds.
- Spike C (TUI fidelity) already has partial evidence: claude renders its TUI
  correctly in xterm.js from the packaged exe, and resize propagates. Spike C
  still owes mouse, paste, Ctrl-C, scrollback, and 24-bit color depth checks.
