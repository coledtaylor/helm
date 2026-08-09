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
- The terminal configuration in `packages/desktop/src/renderer/src/terminal.ts`
  and `ptyEnv` in `packages/desktop/src/main/pty.ts` is load-bearing for TUI
  fidelity, and every line of it is there because Spike C measured the failure
  it prevents. Do not "simplify" it without reading
  [docs/SPIKE-C.md](docs/SPIKE-C.md); `pnpm fidelity` and `pnpm claude-check`
  are the regression tests. They render `spike.html`, a separate page from the
  app, so app layout changes cannot move the terminal under them.
- Every renderer↔main channel is declared in
  `packages/desktop/src/shared/ipc.ts` and nowhere else. The preload exposes
  three generic functions; a feature adds a channel to the contract, not a
  method to the bridge.
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
