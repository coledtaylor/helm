# Helm - Agent Instructions

Helm is a Windows desktop shell for the Claude Code CLI. It hosts `claude` in
terminal tabs and adds what the CLI does not have around it: project discovery,
profiles, session history, a config console, a Files view that renders notes
and artifacts, and a browser pane. Electron and React. It shells out to the
`claude` CLI and never reimplements it.

- [docs/DESIGN.md](docs/DESIGN.md) - the design system. All UI work follows it.
- [docs/TESTING.md](docs/TESTING.md) - how the app is tested.
- [docs/SPEC.md](docs/SPEC.md) - the evidence behind past decisions. Look there
  when a change would reverse one; it is reference, not required reading.

Rules here are short on purpose. The reasoning behind a rule lives in a comment
at the code it governs, and in git history.

## Layout

```
packages/
├── core/     # what clients share: the host's answer shapes (types.ts), helm.db and its copy into the host (store), layout, themes, the start-up sweep
├── ui/       # React components
├── desktop/  # Electron main, preload and renderer
└── plugin-sdk/ # manifest validator, bridge types, helm-plugin CLI, authoring guide
examples/sample-plugin/  # every plugin surface; the plugin the E2E tests drive
crates/
├── floti-protocol/  # the host-client protocol; generates JSON Schema and TypeScript into generated/
└── host/            # floti-host: the `floti` binary (`floti host`); per-OS code only in src/platform/*/{windows,macos,linux}.rs
    ├── src/agent/   # the AgentBackend trait; one module per agent (claude_code/), plain.rs for any command line
    └── src/keeper/  # `floti keeper`: the session keeper holding every session's and plain terminal's pty and tree
test/fake-agents/    # one fake CLI per agent backend, sharing common.mjs; tests drive these, never a real agent
test/fake-ssh/       # fake ssh, wsl.exe and a custom transport; tests reach no other computer or real distro and never touch ~/.ssh
```

pnpm workspaces with `node-linker=hoisted` (`.npmrc` says why). `core` and `ui`
export TypeScript source, so there is one build step. `crates/` is a Cargo
workspace (`Cargo.toml` at the root) for the Floti host; pnpm does not see it.

| command | does |
|---|---|
| `pnpm dev` | the app with its own data directory (see "Where the data lives") |
| `pnpm check` | typecheck, lint and unit and integration tests - the gate |
| `pnpm build` | production build |

## Testing

- Three tiers, and a test sits in the lowest one that can show what it checks:
  - **Unit** tests are most of them and take milliseconds each: one module's
    logic, with the disk, processes, network and clock faked.
  - **Integration** tests are fewer: real processes, ptys, sockets, folders,
    links and database files where meeting them is the point, with the fake
    agents in place of real ones.
  - **End-to-end** tests are very few: the main workflows, on their happy
    paths, through the built app.
- While building, run only the tests for what changed. A full suite is a
  regression check, and it runs on CI: push the branch and read its results
  on Windows, macOS and Linux.
- Unit and integration tests validate the work. End-to-end tests run only
  before a release is cut (the `procedures` skill): never while building, to
  check a fix or to finish a task.
- Nearly everything in a local app can be shown by a unit or integration test.
  Something an end-to-end run catches is a gap in those tiers: add the unit or
  integration test that fails for it, then fix it. Only what needs the whole
  app running stays end-to-end.
- A Rust test run names the binary that holds the tests: `--lib` for a
  module's tests, `--test <file>` for one of `crates/host/tests/*.rs`. A
  filter alone (`cargo nextest run -p floti-host <filter>`) builds and links
  every test binary in the crate first. `cargo check` finds compile errors
  without linking. A test that passed runs again only after the code it
  covers changed.
- `pnpm check` is the gate. CI runs it on Windows, macOS and Linux on every
  push, then builds. All three jobs are required: a failure on any one fails
  the run and stops the release, and a branch merges only once all three
  passed. End-to-end tests run locally only, never in CI.
- `pnpm test:posix` runs the overlay, process-tree and data-directory
  tests where that code is the POSIX one: natively on macOS and
  Linux, and under Linux in WSL from Windows.
- A test cleans up by construction, never by reaching its own teardown, which
  a crash skips: every folder it makes is under its run's root, which the
  process that outlives the tests removes, and every process it starts ends
  with it. Nobody cleans up by hand after a test run. CI fails a run whose
  tests leave a test temp folder or a process behind, and
  `node scripts/test-leftovers.mjs <test command>` is the same check locally.
  It reports and fails; it never deletes or kills.
- A test waits on an event or a polled condition, bounded by the shared
  patience, never on time. Logic driven by a timer, deadline or grace is tested
  by stepping time; no test waits one out.
- Every change ships with its tests: a bug gets a failing test before the fix,
  a feature gets tests that cover it. [docs/TESTING.md](docs/TESTING.md) says
  which kind.
- The in-app drivers (`fidelity`, `claude-check`, `packaging-check`) and
  `scripts/drive-dev.mjs` are diagnostic tools, not tests. Use them to diagnose
  something a test cannot reach, or when asked. No change "owes" a driver run.

## UI

