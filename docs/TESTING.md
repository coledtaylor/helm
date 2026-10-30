# Testing Helm

Helm's tests come with the repository so that anyone working on it can ship
with confidence. There are three tiers of test, plus a set of diagnostic tools
that are not tests. A test sits in the lowest tier that can show what it
checks.

| tier | tests | with | how many |
|---|---|---|---|
| unit | one module's logic, in process | the disk, processes, network and clock faked; an in-memory database | most tests, milliseconds each |
| integration | how the parts meet the OS and each other: ptys, process trees, the host over its socket, links on a real file system, the database file | real processes and temporary folders where meeting them is the point, and the fake agents (never a real one) | fewer, up to seconds each |
| end to end | the main workflows, on their happy paths, through the built app | Playwright for Electron | very few: one per workflow |

| tool | runs | command |
|---|---|---|
| vitest | the TypeScript unit and integration tests | `pnpm test` (part of `pnpm check`), with coverage |
| cargo-nextest | the Rust unit and integration tests, of the Floti protocol crate (`crates/floti-protocol`) and host (`crates/host`) | `cargo nextest run --workspace`, and `cargo test --doc --workspace` for doctests |
| Playwright | the end-to-end tests | `pnpm test:e2e` |

CI runs the unit and integration tests, as `pnpm check` and the host tests, on
Windows, macOS and Linux runners on every push. All three jobs are required: a
failure on any one fails the run and, from the release workflow, stops the
release, and a branch merges only once all three passed. The end-to-end tier
runs locally only, never in CI.

**While building, run only the tests for what changed**: the test file beside
the code (`pnpm vitest run <file>`), the host tests whose names match
(`cargo nextest run -p floti-host <filter>`), and `pnpm test:posix <file>`
for code that differs by OS. A full suite is a regression check, and CI is
where it runs: push the branch and read the results on all three OSes, rather
than running it locally. Locally, a full suite runs only for what CI does not
run, `pnpm test:e2e` for a change to a user workflow.

The protocol crate generates JSON Schema and TypeScript into
`crates/floti-protocol/generated/`. A test fails when those files are out of
date and names the command that rewrites them:
`cargo run -p floti-protocol --bin generate`. The generated TypeScript is
checked under the repository's strict settings with
`tsc -p crates/floti-protocol/generated/tsconfig.json`. Crate tests write only
to temporary directories.

