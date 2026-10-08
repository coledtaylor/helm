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
├── core/     # headless logic: discovery, launch, config, content, usage, archive, store, layout
├── ui/       # React components
├── desktop/  # Electron main, preload and renderer
└── plugin-sdk/ # manifest validator, bridge types, helm-plugin CLI, authoring guide
examples/sample-plugin/  # every plugin surface; the plugin the E2E tests drive
```

pnpm workspaces with `node-linker=hoisted` (`.npmrc` says why). `core` and `ui`
export TypeScript source, so there is one build step.

| command | does |
|---|---|
| `pnpm dev` | the app with its own data directory (see "Where the data lives") |
| `pnpm check` | typecheck, lint and unit and integration tests - the gate |
| `pnpm build` | production build |

## Testing

- `pnpm check` is the gate. Every change passes it, and `pnpm test:e2e`
  when it touches a user workflow.
- Tests run locally, never in CI. CI builds and releases the app.
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
- Every renderer-to-main channel is declared in `shared/ipc.ts`. The preload
  exposes three generic functions; a feature adds a channel, not a bridge
  method. `term:*` (the spike page's single pty) and `session:*` (the app's
  sessions) never mix.
- The main process owns process lifetime. Session rows are written on spawn,
  `before-quit` ends sessions, `will-quit` releases the database, and nothing
  else closes the store.
- Do not use `@anthropic-ai/claude-agent-sdk`.
- Helm renders nothing for a live session: it parses no session output,
  answers no permission prompt and puts nothing between the user and the TUI.
  Rendering an archived transcript (read-only, after the fact) is allowed.
- Windows first: junctions (`mklink /J`) not symlinks, no elevation, test paths
  with spaces.

## Credentials

- Never handle or store a credential, Claude's or GitHub's. A sign-in is
  detected only from an artefact existing (`.credentials.json`,
  `ANTHROPIC_API_KEY`, the onboarding record in `.claude.json`). Never open
  those, `hosts.yml`, the keyring or `GH_TOKEN`. The remedy for "not signed
  in" is a sentence naming `claude`.
- `~/.claude/sessions` keeps a `<pid>.<sha256>.key` credential beside every
  `<pid>.json`. `readSessionRegistry` reads `.json` files only; never widen it.
- The `persist:helm-browser` partition holds the user's cookies and logins.
  Nothing reads it; the only call against it is `clearStorageData`.
- The plugin secret store (`main/plugins/secrets.ts`) is the one place Helm
  keeps a secret, and only one the user typed into it. It is encrypted with
  `safeStorage` and refuses to store when encryption is unavailable; a value is
  filled in by main, for a host and a plugin the user allowed, and never sent
  to any window. Helm never reads a Claude or GitHub credential to put there.
- The network posture is stated identically in README, docs/PACKAGING.md, the
  `update:check` comment in `shared/ipc.ts` and SPEC 5; change all four
  together. Helm contacts nothing on its own except the update check, and it
  listens only on loopback, for the sessions it hosts. A plugin's pages reach
  only the origins its manifest lists.

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

## Agent tools - the one inbound listener

`main/browser-mcp.ts` serves MCP over HTTP: `helm-browser` at `/mcp`,
`helm-sessions` at `/mcp/sessions`, on one port.

- `listen(0, '127.0.0.1')` only. Every request carries `Authorization: Bearer`
  or gets 401 before parsing. There is no unauthenticated route, not even a
  health check.
- One token per session, minted at launch and revoked when it ends. The token
  is the identity. `before-quit` stops the endpoint before sessions end.
- A tool family switched off has no route (404), no entry in `--mcp-config` and
  no tool. Every family off means no bind, no token and no `--mcp-config`.
- Each plugin offering tools is a family: `helm-plugin-<id>` at
  `/mcp/plugin/<id>`, on while the plugin is on and its tools are not switched
  off in Settings. Helm checks the token, then hands the plugin the call with an
  id minted for the session, its name and its working directory - never the
  token, never anything of the conversation. Turning them on reaches sessions
  started after; turning them off reaches running ones at once.
- Registration is a per-session `--mcp-config` file under the data directory,
  never `claude mcp add-json`. Leftover files are removed only when their owning
  pid is provably dead.
- An agent navigation must pass both `browserReach` and `browserMcpLocalOnly`.
- A tool drives the tabs its own session opened and a tab the user shared with
  it from the Share button, and only while the page is within `agentReach`. A
  share is one session per tab, made by session id (the window never sees a
  token), never inherited by a page the shared one opens, and revoked with the
  session's token. `browser_tabs` lists all; `browser_close` closes only the
  session's own.
- `sessions_list` and `session_detail` (`main/session-tools.ts`, shaped by
  `core/registry/describe.ts`) never return any part of another session's
  conversation: no transcript, prompt, output, argv, conversation id or child
  command line. The shaping types have no field for them. The sessions pane may
  show command lines to the user.
- Listing is machine-wide; detail exists only for sessions Helm spawned. A
  status Helm could not read is "unknown", never omitted. No tool takes a
  session id.
- These tools are awareness only. Nothing sends a session anything, waits on
  one or hands one work.

## Plugins

`main/plugins/` hosts them. `packages/plugin-sdk` holds the manifest validator
Helm loads with, so a manifest change starts there. `apiVersion` 1 is the only
one; anything else is an error in Settings, never a crash.

The SDK is published to npm as `@coledtaylor/helm-plugin-sdk`, and authors
start with `npx @coledtaylor/helm-plugin-sdk create`. It ships what `files` in
its `package.json` lists, and nothing it ships may reach outside its own
folder: run through npx, that folder is a cache.

- A plugin page is served on `helm-plugin://<id>/`, one origin per plugin,
  framed out of process, with no preload and no Node. The bridge and the
  primitives stylesheet are injected into every page it serves.
