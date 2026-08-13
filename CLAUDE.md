# Helm - Agent Instructions

Desktop shell on top of Claude Code. Read [docs/SPEC.md](docs/SPEC.md) before
doing anything - it holds the measured evidence behind every design decision.
Do not re-litigate what is recorded there without new evidence.

**All UI work follows [docs/DESIGN.md](docs/DESIGN.md)** - the "Nocturne
Islands" design system. Semantic tokens only (no raw hex in components), islands
with hairline edges on a sunken canvas, the accent never solid-fills anything,
no shadows outside modals, no text weight past 500, mono for machine data. A
change that cannot be expressed in the system's tokens is a deliberate
DESIGN.md amendment or a change to reconsider.

Look at the app, not at the class names. `pnpm design-shot` walks every main
view in both themes and writes PNGs to
`%LOCALAPPDATA%\Helm\checks\design-shot\helm-data\screenshots\design` - its own
data directory, like every check, and never the `%APPDATA%\Helm` somebody is
using while it runs. A UI change is not done until you have looked at one, and
measuring a suspect edge in the PNG beats eyeballing it. `--only=` narrows the
walk; the **`checks`** skill has the groups.

For the question design-shot's fixed itinerary does not reach - what happens
two clicks in - `pnpm dev --drive` and `scripts/drive-dev.mjs` click through
the window you have open, and take the same capture. The **`dev`** skill has it.

## Where the rest of this lives

This file is the part that has to be in mind while doing *anything*. Everything
else is a skill, loaded when the work calls for it, and the argument behind any
rule is in a comment at the code site it governs - that is the copy that stays
true when the code moves.

| skill | read it before |
|---|---|
| **`dev`** | launching the app to look at a change, or driving the window you have open |
| **`checks`** | running or writing a real-window check, or deciding which one a change owes |
| **`surfaces`** | editing the terminal, the usage figures, the pull-request pane, or anything touching a `.claude` tree |
| **`procedures`** | adding an app setting, changing the schema, or building a release |

## Work tracking

ClickUp list **"Helm - Claude Code Shell"** (`901114291892`). Nothing in this
repository refers to a task by id. Each task has checkbox acceptance criteria
and is done when every box is checked, not before. When a task's claim and a
check disagree, the check is right.

## Layout

```
packages/
├── core/     # headless: discovery/, launch/, config/, content/, github/, usage/, store/
├── ui/       # React components
└── desktop/  # Electron main + preload + renderer + the spike harness
```

pnpm workspaces, `node-linker=hoisted` (see `.npmrc` for why). `core` and `ui`
export TypeScript source rather than a build output, so the bundler compiles
them in and there is one build step, not three. `pnpm check` is what CI runs.

## Boundaries

- **`packages/core/` never imports Electron.** Enforced by `no-electron-in-core`
  in `eslint.config.js` - static imports, `require()` and dynamic `import()`
  alike. If core needs something from the host, the host passes it in.
- **A value import into the browser bundle comes from `@helm/core/types`**,
  never the package root, which reaches the filesystem through `launch/` and
  `store/`. That fails at rollup, not at typecheck, so `pnpm typecheck` will not
  catch it. Types are erased and may come from anywhere. `EFFORT_LEVELS` and
  `PERMISSION_MODES` are the ones this comes up for.
- **Every renderer↔main channel is declared in `shared/ipc.ts` and nowhere
  else.** The preload exposes three generic functions; a feature adds a channel
  to the contract, not a method to the bridge. Two terminal families exist and
  never mix: `term:*` is the spike page's single pty, `session:*` is the app's
  many. Changing `term:*` changes what `pnpm fidelity` measures.
- **The main process owns process lifetime.** Rows are written on spawn, so a
  session that dies immediately still happened; `before-quit` ends sessions and
  `will-quit` releases the database. Nothing else may close the store - the
  window's own `close` handler still writes after `before-quit` has run.

## Credentials

- **Never handle or store one, Claude's or GitHub's.** A sign-in is detected
  only from the *existence* of an artefact - `.credentials.json`,
  `ANTHROPIC_API_KEY`, an onboarding record in `.claude.json` - or from what
  `gh` prints on its own streams. Nothing opens any of them, nor `hosts.yml`,
  the keyring or `GH_TOKEN`. The whole remedy for "not signed in" is a sentence
  naming `claude` or `gh auth login`.
- This is why the pull-request surface shells out to `gh` rather than calling
  the API. A remote URL carrying an embedded token is a credential too, so
  `parseGitHubRemote` strips the userinfo before anything reaches the database.
- The network posture is stated identically in four places - README,
  [docs/PACKAGING.md](docs/PACKAGING.md), the `update:check` comment in
  `shared/ipc.ts`, and SPEC 5. If it moves again, all four move together.

## Overlays

- **Shims live under the app data directory, never `%TEMP%`.** Their
  subdirectories are junctions into real repositories, and a temp cleaner that
  follows a reparse point instead of unlinking it deletes the repo's
  `.claude/skills`. Anything that removes a shim must unlink junctions
  (`fs.rm`) and must never walk into one.
- **Shims are swept only at app start** (`createServices`). Sweeping per launch
  would pull a plugin directory out from under a live session that a different
  profile started.
