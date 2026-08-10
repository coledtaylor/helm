# Helm

A portable, configurable desktop shell **on top of** Claude Code. Not a client,
not a reimplementation - Helm hosts the real `claude` TUI in an embedded terminal
and owns everything that happens *before* and *after* a session.

## Why

Claude Code resolves `.claude/` configuration (skills, commands, agents, CLAUDE.md)
relative to the working directory. That forces a bad choice at launch time:

| Launch from | You get | You lose |
|---|---|---|
| Harness/workspace root | cross-repo access, workspace tooling | every project-local skill and agent |
| A single repo | that repo's skills and agents | cross-repo access |

Helm dissolves the tradeoff: it synthesizes **overlay plugins** from each project's
`.claude/` directory and launches `claude` from the root with `--plugin-dir` per
overlay - root cwd, project skills composed in.

## Core concepts

- **Profile** - a saved launch composition: root cwd + overlay projects +
  `--add-dir` access + model/effort/permission-mode + MCP set + opening prompt.
  One click to launch. Exportable as YAML.
- **Launcher** - all projects, plus every session ever recorded in
  `~/.claude/history.jsonl` across every directory (the CLI's `/resume` only sees
  the cwd), searchable by prompt text and resumable into tabs. Claude Code reaps
  transcripts and keeps prompts, so the ones that can no longer be reopened say
  so rather than offering a resume that fails.
- **Config console** - browse/edit any scope's `.claude/` tree with an *effective
  view* showing what a session would actually see, every write snapshotted with undo.
- **Content viewer** - rendered markdown (Obsidian flavor, `[[wikilinks]]`) and
  sandboxed HTML for everything Claude writes.
- **Terminal** - xterm.js + node-pty hosting the unmodified `claude` TUI. Helm
  supplies argv, cwd, and environment, then gets out of the way.

## Architecture

```
packages/
├── core/      # headless: launch/, discovery/, config/, store/ - ZERO electron imports
├── ui/        # React components
└── desktop/   # Electron main + preload + renderer + pty host
```

Stack: Electron, TypeScript strict, React + Vite, shadcn/ui + Tailwind,
xterm.js + node-pty, better-sqlite3 + Drizzle, electron-builder (portable + NSIS).

The one hard rule: **`core/` never imports Electron** (ESLint-enforced). That is
what keeps the app portable and a future mobile client possible.

## Status

All three de-risking spikes are **GO**, and M1-M4 have landed. M5 (config
console) is next. See [docs/SPEC.md](docs/SPEC.md) for the full v1 spec and
[docs/TASKS.md](docs/TASKS.md) for the work plan.

| Spike | Question | Verdict |
|---|---|---|
| A | Does `--plugin-dir` load a *synthesised* overlay? | GO |
| B | Do `node-pty` and `better-sqlite3` survive portable packaging? | GO - [docs/SPIKE-B.md](docs/SPIKE-B.md) |
| C | Is the real `claude` TUI fully usable inside xterm.js? | GO, embedded-first - [docs/SPIKE-C.md](docs/SPIKE-C.md) |

| Milestone | Landed |
|---|---|
| M1 Foundation | monorepo, SQLite store, project discovery, window shell |
| M2 Embedded terminal | real `claude` TUI in tabs, session lifecycle recorded, clean teardown |
| M3 Profiles | overlay composition through `--plugin-dir`, YAML round-trip - **the product premise, proven** |
| M4 Session launcher | 799 sessions / 36 projects indexed from `history.jsonl`, ~3 ms search, resume into a tab |

## Development

Requires Node 22+ and pnpm 10. `node-linker=hoisted` is set in `.npmrc` so
`node_modules` has the flat shape Spike B verified the packaging against.

```bash
pnpm install
pnpm dev               # the app, with hot reload
pnpm check             # typecheck + lint + unit tests (what CI runs)
pnpm dist:win          # portable exe + NSIS installer
```

Spike B and C's harnesses are the regression tests for the terminal
configuration. They render their own page (`spike.html`) and open no database:

```bash
pnpm shell             # interactive pane hosting pwsh
pnpm --filter @helm/desktop claude   # ...hosting the real claude TUI
pnpm fidelity          # terminal fidelity checks     (C1-C9)
pnpm claude-check      # real-TUI checks              (D0-D7)
pnpm selftest          # Spike B packaging regression
```

Each milestone has its own driver, which exercises the app through the real
window - clicking sidebar rows, typing into search boxes, spawning real `claude`
sessions - rather than calling the main process directly:

```bash
pnpm m2-check          # sessions, tabs, teardown
pnpm m3-check          # overlay composition, asked of a live session
pnpm m4-check          # the session index, checked against ~/.claude itself
```

All the drivers accept `--only=` to re-run part of a run (`--only=C5,C6`,
`--only=list,search`). They write a JSON report and screenshots to the app data
directory, and the report - not the exit status - is the verdict: node-pty's
teardown can lose the exit code after the checks have already passed.

Schema changes go through Drizzle:

```bash
pnpm db:generate       # drizzle-kit generate, then embed the SQL into the bundle
```
