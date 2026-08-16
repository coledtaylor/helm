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

## 0.5.0

**Session history**

- A session is called what it was about. Rows were titled with the opening
  prompt, and an opening prompt is often `/exit`, `/usage` or an image you
  pasted - 291 of this machine's 1,011 sessions opened on a bare command. The
  title now reads past those to the first thing you actually said.
- You can name a session yourself, by double-clicking its title, and the name
  you give it is searchable alongside everything said in it. It survives the
  history being rebuilt from scratch.
- An archived conversation reads as a conversation: your messages and Claude's
  in bubbles down opposite sides, tool runs kept out of the way, timestamps
  under the message they belong to. It used to be a table.

**Content viewer**

- A code file is read inside the pane. It used to grow to the length of the
  file, which put the sideways scrollbar at the bottom of the *file* - you had
  to scroll through a minified payload to reach the bar that would move it
  sideways - and clipped the last line mid-glyph. It now scrolls in both
  directions inside its own well, with both bars at the edge of the pane.
- Source files can wrap, per file, from a toggle in the document header. A
  wrapped line hangs from its own indentation rather than from the margin, so
  a deeply nested line's continuation does not read as a new shallow one. Off
  by default, and both the default and the hang are under
  **Settings → Content**.
- A source file stays where you scrolled it. It used to snap back to the top a
  few seconds later, wrap on or off.

**Profiles**

- **Agent** is a picker over the agents that root and the projects composed
  into it would actually resolve - including the ones an overlay contributes,
  which arrive under a prefix you could not have guessed. It says what it does:
  it becomes `--agent` on the session's command line.
- **MCP servers** is a picker over the servers configured for that root, with
  the scope each comes from. It also says plainly what it does *not* do - the
  selection is saved with the profile and travels with its export, but it is
  not applied at launch, and the config console is where a session's servers
  are configured. Both fields used to be text boxes that said none of this.
- A saved agent or server the root no longer resolves is marked **unresolved**
  by name and kept. A profile written before the project that supplies its
  agent exists is a reasonable thing to have.
- The profile dialog no longer scrolls sideways on a shorter screen, which had
  been cutting the Compose and Access columns off the right edge.

**Config console**

- MCP servers configured for a project now appear. Claude Code records them
  against the directory you started it in, writing that path however it was
  given - and Helm was matching it one way only, so it missed the servers of
  very nearly every project and reported "no servers configured" for
  directories whose sessions had one loaded.

**Welcome**

- The empty workspace opens with the ship's wheel rather than the word "Helm"
  above it, which was saying the name twice to somebody already looking at
  the app.

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
