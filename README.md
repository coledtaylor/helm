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

Pre-spike. See [docs/SPEC.md](docs/SPEC.md) for the full v1 spec and
[docs/TASKS.md](docs/TASKS.md) for the work plan. Spike A (overlay composition
via `--plugin-dir`) is the load-bearing assumption and gates everything else.
