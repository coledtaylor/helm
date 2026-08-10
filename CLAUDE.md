# Helm - Agent Instructions

Desktop shell on top of Claude Code. Read [docs/SPEC.md](docs/SPEC.md) before
doing anything - it contains the measured evidence and design decisions. Do not
re-litigate decisions recorded there without new evidence.

## Work tracking

Work is tracked in ClickUp: list **"Helm - Claude Code Shell"** (id `901114291892`)
in the "the author's workspace" space. [docs/TASKS.md](docs/TASKS.md) maps task IDs to scope.

- Pick tasks in priority order. **Spike A gates everything** - if it has no
  recorded verdict yet, it is the only valid task to start.
- Each task has checkbox acceptance criteria. A task is done when every box is
  checked, not before. Update the ClickUp task with findings and check the boxes
  as you go.
- Spike findings also get a reference note in the harness (`../../notes/`) per
  harness convention.

## Layout

```
packages/
├── core/     # headless: discovery/, store/ (+ launch/, config/ to come)
├── ui/       # React components
└── desktop/  # Electron main + preload + renderer + the spike harness
```

pnpm workspaces, `node-linker=hoisted` (see `.npmrc` for why). `core` and `ui`
export TypeScript source rather than a build output, so the bundler compiles
them in and there is one build step, not three. `pnpm check` is what CI runs.

## Hard rules

- `packages/core/` must never import Electron. Enforced by the
  `no-electron-in-core` block in `eslint.config.js`, which blocks static
  imports, `require()`, and dynamic `import()`. If core needs something from the
  host, the host passes it in as an argument.
- The renderer and `packages/ui/` may import **types** from `@helm/core`
  anywhere - they are erased - but a **value** import must come from
  `@helm/core/types`, which has no `node:` imports behind it. The package root
  reaches the filesystem through `launch/` and `store/`, and pulling that into
  the browser bundle fails at rollup, not at typecheck, so `pnpm typecheck`
  will not catch it. `EFFORT_LEVELS` and `PERMISSION_MODES` are the ones this
  comes up for.
- Overlay shims live under the app data directory, never `%TEMP%`. Their
  subdirectories are junctions into the user's real repositories, and a temp
  cleaner that follows a reparse point rather than unlinking it deletes the
  repo's `.claude/skills`. For the same reason, anything that removes a shim
  must use a delete that unlinks junctions (`fs.rm`) and must never walk into
  one.
- Overlay shims are swept **only** at app start (`createServices`). Sweeping
  per launch would pull a plugin directory out from under a live session that a
  different profile started.
- The terminal configuration in `packages/desktop/src/renderer/src/terminal.ts`
  and `ptyEnv` in `packages/desktop/src/main/pty.ts` is load-bearing for TUI
  fidelity, and every line of it is there because Spike C measured the failure
  it prevents. Do not "simplify" it without reading
  [docs/SPIKE-C.md](docs/SPIKE-C.md); `pnpm fidelity` and `pnpm claude-check`
  are the regression tests. They render `spike.html`, a separate page from the
  app, so app layout changes cannot move the terminal under them.
- `pnpm m2-check` is the same idea for the app itself: it drives the real
  window - clicking sidebar rows, the launch button, tabs and their close
  buttons - and asserts on processes, grids and database rows. Run it after
  touching session lifecycle, the tab strip, or shutdown.
- `pnpm m3-check` does it for composition: it builds a profile through the real
  form, launches it, and asks the live session whether the overlays' skills and
  instructions actually arrived. Run it after touching `core/launch/`, the
  profile UI, or the argv builder. It spawns real `claude` sessions on haiku and
  takes minutes. It runs in three phases - the driver, a second real app start
  (`--shim-sweep`), then `scripts/verify-shims.mjs` - because "stale shims are
  cleaned at startup" cannot be asserted by the process that already started.
- `pnpm m4-check` covers the session index. It drives the history pane through
  the real window and checks every count against its own independent read of
  `~/.claude/history.jsonl` - a parser agreeing with itself proves nothing. It
  spawns two real `claude` sessions (one resumed through the app, one on its own
  pty to prove the watcher notices a session Helm did not start), so it takes
  minutes; `--only=list,search,resume,reaped,outside` narrows a re-run.
- `pnpm m5-check` covers the config console. Same discipline: the tree is
  checked against its own `readdirSync` walk, restores against its own
  `sha256`, and predicted overlay namespaces against a hand-built
  `basename(overlay):skill` list. The effective view is then checked against a
  **live session** - three predicted skills invoked, and the settings winner
  read back out of `env` - because a prediction about a session is only worth
  what a session says about it. Spawns one `claude` on haiku;
  `--only=browse,edit,snapshot,json,external,mcp,effective,doctor` narrows it.
- `pnpm usage-check` covers the status bar's usage figures. Same discipline: a
  plain `JSON.parse` beside `parseUsage`, a hand-written "which of these may be
  shown" beside `usageView`, a hand-computed weekday beside `formatResetsIn`, a
  hand-written parse of all 163 transcripts beside the incremental index, and a
  regex over the rendered text beside the component. Three of the criteria could
  not be settled by agreement and are not: a live `claude` is asked for `/usage`
  and its own panel compared to the bar, a fixture's window is set to expire ten
  seconds out so a rollover happens *underneath* the segment, and the full parse
  the index avoids is measured rather than quoted. Two phases, because "the mode
  survives a restart" cannot be asserted by the process that set it. Spawns one
  `claude` session and runs no inference;
  `--only=read,watch,resets,degrade,setting,width,cost,dollars,live` narrows it.
