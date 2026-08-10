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

## What it does

- **Profiles.** A saved launch composition: root cwd + overlay projects +
  `--add-dir` access + model/effort/permission-mode + MCP set + opening prompt.
  One click to launch. Exportable as YAML, so it travels with a workspace.
- **A terminal that hosts the real thing.** xterm.js + node-pty running the
  unmodified `claude` TUI in tabs. Helm supplies argv, cwd and environment, then
  gets out of the way - it renders no messages, parses no output, handles no
  permission prompts.
- **Project discovery.** Workspaces and their repos, auto-detected, with each
  one's skill/agent/command counts and git state at a glance.
- **Session history.** Every session recorded in `~/.claude/history.jsonl`,
  across every directory - which the CLI's `/resume` cannot show you, because it
  reads only the one you started it in. Grouped by project, searchable by prompt
  text, resumable into a tab.

  Claude Code keeps prompts indefinitely and reaps the transcripts behind them,
  so most of that list is a record rather than a door. Helm marks which is which
  instead of offering a resume that fails.

Planned for v1: a config console over `.claude/` trees, and a viewer for the
markdown and HTML Claude writes. See [docs/SPEC.md](docs/SPEC.md).

## Architecture

```
packages/
├── core/      # headless: launch/, discovery/, store/ - ZERO electron imports
├── ui/        # React components
└── desktop/   # Electron main + preload + renderer + pty host
```

Stack: Electron, TypeScript strict, React + Vite, Tailwind, xterm.js + node-pty,
better-sqlite3 + Drizzle, electron-builder (portable + NSIS).

`core` and `ui` export TypeScript source rather than a build output, so the
bundler compiles them in and there is one build step instead of three.

The one hard rule: **`core/` never imports Electron** (ESLint-enforced). That is
what keeps the app portable and a future mobile client possible.

## Documentation

- [docs/SPEC.md](docs/SPEC.md) - the v1 spec, with the measured evidence behind
  each design decision. Read this before changing anything.
- [CLAUDE.md](CLAUDE.md) - the rules that are load-bearing rather than stylistic,
  and why each one is there.
- [docs/TASKS.md](docs/TASKS.md) - what is built and what is not.
- [docs/SPIKE-B.md](docs/SPIKE-B.md), [docs/SPIKE-C.md](docs/SPIKE-C.md) - the
  packaging and terminal-fidelity findings the current configuration rests on.

## Development

Requires Node 22+ and pnpm 10. `node-linker=hoisted` is set in `.npmrc` because
packaging native modules into a portable exe needs the flat `node_modules`
shape.

```bash
pnpm install
pnpm dev               # the app, with hot reload
pnpm check             # typecheck + lint + unit tests (what CI runs)
pnpm dist:win          # portable exe + NSIS installer
```

Beyond the unit tests there are two families of driver. Both are real: they open
windows, click things, and spawn actual `claude` processes, so they take minutes
and cost tokens.

The terminal harnesses render their own page (`spike.html`) and open no
database. They guard the pty and xterm configuration, every line of which
prevents a specific measured failure:

```bash
pnpm shell             # interactive pane hosting pwsh
pnpm --filter @helm/desktop claude   # ...hosting the real claude TUI
pnpm fidelity          # terminal fidelity            (C1-C9)
pnpm claude-check      # the real TUI in the pane      (D0-D7)
pnpm selftest          # native modules in a packaged build
```

The app drivers go through the real window - clicking sidebar rows, typing into
search boxes - rather than calling the main process directly, so what they prove
is that the thing on screen is wired to the thing underneath:

```bash
pnpm m2-check          # sessions, tabs, teardown
pnpm m3-check          # overlay composition, asked of a live session
pnpm m4-check          # the session index, checked against ~/.claude itself
```

All of them accept `--only=` to re-run part of a run (`--only=C5,C6`,
`--only=list,search`) and write a JSON report and screenshots to the app data
directory. **The report is the verdict, not the exit status** - node-pty's
teardown can lose the exit code after the checks have already passed.

Schema changes go through Drizzle:

```bash
pnpm db:generate       # drizzle-kit generate, then embed the SQL into the bundle
```
