<!--
  The top of every GitHub release body. `.github/workflows/release.yml` strips
  this comment, substitutes ${VERSION} if it appears, and appends the commits
  since the previous tag under a "Changes" heading.

  It is deliberately empty. A release page is a changelog and nothing else -
  the reader is already on the repository, and what Helm is, which artefact to
  take, what SmartScreen will say and what to install first are all in the
  README one click away, maintained once instead of restated at every tag.
  Through 0.2.3 they were restated here and the page read as a second README
  with a changelog stapled underneath.

  So the file stays, empty, rather than the workflow losing the seam: a release
  that genuinely needs a sentence at the top - a migration note, a breaking
  change - can have one by editing this file instead of editing release logic.
  Take it back out afterwards.

  This comment is HTML and does not render on the release page.

  0.3.0 is using the seam, for the transcript archive: it is the first release
  where Helm keeps a copy of anything Claude Code wrote. That is worth a
  sentence on the page rather than a line in the changelog. Take the note back
  out after this release.
-->

**Upgrading from 0.2.x:** this release adds the transcript archive. Claude Code
writes a transcript per session and reaps it on its own schedule, so most
conversations are gone within days; Helm now copies them into its own database
before that happens and can show an archived one. The first launch after
upgrading does one pass over the transcripts already on disk, in the background
— on the machine this was built on that was 228 conversations, and the stored
copy came to 1.4 MB. It is read-only: nothing under `~/.claude` is written or
deleted, and storage is capped at 1 GB with the oldest evicted whole.

Two schema migrations run automatically on first launch.
