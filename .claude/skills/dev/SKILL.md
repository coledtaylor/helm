---
name: dev
description: Running Helm in development, looking at a change, and the diagnostic drivers. Use before launching the app to look at something, driving the window you have open, or diagnosing a problem a test cannot reach.
---

## The dev build

```bash
pnpm dev            # its own data directory; the database is a copy of the real one
pnpm dev --fresh    # no database: the first-run state
pnpm dev --drive    # also opens a remote debugging port for drive-dev.mjs
```

- The data directory is `%LOCALAPPDATA%\Helm\dev\helm-data`, seeded each launch
  from a `VACUUM INTO` copy of the real database. Anything changed in dev,
  settings included, is gone at the next launch. A second `pnpm dev` gets
  `dev-2`.
- `gh` is synthetic (`scripts/fake-gh.mjs`): 0-3 stable pull requests per
  repository, derived from the slug. `HELM_FAKE_GH_STATES=draft,failing,big-diff`
  forces a set. It refuses `pr checkout`.
- `~/.claude` and `claude` are the real ones, because `CLAUDE_CONFIG_DIR` moves
  credentials and a dev app that cannot sign in cannot host a session. Dev
  sessions land in the real `~/.claude/history.jsonl`.
- Templates are copied once and then left alone; `--fresh` re-copies them.

`pnpm dev:live` runs against the installed app's `%APPDATA%\Helm`. Do not use it
unless the owner asks.

## Looking at the window

With `pnpm dev --drive` running:

```bash
node packages/desktop/scripts/drive-dev.mjs text             # what the window says
node packages/desktop/scripts/drive-dev.mjs controls         # every button, by label
node packages/desktop/scripts/drive-dev.mjs click "Pull requests"
node packages/desktop/scripts/drive-dev.mjs eval "window.helm.invoke('settings:write', {...})"
node packages/desktop/scripts/drive-dev.mjs shot pulls.png
```

`shot` captures the renderer's own pixels, so it works with the window covered.
The port is off unless `--drive` asks for it.

## Diagnostic drivers

These drive the real window and are tools for diagnosis, not tests. Nothing has
to pass them before a change is done. Each runs in its own data directory under
`%LOCALAPPDATA%\Helm\checks\<name>`.

| command | answers |
|---|---|
| `pnpm fidelity` | does xterm still render a TUI correctly (spike page, no sessions) |
| `pnpm claude-check` | does the real `claude` CLI behave inside Helm's terminal |
| `pnpm packaging-check` | first run, the built artefacts and the personal-path audit; only when the owner asks |

Most take `--only=<group>`; the `GROUPS` constant in each driver is the list.
