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
