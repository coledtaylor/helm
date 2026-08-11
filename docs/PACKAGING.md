# Packaging and updates

What `pnpm dist:win` produces, why the config looks the way it does, how a
release gets cut, and why Helm has no auto-updater. Spike B
([SPIKE-B.md](SPIKE-B.md)) established the build; M7 install-tested it, which
Spike B never did; the release workflow removed the developer's machine from
the process on 2026-08-10.

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

## Releasing

**A release is a version bump merged to `main`.** Nothing else - no tag pushed
by hand, no button, no artefact built on somebody's laptop.
`.github/workflows/release.yml` reads the version out of
`packages/desktop/package.json`, and if that tag does not exist yet it runs the
checks, builds on a clean `windows-latest` runner, and publishes a GitHub
release with both exes attached.

Before this existed, a release was a person running `pnpm dist:win` and
uploading two files. That is the step most likely to be skipped, done from a
dirty tree, or done from a machine whose toolchain is subtly wrong - which had
already happened once: a stale standalone `pnpm.exe` shadowed the managed one
and silently produced an exe with no `app.asar.unpacked`, dead on its first
`dlopen`.

Decisions behind the shape of it, taken on 2026-08-10:

- **The trigger is a push to `main`, gated on the version.** Releasing on every
  merge would burn a release on a typo fix in a doc and make two merges in a row
  collide on one tag. A manual dispatch would put back the step a person can
  skip. So the trigger stays automatic and *bumping the version is the explicit
  act of cutting a release.*
- **The gate asks whether the tag exists, not whether the commit changed the
  version.** Diffing against the parent gives a different answer after a squash,
  a rebase, a revert or a re-run. `git ls-remote --tags origin v1.2.3` gives the
  same answer every time, and it is the question that actually matters. A merge
  that does not bump the version therefore runs the checks, skips the release
  job, and finishes green.
- **`ci.yml` no longer runs on pushes to `main`.** `Release` calls it through
  `workflow_call`, so `main` is still checked on every push - once, rather than
  twice. Windows minutes bill at 2x on a private repository and two identical
  eight-minute runs of the same commit buy nothing. A failing `pnpm check`
  fails that job, and `needs: [version, check]` skips the release: no tag, no
  release, no artefacts.
- **The release is created as a draft and then published, in the same job.**
  This is *not* a human approval gate - `/releases/latest` ignores drafts, so a
  release waiting on somebody to press publish is a release the in-app check
  cannot see. Publishing a draft is what creates the tag, so the ref and the
  ~200 MB of assets appear together. Creating the release outright and uploading
  after would leave a window where the app announces an update whose download
  page is still empty. A run cancelled mid-upload leaves an unpublished draft
  and no tag; the next run deletes it and starts over.
- **Notes come from `git log`, not GitHub's `generate_release_notes`.** The
  generated notes list *merged pull requests*, and this repository's history is
  branches merged locally - the generated body would be a "Full Changelog" link
  and nothing else. The commit subjects here are already written as one-line
  statements of what landed, which is what a changelog entry is. The prose above
  the changes - what Helm is, which file to take, what SmartScreen will say -
  lives in `.github/release-body.md` so that editing what a stranger reads is
  not editing release logic.
- **The artefacts are verified before they are uploaded, from the inside.**
  `pnpm verify:artifact` unwraps the NSIS exe and the `app-64.7z` nested in it
  and asserts the win32-x64 `better-sqlite3` and `node-pty` binaries are present
  under `app.asar.unpacked`. Checking `dist-app/win-unpacked/` would check
  electron-builder's scratch directory rather than the file a person downloads.
  Run it on any exe: `pnpm verify:artifact -- path/to/Helm-x.y.z-setup.exe`.

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
nothing. It is **the only *direct* network request the app makes**, and it is
made only when the channel is invoked - never on a timer, at startup, or in the
background. Offline is an expected answer, reported as "could not ask" rather
than silently as "up to date".

Revisit if the build ever gets code-signed: reason 1 disappears, 2 and 3 do not.

### What "direct" is doing in that sentence

The word was added when the pull-request surface landed, and it was added rather
than deleting the claim because the claim is still true and the qualification is
the honest part.

That surface reaches GitHub as well, and it does it by **shelling out to the
user's own `gh` CLI** - `gh pr list` per repository on a schedule the user sets
(`prPollMinutes`, five minutes by default, `0` to turn it off), plus a `gh pr
view` when a pull request is opened and a `gh pr checkout` if a review is
configured to check one out. So bytes leave the machine without anybody invoking
`update:check`, and a build that said otherwise would be lying about its network
posture.

Amended once more after 0.2.1: that one connection is no longer made only by
hand. Helm asks on launch, at most once a day, and says so beside the version in
the status bar when the answer is a newer release; `updateCheck` in Settings
turns it off. The reason the manual rule went is that it was not working - the
main-process half shipped without a UI half, so nothing ever invoked the channel
and the app had no way to tell anyone a release existed. None of the three
reasons above is weakened by the change, because all three are about replacing
the installed app and Helm still does not: no artefact is fetched, nothing is
unpacked, nothing restarts. The user goes to the releases page themselves.

What has not changed is the part that matters for packaging and for trust. Helm
opens no socket of its own for any of it: the only outbound connection Helm's
own process makes is still this one. And Helm **stores no GitHub credential** -
`gh` owns the token, every fetch runs on it, and a sign-in is detected only from
the exit code of `gh auth status`. Nothing in the app opens `hosts.yml`, the
keyring, or `GH_TOKEN`; a remote URL carrying an embedded token is a credential
too, and `parseGitHubRemote` strips the userinfo before anything reaches the
database. A machine with no `gh` gets a sentence naming where to get one, and
everything else in Helm works exactly as before.

### The check needs the repository to be public

`update.ts` sends `User-Agent` and `Accept` and nothing else - no token, by
design, because Helm handles no credentials. GitHub answers an unauthenticated
request for a **private** repository's releases with `404`, so while
`coledtaylor/helm` is private the check reports *"could not ask"* however
correct the release is. Measured on 2026-08-10: the release workflow's own
`/releases/latest` assertion passes, because a workflow's token is always
authenticated, and the same URL called without one returns
`{"message":"Not Found"}`.

This is a coupling that is easy to break silently later: **making the
repository private again turns the update check off**, and nothing in the app
will say so beyond the error string. The same fact is why release artefacts
cannot be handed to anyone who is not a collaborator - a private release page
is not a download link.

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
