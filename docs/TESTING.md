# Testing Helm

Helm's tests come with the repository so that anyone working on it can ship
with confidence. There are two tiers of test, plus a set of diagnostic tools
that are not tests.

| tier | tool | covers | command |
|---|---|---|---|
| unit and integration | vitest | all app behaviour, as close to the code as it can be tested | `pnpm test` (part of `pnpm check`), with coverage |
| end to end | Playwright for Electron | the high-level user workflows, through the built app | `pnpm test:e2e` |

Both tiers run locally, before a change is merged. CI also runs the unit and
integration tier, as `pnpm check`, on Windows, macOS and Linux runners on every
push. All three jobs are required: a failure on any one fails the run and, from
the release workflow, stops the release. The end-to-end tier runs locally only,
never in CI.

## Running them

```bash
pnpm test                          # every vitest project, with coverage
pnpm vitest run --project ui       # one of core, ui, desktop, sdk, sdk-svelte
pnpm vitest run <file>             # one file, while building
pnpm test:posix                    # the POSIX code's tests: under Linux in WSL on Windows, natively elsewhere
pnpm test:posix <file> ...         # the same, for these files
pnpm test:e2e                      # builds, then runs every workflow
pnpm --filter @helm/desktop exec playwright test -c e2e panes   # one spec, after a build
```

## Windows, macOS and Linux

Every test runs on all three, and a test that only holds on one says so with
`it.runIf(process.platform === ...)` and a comment naming why: a drive letter,
a `.cmd` shim, a file system that folds case. Paths a test hands the code are
absolute on the OS it runs on. Links to folders are made with `linkFolder`
(`test/links.ts`), a junction on Windows and a symbolic link elsewhere, as
overlays make them. The fake `claude` is a `.cmd` shim on Windows and an
executable `sh` script elsewhere (`writeFakeClaude` in `test/world.ts`), and a
world's root is a real path, because on macOS the temporary folder is reached
through a link.

A temporary folder is not always its own real path: macOS's is under `/var`, a
link to `/private/var`, and a GitHub Windows runner's TEMP is the 8.3 alias
`C:\Users\RUNNER~1\...`. Code that checks one path is inside another resolves
both before comparing them, and its tests reach the folder through a link
(`linkFolder`) and, on Windows, through its 8.3 alias (`shortPath`, also in
`test/links.ts`). To run tests the way those machines do, set TEMP and TMP to a
short alias on Windows, or point TMPDIR at a link to a folder - from Windows,
`TMPDIR=/tmp/<link> WSLENV=TMPDIR pnpm test:posix <files>`.

The code that differs by OS - the processes-and-ports pass, overlay links,
ending a process tree, the data directories and node-pty's spawn-helper mode -
has its tests run where that code is the POSIX one by `pnpm test:posix`
(`scripts/test-posix.mjs`):

- **On macOS and Linux** it runs those test files natively, in the checkout.
- **On Windows** it runs them under Linux in WSL. It mirrors the working tree
  into `~/.cache/helm-posix/<checkout>` inside WSL with `rsync` (no
  `node_modules`, `.git` or build output), runs `pnpm install
  --frozen-lockfile` there when `pnpm-lock.yaml` has changed since the last
  install, and runs the tests in that copy. The copy is Linux-side because a
  tree under `/mnt/c` has Windows native modules and no POSIX links or
  permissions. WSL needs Node 22 or later, on `PATH` or under
  `~/.local/node` (no `sudo` needed), and `rsync`; pnpm is the version
  `package.json` pins, through `npx` when it is not installed.

Files given on the command line replace the default set, so any test can be run
under Linux the same way.

## Unit and integration tests

vitest runs five projects (`vitest.config.ts`):

- **core** - pure logic in `packages/core`, in Node.
- **ui** - components in `packages/ui` and modules in the renderer, in jsdom
  with Testing Library. Find elements by role and accessible name. jsdom does
  no layout, so anything about where something lands belongs in the tier
  below.
- **desktop** - main-process services, in Node. `vi.mock('electron')` with
  `test/electron.ts` stands in for Electron; ptys are real and run the fake
  `claude`. `sessions.test.ts` is the example.
