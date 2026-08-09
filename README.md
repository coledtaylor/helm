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
- **Launcher** - all projects and all historical sessions across every directory
  (the CLI's `/resume` only sees the cwd), resume into tabs.
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

All three de-risking spikes are **GO**; milestone work (M1) is next. See
[docs/SPEC.md](docs/SPEC.md) for the full v1 spec and
[docs/TASKS.md](docs/TASKS.md) for the work plan.

| Spike | Question | Verdict |
|---|---|---|
| A | Does `--plugin-dir` load a *synthesised* overlay? | GO |
| B | Do `node-pty` and `better-sqlite3` survive portable packaging? | GO - [docs/SPIKE-B.md](docs/SPIKE-B.md) |
| C | Is the real `claude` TUI fully usable inside xterm.js? | GO, embedded-first - [docs/SPIKE-C.md](docs/SPIKE-C.md) |

## Development

```bash
npm ci
npm run shell          # interactive pane hosting the real claude TUI
npm run fidelity       # terminal fidelity checks     (C1-C9)
npm run claude-check   # real-TUI checks              (D0-D7)
npm run selftest       # Spike B packaging regression
npm run dist:win       # portable exe + NSIS installer
```

The check drivers accept `--only=C5,C6` to re-run individual checks. They write
a JSON report and screenshots to the app data directory.
