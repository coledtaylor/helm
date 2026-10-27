# Testing Helm

Helm's tests come with the repository so that anyone working on it can ship
with confidence. There are two tiers of test, plus a set of diagnostic tools
that are not tests.

| tier | tool | covers | command |
|---|---|---|---|
| unit and integration | vitest | all app behaviour, as close to the code as it can be tested | `pnpm test` (part of `pnpm check`), with coverage |
| end to end | Playwright for Electron | the high-level user workflows, through the built app | `pnpm test:e2e` |
| Rust crates | `cargo test` | the Floti protocol crate (`crates/floti-protocol`) and host (`crates/host`) | `cargo test -p floti-protocol`, `cargo test -p floti-host` |

Both tiers run locally, before a change is merged. CI runs neither: it builds
and releases the app.

The protocol crate generates JSON Schema and TypeScript into
`crates/floti-protocol/generated/`. A test fails when those files are out of
date and names the command that rewrites them:
`cargo run -p floti-protocol --bin generate`. The generated TypeScript is
checked under the repository's strict settings with
`tsc -p crates/floti-protocol/generated/tsconfig.json`. Crate tests write only
to temporary directories.

The host's tests get their support from `crates/host/src/testkit.rs`, which
the crate's own tests turn on through its `testkit` feature: `TestDirs`, a
temporary tree with spaces in its paths holding a home, data, log, config and
runtime folder; `unique_name` for a pipe or socket no other test is using; and
the fake agent. Every folder and socket a host test uses is in a `TestDirs`,
never the real `%LOCALAPPDATA%`, Application Support, XDG data folder or
`~/.config/floti`, and no test registers anything to start at sign-in.

The fake agent (`crates/host/testkit/fake_agent.rs`, the `floti-fake-agent`
binary) is a stand-in for any program a session runs, written in Rust so the
session and host tests need no Node. Each run records its arguments, folder,
variable names, children and every line it read to `<pid>.json` in the folder
`FLOTI_FAKE_AGENT_LOG` names. `--fake-print=<hex>` writes bytes at start,
`--fake-child[=<ms>]` starts a child of its own, `--fake-exit=<code>` exits;
otherwise it answers each line with `echo: <line>`, and `/exit <code>`,
`/print <hex>` and `/child` do the same at its prompt. `--fake-tick=<ms>`
writes `tick <n>` on that interval, for output made while no client watches.
An integration test gets one with `fake_agent!(&dirs)`, and
`FakeAgent::backend` runs it as an agent backend that resumes with
`--resume <id>`.

An agent backend (`crates/host/src/agent/`) is tested against its CLI's fake
in `test/fake-agents`, the same file the app's E2E tests use, run under Node:
`agent/claude_code/tests.rs` launches and resumes through
`test/fake-agents/claude-code.mjs` and asserts on its run log, with the config
folder, home and data folder in a `TestDirs`. Those tests carry core's Claude
Code cases (launch, resume, overlays, agent tool registration, session
records, history, usage, config files, sign-in) with the same inputs and
expectations. `agent/tests.rs` checks the trait's own rules with backends
made in the test, among them one that only runs a program. An E2E test of the
desktop against a backend waits until the desktop talks to the Rust host.

The host process itself is tested in `crates/host/tests/host.rs`, through
`TestClient` (`testkit/client.rs`): a protocol client that connects on the
local socket, says `hello`, makes typed requests and reads a session's
terminal, granting credit as it reads. Most tests run a `Host` in the test
process on a `TestDirs`; the ones about the executable (one instance per data
folder and socket, the SSH refusal, Ctrl+C and SIGTERM, a killed host) run the
built `floti host` with `FLOTI_DATA_DIR`, `FLOTI_RUNTIME_DIR` and the other
folder overrides pointing into the `TestDirs`, `SHELL=/bin/sh`, and the SSH
variables removed. On Windows, Ctrl+C is delivered as `CTRL_BREAK` to the
host's own process group, the only console event one process can send
another. Every test ends every process it started and checks that each
process tree is gone.

`crates/host/tests/os_conditionals.rs` fails, naming each `file:line`, when a
compile-time OS conditional (`cfg(windows)`, `cfg!(unix)`, `target_os` and
the like) appears outside `src/platform/mod.rs` and the per-OS
implementations of the platform concerns (`startup`, `socket`, `folders`,
`process_tree`, `links`, `launcher`). Behaviour that differs by OS goes behind one of those
interfaces, with an implementation for each OS.