- Follow DESIGN.md: semantic tokens only (no raw hex in components), islands
  with hairline edges on a sunken canvas, the accent never solid-fills
  anything, no shadows outside modals, no text weight past 500, mono for
  machine data. Anything the tokens cannot express is a DESIGN.md amendment.
- Look at a UI change before calling it done: `pnpm dev --drive`, then
  `node packages/desktop/scripts/drive-dev.mjs shot <file>.png`. The `dev`
  skill has the rest.

## Boundaries

- `packages/core` never imports Electron (`no-electron-in-core` in
  `eslint.config.js`). If core needs something from the host, the host passes
  it in.
- A value import into the browser bundle comes from `@helm/core/types`, never
  the package root. This fails at rollup, not at typecheck.
- Every channel a Helm page uses is declared in `shared/ipc.ts`. The preload
  exposes three generic functions; a feature adds a channel, not a bridge
  method. `term:*` (the spike page's single pty) and `session:*` (the host's
  sessions) never mix.
- Each Helm page (the window, and the hidden plugin host window) reaches the
  host over its own protocol connection, which main pipes to a bridge unread
  (`hostLink:*`); the bridge holds the device key, never a window. Electron
  IPC carries only what `channels/boundary.rs` lists as client-only, and its
  host-internal channels from the hidden plugin window: `registerIpc`
  registers nothing else, and a page's router (`app/host/router.ts`) refuses
  any other channel at once. `e2e/boundary.spec.ts` fails naming any channel
  that crossed. Main runs no session, terminal, config console, content,
  template or scan service of its own; those are the host's.
- The host never opens `helm.db` or learns Helm's data folder. What only
  `helm.db` holds (archived conversations whose transcript is gone, their
  usage, History's names, config versions) main reads through core's
  read-only pages (`store/copy.ts`) and sends on `carry:*`, in batches, until
  the host records in `floti.db` that the copy finished
  (`main/host/own-data.ts`). The host's merge keeps what it already holds,
  and a copy that stops part way is sent again at the next connect.
- A host channel added to `shared/ipc.ts` is also declared in
  `crates/floti-protocol`, or listed there as client-only or host-internal
  with a reason (`channels/boundary.rs`), and the generated files are
  rewritten with `cargo run -p floti-protocol --bin generate`. A crate test
  reads `shared/ipc.ts` and fails naming any channel that is neither.
- Main owns the window's lifetime and `helm.db`: `will-quit` releases the
  database, and nothing else closes the store.
- The host owns process lifetime. Every session's and plain terminal's pty and process tree is held by the
  session keeper (`floti keeper`, `crates/host/src/keeper`), a process the
  host starts outside its own tie, which holds nothing else: a host that
  crashes, panics or is killed takes no session with it, and the next host
  takes them back under the same ids, with their agent tools and the device
  that started each. A keeper that dies ends what it holds,
  and the host offers those sessions back. Only a deliberate stop ends the
  keeper. Quitting a client ends the sessions it started only where its
  setting for that host says so; a crash ends nothing; stopping the host
  ends every session. Helm's setting is `quitSessions`, kept in `helm.db` keyed by host
  (this PC's is `local`, End when absent; a remote host's is its id, Keep
  when absent). Quitting with sessions it would
  end asks first: End and quit, Keep running and quit (this quit only, never
  written to the setting), or Cancel. Helm never stops the host on its own:
  its deliberate quit sends `host:quit` and lets go, only Settings' Stop host
  (after saying how many sessions it ends) sends `host:stop`, and a host Helm
  started (`floti host --desktop`) exits by itself once it runs nothing and
  no client is attached. When the connection ends without a stop or a quit,
  the window keeps each tab's screen, dimmed with input off, and Helm starts
  a new host if a desktop started the one that died, then reconnects. The
  new host's list decides each: a session or shell it still runs is carried
  again from its redraw, and nothing is resumed. One it lists lost, or that
  is lost while it stays (its keeper died), comes back through the host's
  restore offer, which the window asks for again then; a lost shell, as a
  new shell in its folder.
- A host on another computer is reached by main through `floti bridge`,
  over the user's own `ssh -o BatchMode=yes <target>` or the command they
  gave, one link per host and one page link per host for each window
  (`hostLink:open` names it). Floti adds no ssh option, never skips a
  host-key check, reads or writes nothing under `~/.ssh` and holds no SSH
  secret: a transport that needs a password or a key accepted fails with its
  last line, and the fix is `ssh <target>` in a terminal. Adding a host is
  connecting to it: the first connection pins the key it proves, and
  nothing is approved or typed on the host. The link never
  starts that host and a drop ends nothing there; Remove ends the link and
  removes the host's client folder, and ends nothing on the host.
- Every client sees every session in the host, and tabs, panes and splits are kept per device: `paneLayout`
  stays in `helm.db` and never reaches the host. A window gives a tab only to
  a session its saved layout names or that it opened (`unplacedSessionTabs`
  in `core/layout/panes.ts`), and its connection carries only those
  sessions' terminals. Every other running session is in the sessions pane
  as not open here, with Open (a tab whose screen comes through the host's
  attach, never a second restore path) and End. Closing a running session's
  tab asks first, naming its host, which the window names; Close tab, keep
  running in the tab's menu ends nothing.
- Do not use `@anthropic-ai/claude-agent-sdk`.
- Helm renders nothing for a live session and answers no permission
  prompt. The host reads one thing in a session's output, OSC 7501 status
  reports, kept as the program said them, and draws no conclusion from
  screen text. It passes every byte on untouched and puts nothing between
  the user and the TUI.
  Rendering an archived transcript (read-only, after the fact) is allowed.
  This holds for every agent: no RPC or JSON mode in place of its own TUI.
- Windows, macOS and Linux: links are junctions (`mklink /J`) on Windows and
  symlinks on macOS and Linux; nothing needs elevation; tests use paths with
  spaces. What differs by OS sits behind one interface per concern (in the
  host, each a folder under `crates/host/src/platform`: links, the process
  table, process trees, the local socket and the rest; in the desktop, ending
  a process tree in `treeKill` and data directories in `isolate.mjs`), with one
  implementation per OS, and nothing outside it branches on the OS. An OS with
  no implementation yet reports Unknown and the feature around it keeps working.

## Credentials

- Never handle or store any agent's credential, or GitHub's. Each agent
  backend lists its credential paths (`credential_paths` in the host's
  `AgentBackend`), and nothing opens them. A sign-in is checked by the agent's
  own status command where it has one, by an artefact existing where it does
  not, and is Unknown otherwise. For Claude Code that is an artefact existing
  (`.credentials.json`, `ANTHROPIC_API_KEY`, the onboarding record in
  `.claude.json`). Never open those, `hosts.yml`, the keyring or `GH_TOKEN`,
  and never run a command that prints a credential. The remedy for "not signed
  in" is a sentence naming the agent's login command (`claude` for Claude
  Code).
