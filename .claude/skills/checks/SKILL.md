---
name: checks
description: How Helm's real-window checks work - sessions-check through packaging-check, usage-check, settings-check, fidelity, claude-check, design-shot. Use when running one, narrowing a re-run with --only, reading a report, diagnosing a failure, or writing a new check.
---

## Helm's checks

Helm has two tiers of test and they do not overlap.

`pnpm check` (typecheck + lint + `vitest`) is fast, hermetic, and covers
`packages/core` only. All 270 unit tests live there. It runs in about a second
and it is what CI runs.

The checks in this skill drive the **real Electron window** - clicking real
rows, launching real `claude` sessions, installing real packages - and they are
the only coverage `packages/ui` and `packages/desktop` have. They take minutes,
they cost tokens, and they are deliberately not in `pnpm check`.

Each is named for the surface it covers, and its report ids carry a matching
prefix - `sessions-check` writes `SESS-1`, `config-check` writes `CFG-1`.

## Which one to run

A change to a surface named here is not done until its check is green.

| check | covers | run after touching |
|---|---|---|
| `pnpm sessions-check` | sessions, tabs, teardown | session lifecycle, the tab strip, shutdown |
| `pnpm profiles-check` | profiles, overlay shims, argv | `core/launch/`, the profile UI, the argv builder |
| `pnpm history-check` | session index, resume | history parsing, the history pane, resume |
| `pnpm config-check` | config console, effective view, MCP | `core/config/`, anything that writes into a `.claude` tree |
| `pnpm content-check` | markdown, artifacts, wikilinks, editor | `core/content/`, the content viewer |
| `pnpm packaging-check` | first run, packaging, personal-path audit | setup, portable mode, the installer |
| `pnpm usage-check` | the status bar's usage figures | `core/usage/`, the status bar |
| `pnpm settings-check` | the settings pane, every app setting, terminal/shell preferences | `core/store/settings.ts`, `SettingsPane`, `terminal.ts`, `estimateGrid`, `main/pterm.ts` |
| `pnpm pr-check` | the pull-request surface end to end | `core/github/`, `main/pulls.ts`, `main/gh-cli.ts`, `PullsPane`, `PullRow`, `PullRequestPane`, the project pane's pull-request panel and its Config/Content links, `SessionHost.review` |
| `pnpm affordance-check` | every clickable control looks clickable | `theme.css`, `lib/segmented.ts`, `Checkbox`, any shared control recipe, any new pane |
| `pnpm fidelity`, `pnpm claude-check` | TUI fidelity inside xterm | `terminal.ts`, `ptyEnv` |

`affordance-check` is the one that is about *all* of the UI rather than one
surface, so it is owed by a change to a shared recipe and by a new pane - a new
pane needs a row in its `VIEWS`, or its controls go unmeasured and the check
says so in AFF-2 rather than passing quietly.

`terminal.ts` sits under two of them and they answer different questions:
fidelity says the baked configuration still renders a TUI correctly,
`settings-check --only=terminal` says a preference reaches every live terminal
without disturbing that. A change there is not done until both are green **and
fidelity's numbers have not moved**.

## The discipline every check follows

A check asserts against an **independent second reader**, never against the
code under test. The tree is checked against its own `readdirSync` walk, the
history counts against their own parse of `history.jsonl`, restores against
their own `sha256`. A parser agreeing with itself proves nothing.

Where agreement is not enough, a check asks the world instead: a live `claude`
session is asked what it can actually see, an installer is actually installed,
a usage window is actually allowed to roll over underneath the segment.

**A check that can pass with no evidence behind it is worse than no check.**
PROF-4 asked a session to quote two skills' headings and compared against files
on disk; when those files went missing `firstHeading` returned `''`, the
expected token became `SKILL1=`, and everything matched. It was green for weeks.
Any probe that reads its expected value out of a fixture must first assert the
fixture is there and is discriminating.

## Narrowing a re-run

Most checks take `--only=a,b,c`. **Do not trust a group list written in prose,
including this file.** They have drifted before. Read the authority:

```bash
# in-app groups, per driver
node -e "console.log(require('fs').readFileSync('packages/desktop/src/main/configcheck.ts','utf8').match(/const GROUPS = \[([^\]]*)\]/)[1].replace(/\s|'/g,''))"

# groups the run script owns rather than the app (the packaging phase)
grep -n "wants('" packages/desktop/scripts/run-packaging.mjs
```