- Its CSP has `connect-src 'none'`: `helm.fetch` (`net.ts`) is its only way
  out, to origins the manifest lists, checked again on every redirect hop.
- `guards.ts`: `will-frame-navigate` keeps a plugin frame on its own origin,
  and plugin origins get `clipboard-sanitized-write` and no other permission.
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
- Background pages are iframes in the hidden `plugin-host.html` window, not
  top-level pages: Chromium partitions an iframe's storage by its top-level
  site, and a top-level page would share nothing with the plugin's panels.
- A plugin's tools (`agent` in its manifest) are answered by its background
  page, through `main/plugins/tools.ts`, and served as one more family on the
  inbound listener. A plugin sends no notifications and never sends a running
  session anything: a session calls it, not the other way round.
- A plugin whose `sessions` lists `start` may ask to start one (`sessions.start`): only from
  a click in its page (the relay checks the window's user activation), and
  only once the user agrees in Helm's dialog, which shows the folder, name,
  first message and command. Main composes the launch from what it checked
  and holds; the window answers yes or no and never says what to run.
- A plugin whose `sessions` lists `list` sees Helm's sessions since it opened
  (`sessions.list`, the `sessions` event), shaped by `describePluginSessions`
  in core, whose input has no field for anything of a conversation: no argv,
  conversation id or `waitingFor`. A session's id there is the one its tool
  calls carry, minted at launch by the session host, never its row id.
- Any plugin may open an `https` link in the Browser tab (`open`), from a
  click only (the same relay check), one a second. Main checks it is an
  `https` address; the window opens it through `browser:open`, so it meets
  the reach rule a typed address does. The plugin never reads or drives it.
- `HELM_PLUGINS` registers folders in a dev build only.

## Overlays and templates

- Overlay shims live under the app data directory, never `%TEMP%`: they hold
  junctions into real repositories.
- Anything removing a shim or walking a template unlinks junctions and never
  walks into one. `fs.rm` with `recursive: true` has been seen to leave a
  junction in place.
- Shims are swept only at app start (`createServices`), and only where every
  owning pid is provably dead. `EPERM` counts as alive; unknown means keep.
- Templates live in `templatesDir` (`paths.ts`). The shipped README and example
  are written only when the directory is absent, and nothing there is ever
  overwritten. There is no in-app template editor.

## Where the data lives

`appMode` in `paths.ts` is the authority.

| run | data directory |
|---|---|
| installed | `%APPDATA%\Helm` |
| portable | `helm-data` beside the exe |
| `pnpm dev` | `%LOCALAPPDATA%\Helm\dev\helm-data`, seeded each launch from a copy of the real database. `--fresh` for the first-run state. |
| `pnpm dev:live` | `%APPDATA%\Helm`, the installed app's own |

Templates are `helm-data/templates` when `PORTABLE_EXECUTABLE_DIR` is set, and
`~/.config/helm/templates` otherwise.

## Surfaces

- `renderer/src/terminal.ts` and `ptyEnv` (`main/pty.ts`) are tuned for TUI
  fidelity (SPEC 8.3). Terminal preferences are passed into `createTerminal`;
  never route a setting through `term:*`. The palette and contrast options are
  fixed. `estimateGrid` must keep measuring the way xterm does.
- Usage figures paint nothing rather than a wrong number. A stale reading of a
  window that is still running paints lower bounds. Roll-over is judged before
  age. Dollar figures are estimates and say so.
- `~/.claude` is read-only to Helm, except that the config console writes,
  through `writeConfigFile`, which snapshots the file first and aborts if it
  cannot. The transcript archive copies into `helm.db` and never writes there.
- Session state comes from `~/.claude/sessions/<pid>.json`, read only. Stale
  records are filtered by liveness at read time, and anything that cannot be
  interpreted degrades to the plain tab.
- The process-and-ports pass costs about half a second, so it runs only while
  the sessions pane is on screen or a `session_detail` call is waiting, every
  4s, through `execFile`. Passes never overlap.
- "Could not look" (`null`, painted "Unknown") and "nothing there" (`[]`) are
  never merged.
- The Files view writes one thing: a markdown note in its Edit mode, through
  `content:write` - snapshotted first, refused on a hash conflict, scoped to
  the deepest folder Helm knows that holds the note (`assertContentWritable`
  refuses `repos/` under a harness). Everything else in it is read-only, and
  every `files:*` call names a root main checks it knows (a scanned project, a
  profile's folder, a hosted session's working directory). Changed lines are the working tree against `HEAD`, said
  as that and never attributed to a session: git does not know who made a
  change. Only what is on screen is watched, and main is told the whole set.
- `claude --resume` must run in the directory history recorded. Transcripts are
  found by scanning `projects/*` for `<uuid>.jsonl`, never by deriving a path.
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