- `~/.claude/sessions` keeps a `<pid>.<sha256>.key` credential beside every
  `<pid>.json`. The host's Claude Code status reader
  (`agent/claude_code/status.rs`) reads `.json` files only; never widen it.
- The `persist:helm-browser` partition holds the user's cookies and logins.
  Nothing reads it; the only call against it is `clearStorageData`.
- The plugin secret store (`crates/host/src/plugins/secrets`) is the one
  place Helm keeps a secret, and only one the user typed into it. Each value
  is sealed by this OS's store for the user (`platform/secret_seal`) and
  refused when it cannot be; a value is filled in by the host, for an origin
  and a plugin the user allowed, and never sent to any client. Helm never reads a Claude or GitHub credential to put there.
- The user's login is the access to Floti. The host serves whatever reaches
  its local socket, which only the user's OS account can open, once its Noise
  handshake completes: a client on the host's computer, or one that comes
  through `floti connect` over the user's own ssh or command. Every such
  device is served every channel, as the user could at the host; Floti adds
  no approval, code, role or prompt of its own, and keeps no list of allowed
  devices. The host keeps its host key (`host.key`) in its data folder and
  no device list; at start it deletes the `devices.json` and `enrolment.json`
  an earlier version kept (`RETIRED_FILES` in `server/mod.rs`). Each client
  keeps its device key (`device.key`) and the host key it pinned
  (`host.pub`) at its first connection, and refuses a host that proves
  another, naming the host, until the user removes it and adds it again.
  Each is an owner-only file (`platform/private_files`): `0600` on macOS and
  Linux, an access list naming only the user on Windows. The device key
  names the device in the attached list (`devices:attached`, Settings >
  Devices) and records which sessions it started, so quitting a client ends
  only its own. Disconnect there (`devices:disconnect`) closes every
  connection of a device's key to that host at once and leaves its sessions
  running; taking its SSH key away is what keeps it out. A private key is
  never logged, printed, sent to another client or put in a session's
  environment; logs name a key by its fingerprint, and a client that fails
  the handshake is closed without a byte. Keys and the Noise sessions they
  prove come from snow, through `floti_protocol::noise`; never hand-rolled
  crypto.
- The network posture is stated identically in README, docs/PACKAGING.md, the
  `update:check` comment in `shared/ipc.ts` and SPEC 5; change all four
  together. Helm contacts nothing on its own initiative except the update
  check. Its windows reach the local host over the host's local socket, which
  only the user's OS account can open. The local host listens on loopback for
  its sessions' agent tools, behind a token per session, and holds no port
  while no tool family is on. Main listens on loopback only for a port of a
  session on another computer the user forwarded, which closes with that
  session (`main/host/forwards.ts`). A plugin's pages reach only the origins
  its manifest lists.

## Browser pane

- `will-navigate` and `setWindowOpenHandler` are denied on every web-contents
  in `main/index.ts`. Browser views are exempted by a `webContents.id` registry
  read inside those guards. Widen the registry, never the guard.
- Pages live in one Browser tab, in its own strip (`browserStrip.ts`), never
  among a pane's tabs.
- From a browser view, a `window.open` with features opens a real popup
  window; `_blank`, a plain `window.open` and middle-click open a page in the
  Browser tab that adopts the web contents Chromium made (`createWindow`), so
  both keep `window.opener` (OAuth needs it). Both share the partition,
  permissions, reach rule and exemption registry. A popup shows its host in
  its title bar and is never an agent's: an agent page's opens are more of its
  pages.
