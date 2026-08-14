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

## 0.3.0

**Projects**

- The project pane is the project's hub: links straight into Config and Content
  scoped to it, and the repository's own open pull requests listed on it.
- Pin the projects you actually open, above the harnesses.
- The project shell gets a third of the page and can be dragged, rather than
  that height being its ceiling.

**Sessions**

- Tabs say which session they are, and you can give one a better name.
- **Transcript archive.** Claude Code reaps its own transcripts on a schedule -
  on one machine, 91% of conversations were already gone. Helm now reads them
  before they are deleted and can render an archived one.

**Pull requests**

- The conversation shows the comments people leave on lines of the diff, not
  only the root-level ones.
- Ask Helm whether a newer release exists, and see what the answer was.

**Fixes**

- **Every hover state in the app was dead**, and had been for a while. Fixed.
  Every clickable control now takes the pointer and answers it.
- The tab strip has its scrollbar back.
- Dragging the session split no longer re-renders everything behind it, and
  resizing no longer pays for every row in the history.
- PowerShell is resolved properly instead of hoped for on `PATH`.
- Wikilinks render as the links people wrote them as.

## 0.2.3

- A dropped connection is no longer reported as a signed-out machine.

## 0.2.2

- Helm tells you when a newer release exists. Asking was previously
  unreachable.

## 0.2.1

- The project shell opened the wrong project's shell, and in split view there
  was none at all.
- PowerShell 7 installed from the Microsoft Store was invisible to Helm, so the
  shell started with no profile.
- A usage reading that is merely old now shows as a floor rather than showing
  nothing.

## 0.2.0

**Look**

- The Nocturne Islands design system across the whole app: split-view sessions,
  a project shell terminal, and a themed title bar.

**Settings**

- A settings pane behind the gear in the title bar, with six terminal settings
  that apply live to every open pane.
- Settings are validated on the way in; reads stay tolerant of rows written by
  another build.

**Pull requests**

- A Pull requests pane, sweeping the repositories Helm discovered for anything
  open, with a GitHub group in Settings.
- Open a pull request in a tab of its own, see its patch in a Files view, and
  review it with Claude from the tab it is open in.
- Ignore a repository and its pull requests stop being fetched at all.

## 0.1.0

First release.

- **Embedded terminal.** Claude Code runs in tabs, hosted rather than
  reimplemented.
- **Profiles and overlay composition** - the feature the whole app was a bet on.
- **Session launcher** - every session on the machine, with the resumable ones
  marked.
- **Config console** - any `.claude` tree as a real interface, and what a
  session would actually see.
- **Content viewer** - the vault, rendered, searchable and editable in place.
- **Usage in the status bar**, as a percentage of plan limits or as dated
  dollar estimates.
- First run locates `claude`, chooses roots and scaffolds a harness.
