---
name: surfaces
description: The detailed invariants of Helm's individual surfaces - the embedded terminal, the status bar's usage figures, the pull-request pane, and anything that touches a ~/.claude tree. Use before editing terminal.ts, ptyEnv, estimateGrid, core/usage/, core/github/, main/pulls.ts, core/config/, or the session index.
---

## Surface invariants

Each rule here exists because something was measured. The argument behind it is
in a comment at the code site it governs, which is the copy that stays true when
the code moves - this file is the index, not the authority. CLAUDE.md carries
the one-line version of each; what follows is the detail it points at.

## The terminal

`renderer/src/terminal.ts` and `ptyEnv` in `main/pty.ts` are load-bearing for
TUI fidelity. Every line is there because a spike measured the failure it
prevents - **read SPEC 8.3 before changing either**.

**Five values are settings** - font family, size, cursor style, cursor blink,
scrollback - and they reach a terminal by being **passed in**:
`createTerminal(container, opts, hooks, prefs)`. The app hands its effective
preferences down from `settings:changed` through `app/termprefs.ts`. `spike.ts`
calls the same function with three arguments and gets `TERMINAL_DEFAULTS`, which
is exactly what was baked in before settings existed - so a preference nobody
has touched produces the configuration the spike proved, and `pnpm fidelity` and
`pnpm claude-check` still measure it.

**A setting must never be routed through the `term:*` channels to reach a
terminal.** That is the one change that would alter what fidelity measures.

**Everything else in that file is fixed and is not a setting:**
`minimumContrastRatio: 1`, `drawBoldTextInBrightColors: false`,
`allowProposedApi` / Unicode 11, `lineHeight`, and the whole 24-bit `THEME`. The
palette is asserted pixel-for-pixel by fidelity C1; making colours settable is a
deliberate DESIGN.md amendment, not a row in the settings pane.

**`estimateGrid`** (`app/terminals.ts`) decides what size a pty opens at, and
must keep measuring the way xterm does:

- a **DOM span**, not a canvas - the two resolve a font stack by different rules
  and disagreed by 6% on this machine;
- then the WebGL renderer's device-pixel flooring across and rounding-up down;
- then FitAddon's flat 14px overview-ruler reserve.

Each is worth a column or more. Without all three the pty opens at a grid the
pane does not have - it was eight columns out at 20px before they were added.

**A session's terminal lives outside React** (`app/terminals.ts`) and is
disposed when its tab closes, not when a component unmounts, because scrollback
cannot be rebuilt from props. Panes are hidden, never unmounted, and a hidden
pane measures 0x0 - the guard that stops `FitAddon` turning that into a 1x1 grid
the pty acts on is in `terminal.ts`.

## Usage figures

They degrade to **nothing** rather than to a wrong number. A missing key, a
reshaped object, a reading with no timestamp or one dated in the future, and
above all one whose windows have **already reset** - that last describes a
window which no longer exists, so its percentages are not merely old, they are
about something else. All paint no number and put the reason in the tooltip.

**Age alone does not blank, and it used to.** A reading older than
`USAGE_STALE_AFTER_MS` whose windows are still running paints its figures as
**lower bounds** - `≥59%`, with the age beside it and the reason in the tooltip
- because a window only accumulates until it resets, so such a reading can only
understate. Blanking it was measured to be nearly total: on 2.1.228 Claude Code
left `cachedUsageUtilization` untouched for an hour and three quarters of
continuous use, and a `claude -p` run that finished normally did not refresh it
either. A thirty-minute horizon was not choosing between a good figure and a bad
one, it was discarding the only figure there is.

`/usage` inside a real session is the only refresh anyone has measured. **Do not
put a remedy in that tooltip that has not been.**

**The ordering is load-bearing.** Rolled-over is judged **before** age, in
`usageView` and again, separately, in `usagecheck.ts`'s own restatement of the
rule. Both questions used to answer "paint nothing", so their order did not
matter; now they differ. Measured on 2.1.225: the 5-hour window rolled over
between two reads and the cached figure went 51% to 21%.

**The binding limit of a group is the one with the highest percent**, not the
one flagged `is_active` - that was observed set on the lower of the two.

**Dollar figures are estimates and say so**, because `spend.enabled` is false on
a subscription plan and every `*_dollars` the server sends is null. The price
table's date lives in `PRICE_TABLE_DATE` and the UI reads it from there, so a
stale table is visible rather than merely authoritative-looking. A model with no
rate on file is counted, left unpriced, and named.

## Pull requests

This surface degrades the **opposite** way to the usage figures, and
deliberately: cached rows stay with their age painted on them, because a pull
request that was open two hours ago is a true fact about two hours ago. The
reason goes on the repository that failed, and the age caption is mandatory
rather than decorative.

**`gh auth status` is an opinion, not a verdict, and never a gate.** With no
route to github.com it exits 1 and reports "The token in keyring is invalid",
naming `gh auth login` as the remedy - for a token that is perfectly good.
Measured on 2.86: the same token, the same second, exits 0 with the network up.
So the *fetches* decide, through `classifyGhFailure`, which reads gh's own
connection vocabulary and splits `offline` from `auth`; `gh auth status` is
consulted only when a sweep had nothing to fetch and so learned nothing.
**Nothing on the `offline` branch may mention `gh auth login`** - the user who
follows that instruction is told they are already logged in and is left with no
idea what is wrong.