- A view can lose its web contents (a page that called `window.close()`). Reach
  them only through `contentsOf` in `browser.ts`. `registerIpc` wraps every
  send handler, because a throw there is an uncaught main-process exception.
- Every navigation goes through `browserReachAllows` in `@helm/core`; an
  agent's restrictions are composed by `agentReach`. `file:` and custom schemes
  are refused there.
- A native view paints over all DOM, so it hides while anything is drawn over
  it, through `overlayOpen()` (`ui/src/lib/overlay.ts`), subscribed once in
  `useBrowsers`, and leaves a still of the page in its place
  (`browser:snapshot`). Toasts are drawn clear of the view instead. The view
  never enters the top 36px, where Windows draws the window controls, except
  in fullscreen, when the page has the whole window and there is no title bar.
- The browser's keys are one table (`shared/browserKeys.ts`): main reads it in
  `before-input-event` for a key pressed in a page, the window for a key in
  Helm's chrome, and both run the window's one dispatch. A key an agent sends
  (`agentInput`) is always the page's.
- Hide a view with `setVisible(false)`, which keeps the page capturable,
  scriptable and clickable.
- Self-signed certificates are accepted for loopback only, and there is no
  `certificate-error` handler. Downloads are refused and handed to the system
  browser. Every permission is denied but clipboard writing and fullscreen,
  and those only to a page in the Browser tab that has the keyboard. Only the
  address bar searches, on Enter, with the engine in `browserSearch` (`off`
  refuses); nothing is sent while typing.

## Agent tools - the host's listener

The host serves its sessions' agent tools as MCP over HTTP
(`crates/host/src/agent_tools`): `helm-browser` at `/mcp`, `helm-sessions` at
`/mcp/sessions`, `floti-agents` at `/mcp/agents` and each plugin's tools at
`/mcp/plugin/<id>`, on one port. It is the one inbound listener the host has
besides its local socket. Main binds no listener for them, mints no token and
writes no `--mcp-config`, and never serves `floti-agents`: only the host does.

- `127.0.0.1` on port 0 only. A request announcing a non-loopback `Origin`
  gets 403, and one without `Authorization: Bearer` gets 401 before its body
  is read. There is no unauthenticated route, not even a health check.
- One token per session, minted at launch, given to its agent tools and to its
  environment for `floti agent`, and revoked when it ends. The token is the
  identity, however it arrives.
- A tool family switched off has no route (404), no entry in `--mcp-config` and
  no tool. With no session holding a token and nothing a launch could be
  given, the host holds no port.
- `helm-browser`, `helm-sessions` and `floti-agents` take name, route,
  instructions and tools from `crates/host/src/server/browser_tools.json`,
  `session_tools.json` and `floti_agents.json`. Main reads the browser table
  too, for the tools it answers.
- Main tells the host `browserMcp`, `browserMcpLocalOnly`, `sessionMcp`,
  `sessionAgents` ("Sessions can start agents") and the five agent limits
  (`agentChildrenPerParent`, `agentSessionsPerHost`, `agentDepth`,
  `agentStartsPerParent`, `agentHeavyPerHost`) on each connect and each change (`hostSettingsFor`).