- **sdk** - the plugin SDK in `packages/plugin-sdk/test`: its validator,
  schema and command in Node, the package as npm publishes it, and its React
  and Vue helpers in jsdom against the fake bridge in `test/bridge.ts`.
- **sdk-svelte** - a compiled Svelte component reading the SDK's stores, in
  jsdom. Apart from `sdk` because it resolves Svelte's browser build.

Tests live beside the code as `*.test.ts` or `*.test.tsx`. Logic tangled with
Electron or React moves into a module that can be tested on its own, as
`core/layout/panes.ts` was for the pane layout. The tier runs in seconds and
touches no network, no real `~/.claude` and no real `claude`.

Helpers for the desktop project live in `packages/desktop/test/`:

| helper | gives a test |
|---|---|
| `world.ts` | a temporary home, data directory, fake CLIs and two git projects |
| `electron.ts` | the `electron` module, with windows, dialogs and the network inert |
| `browser-electron.ts` | WebContentsView, its web contents and the browser partition, whose events the test raises |
| `hosted.ts` | a session host running in a world |
| `history-fixture.ts` | `history.jsonl` and transcripts written as the CLI writes them |
| `overlay-world.ts` | a harness with overlays, and shims held by live or exited processes |
| `mcp-client.ts` | a minimal MCP client for the agent endpoint |
| `self-signed.ts` | a self-signed certificate minted at run time |

A test-only helper that has to live under `src` - the renderer's tsconfig
cannot reach `test/` - is named `*.testkit.ts` or `*.testkit.tsx`, and coverage
skips it. The renderer's fake of the preload bridge is `app/bridge.testkit.ts`.

Two traps: `user-event` hangs under fake timers (its async wrapper waits on a
real `setTimeout`), so a test on fake timers uses `fireEvent`; and jsdom has no
`ResizeObserver`, `scrollTo` or `execCommand`, so a test that needs one stubs
it (`CodeEditor.testkit.ts` has them).

## Coverage

`pnpm test` measures coverage over `packages/*/src` (the diagnostic drivers and
their spike page excepted), prints a summary and writes an HTML report to
`reports/coverage`. The thresholds in `vitest.config.ts` are a fixed floor of
70% (branches 68%); a run below them fails, and nothing raises them
automatically. A targeted `vitest run` measures nothing, so it never trips them.

## End-to-end tests

`packages/desktop/e2e/`. One test per user workflow; detail belongs in the
tier above, so keep this one small.

| spec | workflows |
|---|---|
| `sessions` | a session from start to end; renaming a tab and closing it with confirmation; quitting ends every session and what it started; a link Ctrl+clicked in a session that has the mouse |
| `panes` | two panes, the waiting one marked |
| `settings` | a setting survives a restart; the gear opens Settings and Ctrl+Tab walks every tab |
| `history` | an ended session is in history and resumes where it ran |
| `profiles` | a profile made in the form starts with its overlay when saved |
| `launcher` | Ctrl+N, a folder typed, a profile and mode picked there; a conversation reopened in the pane beside; a new harness and a new profile each end in a session |
| `restore` | the main process killed outright, then started again: the sessions come back in their panes, folders, profile and mode, a `/clear`ed one in the conversation it moved to; not now reopens nothing and is not asked again; ticked to resume without asking, the next crash is put back unasked |
| `config` | an edit saved to disk and undone byte for byte |
| `content` | a wikilink followed; an HTML artifact framed with no reach |
| `files` | a file opened from the tree beside its session, its changed lines counted, its line numbers to the bottom, and the view following the session's next edit; Ctrl+P, and the hand-offs to VS Code, Explorer and the clipboard |
| `browser` | browsing; the security posture; the refusals; a cookie surviving a restart |
| `agent-tools` | a session drives the browser pane through its own token, and only its own tabs |
| `plugins` | the sample plugin against a server of its own: its background page, a secret it asks for, its panel, badge, status and a tab with parameters; `helm.fetch` held to the manifest's origins on every redirect; Helm's shortcuts from inside a plugin page and its commands from Ctrl+Shift+P; a crashed plugin page and Reload; an unsupported `apiVersion` said in Settings, and a plugin turned off and on; a theme change reaching a page without reloading it; a session calling the plugin's tools, answered by its background page, and losing them when they are turned off in Settings |