**One condition stops a pass: there is no `gh` binary.** That is a local fact
that cannot go stale between two ticks. Every other reason is a claim about a
server, and a claim about a server may never gate the request that would correct
it - `authenticated` gating the pass is what latched the whole surface off after
a single dropped connection, because the forced re-check that could have cleared
it only ran when a fetch failed and there were no longer any fetches. `PR-20` in
`pnpm pr-check --only=degrade` is that regression and fails if the gate returns.

**A `GhProblem` is a statement about the machine.** Only a full sweep in which
every repository failed may raise one, and any repository coming back clears it.
`only !== null` is a targeted refresh and draws no verdict at all: the old
"every repository attempted failed" test was satisfied by one failure when one
repository was attempted, so clicking a broken row to retry it announced that
GitHub was unreachable. Per-repository reasons live on `PullRepo.error` and are
painted on the row.

**`prIgnoredRepos` is applied before the fetch**, in `pass()`, and not as a
filter over the snapshot. The point of the setting is the `gh` that never runs;
a version that hid rows from an answer already paid for would look identical on
screen and be the opposite of what it is for. Three consequences hold it
together:

- keyed by **slug**, so one entry covers every checkout and survives a
  re-clone, matched case-insensitively because GitHub's names are
  (`isRepoIgnored`);
- an ignored repository is **structurally absent** from `PullsSnapshot.repos`
  and present in `ignored`, so no count can include one by forgetting a filter;
- its cached rows are **left in the database**, so ticking it back on paints
  what it had with its age rather than an empty list.

The pane says what it is hiding - an "Ignored" section - and the empty state and
sidebar line both distinguish "everything is ignored" from "nothing here is on
GitHub", which would otherwise report a setting as a fact about the user's disk.
The tick lives in Settings; the pane carries only the untick's undo.

**The Files view paints the patch**, which SPEC records as a *superseded*
decision rather than a quiet reversal: "no diff viewer" is struck through and
the note under it says what is still not done (syntax highlighting, whitespace
modes, side-by-side, review threads). Three rules hold it together and are not
negotiable without amending that note:

- GitHub's file list is the spine, and the patch is matched onto it by path;
- the cache holds the **text** `gh pr diff` printed, not the parse;
- every ceiling it hits (`MAX_DIFF_BYTES`, `MAX_FILE_LINES`, a file with no
  patch) is counted and said on screen. A diff that quietly stopped halfway
  would read as complete.

**A review launch composes its prompt in main** and the window never sends one:
`pr:review` carries `{repoPath, number, cols, rows}`, the same shape
`profile:launch` takes and for the same reason - argv assembled in a renderer is
argv that can drift from what was saved. The detail pane renders the template
too, but only to say what the button will run; when the preview and the argv
disagree, the argv is right and the preview is the bug.

`prCheckout: 'checkout'` is refused on a dirty tree rather than stashing - Helm
does not move somebody's uncommitted work. `prReviewModel` and `prReviewEffort`
are composed in the same place and are **null by default**, passing no flag: a
setting that defaulted to a model name would make Helm's launches differ from
the CLI's own for no reason the user asked for. The model is deliberately not
validated against a list of names, because the CLI's aliases and ids move faster
than this app releases - the validator checks only that the value can be one
argv word.

## `~/.claude` trees

Helm only ever reads Claude Code's directory, with exactly one exception: the
config console writes to it. That is why the snapshot is not optional - every
byte goes through `config:write` -> `writeConfigFile`, which takes the previous
content into `config_snapshots` *before* touching the file and aborts the write
if the row cannot be taken.

Two facts about the directory were measured on 2.1.225, not assumed:

- **`--resume <id>` resolves the id against the working directory.** From
  anywhere else it prints "No conversation found with session ID" and exits 1.
  So a resume must set cwd to the directory `history.jsonl` recorded, and a
  project that has been deleted makes a session unresumable even though its
  transcript is still there.
- **A transcript is found by scanning `projects/*` for `<uuid>.jsonl`**, never
  by deriving a path from the recorded project. The directory name carries
  whatever casing the CLI was started with, `history.jsonl` records its own, and
  the two disagree on this machine - a derived path reports live conversations
  as reaped.

Resuming passes no `-n`: the session already has a name, and renaming it would
be a side effect of Helm having opened it. The tab's label is Helm's own.

**Settings layers merge per leaf, not per top-level key.** A project
`settings.json` setting `env.A` and a `settings.local.json` setting `env.B`
produce a session with both, and where they name the same leaf the local one
wins. Measured by reading `env` back out of a live session, which is why
`EffectiveSetting` is keyed by `env.A` rather than by `env`. Precedence is
local > project > user; enterprise policy and CLI flags sit above all three and
are not files this console edits.

**`CLAUDE_CONFIG_DIR` genuinely moves the config directory**, credentials
included, so a session pointed at a fixture home cannot log in. Anything that
has to measure the *user* settings layer has to use the real
`~/.claude/settings.json`, snapshot it, and put it back.
