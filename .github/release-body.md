<!--
  The top of every GitHub release body. `.github/workflows/release.yml` strips
  this comment, substitutes ${VERSION} if it appears, and appends the commits
  since the previous tag under a "Changes" heading.

  Keep it to roughly what is here. A release page is a changelog: what Helm is,
  which artefact to take, what SmartScreen will say and what to install first
  all live in the README, one click away, where they are maintained once
  instead of restated at every tag. They were here until 0.2.3 and the page
  read as a second README with a changelog stapled underneath.

  This comment is HTML and does not render on the release page.
-->

A desktop shell for [Claude Code](https://claude.com/claude-code) - the real
`claude` TUI in tabs, with launch profiles, session history and a config editor
around it. Windows, x64.

Two files below, same application: **`setup.exe`** installs for your user with
no admin rights, **`portable.exe`** is one file that keeps its data beside
itself. The README covers [install notes, SmartScreen and first
run](../../blob/main/README.md#install).