- Usage figures degrade to **nothing** rather than to a stale number. The
  server's own answer in `cachedUsageUtilization` is authoritative but dated, so
  a reading older than `USAGE_STALE_AFTER_MS`, one whose `resets_at` has already
  passed, a missing key, or a reshaped object all paint no number and put the
  reason in the tooltip. Measured on 2.1.225: the 5-hour window rolled over
  between two reads and the cached figure went 51% to 21%. The binding limit of
  a group is the one with the **highest percent**, not the one flagged
  `is_active` - that was observed set on the lower of the two.
- Dollar figures are **estimates and say so**, because `spend.enabled` is false
  on a subscription plan and every `*_dollars` the server sends is null. The
  price table's date lives in `PRICE_TABLE_DATE` and the UI reads it from there,
  so a stale table is visible rather than merely authoritative-looking. A model
  with no rate on file is counted, left unpriced, and named.
- **A check that can pass with no evidence behind it is worse than no check.**
  M3-4 asked a session to quote two skills' headings and compared against the
  files on disk - and when those files went missing, `firstHeading` returned
  `''`, the expected token became `SKILL1=`, and every answer matched. It
  reported green for weeks. Any probe that reads an expected value out of a
  fixture must assert the fixture is there and is discriminating.
- `~/.claude` is Claude Code's, and Helm only ever reads it - with one
  exception, which is the whole of M5: the config console **writes** to it.
  That is why the snapshot is not optional. Every byte Helm puts into a
  `.claude` tree goes through `config:write` -> `writeConfigFile`, which takes
  the previous content into `config_snapshots` *before* touching the file and
  aborts the write if the row cannot be taken. Two facts about the directory
  are load-bearing and were measured on 2.1.225, not assumed:
  - `--resume <id>` resolves the id **against the working directory**. From
    anywhere else it prints "No conversation found with session ID" and exits 1.
    So a resume must set cwd to the directory `history.jsonl` recorded, and a
    project that has been deleted makes a session unresumable even though its
    transcript is still there.
  - A transcript is found by **scanning `projects/*` for `<uuid>.jsonl`**, never
    by deriving a path from the recorded project. The directory name carries
    whatever casing the CLI was started with, `history.jsonl` records its own,
    and the two disagree on this machine - a derived path reports live
    conversations as reaped.
  Resuming passes no `-n`: the session already has a name, and renaming it
  would be a side effect of Helm having opened it. The tab's label is Helm's own.
- Settings layers merge **per leaf**, not per top-level key: a project
  `settings.json` setting `env.A` and a `settings.local.json` setting `env.B`
  produce a session with both, and where they name the same leaf the local one
  wins. Measured on 2.1.225 by reading `env` back out of a live session, which
  is why `EffectiveSetting` is keyed by `env.A` rather than by `env`.
  Precedence is local > project > user; enterprise policy and CLI flags sit
  above all three and are not files this console edits.
- `CLAUDE_CONFIG_DIR` genuinely moves the config directory - credentials
  included - so a session pointed at a fixture home cannot log in. Anything
  that has to measure the *user* settings layer has to use the real
  `~/.claude/settings.json`, snapshot it, and put it back.
- Every renderer↔main channel is declared in
  `packages/desktop/src/shared/ipc.ts` and nowhere else. The preload exposes
  three generic functions; a feature adds a channel to the contract, not a
  method to the bridge. Two terminal families exist and do not mix: `term:*` is
  the spike page's single pty, `session:*` is the app's many. Changing `term:*`
  changes what `pnpm fidelity` and `pnpm claude-check` measure.
- A session's terminal lives in
  `packages/desktop/src/renderer/src/app/terminals.ts`, outside React, and is
  disposed when its tab closes rather than when a component unmounts. Scrollback
  cannot be rebuilt from props, so it must not depend on a render. Panes are
  hidden, never unmounted - and a hidden pane measures 0x0, which `FitAddon`
  turns into a 1x1 grid the pty acts on. That guard is in `terminal.ts`.
- The main process owns process lifetime: rows are written on spawn (so a
  session that dies immediately still happened), `before-quit` ends sessions,
  `will-quit` releases the database. Nothing else may close the store - the
  window's own `close` handler still writes to it after `before-quit` has run.
- Schema changes: edit `packages/core/src/store/schema.ts`, then
  `pnpm db:generate`. The generated SQL is embedded into the bundle, so a
  packaged exe carries its migrations rather than needing files beside it.
- Do not use `@anthropic-ai/claude-agent-sdk`. Helm shells out to the `claude`
  CLI. This is a deliberate architectural decision (see SPEC "Supersedes the SDK
  draft") - the app hosts the TUI, it does not reimplement the client.
- Helm renders no session messages, parses no session output, handles no
  permission prompts. If a feature seems to need that, it belongs in the
  transcript-archive backlog or it is out of scope.
- Never handle or store Claude credentials. Detect, and direct the user to run
  `claude` themselves.
- Windows-first: junctions (`mklink /J`) not symlinks; no elevation assumptions;
  test paths with spaces.

## Environment notes

- `claude` CLI is at `~/.local/bin/claude` (2.1.x). Pin behavior against the
  installed version; assert on `claude --version` at startup (warn, don't block).
- This repo lives inside a harness (`~/.harness/dev/repos/helm`). The harness
  root and sibling repos (atlas, atlas-reporting) are the primary test
  fixtures for overlay composition - they have real `.claude/skills` to compose.
- Verify claims against the machine, not memory: plugin anatomy can be inspected
  at `~/.claude/plugins/cache/claude-plugins-official/*/`, session history at
  `~/.claude/history.jsonl`.