- Each plugin offering tools is a family, `helm-plugin-<id>`, on while the
  plugin is on and its tools are not switched off in Settings. The host
  checks the token, then hands the call on with its caller: an id it minted
  when the session launched (random, never the browser key or the host's row
  id, and the id the plugin's `sessions.list` shows), its name and its
  working directory - never the token, never anything of the conversation.
  Turning them on reaches sessions started after; turning them off reaches
  running ones at once.
- Agent tools are registered per launch for every backend, never through an
  agent's own add command or global config. For Claude Code that is a
  `--mcp-config` file in the session's launch folder under the host's data
  folder (`crates/host/src/agent/launch_folder.rs`), never
  `claude mcp add-json`. A launch folder a crash left is swept at host start,
  and only when every owner is provably gone. At its own start main removes
  the per-session `--mcp-config` files an earlier Helm wrote in its data
  folder (`cleanStaleMcpConfigs`), on the same terms.
- An agent navigation must pass both `browserReach` and `browserMcpLocalOnly`.
- The host has no browser, so each browser call goes over `agentBrowser:call`
  to the attached client that declared `browser`, naming the caller's
  session, and that client's answer is the tool's. In Helm, main runs it
  against the browser pane (`runBrowserTool` in `main/browser-mcp.ts`,
  reached through `main/host/browser-tools.ts`). A launch is given
  `helm-browser` only while such a client is attached, and each token reaches
  only the families its launch was given (404 otherwise). A call made with
  none attached, or waiting on a client that leaves, fails at once saying no
  browser is attached. Nothing there waits on a timer.
- A tool drives the tabs its own session opened and a tab the user shared with
  it from the Share button, and only while the page is within `agentReach`. A
  share is one session per tab, made by session id (the window never sees a
  token), never inherited by a page the shared one opens, and revoked when
  the session ends. `browser_tabs` lists all; `browser_close` closes only the
  session's own.
- `sessions_list` and `session_detail` (`crates/host/src/server/session_tools.rs`,
  shaped by `crates/host/src/session/describe.rs`) never return any part of
  another session's conversation: no transcript, prompt, output, argv,
  conversation id or child command line. The shaping types have no field for
  them. The sessions pane may show command lines to the user.
- Listing is machine-wide; detail exists only for sessions the host spawned.
  A status it could not read is "unknown", never omitted. No tool takes a
  session id.
- `helm-sessions` is awareness only: it sends a session nothing, waits on
  none, hands none work, and returns no part of any session's conversation.
- `floti-agents` acts on sessions, and only on the caller's own children:
  sessions started with `agents_start` by the session whose token made the
  call. A parent may start its children, type into them, read their screens,
  wait on them and stop them; a grandchild is reached only through its own
  parent. A child reaches its parent only with `agents_report`, which the
  parent receives as its child's report, never as its user's words. No tool
  reaches a session the caller did not start, nothing is typed into a parent
  or into a session waiting on a permission prompt, and no tool returns a
  transcript, argv or conversation id.
- `floti-agents` (`server/floti_agents.rs`, the work in
  `server/hosted/children.rs`) is the host's own family: it works with no
  client attached, a client quitting reaches a child only through its parent,
  and a child never adds a tab or a pane to a window. It is given to a launch
  while `sessionAgents` is on and the launch's profile does not turn it off;
  off, or an excluded profile, is no route (404), no entry and no tool. Every
  name a tool is given is resolved among the caller's own children only, and
  anything else is not found. A start is judged before anything runs: the role
  and the backend it allows (`AgentBackend`, which refuses a rule it cannot
  enforce, naming the rule and the backend), a folder Floti tracks on the path
  it leads to (a session's own folder does not make one tracked), a permission
  mode never above the parent's, then the limits read afresh from the settings
  and counted from the child rows, so they hold across a host restart. One
  of them is the heavy limit (`agentHeavyPerHost`, 1 to 8, default 1): the
  running agent-started sessions whose row says `child_class` heavy are
  counted, and a start or a resume of a heavy-role child is refused when they
  reach it, naming the limit and each holder by its name and the session that
  started it, and saying to wait for news and start again. Light starts and
  sessions a person starts are not counted, and `agents_list` shows the heavy
  slots left. A
  child ends when its parent ends, however it ends, and its own children with
  it, unless it was started to `outlive`; its row keeps the parent's row and
  conversation, so a restart restores the links and resuming the parent's
  conversation gives its outliving children back.
- A child gets a git worktree when its start names one (`worktree`) or its
  role says `worktree: yes` (named after the child; there is no opt-out of a
  role's), made by the host with git for every backend
  (`workspace/worktrees.rs`) after the whole start has been judged, so a
  refused start writes nothing. It is `<repo>/.floti/worktrees/<name>` on a
  new branch `agent/<name>` cut from the commit the parent's folder has
  checked out, under the repository's main working tree even when the parent
  is itself in an agent worktree; the name is made unique among those folders
  and `agent/*` branches (`name-2`), so no two children share a checkout.
  `/.floti/` is added to the repository's `info/exclude` once, keeping its
  other lines. A start is refused when its folder is not in a git repository,
  or is inside an agent worktree that a running session other than the caller
  works in (naming it). A launch that fails after the worktree was made
  removes it and its branch; otherwise nothing removes a worktree when its
  child ends, because its branch holds the work.
- `agents_start` with `resume` (`floti agent start --resume <name>`) reopens
  one of the caller's ended children, resolved among the caller's own
  children like every other name (ended rows and those given back by a
  resumed parent included; anything else is not found), in the folder or
  worktree its row recorded, through its backend's `Resumer` with the task as
  the conversation's next turn (`ResumeRequest.prompt`) and its role composed
  again, its permission capped by the caller's. It keeps its name, parent
  link, `outlive` and `can_start`, so a resume that also names a role,
  backend, folder, profile, worktree or name is refused. Also refused, with
  nothing started: a child still running, a folder or worktree gone or no
  longer tracked, a backend whose adapter has no `Resumer`, and a child with
  no conversation. It is then judged against every limit as a start is, and
  is one more start and one more running child (a resume adds a row under the
  same name; the newest row of a name is the child).
- `floti agent start` and `floti agent stop` run the same tools from a
  session's own shell: the host puts its `floti` binary's folder first on the
  session's `PATH` and the session's token and the family's address in its
  environment (`FLOTI_AGENT_TOKEN`, `FLOTI_AGENT_URL`; any `FLOTI_AGENT_*` the
  host inherited is stripped first). The command acts as that session, prints
  the tool's text or, with `--json`, its JSON, exits non-zero on a refusal and
  never prints the token. Each tool and each subcommand a launch may run
  without asking is named on its own and passed through the backend's adapter
  the way read-only tools are (for Claude Code `mcp__floti-agents__agents_start`
  and `Bash(floti agent start:*)`); never a `floti agent:*` wildcard, and a
  user's deny rule still wins.
- A session's row keeps what its launch was granted (`agent_tools`: the
  port, the token's SHA-256 and the families), never the token. A host that
  takes back sessions from the keeper binds that port again and accepts each
  token by its hash; when the port cannot be had, those sessions run on
  without tools and the log says so, naming the port only. The device that
  started a session or opened a plain terminal goes in its keeper label by
  fingerprint, so its `host:quit` ends it after a crash as before one.
- The host serves a version 2 plugin's tools itself
  (`server/plugin_tools.rs` `HostPluginTools`): for each plugin whose
  background module runs in its engine, on, error-free and with its tools
  on, `helm-plugin-<id>` at `/mcp/plugin/<id>`, worded from the manifest as
  Helm words an offer, is given to every launch with its read-only tools in
  `--allowedTools`, with no client attached. Each call goes to the module's
  handler (`Registry::call_tool`), naming the session as the relay does, and
  is cancelled there when the session drops it. The plugin turned off,
  removed or with its tools switched off loses its route at once (404) and is
  given to no later launch, until it is back on. A client's offer naming such
  a plugin is passed over (`PluginRelay::installed`), and that client is sent
  no call for it.
- For a version 1 plugin a client offers its servers (`agentPlugin:offer`,
  replacing its last offer) and answers their calls (`agentPlugin:call`,
  `agentPlugin:answer`). Each is
  served as `helm-plugin-<id>` at `/mcp/plugin/<id>`, given to launches only
  while that client listens, its read-only tools passed as `--allowedTools`.
  A server left out of an offer answers 404 at once; a call is withdrawn
  (`agentPlugin:cancel`) when the session cancels it, its request goes away
  or the session ends; with its client gone, a call fails at once saying
  Helm's window is not connected. Main offers the host the servers of the
  plugins it lists as offering tools, on each connect and each change
  (`main/host/plugin-tools.ts`), hands each call to the plugin's background
  page in the hidden plugin host window (`main/host/plugins.ts` `callTool`)
  and answers with its tool result.
- A host serves an offered server only for a plugin it has itself, on,
  error-free and with its tools on (`PluginRelay::installed`), whatever a
  client offers: a plugin only another host has is given to no launch here,
  and its route answers 404. Main runs one tool relay per host on that host's
  own link (`main/host/remote-plugins.ts` for each remote host), offering it
  only that host's plugins, and each call it relays names its host to the
  end, so a remote host's session is answered by that host's background page
  and never by This PC's.

## Plugins

The host runs them (`crates/host/src/plugins`): their registry, settings,
secrets, programs, services and their pages' `fetch`. Main keeps the
`floti-plugin://` and `helm-plugin://` schemes (`main/plugins/protocol.ts`),
the hidden plugin host window and the tool relay (`main/host/plugins.ts`); the
window draws their pages. `packages/plugin-sdk` holds the manifest validator
Helm loads with, so a manifest change starts there. `apiVersion` is 1 or 2,
and both load side by side; anything else is an error in Settings, never a
crash.

- Version 2 is the current one. Its pages are served on
  `floti-plugin://<id>/` and get `window.floti`; its background is an ES
  module the host runs in an isolate of its own
  (`crates/host/src/plugins/runtime`), with `floti`, `BroadcastChannel` and
  timers and nothing else, importing only its plugin's own files by relative
  path. What needs a window (opening a tab or a link, asking for a secret,
  starting or listing sessions) rejects there. `examples/sample-plugin` is a
  version 2 plugin.
- Version 1 pages are served on `helm-plugin://<id>/` and get `window.helm`,
  with the same methods; a version 1 background is a page in the hidden
  plugin window. The host writes each page URL with its version's scheme
  (`plugins/manifest.rs` `page_scheme`), which is how a client tells the two
  apart.

The SDK is published to npm as `@coledtaylor/helm-plugin-sdk`, and authors
start with `npx @coledtaylor/helm-plugin-sdk create`. It ships what `files` in
its `package.json` lists, and nothing it ships may reach outside its own
folder: run through npx, that folder is a cache.

- A plugin page is served on its version's scheme, one origin per plugin,
  framed out of process, with no preload and no Node. The bridge and the
  primitives stylesheet are injected into every page it serves. The same
  plugin on a remote host has an origin of its own,
  `floti-plugin://<id>.<label>/` or `helm-plugin://<id>.<label>/`
  (`shared/plugins/origin.ts`), served from that host's files only, so no
  storage or navigation is shared between hosts; This PC's stays
  `<scheme>://<id>/`.
- Its CSP has `connect-src 'none'`: `floti.fetch` (`helm.fetch` at version 1;
  the host's `plugins/net`) is its only way out, to origins the manifest
  lists, checked again on every redirect hop. A version 2 background's
  `floti.fetch` is held to the same rule.
- `guards.ts`: `will-frame-navigate` keeps a plugin frame on its own origin,
  and plugin origins get `clipboard-sanitized-write` and no other permission.
- The host answers a page's calls, `BroadcastChannel` posts included. The window and the hidden plugin window each ask it over their own
  connection (`app/host/plugins.ts`), and each draws or answers what concerns
  only its own pages: opening a tab and a link (`shared/plugins/client-calls.ts`),
  the theme. What a version 1 background page asks that only the window can
  draw goes between the two windows through main (`pluginWindow:*`). A remote host's pages call that host only, over
  its own connection (`bridgeFor(host)` in the window, a page link per host
  in the hidden window, whose background frames are keyed by host and
  plugin).
- `helm.exec` runs only programs the manifest names, with an argument array
  and no shell. A service gets a loopback port and a token for the run. Both
  run with the user's rights, which is why Settings names them. Turning a
  plugin off or reloading it ends its calls in flight, programs and service.
- Frames live outside React (`app/pluginFrames.ts`) and move between slots
  with `moveBefore`; `appendChild` would reload them. One relay
  (`renderer/src/plugins/relay.ts`) per page owns every frame's port.
- A plugin's failure shows in its own surface (`PluginFrame`), never in Helm's
  chrome, and never takes Helm down.
- A plugin with `pageStrip` has one `plugin-pages` tab whose ref holds its
  pages (`core/layout/pluginPages.ts`), never a tab per page. A page's frame
  key is its `pluginPageId`, never shaped like a plugin tab's, and a page's
  frame ends when the page leaves the layout, whatever removed it.
- Version 1 background pages are iframes in the hidden `plugin-host.html`
  window, not top-level pages: Chromium partitions an iframe's storage by its
  top-level site, and a top-level page would share nothing with the plugin's
  panels. A version 2 background module has no frame and no storage of its
  own; the host relays its `BroadcastChannel` posts to and from the plugin's
  pages on every client.
- A plugin's tools (`agent` in its manifest) are served by the host as one
  more family on its agent tools listener. A version 2 plugin's are answered
  by its background module (`floti.tools.handle`) in the host's isolate, with
  no client attached; a version 1 plugin's by its background page
  (`helm.tools.handle`) in the hidden window, through `main/plugins/tools.ts`.
  A plugin sends no notifications and
  never sends a running session anything: a session calls it, not the other
  way round.
- A tool its manifest marks `readOnly` is listed with `readOnlyHint` and
  passed as `--allowedTools mcp__helm-plugin-<id>__<tool>` to the sessions
  Helm starts, fixed at launch; Settings marks it. Every other tool asks, and
  a deny rule of the user's still wins.
- A plugin whose `sessions` lists `start` may ask to start one (`sessions.start`): only from
  a click in its page (the relay checks the window's user activation), and
  only once the user agrees in Helm's dialog, which shows the folder, name,
  first message and command. The host composes the launch from what it
  checked and holds; the window answers
  yes or no, on the connection it was asked on, and never says what to run.
- A plugin whose `sessions` lists `list` sees Helm's sessions since it opened
  (`sessions.list`, the `sessions` event), shaped by the host
  (`server/features/plugins/sessions.rs`), whose shape has no field for
  anything of a conversation: no argv, conversation id or `waitingFor`. A
  session's id there is the one its tool calls carry, minted by the host,
  never its row id.
- Any plugin may open an `https` link in the Browser tab (`open`), from a
  click only (the same relay check), one a second. The page that draws it
  checks it is an `https` address (`client-calls.ts`); the window opens it through `browser:open`, so it meets
  the reach rule a typed address does. The plugin never reads or drives it.
- `HELM_PLUGINS` registers folders in a dev build only.

## Overlays and templates

- The host composes overlays in each session's launch folder under its own
  data folder, never `%TEMP%`: they hold junctions into real repositories.
- Anything removing an overlay or a shim or walking a template unlinks links
  (junctions on Windows, symlinks on macOS and Linux) and never walks into
  one. `fs.rm` with `recursive: true` has been seen to leave a junction in
  place.
- Launch folders are swept only at host start, and the overlay shims an
  earlier Helm left in its data folder only at Helm's start
  (`createServices`), each only where every owning process is provably dead.
  `EPERM` counts as alive; unknown means keep.
- Templates live in `~/.config/helm/templates` (`helm-data/templates` when
  portable), which the host reads and Helm's start seeds (`templatesDir` in
  `paths.ts`). The shipped README and example are written only when the
  directory is absent, and nothing there is ever overwritten. There is no
  in-app template editor.
- Roles live in `roles` in the host's config folder (`~/.config/floti`), one
  `<name>.md` each (front matter, then the body). The host reads the folder
  afresh on every `agents_start`, `agents_roles` and reopen of a child, never
  from a cache, and seeds the shipped `reviewer.md`, `worker.md` and `lead.md`
  only when the folder is absent: nothing there is ever rewritten, an edit or a
  deletion stays, and an empty folder stays empty. A file that is not a role
  (front matter that does not parse, an unknown key, a value outside its
  choices) is named with its problem by `agents_roles`, and a start naming it
  is refused naming the file; nothing guesses at it. A role's body is composed
  into the child's instructions by its adapter, as its own section after the
  project's, and is never typed to the session.

## Where the data lives

`appMode` in `paths.ts` is the authority.

| run | Windows | macOS | Linux |
|---|---|---|---|
| installed | `%APPDATA%\Helm` | `~/Library/Application Support/Helm` | `${XDG_CONFIG_HOME:-~/.config}/Helm` |
| portable | `helm-data` beside the exe | none | none |
| `pnpm dev` | `%LOCALAPPDATA%\Helm\dev\helm-data` | `~/Library/Application Support/Helm Dev/dev/helm-data` | `${XDG_DATA_HOME:-~/.local/share}/Helm/dev/helm-data` |
| checks | `%LOCALAPPDATA%\Helm\checks\<name>\helm-data` | `~/Library/Application Support/Helm Dev/checks/<name>/helm-data` | `${XDG_DATA_HOME:-~/.local/share}/Helm/checks/<name>/helm-data` |
| `pnpm dev:live` | the installed app's own | the installed app's own | the installed app's own |
| templates | `~/.config/helm/templates`; `helm-data/templates` when portable | `~/.config/helm/templates` | `~/.config/helm/templates` |

`pnpm dev` is seeded each launch from a copy of the installed app's database;
`--fresh` gives the first-run state. The dev and check folders
(`isolatedBaseFor` in `scripts/isolate.mjs`) never sit inside the installed
app's folder, on any OS.

## Surfaces

- `renderer/src/terminal.ts` and the host's session environment
  (`crates/host/src/session/env.rs`) are tuned for TUI fidelity (SPEC 8.3);
  `ptyEnv` (`main/pty.ts`) is the spike page's single pty, kept to match. Terminal preferences are passed into `createTerminal`;
  never route a setting through `term:*`. The palette and contrast options are
  fixed. `estimateGrid` must keep measuring the way xterm does.
- Usage figures paint nothing rather than a wrong number. A stale reading of a
  window that is still running paints lower bounds. Roll-over is judged before
  age. Dollar figures are estimates and say so.
- Every agent's config directory (`~/.claude` for Claude Code) is read-only to
  Helm and Floti, except config console writes and hooks the user installs
  from it, each through the host's one config writer
  (`config_console/writer.rs`), which snapshots the file first and aborts if
  it cannot. The transcript archive copies into the host's `floti.db`, and
  never writes there. Copying `helm.db`'s archive into
  `floti.db` writes neither the agent's config nor `helm.db`, and logs
  counts, never a message. What a launch needs (agent
  tools, settings, composed instructions, overlays) is a per-launch file under
  the data directory, never a write into the agent's config.
- Session state comes from each backend's own signals, read only, then from
  OSC 7501 reports; a session with neither shows the plain tab. For Claude
  Code that is `~/.claude/sessions/<pid>.json`. Stale records are filtered by
  liveness at read time, and anything that cannot be interpreted degrades to
  the plain tab.
- The process-and-ports pass costs about half a second, so it runs only while
  the sessions pane is on screen or a `session_detail` call is waiting, every
  4s, in the host (`server/features/resources.rs`). Passes never overlap.
- "Could not look" (`null`, painted "Unknown") and "nothing there" (`[]`) are
  never merged.
- The Files view writes one thing: a markdown note in its Edit mode, through
  `content:write` - snapshotted first, refused on a hash conflict, scoped to
  the deepest folder Helm knows that holds the note (`assertContentWritable`
  refuses `repos/` under a harness). Everything else in it is read-only, and
  every `files:*` call names a root the host checks it knows
  (`workspace/roots.rs`: a scanned project, a profile's folder, a hosted
  session's working directory). Changed lines are the working tree against `HEAD`, said
  as that and never attributed to a session: git does not know who made a
  change. Only what is on screen is watched, and main is told the whole set.
- A project's agent worktrees (`worktrees:list`, `worktrees:remove`, served by
  `server/features/worktrees.rs` over `workspace/worktrees.rs`) are the folders
  `git worktree list` gives under `<repo>/.floti/worktrees` and no other
  worktree of the repository. The project must be one the host knows (a
  scanned project, a harness or a profile's folder; a hosted session's working
  directory does not make one). A removal is `git worktree remove` without
  `--force`, never a recursive delete, and keeps the `agent/<name>` branch. It
  is refused, in the answer and with the worktree left as it is, for a folder
  that is none of the project's agent worktrees, for one a running session
  works in (naming it) and for one with uncommitted changes (modified or
  untracked). Whether a worktree has uncommitted changes is `null` when git
  could not be asked, never "clean".
- Every backend resumes in the directory history recorded; for Claude Code,
  `claude --resume` there. Claude Code's transcripts are found by scanning
  `projects/*` for `<uuid>.jsonl`, never by deriving a path.
- `CLAUDE_CONFIG_DIR` moves credentials too, so a session pointed at a fixture
  home cannot sign in.

## Never touch the installed app

`pnpm verify:installer --yes`, `pnpm dist:win` where it feeds that, and
`pnpm dev:live` act on the installed Helm or its data. Run them only when the
owner asks, never as part of a suite. `packaging-check` also runs only on
request.

## Releases and tracking

- A release is a version bump in `packages/desktop/package.json` plus a
  `## <version>` section in CHANGELOG.md, merged to `main`. CI does the rest.
  The `procedures` skill has the detail.
- The plugin SDK publishes to npm on its own version: a bump in
  `packages/plugin-sdk/package.json` merged to `main`. A change to the SDK
  reaches plugin authors only with that bump.
- Work is tracked in the ClickUp list "Helm - Claude Code Shell"
  (`901114291892`). Nothing in the repository refers to a task by id.
- Machine-specific facts go in `CLAUDE.local.md` (gitignored). No personal path
  or name may appear anywhere in the repository; `pnpm packaging-check
  --only=audit` checks that, when asked for.
