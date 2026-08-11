---
name: checks
description: How Helm's real-window checks work - m2-check through m7-check, usage-check, fidelity, claude-check, design-shot. Use when running one, narrowing a re-run with --only, reading a report, diagnosing a failure, or writing a new check.
---

## Helm's checks

Helm has two tiers of test and they do not overlap.

`pnpm check` (typecheck + lint + `vitest`) is fast, hermetic, and covers
`packages/core` only. All 270 unit tests live there. It runs in about a second
and it is what CI runs.

The checks in this skill drive the **real Electron window** - clicking real
rows, launching real `claude` sessions, installing real packages - and they are
the only coverage `packages/ui` and `packages/desktop` have. They take minutes,
they cost tokens, and they are deliberately not in `pnpm check`. CLAUDE.md's
table says which one to run after touching what; this file is the mechanics.

The `mN` prefix is the ClickUp milestone whose acceptance criteria the check
encodes. `docs/TASKS.md` maps the numbers to scope. The names are provenance,
not a description - use the table in CLAUDE.md to pick one.

## The discipline every check follows

A check asserts against an **independent second reader**, never against the
code under test. The tree is checked against its own `readdirSync` walk, the
history counts against their own parse of `history.jsonl`, restores against
their own `sha256`. A parser agreeing with itself proves nothing.

Where agreement is not enough, a check asks the world instead: a live `claude`
session is asked what it can actually see, an installer is actually installed,
a usage window is actually allowed to roll over underneath the segment.

**A check that can pass with no evidence behind it is worse than no check.**
M3-4 asked a session to quote two skills' headings and compared against files
on disk; when those files went missing `firstHeading` returned `''`, the
expected token became `SKILL1=`, and everything matched. It was green for weeks.
Any probe that reads its expected value out of a fixture must first assert the
fixture is there and is discriminating.

## Narrowing a re-run

Most checks take `--only=a,b,c`. **Do not trust a group list written in prose,
including this file.** They have drifted before. Read the authority:

```bash
# in-app groups, per driver
node -e "console.log(require('fs').readFileSync('packages/desktop/src/main/m5check.ts','utf8').match(/const GROUPS = \[([^\]]*)\]/)[1].replace(/\s|'/g,''))"

# groups the run script owns rather than the app (m7's packaging phase)
grep -n "wants('" packages/desktop/scripts/run-m7.mjs
```

`m3-check`'s groups are filtered inside `m3check.ts`; `m7-check`'s `package`
group lives in `run-m7.mjs`, not in the driver's `GROUPS`, because the
packaging phase runs outside the app.

## What each one is, and the shape worth knowing first

**`m2-check`** - sessions, tabs, teardown. Drives the window: sidebar rows, the
launch button, tabs and their close buttons, asserting on processes, xterm grids
and database rows. Then `scripts/verify-orphans.mjs` confirms nothing survived.

**`m3-check`** - profiles and overlay composition. Builds a profile through the
real form, launches it, and asks the live session whether the overlays' skills
and instructions actually arrived. **Three phases**, orchestrated by
`run-m3.mjs` rather than `&&`: the driver, a second real app start
(`--shim-sweep`), then `scripts/verify-shims.mjs`. The second start exists
because "stale shims are cleaned at startup" cannot be asserted by the process
that already started. Spawns real sessions on haiku.

**`m4-check`** - the session index. Drives the history pane and checks every
count against its own read of `~/.claude/history.jsonl`. Spawns two real
sessions: one resumed through the app, one on its own pty to prove the watcher
notices a session Helm did not start.

**`m5-check`** - the config console. Tree against its own `readdirSync`,
restores against their own `sha256`, predicted overlay namespaces against a
hand-built `basename(overlay):skill` list. The effective view is then checked
against a **live session** - three predicted skills invoked and the settings
winner read back out of `env` - because a prediction about a session is only
worth what a session says about it. One haiku session.

**`m6-check`** - the content viewer. Opens every markdown file in the user's
harness vault and checks the DOM against a regex read of the same source,
navigates a wikilink, interrogates the artifact frame's sandbox from inside it,
measures search latency and scroll frame intervals, and edits a real note with
a hash-verified restore. Spawns no sessions, so it takes about a minute.

**`m7-check`** - first run and the built artefacts, in three phases. Two shapes
matter before touching it. **First run is a second process**: "a fresh
`~/.claude` and no harness at all" is not a state this machine can enter, so
`run-m7.mjs` starts the app again with `PORTABLE_EXECUTABLE_DIR` pointed at a
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

**`fidelity` and `claude-check`** - TUI fidelity inside xterm. These render
`spike.html`, a separate page from the app, so app layout changes cannot move
the terminal under them. Read `docs/SPIKE-C.md` before touching `terminal.ts`
or `ptyEnv`.

**`design-shot`** - not a check, nothing is asserted. Opens the real window,
walks every main view in both themes, and writes PNGs. It is how a UI change
gets looked at rather than reasoned about. Measure a suspect edge in the PNG
rather than eyeballing it - `System.Drawing` from PowerShell is enough to scan a
column for an island's top and bottom edge.

## Where the output lands

Reports and screenshots go to `dataDir`: `%APPDATA%\Helm` for dev and installed
builds, `helm-data/` beside the exe in portable mode (`src/main/paths.ts`).
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
