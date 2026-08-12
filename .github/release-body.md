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
-->
