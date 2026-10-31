# Packaging and updates

What `pnpm dist:win` and `pnpm dist:mac` produce, where their data goes, how a
release is cut, and why Helm has no auto-updater.

## Artefacts

`pnpm dist:win` writes two files to `packages/desktop/dist-app/`:

| File | What it is |
|---|---|
| `Helm-<version>-portable.exe` | One file, ~95 MB. No install. Keeps its data in `helm-data\` beside itself. |
| `Helm-<version>-setup.exe` | NSIS one-click installer. Per-user, no elevation. Data in `%APPDATA%\Helm`. |

`pnpm dist:mac` writes two more, and runs only on macOS, because
electron-builder makes a dmg only there:

| File | What it is |
|---|---|
| `Helm-<version>-arm64.dmg` | Disk image: Helm.app beside an Applications link to drag it onto. Apple Silicon only. |
| `Helm-<version>-arm64-mac.zip` | The same Helm.app, zipped, for anyone who would rather not mount an image. |

Every build comes out of the same code. No node module is compiled:
`npmRebuild: false` and the native modules ship N-API prebuilds for each
platform, so a clean checkout needs no C compiler, no Python and no build tools.
The one thing compiled is the `floti` host, which runs sessions when "Run
sessions in the local host" is on: both commands first run
`scripts/stage-floti.mjs`, which builds it in release with the Rust toolchain
`rust-toolchain.toml` names and copies it to `packages/desktop/dist-host/`.
electron-builder carries it beside the app, at `resources\floti.exe` on Windows
and `Contents/Resources/floti` on macOS, where the app looks for it.

Beside `floti` goes the Node runtime the local host runs plugin services on.
`scripts/node-runtime.json` pins its version (a Node 24 LTS release) and, for
win32-x64, darwin-arm64 and linux-x64, the archive from nodejs.org and its
SHA-256 from that release's `SHASUMS256.txt`. `stage-floti.mjs` downloads the
archive into `<cargo target>/node-runtime/`, or reuses one already there, and
checks its SHA-256 before extracting anything: a mismatch, or a platform the
pin file does not list, fails the build. It then extracts only Node's binary
and `LICENSE`, with the system tar (Windows' own `tar.exe`, which reads zip),
into a fresh folder there, and stages them as `dist-host/node/`. The app
carries them at `resources\node\node.exe` on Windows and
`Contents/Resources/node/bin/node` on macOS, each with Node's `LICENSE` beside
it. Node is fetched at build time only; the app never downloads it. To move to
a newer Node, change the version, archive names and checksums in the pin file
together.

### The Mac build is ad-hoc signed

Apple Silicon runs no arm64 binary without a code signature, and Helm has no
Apple Developer ID to sign with, so `identity: '-'` in `electron-builder.yml`
signs it ad-hoc: a valid signature with no certificate behind it. A copy
downloaded in a browser is quarantined, so macOS refuses it the first time it
is opened; **System Settings > Privacy & Security > Open Anyway** opens it, once.
A copy built on the machine itself carries no quarantine and just opens.
Developer ID signing and notarization would remove that step and wait on an
Apple Developer account.

`hardenedRuntime` is off with it. The hardened runtime is only for notarization,
and with an ad-hoc signature it turns on library validation, which refuses to
load the native modules. `darkModeSupport` is on, or the app is pinned to the
light appearance and the `system` theme never follows macOS into dark mode.

node-pty starts every pty on macOS through `spawn-helper`, an executable in its
macOS prebuilds, and publishes it without the execute bit; without one every
terminal fails with `posix_spawnp failed`. `scripts/spawn-helper.mjs` sets the
bit in two places: as `@helm/desktop`'s postinstall, for a checkout on a Mac,
and from electron-builder's `afterPack` hook (`scripts/after-pack.mjs`) on the
copy under `app.asar.unpacked`. `afterPack` runs before signing, so the
signature covers the file as changed. Neither rebuilds anything, and both do
nothing on Windows and Linux.

The icon is `build/icon.icns`, packed by `pnpm icon` from the same drawing as
the .ico and committed beside it. Its large sizes sit on Apple's icon grid (the
artwork in the middle 824px of 1024) so the wheel stands the size of the icons
around it in the Dock.

`pnpm verify:mac-artifact` opens the dmg and the zip a person downloads and
checks the Helm.app in each: an arm64 executable, a signature that verifies and
is ad-hoc, `CFBundleIconFile` naming a file identical to `build/icon.icns`, no
`NSRequiresAquaSystemAppearance`, and better-sqlite3, node-pty (with an
executable `spawn-helper`) and koffi unpacked beside the asar. It needs macOS;
`--icon` checks only the .icns, anywhere.

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

**Harness templates take the same branch.** `templatesDir` reads the same
variable: set, they live in `<exe dir>\helm-data\templates`, so **a portable
install keeps its templates on the stick and leaves nothing on a machine it is
plugged into**; unset, they live in `~/.config/helm/templates` rather than under
`%APPDATA%`, because a template is a directory somebody authors by hand and
likely keeps in git. One rule, four run modes, and no second override
mechanism - `pnpm dev` and every check get a templates directory of their own
for free, because both already set that variable for the database.

The shipped `README.md` and example template are written on a start that finds
the directory **absent**, and nothing there is ever overwritten. Helm records no
hashes of what it seeded, so it cannot distinguish an edited file from an
untouched one; deleting the directory is what puts the originals back.

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
  those. `pnpm verify:installer --yes` asserts the install directory,
  the start-menu shortcut and the uninstall registry entry are gone and that the
  data directory is not.
- **No desktop shortcut.** A start-menu entry is enough.

## Releasing

**A release is a version bump merged to `main`.** Nothing else: no tag pushed by
hand, no button to press, no artefact built on a developer's machine.

`.github/workflows/release.yml` reads the version out of
`packages/desktop/package.json` and, if `v<version>` is not already a tag on the
remote, runs the checks, builds the Windows artefacts on a clean
`windows-latest` runner and the macOS ones on `macos-latest`, and publishes one
GitHub release with all four attached. A merge that does not bump the version
runs the checks, skips both build jobs and finishes green.

- **The Mac build is its own job and publishes nothing.** `release-mac` has the
  same gate as `release`, builds with `pnpm dist:mac`, runs
  `verify-mac-artifact.mjs` over the dmg and the zip, and hands them on as a
  workflow artifact. `release` needs it, downloads them and attaches them with
  the two exes. A failed Mac build therefore skips the release outright: a
  version is never published with half its downloads. Every runner is a
  standard GitHub-hosted one, and no secret or certificate is involved.

- **The gate is whether the tag exists**, asked with `git ls-remote --tags`, not
  whether the commit changed the version. Diffing against the parent gives a
  different answer after a squash, a rebase, a revert or a re-run.
- **`ci.yml` does not run on pushes to `main` on its own.** `release.yml` calls
  it through `workflow_call`, so `main` is checked once per push rather than
  twice. It runs `pnpm check` (typecheck, lint, unit and integration tests)
  and then builds, on Windows, macOS and Linux runners, each its own job; the
  end-to-end tests run locally only. All three jobs are required: a failure on
  any one fails `check`, and `needs: [version, check]` skips the release and
  the SDK publish: no tag, no release, no artefacts.
- **The release is created as a draft and published in the same job**, which is
  not an approval gate. `/releases/latest` ignores drafts, and publishing the
  draft is what creates the tag, so the ref and all four assets appear
  together rather than leaving a window where the app announces a version whose
  download page is empty. A run cancelled mid-upload leaves an unpublished
  draft; the next run deletes it and starts over.
- **Notes are the `## <version>` section of [CHANGELOG.md](../CHANGELOG.md)**,
  and **a release with no section for its version fails rather than
  publishing.** No tag is created when that job fails, so the remedy is to write
  the section and push again. GitHub's generated notes list merged pull
  requests, and this repository's history is branches merged locally, so the
  generated body would be a "Full Changelog" link and nothing else.