## Running them

```bash
pnpm test                          # every vitest project, with coverage
pnpm vitest run --project ui       # one of core, ui, desktop, sdk, sdk-svelte
pnpm vitest run <file>             # one file, while building
pnpm test:e2e                      # builds, then runs every workflow
pnpm --filter @helm/desktop exec playwright test -c e2e panes   # one spec, after a build
cargo test -p floti-protocol       # the protocol crate, its ipc.ts coverage and generated-file check included
cargo test -p floti-host           # the host, with the fake agents (Node on PATH)
cargo run -p floti-protocol --bin generate                      # rewrite the generated schema and TypeScript
pnpm exec tsc -p crates/floti-protocol/generated/tsconfig.json  # the generated TypeScript under strict settings
```

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
  as a `.cmd` shim, two git projects, and the app's data
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

## The fake agents

Every agent backend has a fake CLI in `test/fake-agents/`, one file per backend
named after its id, sharing `common.mjs`. A fake does what Helm and Floti can
observe of the real CLI and nothing more, and it is strict where the real one
is: tests never launch a real agent. The pattern every fake follows:

- **Its arguments are parsed as the real parser does.** A variadic option takes
  values until the next argument that starts with a dash or `--`; everything
  after `--` is positional. An unknown option, too many positionals, or a file
  option naming a missing file fails with the CLI's own error and exit code,
  so a launch that composes argv wrongly fails its test rather than passing.
- **It loads what the real CLI loads** - settings, instruction files, MCP
  servers - from the same places and in the same order, so a test can assert
  what a session would actually have been given.
- **It writes one run log**, `<config dir>/fake-agent/<pid>.json`, in a shape
  every fake shares (`RunLog` in `common.mjs`): `backend`, `argv`, `cwd`,
  `settings` (each source in load order), `instructionFiles` (outermost
  first), `composedInstructions`, `openingPrompt`, `mcpServers`, `received`
  and `exitCode`, then fields of the backend's own.
- **Its version is overridable**: `FAKE_AGENT_VERSION` changes what
  `--version` answers, so a tested-range check can be driven to either side.
- **It writes the artefacts the real CLI writes** that Helm or Floti read: its
  live-session record, history and transcripts, in the real formats.

### Claude Code (`claude-code.mjs`)

Answers `--version` (2.1.999 unless `FAKE_AGENT_VERSION` says otherwise) and
`--help`, draws a prompt, echoes what is typed, and writes the session
registry record under `<config dir>/sessions/` (with a `<pid>.<hash>.key`
file beside it, as the real CLI keeps one, removed at exit), `history.jsonl`
and a transcript whose assistant rows carry a model and token usage.
`--resume` works only in the directory the conversation was recorded in. The
config dir is `CLAUDE_CONFIG_DIR`, or `~/.claude`.

- `--add-dir`, `--mcp-config`, `--plugin-dir` and `--allowedTools` are
  variadic; the opening prompt is the first positional.
- `--settings` takes a file or inline JSON; a missing file fails as the CLI
  does. User, project and local settings are loaded too, and logged in order.
- Instructions: `<config dir>/CLAUDE.md`, then each folder from the root down
  to the working directory. In each, `CLAUDE.md` is loaded; `AGENTS.md` only
  where no `CLAUDE.md` was found in that folder or above it, unless settings
  set `instructionFiles` to `claude-md-and-agents-md`, when both load. Each
  file loads once. `--append-system-prompt-file` is logged as
  `composedInstructions`.
- `--mcp-config` files are read and their servers logged; a missing file fails
  as the CLI does.
- `mcp add-json` and `mcp remove` write `.mcp.json` or `~/.claude.json` as the
  real CLI does.

At its prompt: `/exit` and `/crash` end it with 0 and 3, `/wait` reports
"waiting" until `y` or `n`, `/busy <ms>` reports "busy", `/child` starts a
long-running child process, `/links` asks for the mouse as the fullscreen CLI
does and prints a hyperlink and a bare address (logging the mouse reports it
is sent), and anything else is a prompt it records and answers.

A new backend gets its fake here, written to the same pattern, before its
backend code: the backend's tests drive the fake, never the real CLI.

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