- **The sweep removes only what it can prove is dead.** A shim's stamp names the
  processes holding it; `cleanStaleShims` asks the kernel about each, counts
  `EPERM` as *alive*, treats a claim from before this boot as dead however the
  pid probes, and **leaves the shim wherever the answer is unknown**. The
  asymmetry is the design: a stale directory is collected at the next start,
  where a live shim deleted is a session that has silently lost its skills.
  "Nothing else is running" is never a thing one process may assume - `PROF-10`
  is two of them, overlapping, and it is what says this still holds.

## Where the data lives

Four modes, and `appMode` in `paths.ts` is the authority. Only one of them
shares a directory with another Helm, and it is opt-in:

| run | data directory |
|---|---|
| installed | `%APPDATA%\Helm` |
| portable | `helm-data` beside the exe |
| `pnpm dev` | `%LOCALAPPDATA%\Helm\dev\helm-data` - its own database, Chromium profile and `overlays/`, seeded each launch from a `VACUUM INTO` copy of the real one. A synthetic `gh` (`--gh=`), so the pull-request pane is offline and every state reachable. `~/.claude` and `claude` are the real ones, because `CLAUDE_CONFIG_DIR` moves credentials and a dev app that cannot sign in cannot host a session. `--fresh` for the first-run state; a second `pnpm dev` gets `dev-2`. |
| `pnpm dev:live` | `%APPDATA%\Helm` - the installed app's. Kept deliberately, says so loudly on the console, and the status bar's mode chip reads `dev · live`. |

A check gets its own directory too, under `%LOCALAPPDATA%\Helm\checks\<name>`;
see the **`checks`** skill.

## Surfaces that degrade

Each of these has one rule that must survive contact with a refactor. The detail
is in the **`surfaces`** skill.

- **`terminal.ts` and `ptyEnv` are load-bearing for TUI fidelity.** Every line
  is there because a spike measured the failure it prevents. Do not "simplify"
  either without reading SPEC 8.3, and never route a setting through the
  `term:*` channels - that is the change that would alter what `pnpm fidelity`
  measures.
- **Usage figures paint nothing rather than a wrong number.** Age alone is the
  exception, painting lower bounds. Dollar figures are estimates and say so.
- **Pull requests degrade the opposite way**: cached rows stay with their age on
  them. One condition stops a fetch pass - there is no `gh` binary. Every other
  reason is a claim about a server, and a claim about a server may never gate
  the request that would correct it (`PR-20`).
- **`~/.claude` is Claude Code's and Helm only reads it**, with exactly one
  exception: the config console writes, through a snapshot taken *before* the
  file is touched that aborts the write if the row cannot be taken.
- **`CLAUDE_CONFIG_DIR` moves credentials too**, so a session pointed at a
  fixture home cannot log in. Measuring the user settings layer means using the
  real `~/.claude/settings.json`, snapshotted and put back.

## Checks

They drive the **real window** and most spawn real `claude` sessions. They are
the only coverage `packages/ui` and `packages/desktop` have - every unit test
lives in `packages/core` - so **a change to a surface a check covers is not done
until that check is green.** They sit outside `pnpm check` deliberately: that
stays fast and hermetic, these take minutes and cost tokens.

The **`checks`** skill has the table of which one a change owes, what each does,
and how to narrow a re-run. Two rules belong here rather than there:

- **A check that can pass with no evidence behind it is worse than no check.**
  `PROF-4` compared a session's answer against headings read from fixture files;
  when the files went missing the expected value became `''`, every answer
  matched, and it reported green for weeks. Any probe that reads an expected
  value out of a fixture must assert the fixture is there and is discriminating.
- **A check gets its own data directory**, reached through
  `PORTABLE_EXECUTABLE_DIR` - never `%APPDATA%\Helm`, which is the app somebody
  is using while the check runs. A new driver calls `isolate(name)` and threads
  its `env` into every spawn.

## Scope

- **Do not use `@anthropic-ai/claude-agent-sdk`.** Helm shells out to the
  `claude` CLI - see SPEC "Supersedes the SDK draft". The app hosts the TUI, it
  does not reimplement the client.
- Helm renders no session messages, parses no session output and handles no
  permission prompts. A feature that seems to need that belongs in the
  transcript-archive backlog or is out of scope.
- Windows-first: junctions (`mklink /J`) not symlinks, no elevation
  assumptions, test paths with spaces.

## Environment notes

Whatever is true of **one machine** - where its `claude` binary sits, what
directory this checkout lives in, which repositories happen to be beside it -
belongs in `CLAUDE.local.md`, which is gitignored. This file describes the
project, and a contributor should be able to follow every rule in it without
owning the machine it was written on.

Nothing in `packages/` may assume any of that either, and two checks say so:
`pnpm packaging-check --only=audit` fails if a personal path or name reaches
what ships, and its publication audit fails if one reaches **anywhere in the
repository** - docs, this file, the scripts and the drivers included. That one
reads the names it looks for from `.audit-private.local`, an uncommitted file,
so the audit never publishes the list it polices; `.audit-private.local.example`
says how to write one.

Both derive what to look for at runtime. Do not answer a failure by adding an
exemption: the hit is the finding.
