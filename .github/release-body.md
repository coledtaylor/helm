<!--
  The top of every GitHub release body. `.github/workflows/release.yml` reads
  this file, substitutes ${VERSION}, and appends the commits since the previous
  tag under a "Changes" heading.

  It is a separate file rather than a heredoc in the workflow so that editing
  the prose a stranger reads is not editing release logic. This comment is HTML
  and does not render on the release page.

  The build is unsigned by decision (docs/PACKAGING.md), so this page is the
  only place a first-time downloader is told that the SmartScreen warning is
  expected. If that decision changes, the SmartScreen section goes.
-->

**Helm** is a desktop shell for [Claude Code](https://claude.com/claude-code): it hosts the real `claude` terminal UI in tabs, with launch profiles, session history and a config editor around it. Windows only.

## Which file do I want?

| File | |
|---|---|
| **`Helm-${VERSION}-setup.exe`** | The installer, and the one to take unless you have a reason not to. Installs for you alone under `%LOCALAPPDATA%` - no administrator rights, no UAC prompt - and adds a Start-menu entry. Your data lives in `%APPDATA%\Helm` and **survives uninstalling**. |
| **`Helm-${VERSION}-portable.exe`** | One file, no install. Keeps its data in a `helm-data\` folder beside itself, so it runs from a USB stick and leaves nothing behind on the machine. |

Same application either way, and about 100 MB either way.

## "Windows protected your PC"

Expect that dialog. These builds are **not code-signed**, so SmartScreen has no publisher to check and warns about every download. To continue: **More info** -> **Run anyway**.

That warning is doing its job, and you should not wave it away for software you have no reason to trust. If you would rather check rather than trust: the source is this repository, and both files above were built from the tagged commit by GitHub Actions - the workflow is [`.github/workflows/release.yml`](../../blob/main/.github/workflows/release.yml), and its run is linked from the commit.

## Before you start

Helm drives the `claude` CLI, it does not replace it. Install [Claude Code](https://claude.com/claude-code) and sign in first. Helm never asks for, stores or reads your credentials - it only notices whether you have already signed in, and tells you to run `claude` if you have not.

## Updating

Helm has no auto-updater, on purpose ([why](../../blob/main/docs/PACKAGING.md#updates-an-explicit-check-not-an-updater)) - nothing runs in the background, and nothing replaces itself while you have a session open. To get a newer version, come back to this page and download it. Watching this repository for releases is the way to be told about one.
