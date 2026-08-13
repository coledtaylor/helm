# Packaging and updates

What `pnpm dist:win` produces, where its data goes, how a release is cut, and
why Helm has no auto-updater.

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

`src/main/paths.ts` decides, from one signal. electron-builder's portable
launcher extracts the app to `%TEMP%\<random>\` and sets
`PORTABLE_EXECUTABLE_DIR` to the directory the exe was double-clicked from. If
that variable is set, `userData` is redirected to `<exe dir>\helm-data\`;
otherwise it is `app.getPath('userData')`, which is `%APPDATA%\Helm`.

`process.execPath` in portable mode points at the temp extraction, so **never
derive an app path from execPath.** Use `PORTABLE_EXECUTABLE_DIR` or
`app.getPath('userData')`.

The check drivers use the same mechanism for isolation: they start the app with
`PORTABLE_EXECUTABLE_DIR` pointed at a directory of their own, so a check runs
against a real profile layout without touching the one somebody is using.
`pnpm dev` does too, at `%LOCALAPPDATA%\Helm\dev` - `productName` is `Helm`, so
an unpackaged run with no such directory resolves `userData` to `%APPDATA%\Helm`
and shares the installed app's database, shims and Chromium profile. That is
`pnpm dev:live`, which is the one mode that does it on purpose.

`appMode` therefore reads **two** signals, not one: `app.isPackaged` says build
or checkout, and `PORTABLE_EXECUTABLE_DIR` says whether the data is its own -
`installed`, `portable`, `dev`, `dev-live`.

## What the installer does, and what it deliberately does not

- **Per-user**, into `%LOCALAPPDATA%\Programs\Helm`. Nothing Helm does needs
  administrator rights, and an installer that asks for them cannot be run on a
  machine the user does not own. `allowElevation: false` is set explicitly, so a
  config change that *would* need elevation fails the install rather than
  quietly putting a UAC prompt in front of everyone.
- **Uninstall removes the program and leaves the data.**
  `deleteAppDataOnUninstall` stays false: `%APPDATA%\Helm\helm.db` holds the
  user's profiles, their session index and every config snapshot Helm has taken
  on their behalf, and uninstalling the program is not a request to destroy
  those. `pnpm packaging-check --only=package` asserts the install directory,
  the start-menu shortcut and the uninstall registry entry are gone and that the
  data directory is not.
- **No desktop shortcut.** A start-menu entry is enough.

## Releasing

**A release is a version bump merged to `main`.** Nothing else: no tag pushed by
hand, no button to press, no artefact built on a developer's machine.

`.github/workflows/release.yml` reads the version out of
`packages/desktop/package.json` and, if `v<version>` is not already a tag on the
remote, runs the checks, builds on a clean `windows-latest` runner and publishes
a GitHub release with both exes attached. A merge that does not bump the version
runs the checks, skips the release job and finishes green.

- **The gate is whether the tag exists**, asked with `git ls-remote --tags`, not
  whether the commit changed the version. Diffing against the parent gives a
  different answer after a squash, a rebase, a revert or a re-run.
- **`ci.yml` does not run on pushes to `main` on its own.** `release.yml` calls
  it through `workflow_call`, so `main` is checked once per push rather than
  twice. A failing `pnpm check` fails that job and `needs: [version, check]`
  skips the release: no tag, no release, no artefacts.
- **The release is created as a draft and published in the same job**, which is
  not an approval gate. `/releases/latest` ignores drafts, and publishing the
  draft is what creates the tag, so the ref and the ~200 MB of assets appear
  together rather than leaving a window where the app announces a version whose
  download page is empty. A run cancelled mid-upload leaves an unpublished
  draft; the next run deletes it and starts over.
- **Notes are `git log` subjects**, oldest first, merges excluded. GitHub's
  generated notes list merged pull requests, and this repository's history is
  branches merged locally, so the generated body would be a "Full Changelog"
  link and nothing else.
- **A release page is a changelog and nothing else.** Install notes, the
  SmartScreen warning and first run are the README's, one click away and
  maintained once rather than restated at every tag.
  `.github/release-body.md` is what gets prepended to the changes and is
  deliberately empty; it stays as a seam, so a release that genuinely needs a
  sentence at the top can have one without editing release logic.
- **Artefacts are verified before upload, from the inside.**
  `pnpm verify:artifact` unwraps the NSIS exe and the `app-64.7z` nested in it
  and asserts the win32-x64 `better-sqlite3` and `node-pty` binaries are present
  under `app.asar.unpacked`. What it guards against is an exe built with the
  wrong package-manager collector, which carries no `app.asar.unpacked` and dies
  on its first `dlopen`. Checking `dist-app/win-unpacked/` instead would check
  electron-builder's scratch directory rather than the file a person downloads.
  It runs on any exe: `pnpm verify:artifact -- path/to/Helm-x.y.z-setup.exe`.

## Updates: an explicit check, not an updater

`update:check` asks the GitHub releases API for the newest tag, compares it
against `app.getVersion()` and returns a URL. It downloads nothing and executes
nothing; upgrading is something the user does from the releases page.

It happens two ways and no others, and never on a timer. The app asks on its own
at launch, at most once a day (`UPDATE_CHECK_EVERY_MS`), when `updateCheck` is
on; and a person asks by pressing **Check now** in Settings → Updates, which
keeps no throttle of its own and works with `updateCheck` off. A deliberate act
that silently did nothing would be worse than no button, and the bound that
earns the app the right to ask by itself is the launch throttle - which a manual
check therefore does not stamp. Either way a newer release is reported beside
the version in the status bar. Offline is an expected answer, reported as "could
not ask", with the reason, rather than silently as "up to date".

There is deliberately no electron-updater. Three reasons, any one of which would
be enough:

1. **The build is unsigned.** electron-updater's NSIS path downloads a
   replacement installer and runs it. An unsigned replacement puts a SmartScreen
   prompt in front of *every* update, and an update mechanism whose happy path
   is a scary dialog teaches people to dismiss scary dialogs.
2. **It could only cover half the users.** The portable exe has no install
   location to replace, so electron-updater applies to the NSIS build alone.
3. **The app hosts long-lived sessions.** A background updater that restarts
   Helm ends somebody's `claude` session, possibly mid-turn.

Code-signing the build would retire reason 1. It would not touch 2 or 3.

## Network posture

The update check is **the only network connection Helm's own process opens**.
With `updateCheck` off, Helm opens none on its own initiative; the one remaining
route is a person pressing Check now, so nothing leaves the machine unasked for.

The pull-request pane reaches GitHub as well, but through the user's own `gh`
CLI: `gh pr list` per repository on a timer (`prPollMinutes`, five minutes by
default, `0` disables it), `gh pr view` when a pull request is opened, and `gh
pr checkout` when a review is configured to check one out. Bytes leave the
machine without `update:check` being involved.

Helm stores no GitHub credential. `gh` owns the token and every fetch runs on
it; nothing in Helm opens `hosts.yml`, the keyring or `GH_TOKEN`, and a sign-in
is read only from what `gh` reports on its own streams. A remote URL carrying an
embedded token is a credential too, so `parseGitHubRemote` strips the userinfo
before anything reaches the database. A machine with no `gh` gets a sentence
naming where to get one, and everything else in Helm works unchanged.

## The update check needs the repository to be public

`update.ts` sends `User-Agent` and `Accept` and nothing else - no token, because
Helm handles no credentials. GitHub answers an unauthenticated request for a
**private** repository's releases with `404`, so while the repository is private
the check reports *"could not ask"* however current the release actually is.

This is a coupling that breaks silently: **making the repository private turns
the update check off**, and nothing in the app says so beyond the error string.
The same fact is why release artefacts cannot be handed to anyone who is not a
collaborator - a private release page is not a download link.

## Install-testing it

```bash
pnpm packaging-check --only=package
```

Builds the artefacts if they are missing, then:

- copies the portable exe into a path with spaces, runs `--selftest` out of it
  as the ordinary user, and checks the data landed beside the exe and that
  `%APPDATA%\Helm` gained nothing;
- installs the NSIS package silently, runs `--selftest` out of the installed
  app, checks it reports `installed` mode with `%APPDATA%\Helm` as its data
  directory and that nothing landed beside the exe, then uninstalls and checks
  what is gone and what is kept.

The selftest itself (SPEC 8.2) is a SQLite WAL roundtrip, an interactive pwsh
through ConPTY, renderer-synthesized keystrokes, a resize verified inside the
shell, and the real `claude` TUI reaching its version banner. It spawns a real
session.

## License

MIT. `LICENSE` at the repository root.
