# Changelog

What each release changed **for somebody using Helm**. One section per version,
newest first, and `.github/workflows/release.yml` publishes the section matching
the version being released as the release body.

Not a commit log. The commits are one click away under "Full changelog" on every
release page, and they include the checks, the fixtures and the refactors - all
of which matter to whoever works on Helm and none of which a person downloading
an exe has any use for. Deriving this from `git log` was tried through 0.4.0 and
produced fifty-nine lines, most of them naming probe ids.

A version with no section here does not release: the workflow fails rather than
publishing an empty body, because the step a person can skip is the step that
gets skipped.

## 0.4.0

**Folders**

- Adding a folder adds *that* folder. It used to add every subdirectory inside
  it, so pointing Helm at one tool directory filled the launcher with its
  `src`, `tests` and `data` and nothing named after the folder you picked.
- A scanned folder can be removed again, from its own project pane. Nothing on
  disk is deleted - it leaves Helm, and adding it back brings it all with it.
- Removing a folder now closes its terminal. It used to keep running, with no
  tab in front of it, until you quit.

**Pull requests**

- The Open section is a triage surface. Filter by title, number, branch, author
  or repository; group by repository or author; and open pull requests split
  into ACTIVE and STALE so one busy repository stops burying everything else.
- Stale rows collapse to one-line chips that keep their state dot and check
  tally, so a pull request with red CI is still visible while it is quiet.
- The cutoff is yours: **Settings → GitHub → stale cutoff**, from one day to
  ninety, or off for the single flat list exactly as it was.

**Config console**

- Create, rename and delete files in a `.claude` tree. A new skill scaffolds its
  directory and frontmatter; a rename moves a skill's whole directory; a delete
  is snapshotted first and restorable from the file's own history.
- A file opens as the object it is rather than as a box of text: `settings.json`
  as a form over its real keys, markdown rendered with its frontmatter as chips,
  and a hook showing which event fires it and from which settings block.
- Rows say whether the thing is live - shadowed by another scope, namespaced
  under an overlay, or overridden downstream - so the list stops reading as a
  directory listing.
- Files bundled beside a `SKILL.md` nest under their skill instead of landing in
  `Other`.
- The console no longer opens `.credentials.json` at all.

**Content viewer**

- A harness opens on the curated view; a project opens on a real file tree, read
  lazily as you expand it and greying what `.gitignore` excludes rather than
  hiding it. Either mode works from either kind, and the header says which rule
  is in force.
- Roots are badged and counted, and an empty one stays listed rather than
  vanishing.
- Every file inside a root is listed. Source files open in a source view instead
  of being hidden, so the scripts an agent writes into `tools/` are readable.

**Everywhere**

- Code blocks were rendering at double height throughout the app. Fixed.
- Every hover, cursor and pressed state was audited across all 194 controls.
