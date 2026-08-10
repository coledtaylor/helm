# Packaging and updates

What `pnpm dist:win` produces, why the config looks the way it does, and why
Helm has no auto-updater. Spike B ([SPIKE-B.md](SPIKE-B.md)) established the
build; M7 install-tested it, which Spike B never did.

## Artefacts

`pnpm dist:win` writes two files to `packages/desktop/dist-app/`:

| File | What it is |
|---|---|
| `Helm-<version>-portable.exe` | One file, ~95 MB. No install. Keeps its data in `helm-data\` beside itself. |
| `Helm-<version>-setup.exe` | NSIS one-click installer. Per-user, no elevation. Data in `%APPDATA%\Helm`. |

Both come out of the same build. Nothing is compiled: `npmRebuild: false` and
both native modules ship N-API prebuilds, so a clean checkout needs no compiler,
no Python and no build tools.

## Where the data goes

`src/main/paths.ts` decides, and it decides from one signal. electron-builder's
portable launcher extracts the app to `%TEMP%\<random>\` and sets
`PORTABLE_EXECUTABLE_DIR` to the directory the exe was double-clicked from. If
that variable is set, `userData` is redirected to `<exe dir>\helm-data\`;
otherwise it is `app.getPath('userData')`, which is `%APPDATA%\Helm`.

`process.execPath` in portable mode points at the temp extraction, so **never
derive an app path from execPath.** Use `PORTABLE_EXECUTABLE_DIR` or
`app.getPath('userData')`.

That same mechanism is what `pnpm m7-check`'s first-run phase uses for
isolation: it starts a second app with `PORTABLE_EXECUTABLE_DIR` pointed at a
temporary directory, so a genuinely empty profile exists without touching the
real one.

## What the installer does, and what it deliberately does not

- **Per-user.** `%LOCALAPPDATA%\Programs\Helm`. Nothing Helm does needs
  administrator rights, and an installer that asks for them cannot be run on a
  machine the user does not own. `allowElevation: false` is set explicitly so a
  future config change that *would* need elevation fails the install rather than
  quietly putting a UAC prompt in front of everyone.
- **Uninstall removes the program and leaves the data.**
  `deleteAppDataOnUninstall` stays false. `%APPDATA%\Helm\helm.db` holds the
  user's profiles, their session index and every config snapshot Helm has taken
  on their behalf before writing to a `.claude` tree. Uninstalling the program
  is not a request to destroy those. `pnpm m7-check --only=package` asserts the
  install directory, the start-menu shortcut and the uninstall registry entry
  are gone and that the data directory is not.
- **No desktop shortcut.** A start-menu entry is enough.

## Updates: an explicit check, not an updater

**Decision: no electron-updater. A user-initiated check that reads a version
number and hands over a link.** Three reasons, and any one of them would be
enough:

1. **The build is unsigned.** electron-updater's NSIS path downloads a
   replacement installer and runs it. An unsigned replacement puts a SmartScreen
   prompt in front of *every* update. An update mechanism whose happy path is a
   scary dialog is worse than none - people learn to dismiss it, and that is the
   habit you least want to teach.
2. **It could only cover half the users.** The portable exe has no install
   location to replace, so electron-updater applies to the NSIS build alone.
   Shipping an update path that silently does not exist for the artefact
   somebody actually downloaded is worse than shipping one path that works the
   same way for both.
3. **The app hosts long-lived sessions.** A background updater that restarts
   Helm is a background updater that ends somebody's `claude` session, possibly
   mid-turn. Nothing here is worth that.

So `update:check` asks the GitHub releases API for the newest tag, compares it
to `app.getVersion()`, and returns a URL. It downloads nothing and executes
nothing. It is **the only outbound request the app makes**, and it is made only
when the channel is invoked - never on a timer, at startup, or in the
background. Offline is an expected answer, reported as "could not ask" rather
than silently as "up to date".

Revisit if the build ever gets code-signed: reason 1 disappears, 2 and 3 do not.

## Install-testing it

```bash
pnpm m7-check --only=package
```

Builds the artefacts if they are missing, then:

- copies the portable exe into a path with spaces, runs `--selftest` out of it
  as the ordinary user, and checks the data landed beside the exe and that
  `%APPDATA%\Helm` gained nothing;
- installs the NSIS package silently, runs `--selftest` out of the installed
  app, checks it reports `installed` mode with `%APPDATA%\Helm` as its data
  directory and that nothing landed beside the exe, then uninstalls and checks
  what is gone and what is kept.

The selftest is Spike B's: a SQLite WAL roundtrip, an interactive pwsh through
ConPTY, renderer-synthesized keystrokes, a resize verified inside the shell, and
the real `claude` TUI reaching its version banner. It spawns a real session.

## License

MIT. `LICENSE` at the repository root; `package.json` said MIT before there was
a file to back it up, and now there is one.