- **Why it is written rather than derived.** Through 0.4.0 the notes were
  `git log` subjects, on the argument that they are already one-line statements
  of what landed. They are - of what landed in the *repository*. 0.4.0 produced
  fifty-nine lines, most of them naming a probe id, a fixture or a refactor, and
  three identical lines from one cherry-pick onto three branches. Filtering by
  path removes some and cannot remove the rest: the same file is touched for a
  reason somebody using Helm sees and for a reason they never will, and only the
  person who wrote the commit knows which. The changelog is for them; the
  commits are one click away under "Full changelog".
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
  The Mac artefacts get `verify-mac-artifact.mjs`, described above.
- **The confirmation expects all four files.** After publishing, the job asks
  `/releases/latest` - the endpoint the in-app check asks - and fails unless it
  names this tag, is not a draft, and lists exactly the setup exe, the portable
  exe, the dmg and the zip.

## Looking at the Mac build

Nobody working on Helm has a Mac in front of them, so the
**macOS build and screenshots** workflow
(`.github/workflows/macos-screenshots.yml`) builds and photographs it on
`macos-latest`. It runs on a push to any branch but `main` that changes how the
Mac build is made or photographed - `electron-builder.yml`, `build/`,
`packages/desktop/package.json`, `verify-mac-artifact.mjs`, the `afterPack`
hook and the spawn-helper script it shares with the postinstall, the screenshot run,
the E2E launch and world it uses, or the workflow itself - so a branch shows
its dmg and zip build before it merges rather than at release time. It can
also be started by hand from the Actions tab, or with
`gh workflow run macos-screenshots.yml --ref <branch>` once the file is on
`main`.

It runs `pnpm dist:mac` and `verify-mac-artifact.mjs` over the dmg and the zip
exactly as `release-mac` does, then launches the built app through the E2E
tests' Playwright launch into a world with the fake claude, and photographs
every destination on the rail and a session terminal in the light and the dark
theme. The pictures are the run's `helm-macos-screenshots` artifact: each view
as the page and, on macOS, as the window with its traffic lights. It is no
check in the gate and nothing waits on it. `pnpm screenshots` runs the same
capture locally on any OS, into `reports/screenshots`.

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