`profiles-check`'s groups are filtered inside `profilescheck.ts`; `packaging-check`'s `package`
group lives in `run-packaging.mjs`, not in the driver's `GROUPS`, because the
packaging phase runs outside the app.

## What each one is, and the shape worth knowing first

**`sessions-check`** - sessions, tabs, teardown. Drives the window: sidebar rows, the
launch button, tabs and their close buttons, asserting on processes, xterm grids
and database rows. Then `scripts/verify-orphans.mjs` confirms nothing survived.

**`profiles-check`** - profiles and overlay composition. Builds a profile through the
real form, launches it, and asks the live session whether the overlays' skills
and instructions actually arrived. **Four phases**, orchestrated by
`run-profiles.mjs` rather than `&&`: the driver, a second real app start
(`--shim-sweep`), `scripts/verify-shims.mjs`, then the hold phase. Spawns real
sessions on haiku.

The last two phases are about **two Helms** and they are opposites, which is
what makes them worth reading together:

- `PROF-9` - a shim from a run that *ended* must be collected. The driver plants
  one stamped with the pid of a process it spawned and waited on, so the sweep
  removes it by establishing the owner is gone rather than by default. Asserted
  across two starts because one process cannot observe its own startup.
- `PROF-10` - a shim a *running* Helm is serving must survive. This is an
  overlap rather than a sequence, so `--shim-hold` is **spawned**, not waited
  on: it launches a real session, writes `shim-hold-ready.json`, and blocks
  while `run-profiles.mjs` starts a second real app that sweeps. The holder then
  reads its own shim back and **makes the verdict itself** - it is the process
  whose session would have lost its skills. It reads the skill body *through*
  the junction, and asserts the before-values too, since "absent then, absent
  now" would otherwise pass.

**`history-check`** - the session index. Drives the history pane and checks every
count against its own read of `~/.claude/history.jsonl`. Spawns two real
sessions: one resumed through the app, one on its own pty to prove the watcher
notices a session Helm did not start.

**`config-check`** - the config console. Tree against its own `readdirSync`,
restores against their own `sha256`, predicted overlay namespaces against a
hand-built `basename(overlay):skill` list. The effective view is then checked
against a **live session** - three predicted skills invoked and the settings
winner read back out of `env` - because a prediction about a session is only
worth what a session says about it. One haiku session.

**`content-check`** - the content viewer. Opens every markdown file in the user's
harness vault and checks the DOM against a regex read of the same source,
navigates a wikilink, interrogates the artifact frame's sandbox from inside it,
measures search latency and scroll frame intervals, and edits a real note with
a hash-verified restore. Spawns no sessions, so it takes about a minute.

**`packaging-check`** - first run and the built artefacts, in three phases. Two shapes
matter before touching it. **First run is a second process**: "a fresh
`~/.claude` and no harness at all" is not a state this machine can enter, so
`run-packaging.mjs` starts the app again with `PORTABLE_EXECUTABLE_DIR` pointed at a
temp directory - the app's own portable mechanism, not a test hook - and
`--claude-home=` pointed away from the real one. Nothing of the user's is backed
up because nothing of the user's is opened. And **the audit is made to fail
first**: a file carrying a Windows profile path, a harness path and a private
project name is planted, caught, and deleted before its clean result is
believed, because a grep that finds nothing is indistinguishable from a grep
looking for nothing. Phase 3 installs the NSIS package for real and uninstalls
it. `--sandbox=` puts the throwaway profile somewhere with no account name in
the path, which is how the README's screenshots were taken.

**`usage-check`** - the status bar's figures. A plain `JSON.parse` beside
`parseUsage`, a hand-written "which of these may be shown" beside `usageView`, a
hand-computed weekday beside `formatResetsIn`, a hand-written parse of every
transcript beside the incremental index, a regex over the rendered text beside
the component. Three criteria could not be settled by agreement and are not: a
live `claude` is asked for `/usage` and its panel compared to the bar, a
fixture's window is set to expire ten seconds out so a rollover happens
*underneath* the segment, and the full parse the index avoids is measured rather
than quoted. Two phases, because "the mode survives a restart" cannot be
asserted by the process that set it.