The crates' tests run under cargo-nextest (`cargo install cargo-nextest
--locked`), which runs each test in a process of its own, so no test depends on
another having run first in the same process. `.config/nextest.toml` holds its
profiles: a test still running after a minute is named each minute and ended
after five, and CI's `ci` profile runs every test even after one fails and
never retries one. nextest does not run doctests; `cargo test --doc
--workspace` does. `cargo test` still runs everything, one process per test
binary.

The host's tests get their support from `crates/host/src/testkit.rs`, which
the crate's own tests turn on through its `testkit` feature: `TestDirs`, a
temporary tree with spaces in its paths holding a home, data, log, config and
runtime folder; `unique_name` for a pipe or socket no other test is using;
`RunningHost`, a host serving on a thread and runtime of its own; and the fake agent. A
`TestDirs` names the test process in a `test-owner` file at its root
(`testkit/owner.rs`), and every fake started in it exits once that process is
gone, so a test that crashed or was killed leaves no fake running. Every
folder and socket a host test uses is in a `TestDirs`, never the real
`%LOCALAPPDATA%`, Application Support, XDG data folder or `~/.config/floti`,
and no test registers anything to start at sign-in.

A host test leaves nothing behind, and the testkit enforces it rather than
each test remembering to. A `TestDirs` that cannot remove its tree because
something the test started still has a file in it open fails that test,
naming the folder; Windows refuses to remove an open file, so that is where
such a test fails. A struct holding a `TestDirs` declares it last, since
fields drop in order. A test that starts a host in-process uses `RunningHost`
and ends with `stop(..).await`, which ends the host's sessions and lets go of
its store. Dropping one unstopped, a panicking test's unwind included, stops
it the same way and waits for it before the `TestDirs` goes, so a failing test
leaves nothing behind and fails with its own message; a test that ends without
stopping its host still fails, saying so, once the host is stopped. A test that kills the
`floti host` executable kills that process alone, as a crash would: the host
takes everything it started with it (a job object on Windows, a guard process
on macOS and Linux). The test lists those processes before the kill
with `process_tree::descendants` (testkit only) and checks they have all
ended, ending any that has not so it cannot outlive the test.

The fake agent (`crates/host/testkit/fake_agent.rs`, the `floti-fake-agent`
binary) is a stand-in for any program a session runs, written in Rust so the
session and host tests need no Node. Each run records its arguments, folder,
variable names, children and every line it read to `<pid>.json` in the folder
`FLOTI_FAKE_AGENT_LOG` names. `--fake-print=<hex>` writes bytes at start,
`--fake-child[=<ms>]` starts a child of its own, `--fake-gui-child[=<ms>]`
starts `floti-fake-gui` (`testkit/fake_gui.rs`) as one, `--fake-listen[=<ms>]`
starts one that listens on a TCP port on 127.0.0.1 the OS picks and records
the port as `listening` in its own record (it runs `--fake-serve=<ms>`), for
the processes-and-ports tests, `--fake-exit=<code>` exits; otherwise it
answers each line with `echo: <line>`, and `/exit <code>`, `/print <hex>`,
`/child` and `/gui-child` do the same at its prompt.
`floti-fake-gui` is built for the Windows `windows` subsystem, so there it has
no console and the pseudoconsole closing does not reach it, as with a GUI app
or a tool a CLI starts with its window hidden; elsewhere it is an ordinary
program. `--fake-tick=<ms>` writes `tick <n>` on that interval, for output
made while no client watches.
It, and every child it starts, exits once the test process that owns it is
gone: the one the `test-owner` file nearest above its record folder names.
That is the test process, never the fake's parent, so a session that leaves
its agent running when it is closed still leaves it running while its test
does, and the test that says it must not fails.
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
local socket, runs the Noise handshake as the testkit's device, paired with
that host and pinned to its key, says `hello`, makes typed requests and reads
a session's terminal, granting credit as it reads. `RunningHost` pairs the
device into its host's registry before serving, and `pair_test_device` does
the same for the executable, so a test still connects with an endpoint and
its capabilities alone. `noise_sessions.rs` tests the handshake itself: what
crosses the socket, read through a tap that relays one endpoint to another,
and clients that misbehave, built as raw sockets from the protocol's Noise
layer, against the executable, whose stderr is the host's log. The stalled
handshake runs on a deadline of its own (`TestDirs::with_handshake_deadline`,
a marker in the data folder that only a test build reads); the real
deadline's length is stepped on tokio's paused clock in
`server/connection/tests.rs`. Most tests run a `Host` in the test
process on a `TestDirs`; the ones about the executable (one instance per data
folder and socket, the SSH refusal, Ctrl+C and SIGTERM, a killed host) run the
built `floti host` with `FLOTI_DATA_DIR`, `FLOTI_RUNTIME_DIR` and the other
folder overrides pointing into the `TestDirs`, `SHELL=/bin/sh`, and the SSH
variables removed. On Windows, Ctrl+C is delivered as `CTRL_BREAK` to the
host's own process group, the only console event one process can send
another. Every test ends every process it started and checks that each
process tree is gone.

What a client browses around its sessions is tested through `TestClient`
against a `RunningHost`, one file per feature in `crates/host/tests/`:
`discovery.rs`, `settings.rs`, `profiles.rs`, `templates.rs`, `content.rs`,
`files.rs` and `highlighting.rs`, with the processes-and-ports pass in
`resources.rs`. They carry core's and main's cases for discovery, roots,
harnesses, settings, profiles, templates, content and the Files view with the
same inputs and expectations. A test that needs a repository makes one with
`GitRepo` (testkit), which commits with a fixed author and date and none of
the machine's git configuration. One that needs a link makes it with
`link_folder`, a junction on Windows and a symlink on macOS and Linux, and
checks that every file at its target is still there afterwards.
`highlighting.rs` reads today's languages from
`packages/core/src/content/highlight.ts` and `packages/ui/src/lib/languages.ts`
when it runs, so a language the app highlights and the host does not fails it.

The agent tools listener is tested at three levels. `src/agent_tools/tests.rs`
drives the listener with families made in the test: loopback only, 401 before
the body is read, 404 for a family switched off, Origin refused, one token
per session. `src/server/session_tools/tests.rs` calls helm-sessions on a
world made in the test, for what a real host cannot be put in on demand (a
listing not ready yet, a token whose session is not live). And
`crates/host/tests/agent_tools.rs` runs a `RunningHost` with sessions on the
fake agent (`FakeAgent::backend(..).with_agent_tools()`, which takes agent
tools as Claude Code does) and the fake `claude`, reads each session's URL
and token out of the `--mcp-config` file it was launched with, and calls the
listener over HTTP as a session would: registration and the launch folder,
revocation at exit and at stop, the settings switch, the sweep at start, and
what `sessions_list` and `session_detail` answer, with nothing of another
session's conversation in any answer. Its helm-browser tests attach a
`TestClient` that declares `browser` and listens on `agentBrowser:call`, in
place of Helm's window, and answer each call it is sent: the tool table a
session lists, a call carried to that client and its answer handed back, no
family for a launch with no browser attached, a call failing at once when
the client leaves, and the refusals on the route. Its helm-sessions test
compares what a session lists with `src/server/session_tools.json`, the table
the desktop reads too. Its plugin tests attach a `TestClient` that listens on
`agentPlugin:call` and `agentPlugin:cancel` and offers a plugin server: the
tools a session lists and the read-only one in `--allowedTools`, a call
answered by that client, a server left out of the next offer refused to a
running session at once, calls failing at once when the client leaves, and a
call withdrawn from the client when the session cancels it or ends. The relays
themselves (`src/server/features/agent_browser.rs`, `agent_plugin.rs`) have
unit tests with no listener.

`crates/host/tests/os_conditionals.rs` fails, naming each `file:line`, when a
compile-time OS conditional (`cfg(windows)`, `cfg!(unix)`, `target_os` and
the like) appears outside `src/platform/mod.rs` and the per-OS
implementations of the platform concerns (`startup`, `socket`, `folders`,
`process_tree`, `process_table`, `links`, `launcher`, `private_files`,
`secret_seal`). Behaviour that differs by OS goes behind one of those
interfaces, with an implementation for each OS. `private_files` is tested by
what the OS reports for a written file: mode `0600` on macOS and Linux, and on
Windows a protected access list with one entry, the current user's, read the
way the pipe's is; each with a control file made the ordinary way that the
check rejects.

The plugin runtime is tested the same way, one file per part in
`crates/host/tests/`: `plugins.rs` (folders, the registry and settings),
`plugin_secrets.rs`, `plugin_runtime.rs` (the isolates: globals, imports,
timers, BroadcastChannel, crashes, endless loops, tool calls),
`plugin_exec.rs` and `plugin_fetch.rs`, and `plugin_background.rs`, which
adds a plugin like the sample plugin to a `RunningHost` and drives its
background script end to end over client connections. They carry today's
`desktop/main/plugins` cases with the same inputs and expectations. Each
plugin is a folder a test writes into its `TestDirs` with
`TestDirs::plugin_folder`, its background a script in the test. A script is
read where a user would see it, by the status item and badge in every
client's `plugins:changed` push, or, where there is no channel for it yet (a
session's tool call, a plugin's own log), through a registry and an
`IsolateRuntime` the test builds the way the host does. The program a
manifest's `exec` names is `floti-fake-program`
(`crates/host/testkit/fake_program.rs`), which reports its arguments, folder,
chosen variables and standard input as JSON, and can start a child, write a
pid file, write a flood of output, sleep and exit with a code. `floti.fetch`
goes to a plain HTTP server the test starts on `127.0.0.1:0`, or a TLS one
with a self-signed certificate made for that file alone, which records every
request it is sent; nothing a plugin test does leaves the computer.

No host test touches the user's credential store. Every `TestDirs` marks its
data folder, and a host built with the testkit seals plugin secrets with a key
file inside a marked folder (`TestDirs::without_secret_store` makes it a
computer with no store instead); a production build never reads the marker.
The Windows seal (DPAPI) has round-trip tests of its own, which store nothing;
the Linux one is tested only where there is no session bus, where it reports
that sealing is unavailable.

## Running them

```bash
pnpm test                          # every vitest project, with coverage
pnpm vitest run --project ui       # one of core, ui, desktop, sdk, sdk-svelte
pnpm vitest run <file>             # one file, while building
pnpm test:posix                    # the POSIX code's tests: under Linux in WSL on Windows, natively elsewhere
pnpm test:posix <file> ...         # the same, for these files
pnpm test:e2e                      # builds, then runs every workflow
pnpm --filter @helm/desktop exec playwright test -c e2e panes   # one spec, after a build
cargo nextest run --workspace      # every crate's tests; CI adds --profile ci
cargo nextest run -p floti-protocol   # the protocol crate, its ipc.ts coverage and generated-file check included
cargo nextest run -p floti-host    # the host, with the fake agents (Node on PATH)
cargo nextest run -p floti-host <filter>   # the tests whose names contain <filter>
cargo test --doc --workspace       # the doctests, which nextest does not run
cargo run -p floti-protocol --bin generate                      # rewrite the generated schema and TypeScript
pnpm exec tsc -p crates/floti-protocol/generated/tsconfig.json  # the generated TypeScript under strict settings
node scripts/test-leftovers.mjs pnpm check                      # runs a test command, then fails for anything it left behind
node scripts/test-leftovers.mjs cargo nextest run --workspace   # the same around the host tests
```

`scripts/test-leftovers.mjs` is the check CI runs after `pnpm check` and after
the host tests, on every runner. Around a command it runs it, then lists each
test temp folder (`helm-test-run-*`, a vitest or Playwright run's root,
`floti test *`, `helm world-*`, `helm-test-posix-*`) the
command left in the temp folder and each process of a kind tests start
(`floti*`, Node, shells, `conhost`) that the command started and is still
running, with its pid, name and command line. It exits with the command's
status when the command failed, 1 when it left anything, and 0 otherwise.
It reports only what appeared while the command ran, so other sessions and
earlier runs' folders never fail it, and it deletes and ends nothing itself.
CI takes the two halves as steps of their own: `before <state-file>` ahead of
the tests and `after <state-file>` behind them. `before` makes a mark for the
step and hands it to the later steps through `GITHUB_ENV`, as
`TEST_LEFTOVERS_MARK`; the local command puts it in the command's environment.
On macOS and Linux a process the tests left is adopted by init, launchd or a
subreaper, which also starts the machine's own daemons, so an adopted process
counts only when it carries the mark or runs inside a test temp folder or the
checkout (the host starts its sessions and plugin programs with a cleared
environment, in a test folder). A Windows orphan names its dead parent, which
is enough there.

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

- **core** - `packages/core`, in Node: unit tests of its logic, and
  integration tests of the code whose job is the file system (discovery,
  content, files, templates and the store's database file) against real
  temporary folders, links and git repositories. A store test about rows uses
  an in-memory database; only one about the file itself opens a file.
- **ui** - components in `packages/ui` and modules in the renderer, in jsdom
  with Testing Library. Find elements by role and accessible name. jsdom does
  no layout, so anything about where something lands belongs in the tier
  below.
- **desktop** - main-process services, in Node. `vi.mock('electron')` with
  `test/electron.ts` stands in for Electron; ptys are real and run the fake
  `claude`. The faked app's folders are in the run's root (below).
  `sessions.test.ts` is the example.
- **sdk** - the plugin SDK in `packages/plugin-sdk/test`: its validator,
  schema and command in Node, the package as npm publishes it, and its React
  and Vue helpers in jsdom against the fake bridge in `test/bridge.ts`.
- **sdk-svelte** - a compiled Svelte component reading the SDK's stores, in
  jsdom. Apart from `sdk` because it resolves Svelte's browser build.

Every project runs one global setup, `test/run-root.ts`, set in the root
config, which every project extends. It makes the run's root, a
`helm-test-run-*` folder in the OS temp folder, and points `TMPDIR`, `TEMP` and
`TMP` at it before any worker starts; the workers are forked with that
environment, so every temp folder a test, the code under test or a process
either starts makes is in the root, by construction, a world (`createWorld`)
and a store test's file included. The teardown, which runs in the main vitest
process and so outlives a worker that crashed, puts the variables back and
removes the root. The root keeps the path the OS gives its temp folder (macOS's
`/var`, a runner's 8.3 alias), not its real path.
`packages/desktop/test/run-root.test.ts` shows it, crash included: it runs a
vitest run of its own (`packages/desktop/test/crash-run/`) whose
test makes a world, starts the fake `claude` in a pty and kills its worker,
and checks the root, the world and the fake are gone afterwards. Playwright's
global setup (`e2e/run-root.ts`) takes the same root for the end-to-end run.

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

`packages/desktop/e2e/`. One test per user workflow, on its happy path; detail
belongs in the tier above, so keep this one small. A refusal or an edge case is
tested here only when nothing but the real app can show it: a native view drawn
over the window, or Electron's own guards on a page.

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
  its path, in the run's root, named owner of its fake agents (a `test-owner`
  file holding the test process's pid), holding a home directory with its own `.claude`, the fake `claude`
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
- Wait on conditions (`expect`, `expect.poll`), never on sleeps, and with the
  config's timeout, never one of their own (see "Waiting" below).

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
- **It exits once the test process that owns it is gone**: the one a
  `test-owner` file names in its config folder or a folder above it
  (`watchOwner` in `common.mjs`), which a world and a `TestDirs` write. It
  polls on an interval that keeps nothing alive. The owner is the test, never
  the fake's parent, and a file rather than a variable or an argument because
  the arguments are the CLI's and the host clears a session's environment. A
  long-lived child it starts does the same.
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

- `--add-dir`, `--mcp-config` and `--allowedTools` are variadic, and
  `--plugin-dir` takes one path per flag; the opening prompt is the first
  positional. The tools `--allowedTools` allows are logged as `allowedTools`.
- `--settings` takes a file or inline JSON; a missing file fails as the CLI
  does. User, project and local settings are loaded too, and logged in order.
- Instructions: `<config dir>/CLAUDE.md`, then each folder from the root down
  to the working directory. In each, `CLAUDE.md` is loaded; `AGENTS.md` only
  where no `CLAUDE.md` was found in that folder or above it, unless settings
  set `instructionFiles` to `claude-md-and-agents-md`, when both load. Each
  file loads once. `--append-system-prompt-file` is logged as
  `composedInstructions`.
- Each `--mcp-config` value is inline JSON or a file; the servers are logged
  by name, and a missing file fails as the CLI does.
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
- **A test leaves nothing behind, by construction**: no temporary folder, no
  process, no read of the real home, whether it passes, fails or its process
  crashes. Cleanup never depends on the test reaching its own teardown, which a
  crash or a kill skips. Every folder a test makes is under its run's root,
  which the process that outlives the tests removes when the run ends, and
  every process it starts ends with it: a fake agent exits once the test
  process that owns it is gone. Nobody cleans up by hand after a test run. CI
  fails a run that leaves a test temp folder or a process behind, and
  `node scripts/test-leftovers.mjs <test command>` is the same check locally
  (see "Running them"); it is a tripwire for when that breaks, not a cleanup.

## Waiting

A test passes or fails the same way on a fast machine and a slow one. A sleep
followed by an assertion passes on the machine it was written on and fails on
a slower one, so no test has one.

- **A test waits on an event or a polled condition, never on time.** Every
  wait is bounded by the shared patience, and a wait that runs out fails
  naming what it waited for: the assertion it polled, or the message a Rust
  wait gives. The patience is 20 s in every tier, and each language has one
  constant for it: `PATIENCE` in `test/patience.ts` for TypeScript, passed as
  `vi.waitFor`'s `timeout`, set as Testing Library's default in
  `ui/src/test-setup.ts` and as Playwright's `expect` timeout in
  `e2e/playwright.config.ts`; and `PATIENCE` in the host's testkit
  (`testkit/client.rs`) for Rust, which no test shadows with a wait of its
  own. A passing test never comes near it.
- **No test waits out a real deadline, grace or interval.** When a duration is
  the behavior under test (a session ends within its grace, a handshake is cut
  at its deadline), the test steps time, as below; an integration test of the
  same path shows only that the event happens and what it leads to. Anything
  else measured against a bound waits on the event instead.
- **A test that says something did not happen proves it with a barrier.**
  After the action that must cause nothing, it causes a second, known event
  and waits for it; the first event to arrive must be that one. `files.test.ts`
  lets go of a watch, writes a file, watches again and writes another: the
  second file is told, and the first never was. Or it steps the logic, as
  below. Never "sleep, then assert nothing came", which proves only that
  nothing came yet.
- **Logic driven by timers or polling is tested by stepping it**: the test
  calls the step function with each state, or runs on fake timers
  (`vi.useFakeTimers`, then `vi.advanceTimersByTime` or
  `vi.runAllTimersAsync`), as `browser.test.ts` does for a page's retries. In
  Rust it runs on tokio's paused clock (`#[tokio::test(start_paused = true)]`,
  then `tokio::time::advance`), as the resources pass tests do, or calls the
  step itself, as the config watch's `look` test does. Integration tests check
  only the wiring: that the timer is set and reaches what it calls.
- **A module ported from TypeScript lists what Node or Electron did for it
  implicitly, and tests each.** Node's http server discards a request body
  nobody read; the config watch debounced an editor's write, truncate and
  write again. A port that does not do the same loses it without a sound, and
  only a test that names it notices.
- A sleep inside a fake that plays a slow program is fine, as long as no
  assertion depends on its length.

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