**Helm contacts nothing on its own initiative except the update check.
Everything else on the network happens because you asked for it: the browser
pane fetches the page you navigate to, and a plugin you added reaches the hosts
its manifest names.**

There is no telemetry, no crash reporting, no fonts and no CDN. With
`updateCheck` off, Helm asks nothing by itself at all; the one remaining route
is a person pressing Check now, so nothing leaves the machine unasked for.

**Inbound is one listener and it is loopback.** A Claude session Helm hosts can
drive the browser pane, and can ask what the other Claude Code sessions on this
machine are doing; both sets of tools arrive over one MCP endpoint bound to
`127.0.0.1` on a port chosen per app run - two named servers on two routes, one
socket. It is the only socket Helm has ever accepted a connection on. Nothing
off this machine can reach it; every request carries a bearer token minted for
one session and revoked when that session ends; and each set has its own setting
(`browserMcp`, `sessionMcp`) that removes it from every launch, with no port
bound at all when both are off. Worth knowing for a packaged build in
particular: an installer that a firewall prompt follows is a bad first
impression, and a loopback bind produces no prompt on Windows.

**Plugins reach the hosts their manifests name.** A plugin page has no network
of its own (`connect-src 'none'`); `helm.fetch` sends its requests from the
main process, only to an origin the manifest lists, following redirects one
hop at a time so that every hop is checked against the same list. A plugin's
background page may fetch on its own schedule, which is the plugin's doing
rather than Helm's - the user added it - and is why the sentence above says
so. A plugin never holds a secret: it writes `{{key}}`, and main fills in a
value the user typed into Settings > Secrets, only for a host and a plugin the
user allowed. The store is `safeStorage` (DPAPI, bound to the signed-in user),
and with encryption unavailable it refuses to store anything rather than fall
back to plaintext. The programs (`exec`) and the service a plugin declares are
ordinary processes with the user's rights, and their network is not confined;
Settings > Plugins names them per plugin, and turning the plugin off ends
them. A service listens on `127.0.0.1` on a port Helm gives it and is reached
with a token minted for the run - a listener of the plugin's, not Helm's, so
the inbound paragraph above still describes the app.

## The update check needs the repository to be public

`update.ts` sends `User-Agent` and `Accept` and nothing else - no token, because
Helm handles no GitHub credential. GitHub answers an unauthenticated request for a
**private** repository's releases with `404`, so while the repository is private
the check reports *"could not ask"* however current the release actually is.

This is a coupling that breaks silently: **making the repository private turns
the update check off**, and nothing in the app says so beyond the error string.
The same fact is why release artefacts cannot be handed to anyone who is not a
collaborator - a private release page is not a download link.

## Install-testing it

A check and a tool, and the split is the point: one is safe to run on the
machine you work on, and one is not. The unsafe one is not a group of any suite
and no `--only=` reaches it.

```bash
pnpm packaging-check --only=package   # the artefacts and the portable exe
pnpm verify:installer --yes           # installs and UNINSTALLS Helm here
```

`package` is in the default `pnpm packaging-check`. It builds the artefacts if
they are missing, checks the two native modules are unpacked beside the asar,
then copies the portable exe into a path with spaces, runs `--selftest` out of
it as the ordinary user, and checks the data landed beside the exe and that
`%APPDATA%\Helm` gained nothing. (That last read is dropped, and says so in the
report, when an installed Helm is running - it writes to `%APPDATA%\Helm` too,
so the comparison would be about two processes.)

**`installer` is opt-in and is the only destructive thing in this repository.**
It installs the NSIS package silently, runs `--selftest` out of the installed
app, checks it reports `installed` mode with `%APPDATA%\Helm` as its data
directory and that nothing landed beside the exe, then uninstalls and checks
what is gone and what is kept - and **puts nothing back**. It cannot be
isolated into its own data directory, because it is *about* where an installer
puts things.

It refuses outright if Helm is running from the install directory
(`--replace-running` overrides that, which is what a release machine says on
purpose). Helm hosts Claude Code sessions, so terminating it is not like
terminating an editor with everything saved - it ends the work inside them, and
it has done exactly that once, from a sweep of "every check".

So it is not part of the release gate, and neither is `packaging-check`: both
run only when the owner asks for them, a release that **changes packaging** -
electron-builder, `electron-builder.yml`, the native modules, `dist-win.mjs`, or
anything about where files land - included, and this one only on a machine
where nobody is working. The default run prints a `PKG-2` line recording that it did not,
so a green run is never mistaken for one that covered the installer, and CI
runs `verify-artifact.mjs` over both exes on every publish regardless.

The selftest itself (SPEC 8.2) is a SQLite WAL roundtrip, an interactive pwsh
through ConPTY, renderer-synthesized keystrokes, a resize verified inside the
shell, and the real `claude` TUI reaching its version banner. It spawns a real
session.

## License

MIT. `LICENSE` at the repository root.