**`settings-check`** - the settings pane, every app setting, and the terminal
preferences. The second
reader is this driver's **own read-only connection to `helm.db`**, opened beside
each UI assertion: reading through `services.store` would be reading the handle
the app just wrote through, which passes whether or not anything was committed.
Three things it does not settle by agreement - the removal of a scan root is
checked against the *next scan's* project set rather than against the list of
roots, the theme against the colour Electron was handed for the window controls
(captured by wrapping `setTitleBarOverlay` on the window itself) compared with
the `--helm-bg` token as CSS resolved it, and the CLI override against a stub
program on disk that answers `--version` with 9.9.9. Every rejection case is
preceded by a **valid** write of the same key through the same channel, because
"the row did not change" is also what a channel that writes nothing would
report. Two phases: it parks every setting on a non-default value, and
`run-settings.mjs` starts the app again to read them back - and to restore the
originals, since this one borrows a database (a *copy* of the real one; see
"Where the output lands").

Its `terminal` group is the one part that spawns a `claude`, because the
claim is about terminals in **both** registries and only a session puts one in
the session registry. Three things there are worth knowing before touching it.
Live terminals are reached through `window.__helmTerminals()` - a read-only tap
in `app/inspect.ts`, since they live outside React and `executeJavaScript` has
no other route to them - but it is never the only witness: cell geometry is
checked against a measurement the driver makes itself, and every pty resize is
counted by wrapping `sessions.resize` and `pterm.resize` on the host objects.
The group **writes its own baseline first**, because the validation group parks
each terminal setting on a value of its own on the way past. And a `<select>`
is checked for having taken the value **before** the change event is dispatched:
React flushes a discrete event synchronously and re-renders from props the write
has not come back and changed yet, which puts the old value back.

**`fidelity` and `claude-check`** - TUI fidelity inside xterm. These render
`spike.html`, a separate page from the app, so app layout changes cannot move
the terminal under them. Read SPEC 8.3 - the terminal-fidelity spike - before
touching `terminal.ts` or `ptyEnv`.

**`design-shot`** - not a check, nothing is asserted. Opens the real window,
walks every main view in both themes, and writes PNGs. It is how a UI change
gets looked at rather than reasoned about. Measure a suspect edge in the PNG
rather than eyeballing it - `System.Drawing` from PowerShell is enough to scan a
column for an island's top and bottom edge.

Four groups, `--only=` like the checks (`GROUPS` in `designshot.ts` is the
authority): **views** is the walk itself, **states** the collapsed section and
the five hover probes,
**responsive** a width sweep over the two scoped pane headers, and **split** a
pane docked beside a real session at four widths. Two of them are worth knowing
about. `responsive` **prints numbers** - each header's `overflow` and `spill`,
the second being how far a child reaches past the padding box, which is the
failure a thumbnail does not show and the one the header bug was found by.
And `split` is the only group that spawns a session, and the only one that
reaches pane widths below the ~596px the window's own `minWidth` leaves: the
divider is bounded at a *fraction* of the row, so it docks far narrower than
any window can be made.

`states` **prints numbers too**. Five named probes: each moves the pointer away,
moves it onto the element that carries the class, and reports background, border
and a child's colour before and after. Three of them ask "did anything happen";
the other two - `segment-on` and `select` - exist because their hover is a
*judgement about a colour* rather than a yes/no, and the numbers are what say
whether a change an assertion scores as real is one an eye can find. Each probe
carries its own positive control, `el.matches(':hover')`, because a synthesised
move that never reaches the hit test reports every tint on screen as dead, which
looks identical to every tint being dead.

Whether a control has *any* hover state is `affordance-check`'s question, over
every control rather than five. These five stay because they print colours and
cost seconds.

**`affordance-check`** - does everything clickable look clickable. Walks ten
views in the real window, enumerates every button, link, select, tab and
checkbox on each, and puts a real pointer on each one in turn: AFF-3 says it
computes `cursor: pointer`, AFF-4 says some computed property actually changes
underneath it, AFF-5 says the converse - that a text field still reads `text`
and a disabled control does not read `pointer`, since `* { cursor: pointer }`
would pass AFF-3 and is the same lie pointing the other way. No sessions, no
network, about a minute and a half.

