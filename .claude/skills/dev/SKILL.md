---
name: dev
description: Running Helm's dev build and driving it - what pnpm dev isolates, what it fakes, and how to click through the running window from outside it. Use when launching the app to look at a change, reproducing something by hand, or deciding between pnpm dev, dev:live and design-shot.
---

## The dev build

`pnpm dev` has its own everything: `%LOCALAPPDATA%\Helm\dev\helm-data`, holding
its own `helm.db`, Chromium profile and `overlays/`. It can run beside an
installed Helm, and a second `pnpm dev` gets `dev-2` rather than failing on a
held database. `CLAUDE.md`'s "Where the data lives" table is the authority for
which mode puts what where.

```bash
pnpm dev                  # isolated; database is a copy of the real one
pnpm dev --fresh          # ...with no database, which is the first-run state
pnpm dev --drive          # ...and open the remote debugging port (below)
pnpm dev:live             # against %APPDATA%\Helm - the installed app's own
```

Three things about it are worth knowing before you are surprised by them.

**The database is a copy, taken at launch.** So the projects, profiles, roots
and session history are the machine's real ones - which is what makes dev worth
looking at - and anything you change in dev is gone at the next launch. That
includes settings: park one to reproduce something and it will not be there
when you restart.

**`gh` is synthetic** (`scripts/fake-gh.mjs` in its `HELM_FAKE_GH_SYNTHETIC`
mode, behind a `.cmd` shim, reached through `--gh=`). It derives 0-3 stable
pull requests from each slug's hash - so every repository has plausible offline
pull requests, the same ones on every run, and the pane's states are reachable
without arranging one on GitHub. Three bits per pull request pick draft, checks
failing, and a patch over the 2MB ceiling. It **refuses `pr checkout`** with a
sentence: dev's projects are the machine's real working trees.

`HELM_FAKE_GH_STATES=draft,failing,big-diff` forces a repository's set when its
hash is unlucky.

**`~/.claude` and `claude` are real, deliberately.** `CLAUDE_CONFIG_DIR` moves
credentials, so a dev app pointed at a fixture home cannot sign in and cannot
host a session. The residue is named rather than hidden: dev sessions land in
the real `~/.claude/history.jsonl`, and the config console still writes the
real user settings through its snapshot path.

## Looking at it

Two tools, and they answer different questions.

**`pnpm design-shot`** is the sanctioned one for a design review: its own
isolated run, every main view in both themes, PNGs to argue over. Reach for it
when the question is "does this look right". The **`checks`** skill has its
groups.

**`scripts/drive-dev.mjs`** is for the app you have open. Reach for it when the
question is "what happens two clicks in", which design-shot's fixed itinerary
does not go to.

```bash
pnpm dev --drive                                   # one terminal
node scripts/drive-dev.mjs text                    # what the window says
node scripts/drive-dev.mjs controls                # every button, by label
node scripts/drive-dev.mjs click "Pull requests"
node scripts/drive-dev.mjs eval "window.helm.invoke('settings:write', {...})"
node scripts/drive-dev.mjs shot pulls.png
```

`shot` is `Page.captureScreenshot`, which is the renderer's own pixels - so it
works with the window behind something else, and it is the **same capture**
`design-shot` makes (`webContents.capturePage`). An edge measured in one and an
edge measured in the other are the same edge.

The port is **off unless `--drive` asks for it**, and there is no flag that
opens it for `dev:live`. It is a door into a process that reaches the real
`~/.claude` and spawns real sessions; this repository's habit with doors is not
to build the ones nothing needs.

## What this is not

It is not a check. Nothing here asserts, nothing writes a report, and a claim
made by clicking around by hand is worth what a claim made by clicking around
by hand is worth. **A change to a surface a check covers is not done until that
check is green** - see the **`checks`** skill for which one a change owes. This
is for finding the thing to fix, and for looking at it afterwards.

Two things found this way that no check would have: every row of the
pull-request Files view reading "No patch for this file in what was fetched",
because a fixture's patch named a path its own detail did not list; and a
generator dropping `reviewDecision` out of its JSON entirely - a *missing*
field, not a wrong one - because a 48-bit seed shifted with `>>` went negative.
Both were invisible one level up and obvious on the pane.