- **Each test gets a world** (`test/world.ts`): a temporary root with a space in
  its path, holding a home directory with its own `.claude`, the fake `claude`
  (a `.cmd` shim on Windows, an `sh` script elsewhere), two git projects, and the app's data
  directory (`PORTABLE_EXECUTABLE_DIR`). Settings are seeded through the app's
  own store before it starts: the projects folder scanned, the fake `claude`
  chosen, first run done, the update check off. Nothing reaches the network, a
  real `~/.claude` or the installed app.
- **`e2e/helm.ts`** has the `test` fixture (`world`, `helm`, `relaunch`) and
  the helpers: `startSession`, `typeLine`, `terminalText`, `claudeRunIn`,
  `processAlive`.
- **Find elements by role and accessible name**, as a user sees them. Two
  exceptions, both read-only: terminal text comes from
  `window.__helmTerminals()`, because xterm paints to a canvas; and a pane's
  "needs you" state is `data-pane-attention`, which has no ARIA equivalent.
- **The browser pane's page** is a native view, not part of the window's DOM.
  Once it has loaded a page, it appears in `app.windows()` as a page of its
  own.
- **A plugin's page** is a frame of the window: `e2e/plugin-fixture.ts` copies
  the sample plugin into the world, registers it, starts its server, and finds
  a page with `pluginFrame`. `test:e2e` builds the sample first. Once a plugin
  frame's process ends, Playwright counts the whole window as crashed and will
  not drive it again, so the crash test drives the window through the main
  process instead.
- Wait on conditions (`expect`, `expect.poll`), never on sleeps.

## The fake `claude`

`packages/desktop/test/fake-claude.mjs` does what Helm can observe of the real
CLI and nothing more. It answers `--version` and `--help`, draws a prompt,
echoes what is typed, and writes the session registry record, `history.jsonl`
and a transcript. `--resume` works only in the directory the conversation was
recorded in. It reads its argv as the real CLI's parser does: `--add-dir`,
`--mcp-config` and `--allowedTools` take every argument up to the next that
starts with a dash, `--` ends the options, and what is left is the opening
prompt. An `--mcp-config` value that is neither JSON nor a file that exists
fails the run with the real CLI's error. Everything it was given and received,
the opening prompt it read, the MCP servers it loaded and the tools it allows
without asking are logged to `<claude dir>/fake-claude/<pid>.json`.

It also answers `mcp add-json` and `mcp remove` by writing `.mcp.json` or
`~/.claude.json` as the real CLI does.

At its prompt: `/exit` and `/crash` end it with 0 and 3, `/wait` reports
"waiting" until `y` or `n`, `/busy <ms>` reports "busy", `/child` starts a
long-running child process, `/links` asks for the mouse as the fullscreen CLI
does and prints a hyperlink and a bare address (logging the mouse reports it
is sent), and anything else is a prompt it records and answers.

## Rules for every test

- **A failing test means something is broken**, in the app or in the test. Fix
  it or delete it. Tests are never retried.
- **Assert against an independent expectation**, not against the output of the
  code under test.
- **A test whose expected value comes from a fixture asserts the fixture is
  there first.** An empty expectation matches everything and passes with no
  evidence.
- A bug gets a failing test before its fix.

## Not covered by tests

Deliberately left out, because a test of them would be fragile or would test
something other than Helm:

- **Pixel geometry and computed styles** - gutters, radii, overflow at a window
  width, cursors and hover states, list bullets. The logic behind them (a CSS
  variable written, a setting applied, a write once per drag) is tested; what
  Chromium then paints is checked by looking: `pnpm dev --drive` and
  `drive-dev.mjs shot`.
- **Frame timing and performance budgets**, beyond the one search budget in
  `store/history.test.ts`.
- **What Chromium and Electron do on their own** - a hidden view still painting,
  cache bypass, zoom, the undo stack.

Compatibility with the real `claude` CLI changes with every CLI release, and
depends on what is installed on the machine, so it cannot be deterministic.
The diagnostic drivers cover it on demand: `pnpm claude-check` and
`pnpm fidelity` for the terminal, and `scripts/drive-dev.mjs` for looking at a
running dev build. The `dev` skill (`.claude/skills/dev`) describes them.
None of them has to pass before a change is done.