Three things about it are worth knowing before touching it. It **plants two
controls first** (AFF-1) - one with no hover rule and an inline `cursor: default`
that no stylesheet can outrank, one with both - and refuses to run the walk
unless it fails the first and passes the second; an auditor is not believed
until it has been made to fail. It reads what a person would see rather than
scraping rules, because `document.styleSheets` throws `SecurityError` on
`file://` and returns an empty list that reads exactly like "no rules matched",
which is how the original bug survived one investigation. And a view is
confirmed by an **anchor element**, not by how many controls it produced: a
count high enough to catch a pane that never opened also fails
`config:health`, which legitimately holds one control until the doctor has run.

What it does not reach: the modal dialogs, the pull-request detail tabs and the
profile editor, all of which are behind a state the walk would have to create
and then unwind - and a walk that leaves a dialog open poisons every view after
it. Their controls are covered only where they share a recipe with something the
walk does reach.

Both this and the `states` probes exist because of the same failure. Tailwind v4
gates `hover:` behind `@media (hover: hover)`, and on a machine where Chromium
answers false to that (design-shot prints the four pointer queries beside the
probes) **every hover state in the app dies at once** with nothing else looking
wrong: the tokens resolve, the classes are present, the rules are in the
stylesheet. `theme.css` overrides the variant. Sampling three elements cannot
tell that from three unlucky ones, which is the whole argument for enumerating.

`views` walks the project pane **twice**: once for whatever the tree lists
first, and once for a project the pull-request snapshot knows about
(`project-repo-*.png`), found by path rather than by position. On a machine
organised into harnesses the first row is the harness, which is not a git
repository - so without the second shot a branch, a git stat group and the
whole pull-request panel are never photographed. It is skipped, out loud, where
there are no github.com remotes.

## Where the output lands

Every check runs against a **data directory of its own**:
`%LOCALAPPDATA%\Helm\checks\<name>\helm-data`, one per check so a failed run's
database and screenshots survive for inspection. `scripts/isolate.mjs` makes it,
and the app is told about it with `PORTABLE_EXECUTABLE_DIR` - the app's own
portable-mode mechanism, the same one `run-packaging.mjs` already used as isolation,
rather than a hook that exists only for checks. `paths.ts` puts `helm-data`
under it and calls `app.setPath('userData')`, so the database, the overlay
shims, the reports and Chromium's own profile all move together.

Not under `%TEMP%`, and that is not arbitrary: the directory holds `overlays/`,
whose subdirectories are junctions into real repositories, and CLAUDE.md's rule
about temp cleaners following reparse points is not relaxed by the directory
being a check's.

The database is **seeded with a copy of the real one** each run, taken with
`VACUUM INTO` through a read-only connection - the only safe way to read a
SQLite file another process holds open in WAL mode. So the checks still assert
against the machine's actual projects, roots and history, which is what makes
them worth running, while never writing to the file the user's Helm is using.
This is why `run-settings.mjs` can go on parking settings and restoring them:
what it parks is the copy.

Helm is a desktop app somebody is using while its checks run, and the drivers
used to point at `%APPDATA%\Helm` directly. Observed once: a run flipped the
live app's theme, font and default shell underneath it, and the only reason they
came back is that the run reached its restore. A run that dies leaves them
parked. Do not point a new driver at the real directory.

`run-packaging.mjs` is the exception and stays one. Its phases are *about* where data
lands - "beside the exe" for portable, `%APPDATA%\Helm` for installed - so an
isolated data directory would erase the thing it measures.

What is still shared, because it cannot be otherwise: `~/.claude`. Checks that
spawn a real `claude` add to its history like any session, and `config-check` edits
the real user settings layer and puts it back. `CLAUDE_CONFIG_DIR` moves
credentials too, so a session pointed at a fixture home cannot log in.

Screenshots are under `screenshots/`, reports are `<name>-report.json` at the
root. The multi-phase checks make the **report the verdict**, not the exit code,
because node-pty's teardown loses it.

## Writing a new check

- Drive the real window through `executeJavaScript`; never a test renderer.
- Assert against a reader you wrote separately, or against the world.
- Assert your fixtures exist and discriminate before believing a pass.
- If a claim cannot be made by the running process - "cleaned at startup",
  "survives a restart" - it needs a second phase and a `run-*.mjs`, and the
  verdict moves into the report.
- Put the group list in a `GROUPS` const so `--only` has one authority.
- Say what a run costs in the driver's header comment: sessions spawned, model,
  rough wall time.
