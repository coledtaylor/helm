# Test backlog

What the removed real-window check drivers asserted, collected on 2026-10-02 so
the tests that replace them cover the same ground. Delete this file when every
line is covered or dropped (prerequisite C).

Each line is `[probe id] behaviour - tier`:

- **unit** - pure logic, no Electron or DOM.
- **integration** - a main-process service or a React component in jsdom, with
  Electron, the pty and the filesystem faked.
- **e2e** - a user workflow through the built app (Playwright), against a fake
  `claude` and a fake `gh`.
- **tool** - only meaningful against the real `claude` CLI or the real machine;
  a diagnostic, not a test.
- **drop** - asserted the driver's own machinery, a one-off measurement, or
  something no longer in the app.

`(covered: <file>)` marks a behaviour an existing `packages/core` test already
covers; `(partly: ...)` marks one whose logic is tested but whose wiring is not.
The drivers themselves are in git history before the commit that removed them.

## Found while collecting

- **TPL-13, possibly a live bug:** a startup scan that finishes after a newer
  scan overwrites `services.lastScan` with the old roots. The driver retried
  around it instead of failing. Reproduce before fixing.
- **BR-24:** Helm's retry on a refused connection was never proven; Chromium
  held the connection open itself, so the check could not tell the two apart.
- `configcheck.ts` used CFG-12, CFG-13 and CFG-14 twice each; the lines below
  tell them apart as "(files)" and "(crud)".

## Surface invariants

Rules from the removed `surfaces` skill. Each should become a test.

- Terminal preferences (font family, size, cursor style, blink, scrollback) reach a terminal only through `createTerminal`'s prefs; with none it uses `TERMINAL_DEFAULTS` - unit
- `estimateGrid` measures with a DOM span, floors and rounds as the WebGL renderer does, and reserves FitAddon's 14px ruler - integration
- A session's terminal is disposed when its tab closes, not when a component unmounts; a hidden pane at 0x0 is never fitted - integration
- Usage: a missing key, a reshaped object, no or a future timestamp, or windows that already reset paint no figure and give the reason - unit
- Usage: a stale reading of a window still running paints lower bounds (`>=59%`) with its age - unit
- Usage: roll-over is judged before age - unit
- Usage: a group's binding limit is the highest percent, not the one flagged `is_active` - unit
- Usage: dollar figures say they are estimates and show `PRICE_TABLE_DATE`; a model with no rate is counted, unpriced and named - unit
- Pull requests: cached rows stay, with their age, when a fetch fails - integration
- Pull requests: `classifyGhFailure` splits offline from auth by gh's own words; nothing on the offline branch mentions `gh auth login` - unit
- Pull requests: only a missing `gh` binary stops a pass; `gh auth status` never gates one (PR-20) - integration
- Pull requests: a `GhProblem` is raised only when a full sweep failed for every repository; a targeted refresh draws no verdict - unit
- Pull requests: `prIgnoredRepos` applies before the fetch, by slug, case-insensitively; ignored repos are absent from `repos`, listed in `ignored`, and keep their cached rows - unit
- Pull requests: the Files view matches the patch onto GitHub's file list by path, the cache keeps the diff text, and every ceiling hit is counted on screen - integration
- Pull requests: a review launch builds its prompt and argv in main from `{repoPath, number, cols, rows}`; null `prReviewModel` and `prReviewEffort` add no flag - unit
- Pull requests: `prCheckout: 'checkout'` refuses a dirty tree - integration
- Config: every write goes through `writeConfigFile`, which snapshots first and aborts if it cannot - integration
- Config: settings layers merge per leaf, local over project over user - unit
- History: a resume runs in the recorded directory and passes no `-n` - unit
- History: a transcript is found by scanning `projects/*` for `<uuid>.jsonl` - unit

## Sessions, history and transcripts

Sources: `sessionscheck.ts` (with `run-sessions.mjs`, `verify-orphans.mjs`), `historycheck.ts` (with `run-history.mjs`),
`transcriptcheck.ts` (with `run-transcript.mjs`). Coverage paths are relative to `packages/core/src/`. `(partly: <file>)`
means the pure core function is tested but the app wiring the probe exercised is not. No mark means grep found no test.

### Session tabs and lifecycle
- [SESS-1] Three sessions started from the sidebar tree's `+` run concurrently, one tab each, distinct cwds and pids, all at the prompt - e2e
- [SESS-2] A backgrounded session pane keeps its grid; a hidden 0x0 container is never fitted to 1x1 and sent to the pty - integration
- [SESS-3] Ctrl+Shift+Arrow on a focused tab moves it along the strip without losing or adding tabs - integration (partly: layout/panes.test.ts)
- [SESS-4] A session that exits on its own records status exited, exit code 0 and a measured duration - integration (partly: store/store.test.ts)
- [SESS-4] An ended session's tab and scrollback stay open, with a "Session ended" status banner offering the close - integration
- [SESS-5] A background tab's session ending raises a notification, even while another session tab is in front - integration
- [SESS-6] Closing a live session's tab asks a close-session confirmation; declining keeps both the tab and the process - integration
- [SESS-6] Confirming the close kills the process, removes the tab, and records the row as exited with a duration - integration
- [SESS-10] The crumb under the front session tab names its branch at spawn, as git reports it and as the row stores it - integration (partly: store/store.test.ts)
- [SESS-11] Double-clicking a tab title opens a focused rename field; Enter sets the label on tab, hosted record and row - integration (partly: store/store.test.ts)
- [SESS-11] A rename never touches the `-n` name the CLI got; the close confirmation uses the label - integration (partly: store/store.test.ts)
- [SESS-11] While the rename field has focus, keystrokes send zero bytes to the pty and the field keeps focus as the terminal repaints - e2e
- [SESS-12] Emptying the rename field restores the CLI name as the tab title and stores the label as null - integration (partly: store/store.test.ts)
- [SESS-13] A launch beside an ended-but-open tab does not take its name; no two tabs share a label - integration (partly: launch/session.test.ts)
- [SESS-15] Dragging the pane divider with the button held tracks the pointer mid-gesture and lands within 8px of the pointer's travel - e2e
- [SESS-15] A divider drag writes no attribute to either column (only the `--split` property), so the history list beside it is not re-rendered - e2e
- [SESS-15] The pane split button gives an open history tab its own pane, producing the divider - integration (partly: layout/panes.test.ts)

### Session rows and restart
- [SESS-8] After shutdown every session from the run has a completed row (status exited, duration set) - integration (partly: store/store.test.ts)
- [SESS-14] After an app restart a renamed row keeps its label and `-n` name, no other row has the label, branches persist - integration (partly: store/store.test.ts)

### Process teardown
- [SESS-7] Session host shutdown kills every session's whole process tree (claude and its conpty children), not just the shell - e2e
- [SESS-9] Quitting the app reaps a live session's process tree through before-quit; nothing outlives the app by more than 10s - e2e

### Session activity state (registry join and tab dot)
- [SESS-16] A launch puts a fresh `--session-id` uuid on argv and stores it on the row - unit (covered: launch/plan.test.ts, store/store.test.ts)
- [SESS-16] The real CLI registers in `~/.claude/sessions` under the assigned id, with the pty's pid - tool
- [SESS-17] The activity service joins each hosted session to its registry record: idle, waiting (+ waitingFor), busy - integration (partly: registry/registry.test.ts)
- [SESS-17] The tab dot paints idle in the success token, waiting in warn and busy in accent - three distinct tokens - integration
- [SESS-17/35] The real CLI publishes idle at its prompt, waiting with waitingFor "dialog open" under /help, and busy during a turn - tool
- [SESS-18] A record left by a hard kill, still claiming busy, is dropped and the tab dot stops painting busy or waiting - integration (partly: registry/registry.test.ts)
- [SESS-18] Helm leaves that stale record on disk for the CLI's own sweep - integration
- [SESS-19] An activity pass leaves the registry byte-identical and keeps only live records past stale and junk files - integration (partly: registry/registry.test.ts)
- [SESS-20] The registry join finds a session launched via a `.cmd` shim, where the pty pid is cmd.exe - unit (covered: registry/registry.test.ts)
- [SESS-20] A `.cmd` claude in a path with spaces is spawned through `cmd.exe /c` and its session reaches the prompt - e2e

### Sessions pane - process trees, ports and machine-wide listing
- [SESS-21] A hosted session's tree is rooted at its pty pid and every process in it descends from that pid - unit (covered: resources/resources.test.ts)
- [SESS-21] The resources service emits each running hosted session exactly once, at the pid the host holds, and invents none - integration
- [SESS-22] The real process pass maps a loopback listener's port to its pid unelevated, and drops it when it dies - tool (parse half could be unit)
- [SESS-23] The sessions pane lists each hosted session with its own cwd; its detail shows only its own children and ports - integration (partly: resources/resources.test.ts)
- [SESS-23] A port held outside the session's tree is never attributed to it, even on the same port number - unit (covered: resources/resources.test.ts)
- [SESS-23] A session with no children says "Nothing but the session itself" and draws no tree rows - integration (partly: resources/resources.test.ts)
- [SESS-24] A failed pass paints "Unknown" for tree and ports separately, never "nothing" - integration (partly: registry/describe.test.ts, resources/resources.test.ts)
- [SESS-25] A claude Helm did not start is listed under "Elsewhere on this machine", not hosted, with its cwd - integration (partly: registry/describe.test.ts)
- [SESS-26] The launch row warns first when a session runs in that folder, naming it and saying Helm did not start it - integration (partly: resources/resources.test.ts)
- [SESS-26] A project with nothing running in it shows no already-running warning - integration (partly: resources/resources.test.ts)

### Session tools (helm-sessions MCP server)
- [SESS-27] `--mcp-config` lists helm-browser at /mcp and helm-sessions at /mcp/sessions, one port, one shared token - unit (covered: launch/plan.test.ts)
- [SESS-27] Two hosted sessions are handed two different bearer tokens - integration
- [SESS-27] The sessions route answers 401 to a request with no token and to a token one character off - integration
- [SESS-27] tools/list returns exactly sessions_list and session_detail; every description and the server instructions say read-only - integration
- [SESS-27] initialize names the server helm-sessions, and the browser family on the same port still answers as helm-browser - integration
- [SESS-28] sessions_list holds every live registry record, each block with a status line, hosted ones saying "hosted yes" - integration (partly: registry/describe.test.ts)
- [SESS-28/31] One "(this session)" mark, on the caller's pid; the same call with another session's token moves it - integration (partly: registry/describe.test.ts)
- [SESS-29] session_detail(pid) on another hosted session gives its cwd (not the caller's), Helm tab id and spawn branch - integration (partly: registry/describe.test.ts)
- [SESS-29] session_detail takes a watch on the resources service and reports what is held from a pass the call itself caused - integration
- [SESS-30] No tool answer contains another session's first message, argv, `--mcp-config` path, either bearer token or conversation id - integration
- [SESS-30] The holding section names child processes as "name #pid" and never prints their command lines - unit (covered: registry/describe.test.ts)
- [SESS-31] session_detail with no pid answers for the token's own session, and undeclared identity arguments are ignored - integration
- [SESS-31] A real token with no session behind it may list (with no mark) but its own session_detail is refused - integration
- [SESS-32] With sessionMcp off a registration and its `--mcp-config` carry only helm-browser - integration (partly: launch/plan.test.ts)
- [SESS-32] Turning sessionMcp off live makes the sessions route 404 to a valid token while the browser route stays 200; on again restores 200 - integration
- [SESS-32] The endpoint's served names omit helm-sessions while it is off and keep helm-browser - integration
- [SESS-33] A real claude given only the tools finds another session by its directory and reports its Helm tab number and name - tool
- [SESS-34] For an exited session's pid, session_detail says "No Claude Code session with pid N" and the list drops it - integration (partly: registry/describe.test.ts)
- [SESS-35] A waiting session reads "waiting on the user (<waitingFor>)" with the reason verbatim, in list and detail - unit (partly: registry/describe.test.ts)

### History pane - index, list and search
- [HIST-0] The index's session, prompt, project and resumable counts match a plain read of history.jsonl and projects/ - unit (covered: store/history.test.ts)
- [HIST-1] The pane lists every session in history.jsonl, each row with its project basename and an age (now, Nm/h/d/w/y) - integration (partly: store/history.test.ts)
- [HIST-2] Grouping by project gives one header (with a count) per case-folded directory and keeps every row - integration (partly: store/history.test.ts)
- [HIST-3] Each row's resumable mark is right, and every unreopenable row carries a word badge, not only a colour - integration (partly: store/history.test.ts)
- [HIST-4] Search matches a substring of any prompt or the project path (LIKE, not FTS), returning exactly those sessions - unit (covered: store/history.test.ts)
- [HIST-4] Search over 3000+ prompts answers with a p95 under 100ms - unit (perf bound on a synthetic fixture; unsure if covered)
- [HIST-4] Typing in the search box filters the painted list to exactly the ids the history:sessions query returns - integration
- [HIST-8] The history list's scrollHeight stays within 2% of rows x row height (contain-intrinsic-size not padded twice) - e2e
- [HIST-8] content-visibility on history rows makes a resize relayout at least 3x cheaper than without it - tool

### History - resume and reaped sessions
- [HIST-5] Resume opens a tab running `claude --resume <id>`, no `-n`, in the session's recorded cwd - e2e (partly: launch/session.test.ts)
- [HIST-5] The real CLI redraws the resumed conversation and never prints "No conversation found" - tool
- [HIST-6] A reaped row's detail shows no Resume button, an explanation naming the missing transcript, and all of its prompts - integration
- [HIST-6] The main process refuses to resume a reaped session with a transcript error and spawns nothing, whatever the window asks - integration

### History - titles and hand-given names
- [HIST-9] Row titles are never blank, a placeholder, or a bare slash command when the session later said prose - unit (covered: discovery/title.test.ts)
- [HIST-9] A title is a stand-in only if no prompt is usable, else a real prompt's prefix cut at a word end within 60 chars - unit (covered: discovery/title.test.ts)
- [HIST-10] Renaming from the detail pane (rename button, field, Enter) repaints the row title with the name - integration
- [HIST-10] A hand-given name lives in history_names, survives a full re-index, and is searchable - unit (covered: store/history.test.ts)
- [HIST-10] Clearing the name restores the derived title in row and heading and deletes the history_names row - integration (partly: store/history.test.ts)

### History - sessions started outside Helm
- [HIST-7] A prompt appended to history.jsonl by a claude outside Helm is indexed by the watch or stat poll within 10s, with no forced refresh - integration
- [HIST-7] The newly indexed session reaches the open history pane without the renderer asking for it - integration

### Transcript archive
- [T-0] claudeHome() resolves to CLAUDE_CONFIG_DIR when it is set, and the archive and history read that tree, never ~/.claude - unit
- [T-0] A transcript that ended while Helm was closed is archived by the start-up sweep - integration
- [T-1] The watch over projects/ archives a newly written transcript without a forced refresh - integration
- [T-1] Archived text matches message for message; tool calls become "[tool: Name]"; tool results and noise are dropped - unit (covered: store/archive.test.ts)
- [T-2] A transcript that grew by n bytes costs an n-byte read and adds exactly the appended messages - unit (covered: store/archive.test.ts)
- [T-3] A token planted mid-conversation is found by the messages search scope and not by the prompts scope - unit (partly: store/archive.test.ts)
- [T-3] The history pane's scope toggle switches the search box between prompts and conversation content - integration
- [T-4] Eviction drops whole sessions, oldest last message first, only until stored bytes are under the ceiling - unit (covered: store/archive.test.ts)
- [T-4] A ceiling written through settings:write is honoured by the next sweep - integration
- [T-4] The settings pane's archive group states sessions, stored bytes, evicted count and max equal to the store's own figures - integration
- [T-5] A full archive and history pass with cursors cleared leaves the .claude tree byte-identical (path, size, mtime, sha256) - integration
- [T-6/T-7] With its transcript deleted and the app restarted, a conversation stays archived, identical and searchable - integration (partly: store/archive.test.ts)
- [T-7] That session's history row has no transcript file, archive state archived and an "archived" badge - integration
- [T-7] The transcript viewer renders each non-tool message as a row and folds each run of tool-only messages into one line - integration

### Driver machinery
- [SESS-0, SESS-16-SKIP, SESS-21-SKIP, SESS-27-SKIP, HIST-SKIP] Setup guards: discovery found enough projects, the index agreed with the file - drop
- [SESS-27] Failure line for "Helm's endpoint was not running" when the tools group starts - drop
- [SESS-9] verify-orphans' 10s grace window and naming of survivors (the behaviour itself is the SESS-9 line above) - drop
- [SESS-14, T-7] Runner failure lines for a phase that wrote no report or no phase-one record - drop
- [all] Report-audit completeness, `--only` phase gating and report-over-exit-code verdicts in the three runners - drop

## Settings and usage

Sources: `settingscheck.ts` + `scripts/run-settings.mjs` (S-*), `usagecheck.ts` + `scripts/run-usage.mjs` (U-*).
Paths in `(covered: ...)` are relative to `packages/core/src/`.

### Settings pane

- [S-1] The rail's gear opens a Settings tab that was not mounted before the click, and the tab is selected - integration
- [S-1] Settings renders all 12 groups in a fixed order (claude, workspace, ... archive, github), each with all its controls - integration
- [S-1] The pane never shows internal state keys (windowBounds, firstRunCompletedAt, paneLayout, browserRecentUrls, browserProjectUrls) - integration
- [S-1] Ctrl+Tab, bound in capture on the window, walks every workspace tab once in strip order and returns to the start - e2e
- [S-1] Tab cycling treats every group as one ring and moves focus with it - unit (covered: layout/panes.test.ts)

### Claude CLI override

- [S-2] The Claude group shows the discovered CLI path and the version that executable reports; Clear is disabled with no override - integration
- [S-2] Discovery lands on the same claude that where.exe finds on PATH - tool
- [S-2] Locate (file picker) writes claudePath; the pane shows the override and its own --version; setup:status reports source 'setting' - integration
- [S-2] Clear writes claudePath null; setup:status returns to 'discovered' and the pane to the discovered path - integration

### Scan roots

- [S-3] Adding a root through the directory picker appends it to scanRoots and the next scan lists its projects (paths with spaces) - integration
- [S-3] Removing a root from its settings row drops it from scanRoots; the next scan loses exactly its projects and keeps other roots' - integration
- [S-3, S-22] Removing a root orphans only the cached project rows it contributed - unit (covered: discovery/scan.test.ts)
- [S-22] A folder whose children are not projects is listed as one row, itself - unit (covered: discovery/scan.test.ts)
- [S-22] A scan root's project pane offers Remove root; the pane of a project inside a root does not - integration
- [S-22] Remove root from the project pane drops the root and its cached rows, closes its tab, and leaves the folder on disk - integration

### Pinned projects

- [S-19] The star on a project row pins it into a flat, cross-harness Pinned section; there is no section while nothing is pinned - integration
- [S-19] A pinned project appears exactly once in the tree - in Pinned, not also in its harness group - integration
- [S-19] pinnedProjects matches paths case-insensitively, stays sorted, and never holds two spellings of one path - unit (covered: store/store.test.ts)
- [S-19] A pin whose folder is gone is kept, shows a "folder gone" badge, and offers no launch - integration
- [S-19] A rescan leaves every pin in place, unresolvable ones included - integration
- [S-19] The sidebar filter applies to the Pinned section, and clearing it brings every pin back - integration
- [S-19] The settings pane lists every pin, gone ones included, and unpins from there - integration

### Appearance - themes

- [S-4] Clicking a built-in theme card sets data-theme, the dark class, color-scheme and the body background, and marks the card checked - integration
- [S-4] Picking a card writes theme=<kind> and the matching slot (themeDark or themeLight)=<id> - integration
- [S-4] Main applies the theme to nativeTheme.themeSource, the window background, and the title-bar overlay (bg, fg-muted symbols) - integration
- [S-4] Following Windows writes theme=system, sets nativeTheme to system, paints the slot Windows' mode picks; cards carry dark/light slot tags - integration
- [S-4] Theme resolution asks Windows only under 'system' and falls back to the slot's built-in when a named theme is gone - unit (covered: theme/theme.test.ts)
- [S-4c] A JSON file written into the themes folder becomes a card without a restart, and each later save repaints window and overlay live - integration
- [S-4c] A theme file broken mid-edit is named in the pane, its card goes, and the window falls back to the slot's built-in (not the light one) - integration
- [S-4c] Theme files parse with named problems, and unreadable files are skipped with a reason - unit (covered: theme/theme.test.ts)
- [S-4c] Duplicate writes a non-overwriting copy into the themes folder that reads back as the same palette - unit (covered: theme/theme.test.ts)
- [S-4c] A duplicated theme appears as a new card (e.g. graphite-copy) without a restart - integration

### Appearance - shape and accent

- [S-4b] The gap and corner steppers, the density switch and the accent swatches write paneGap, cornerRadius, density and accentColor - integration
- [S-4b] Gap, radius and density reach the layout: gutter = gap px, island radius = r, control radius = r+1, compact row padding 3px, strip 34px - e2e
- [S-4b] A chosen accent is adjusted to hold >=3:1 mark and >=4.5:1 text contrast against the surface - unit (covered: theme/theme.test.ts)
- [S-4b] Choosing the theme's own accent clears accentColor back to null - integration

### Usage status bar

- [U-1] The view shows the session limit and the binding (highest) weekly limit with its model scope, rounded - unit (covered: usage/usage.test.ts)
- [U-1] The segment paints "Session N%" and "Week (Model) N%" as readable text from that view - integration
- [U-1] .claude.json is found beside or inside the config directory and read from disk - unit (covered: usage/usage.test.ts)
- [U-2] A rewritten .claude.json reaches the bar with no restart, click or IPC (fs.watch plus stat poll, debounced) - integration
- [U-2] Each figure's colour follows the server's severity field (warning and critical differ), not a local threshold - integration
- [U-3] A reset under a day is counted down ("resets in 2h 5m"); one over a day shows weekday and clock time - unit
- [U-4] The segment re-derives on a clock tick and drops a window that resets while on screen, keeping the one that has not - integration
- [U-4, U-5] Reset windows are dropped; all-reset, future-dated, and stale-and-rolled-over readings show nothing - unit (covered: usage/usage.test.ts)
- [U-5] Missing, null, reshaped (limits or root) and half-written readings yield no number - unit (covered: usage/usage.test.ts)
- [U-5] For an unusable reading the tooltip says why (has not cached, already reset, reshaped shape, did not parse) - integration
- [U-5] Past the 30-minute horizon with live windows the figures become lower bounds; fresh readings do not - unit (covered: usage/usage.test.ts)
- [U-5] Lower bounds paint a >= before every figure and the tooltip calls them lower bounds; a fresh reading paints none - integration
- [U-6] Clicking the segment cycles percent -> cost -> off -> percent once the index has an estimate, and writes usageDisplay - integration
- [U-6, S-5] The cost mode is skipped and not offered until the transcript index has an estimate - unit (covered: usage/usage.test.ts)
- [U-6] Percent mode shows no dollars, cost mode shows dollars and no percent, off shows neither - integration
- [U-7] The status bar never overflows at 900/1024/1280/1600px in either theme with the widest reading; reset text hides below 1024 - e2e
- [U-11] Spend sums the session (anchored on the plan's reset), today and 7-day windows, deduped by uuid, priced per model - unit (covered: usage/cost.test.ts)
- [U-11] Cost mode leads with "Est.", shows the price-table date, and its tooltip says "Estimated, not billed" - integration
- [U-11] Painted dollar totals reconcile with an independent parse of the real transcripts, to painted precision - tool
- [U-9] Percent mode matches /usage in a live claude session within a point, and the bar follows the cache that session rewrites - tool
- [S-5] The pane's Usage display control sets each offered mode; the status bar segment and the row follow - integration
- [S-5] The cost option is disabled with an "index has caught up" reason until an estimate exists - integration
- [S-6] Cycling the status bar segment writes usageDisplay and the open settings pane's control follows it - integration

### Updates

- [S-6] The launch update-check tick writes updateCheck false and true again - integration
- [S-14] Check now asks the release source on every press with no throttle - two presses, two requests - integration
- [S-15] Check now is disabled and the outcome reads 'checking' while a request is in flight, and is enabled again after - integration
- [S-15] With updateCheck off, Check now stays enabled, still gets an answer, and does not switch updateCheck on - integration
- [S-16] newer, current and unreachable each render a distinct sentence; newer names both versions; unreachable carries the error reason - integration
- [S-16] Tones: current is 'ok'; unreachable is 'todo' with an offline follow-up line; neither newer nor unreachable is 'warn' - integration
- [S-16] A release tag equal to the running version counts as current (strict newer comparison) - unit
- [S-16] The Latest fact follows the last answer and shows '-' when unreachable; the version shown is app.getVersion() via app:info - integration
- [S-17] Release notes stays enabled during a check and in the up-to-date and offline states, with the same https URL in each - integration
- [S-18] A manual check never writes lastUpdateCheckAt, on success or on failure - integration

### Settings persistence and validation

- [S-7] Every AppSettings key rejects a malformed value, naming the key, and keeps the stored value; valid values land - unit (covered: store/store.test.ts)
- [S-7] A patch with one bad key writes none of it; unknown keys are ignored rather than rejected, and are not stored - unit (covered: store/store.test.ts)
- [S-7] settings:write over IPC hands the renderer accepted:false and the validator's message for a rejected patch - integration
- [S-8, S-9, U-10] Every setting (arrays, nulls, numbers, enums) reaches the database file and survives a reopen - unit (covered: store/store.test.ts)

### Terminal settings

- [S-10] Font size, cursor style, blink and scrollback changes apply live to every open terminal, sessions and project shells alike - integration
- [S-10] A font size change re-reports the new grid to the visible pane's pty - integration
- [S-10] A hidden (0x0) pane's pty is not resized; it receives the new grid as soon as the pane is shown again - integration
- [S-10] Cursor, blink and scrollback changes resize no pty, and rewriting an unchanged size resizes nothing - integration
- [S-10] xterm paints cells at the requested font size (cell width matches an independent canvas measurement) - e2e
- [S-10] A new shell's pre-spawn grid estimate uses the configured font size and lands within one column/row of the fitted grid - e2e
- [S-10b] After switching project, the pane holds exactly one terminal, the active project's; the previous shell stays alive, detached - integration
- [S-11] A user font family is prepended to the built-in stack ("Cascadia Mono", "Consolas", monospace), never substituted for it - unit
- [S-11] The font field commits on Enter, writes terminalFontFamily and applies live; Clear restores the built-in stack and a null row - integration
- [S-11] A family that is not installed raises a hint naming it; an installed family raises none - integration
- [S-12] Shell launch args are keyed on file name: -NoLogo for pwsh.exe and powershell.exe only, none for cmd, wsl and bash - unit
- [S-12] Shell detection finds shells on PATH and in off-PATH install locations (Store pwsh); pterm:shells returns the same list - integration
- [S-12] Every detected shell launches with its args and stays running (wsl may exit when no distribution is installed) - tool
- [S-12] terminalShell decides the next project shell opened, with no restart; null means the auto-detected first shell - integration
- [S-12] The shell picker in a project shell's header overrides that pane only; other panes keep the default - integration
- [S-12] Claude sessions always run the claude CLI whatever the shell setting says - integration

### Pane geometry

- [S-20] Dragging the project shell's handle stops at half the column and at a 180px floor - e2e
- [S-20] Double-clicking the handle returns the shell to the 30% default - e2e
- [S-20] Each drag or reset is exactly one projectShellHeightPct write, not one per pointermove - e2e
- [S-20] After every drag the xterm grid fits its box to within one cell and the pty is told the final grid - e2e
- [S-21] paneSplitPct lays the second pane out at that share of the row - e2e
- [S-21] Dragging the divider writes paneSplitPct once per gesture, matching the pane's measured share - e2e

### Content viewer wrapping

- [S-12b] The wrap checkbox writes contentWrap and the indent field, committed on Enter, writes contentWrapIndent - integration
- [S-12c] With contentWrap on, a source file opened afterwards wraps (no horizontal overflow, multi-row lines); off, it overflows in single rows - e2e
- [S-12c] Wrapped continuation rows hang contentWrapIndent columns from the line's own indentation, not the block edge - e2e
- [S-12c] contentWrap is the default a document mounts with; a pane already open keeps its own per-file choice - integration

### GitHub settings

- [S-13] The GitHub group shows the discovered gh path and its version; Clear is disabled with no override - integration
- [S-13] The discovered gh matches where.exe gh - tool
- [S-13] Locate writes ghPath; the pane shows the override's version and the next PR fetch runs that gh - integration
- [S-13] A fetch failing with gh's sign-in sentence is classified unauthenticated (from the fetch, not auth status) - unit (covered: github/github.test.ts)
- [S-13] Signed out, the Pulls pane says "gh auth login", the sidebar row says "Run gh auth login", and the fetched-age caption stays - integration
- [S-13] Clearing the gh override returns to the discovered gh and the auth problem clears on the next fetch - integration
- [S-13] PR poll interval offers Off (0) and stores 0 and 15; the stale cutoff offers Off (0) and stores 0 and 7 - integration
- [S-13] The review prompt commits typed text; Reset restores "/code-review {number}" and is disabled at the default - integration
- [S-13] Checkout mode stores checkout and none; review model and effort take a value and clear back to null via the empty option - integration

### Driver machinery and measurements

- [S-0] A check run starts with no saved panes, no saved window bounds and a 1280x820 window (the isolation seed's strip) - drop
- [S-4c] The themes folder a check sees lies inside the check's own data directory - drop
- [S-11] An absent family measures the same as the bare built-in stack (Chromium's per-glyph fallback; the prepend is the app's part) - drop
- [U-8] A repaint reads no file; a .claude.json read, a steady index pass and the spend sum stay under timing budgets - drop

## Pull requests and profiles

Sources: `prcheck.ts` (+ `run-prcheck.mjs`), `profilescheck.ts`, `shimhold.ts` (+ `run-profiles.mjs`, `verify-shims.mjs`).
Coverage notes name files under `packages/core/src/`. "partly covered" means the pure half is tested and the wiring is not.

### Pull requests - fetch and remote mapping
- [PR-1] A sweep paints every open PR gh returns in the Pulls pane, the pull_requests table and the sidebar "N open" total - e2e
- [PR-1] A later sweep drops a PR gh no longer returns and rewrites a changed title, in pane and cache - integration (partly covered: store/pulls.test.ts)
- [PR-2] `gh pr list` uses `--repo <slug> --state open` and every painted field, never the cwd - integration (partly covered: github/github.test.ts)
- [PR-2] A sweep also asks `gh --version` and `gh auth status` - integration
- [PR-2] A gh installed as a `.cmd` shim (scoop/npm shape) is resolved and runnable - integration
- [PR-3] Origin is read via real `git remote get-url origin` in a path with spaces and stored as the slug - integration (parse covered: github/github.test.ts)
- [PR-22] Before any remote is read, folders count as `unmapped` and pane/sidebar say "Checking...", never "No github.com repositories" - integration

### Pull requests - ignore list
- [PR-18] An ignored repo gets no `gh pr list` call on a sweep while other repos still do - integration (slug matching covered: github/github.test.ts)
- [PR-18] An ignored repo leaves the Pulls pane, shows as an Ignored chip (not under quiet), and its cached rows stay in the DB - integration
- [PR-18] Settings lists every known GitHub repo, with the ignored one unticked - integration
- [PR-18] Clicking the Ignored chip removes the slug from `prIgnoredRepos` and the repo's rows return on the next fetch - integration
- [PR-24] A project pane for an ignored repo names the slug with an un-ignore button rather than going empty; undo restores rows from cache - integration

### Pull requests - project pane
- [PR-23] A project pane lists exactly its own repo's open PRs, with no source pill and a "fetched ..." age caption - integration
- [PR-23] Clicking a project-pane PR row opens that PR's detail tab - integration
- [PR-23] The project pane's Config and Content links open those panes scoped to that project - integration

### Pull requests - triage (Open section)
- [PR-31] `prStaleDays: 0` shows one Open section, newest update first, unparseable timestamps last, no split - integration (sort covered: github/github.test.ts)
- [PR-32] ACTIVE/STALE split on updatedAt vs the cutoff; unparseable updatedAt goes to ACTIVE; failing checks never move a row out of STALE - unit
- [PR-32] A stale row still paints its checks tally chip; STALE reads "No motion in N+ days"; header "N open" counts every row - integration
- [PR-31/32/34] Every section heading's count equals the rows painted under it, filtered or not - integration
- [PR-33] STALE collapses and expands; collapsed, its heading keeps the count and caption; ACTIVE and the header are untouched - integration
- [PR-33] Collapse state is not persisted: a remounted pane shows STALE expanded - integration
- [PR-34] The filter matches PR number (with or without #), title, branch, author and repo slug - unit
- [PR-34] While filtering, an `x/N` count shows by the field and the header total never changes - integration
- [PR-34] A query matching nothing shows a filter-specific empty state, not the "nothing open" one - integration
- [PR-35] GROUP None is the default; Repo groups in core's busiest-first order, Author groups by count then name; one-row groups get headings - unit
- [PR-35] Grouped by repo the source pill is hidden, grouped by author it is on every row; grouping never changes the row set - integration
- [PR-36] Filter text and group choice reset when the pane remounts and are never written to settings - integration
- [PR-36] `prStaleDays` is a persisted, validated setting - unit (covered: store/store.test.ts)

### Pull requests - detail tab
- [PR-4] A PR tab's header (number, title, state, branch, +/-, "N files"), commits and files match gh - integration (parse covered: github/github.test.ts)
- [PR-4] The checks tally reduces a mixed rollup (CheckRun pass, CheckRun pending, StatusContext fail) to 3/1/1 - unit (covered: github/github.test.ts)
- [PR-16] Files view paints `gh pr diff`: status badge (`new file mode` = added), add/del/context rows, hunk header - integration (parse covered: github/github.test.ts)
- [PR-16] A file collapses to its header (rows removed, file still listed) and reopens with the same rows - integration
- [PR-5] Comment markdown is rendered and sanitised in main and arrives as HTML (`**x**` becomes `<strong>`) - integration (unsure if covered)

### Pull requests - review threads
- [PR-25] Review threads (`gh api graphql`) show in Conversation, one card each, timed by first comment - integration (ordering covered: github/github.test.ts)
- [PR-26] A thread card names file:line (the original line for an outdated thread) and renders its markdown through main - integration
- [PR-26] A thread's diffHunk is painted as text, never HTML; planted markup produces no element - integration
- [PR-26] Resolved threads carry a "resolved" chip and start collapsed; outdated carry "outdated" and start open; others carry no chip - integration
- [PR-27] All thread pages (120) and reply pages (130) are fetched in order with the right cursors - integration (page parse covered: github/github.test.ts)
- [PR-28] Cached detail without reviewThreads says "not been fetched - Refresh" in both views, never "none" - integration (partly covered: github/github.test.ts)
- [PR-28] One refresh writes `reviewThreads: []` to the cache and the note disappears - integration
- [PR-29] A failing thread fetch keeps body, comments, reviews and earlier threads, and says "could not be re-read" with reason and age - integration
- [PR-29] The thread-failure note clears by itself on the next good fetch - integration
- [PR-30] Files view puts each thread on its head-side line; one outside the patch sits at the file's foot - integration (anchoring covered: github/github.test.ts)

### Pull requests - review launch
- [PR-6] The Review button stays disabled until the PR detail has loaded - integration
- [PR-6] Review launches in the repo dir, named "PR #n review", `-n <name>` first and the rendered prompt as trailing positional - integration
- [PR-6] Clicking Review writes a sessions row and opens a live session tab in the strip - e2e
- [PR-7] A `prReviewPrompt` set in Settings persists and reaches the next launch, all five placeholders filled - integration (render covered: github/github.test.ts)
- [PR-17] `prReviewModel`/`prReviewEffort` add `--model`/`--effort` before the trailing prompt, and only when set - integration
- [PR-17] The review disclosure sentence names the model and effort flags before the button is pressed - integration
- [PR-8] Checkout mode refuses a dirty tree with "N uncommitted change(s)" and spawns nothing - integration
- [PR-8] Checkout mode on a clean tree runs `gh pr checkout <n>` in the repo before the session row is written and reports git's branch - integration
- [PR-9] `pr:review` from the renderer carries only repoPath, number, cols, rows; a prompt sent over IPC is ignored and main renders it - integration

### Pull requests - degradation
- [PR-10] A refused token gives `unauthenticated` and a "gh auth login" sentence; rows, cache, age caption stay - integration (classifier covered: github/github.test.ts)
- [PR-19] Unreachable GitHub is `offline`: never says "gh auth login" or "not signed in", and rows stay - integration (classifier covered: github/github.test.ts)
- [PR-20] The next sweep after the network returns clears the banner and refetches, with no restart - integration
- [PR-21] A targeted refresh of one failing repo sets a row error, never a machine-wide banner - integration
- [PR-11] No gh binary gives `missing` with a sentence naming cli.github.com and Settings - integration
- [PR-12] Non-JSON gh output is reported per repo as "not JSON"; rows stay, the poller survives and recovers - integration (parse covered: github/github.test.ts)

### Pull requests - live gh
- [PR-13] A real `gh pr list` on a real repository parses field for field the same as an independent parse - tool

### Profiles - form
- [PROF-0] A harness added as a scan root via IPC is discovered with its repos and offered by the form - integration (scan covered: discovery/scan.test.ts)
- [PROF-1] New profile dialog saves name, root, model, opening prompt, overlays and access; row is listed - integration (store covered: store/profiles.test.ts)
- [PROF-1] Ticking Compose on a repo also ticks its Access - integration
- [PROF-11] With no root, the MCP picker says to set a root rather than showing an empty list - integration
- [PROF-11] Agent is a select over the root's agents plus composed overlays' namespaced `<overlay>:<agent>` - integration (prediction covered: config/config.test.ts)
- [PROF-11] MCP servers are checkboxes over the root's .mcp.json keys; no free-text MCP field exists - integration
- [PROF-11] The picked agent and ticked servers are what the profile saves - integration
- [PROF-12] A saved agent or MCP name the root cannot resolve is shown selected, marked unresolved by name, and kept on save - integration

### Profiles - launch and composition
- [PROF-2] Clicking a profile row launches one session tab with cwd at the root and the profile id recorded - integration
- [PROF-2] Argv: a `--plugin-dir` per overlay, `--add-dir`, `--model`, `--append-system-prompt-file`, prompt last - unit (covered: launch/plan.test.ts)
- [PROF-2] One click on a profile opens a live session tab in the window - e2e
- [PROF-3] The opening prompt is answered with nothing typed into the pty - tool
- [PROF-4] Same-named skills from two overlays both invoke under their own namespaces in a root-launched session - tool (prediction covered: config/config.test.ts)
- [PROF-5] An overlay's CLAUDE.md reaches context via --append-system-prompt-file (--add-dir does not) - tool (composition covered: launch/overlay.test.ts)
- [PROF-6] Files in overlay repos are readable via --add-dir from a session rooted elsewhere - tool
- [PROF-7] A profile survives YAML export, delete and import intact, paths relative to the root - unit (covered: store/profiles.test.ts, launch/profile.test.ts)
- [PROF-8] An edit to a source repo's skill shows through the shim junction on relaunch, with no stale copy - integration (covered: launch/overlay.test.ts)
- [PROF-8] A relaunched session actually invokes the edited skill body - tool

### Profiles - overlay shims across app starts
- [PROF-9] App start sweeps a shim whose owner exited, leaving no overlay-* dirs and the repos intact - integration (partly covered: launch/overlay.test.ts)
- [PROF-10] A second Helm starting on the same data dir leaves a running Helm's live shim and junctions intact - integration (partly covered: launch/overlay.test.ts)

### Driver machinery
- [PR-1] Mutating the fixture under the comparator to prove it discriminates - drop
- [PROF-0/PROF-11] Fixture-usable guards: setup found the fixtures, picker fixtures are discriminating - drop
- [PROF-9] Planting a stamped shim owned by an exited pid for the next start to find - drop
- [PROF-10] READY/RELEASE file handshake between the holding app and the sweeping app - drop
- [profiles] Auto-answering trust, MCP and skill-consent gates in a hosted claude - drop
- [runners] Report over exit code, settings restore after a killed run, report-completeness audit - drop

## Content, config and editors

Sources: `contentcheck.ts` (CONT-*), `configcheck.ts` (CFG-*), `highlightcheck.ts` (HL-*), plus `run-content.mjs` and `run-config.mjs`.
The runners assert nothing about the app: they restore borrowed files and audit that the report is complete.
Covered paths are relative to packages/core/src/.
configcheck reuses three ids for two different probes: `CFG-12/13/14 (files)` is the Files view, `CFG-12/13/14 (crud)` is create/rename/delete.

### Content viewer - scopes and file browser

- [CONT-0, CFG-0, HL-0] A profile root outside every scan root becomes a scope in the content and config switchers after Refresh re-reads scopes - integration
- [CONT-1] Curated view offers notes/, context/, .claude/skills/, docs/ when present and lists every file in an offered root - unit (covered: content/content.test.ts)
- [CONT-1] The curated list paints exactly one row per file in the scope's tree, each tagged with its kind (markdown, html, source, binary) - integration
- [CONT-12] A harness opens in Curated and a project in Tree by default, and a caption names the rule ("harness default" / "project default") - integration
- [CONT-12] Either mode works from either scope kind: a project read as Curated, a harness walked as Tree with its top-level dirs as rows - integration
- [CONT-12] An empty named root stays listed, badged "named", and the pane says it is empty - integration (core half covered: content/content.test.ts)
- [CONT-13] A scripts-only dir is a discovered root, a binaries-only dir is not, and a binary inside an offered root is listed - unit (covered: content/content.test.ts)
- [CONT-13] In the curated list, scripts show with the source kind and a binary inside a root shows with the binary kind instead of being hidden - integration
- [CONT-14] Project tree lists every entry (unsupported kinds like LICENSE too) and reads a directory only on expand - unit (covered: content/content.test.ts)
- [CONT-14] Ignore state comes from the repo's .gitignore, not a built-in list; ignored entries are marked, not dropped - unit (covered: content/content.test.ts)
- [CONT-14] Ignored tree rows show an IGNORED badge, the caption says ".gitignore respected", and the header count mentions ignored entries - integration
- [CONT-14] Expanding a folder in the tree paints its children, which were absent before the click - integration

### Content viewer - markdown rendering and links

- [CONT-2] Frontmatter is parsed and never rendered as body text; a broken block is reported rather than shown raw - unit (covered: content/content.test.ts)
- [CONT-2] GFM tables, checked task items, highlighted fenced code with a language label, and callouts render as such - unit (covered: content/content.test.ts)
- [CONT-2] The reading view paints a frontmatter chip row for a note that has frontmatter - integration
- [CONT-2] Rendered lists show disc bullets and decimal numbers despite the CSS preflight reset; task lists show no bullet - e2e
- [CONT-2] Every markdown file in a real harness vault renders with no console error and matches an independent regex count of its features - tool
- [CONT-4] Wikilinks resolve by path spelling, then by bare basename, case-insensitively; an unresolved one is counted broken - unit (covered: content/content.test.ts)
- [CONT-4] A wikilink whose alias remark split into its own node is still found, counted and labelled - unit (covered: content/content.test.ts)
- [CONT-3] Clicking a live wikilink opens the target note in the pane - integration
- [CONT-3] A broken wikilink is visibly distinct from a live one (different computed colour and a dashed underline) and a broken-link count shows - e2e
- [CONT-11] Clicking an https link in a note is intercepted and sent to the system browser rather than swallowed by the navigation lock - integration
- [CONT-11] shell:openExternal refuses every scheme but http, https and mailto (a file: URL returns opened: false and opens nothing) - integration

### Content viewer - HTML artifacts

- [CONT-5] An HTML artifact opens in a frame, lays out its text, runs its inline script, and logs no console error or warning (bootstrap included) - e2e
- [CONT-5b] A real artifact from a harness vault can be served by the protocol and framed - tool
- [CONT-6] The artifact frame has no Node globals, no preload bridge, an opaque origin, no window.top access, and cannot fetch or load remote images - e2e
- [CONT-6] helm-content refuses traversal out of the artifact's directory (403 for an encoded %2f, 404 once normalised) and leaks no bytes - integration
- [CONT-6] helm-content serves a sibling file of the artifact (200) under a CSP of default-src 'none', connect-src 'none' and no http(s) source - integration
- [CONT-15] A [[wikilink]] in an artifact becomes a link, a broken one is marked differently, and clicking the live one opens the note in the pane - e2e
- [CONT-15] The bootstrap injected into an artifact is given names-to-booleans only; no filesystem path appears in the framed document - integration

### Content viewer - search

- [CONT-7] Search matches case-insensitively inside words, and matches names of every kind without reading non-text bodies - unit (covered: content/content.test.ts)
- [CONT-7] Bodies are read for markdown, data, text and source only, files over 4 MB are matched by name only, and the result reports body kinds - unit
- [CONT-7] Total match count equals an independent occurrence count for every term, including terms that match nothing - unit
- [CONT-7] The hit list is capped at 200 files while the total match count is not, and the pane says more files matched than are listed - unit
- [CONT-7] The search box paints result rows and a status line stating what was searched ("text in N, names in M") - integration
- [CONT-7] Warm search over a real harness vault answers in under 200 ms p95, measured in the renderer around the IPC call - tool

### Content viewer - editing and the write guard

- [CONT-8] In the split editor, typing marks the note dirty and the preview redraws from the draft - integration
- [CONT-8] Saving a note writes the draft verbatim, so frontmatter is byte-identical, and takes exactly one snapshot recording the original hash - e2e
- [CONT-8] A content write snapshots the prior bytes before writing and restore returns them exactly - unit (covered: config/config.test.ts, shared path)
- [CONT-9] Content writes refuse a path outside the scope, inside a nested repository, or with a non-content extension - unit (covered: content/content.test.ts)

### Content viewer - scrolling

- [CONT-16] A scrolled source view keeps its offset and DOM node while idle, wrapped or not; re-renders do not re-inject the highlighted HTML - integration
- [CONT-10] A 20,000-word note and the largest vault note scroll with a p95 frame interval of 32 ms or less - tool

### Config console - browsing and live state

- [CFG-1] Config tree names skills by dir, commands and agents by path, and finds settings in user, harness, project scopes - unit (covered: config/config.test.ts)
- [CFG-1] The Files list paints one row per tree file except files bundled under a skill, and skill rows are present - integration
- [CFG-15] A file is assigned to the skill whose directory holds its SKILL.md (bundledWith) - unit
- [CFG-15] A bundled file has no row of its own; it shows on the skill row's second line and in the skill pane's bundle list - integration
- [CFG-12 (files)] A settings file is live, partial or shadowed by how many keys another layer outranks (local > project > user) - unit (covered: config/live.test.ts)
- [CFG-13 (files)] A skill carries the invocation a session would type (<overlay>:<skill> under an overlay), no winner for a contest - unit (covered: config/live.test.ts)
- [CFG-12, CFG-13 (files)] Rows paint live state only once resolution arrives, and a skill row's second line shows its invocation - integration
- [CFG-12 (files)] The settings pane marks, per key, whether this file's value wins, and lists exactly the keys the file declares - integration
- [CFG-14 (files)] Hook provenance (event, matcher, settings block) is computed from the settings that name the script - unit (covered: config/live.test.ts)
- [CFG-14 (files)] A hook file's pane shows that provenance above its source and names the settings file it came from - integration
- [CFG-16] A SKILL.md opens rendered through the shared markdown renderer with frontmatter chips and no textarea; Edit shows its source - integration

### Config console - editing, snapshots and conflicts

- [CFG-2] A file in each scope (user CLAUDE.md and settings.json, a harness skill, a project agent and settings) can be edited and saved from the pane - e2e
- [CFG-3, CFG-9B] Every save takes a snapshot, and restoring it brings back the exact prior bytes, user settings.json included - unit (covered: config/config.test.ts)
- [CFG-4] A changed write takes exactly one snapshot before touching disk; an identical write takes none and reports unchanged - unit (covered: config/config.test.ts)
- [CFG-5] Malformed JSON is located by line and column (a trailing comma reports the line it is on) - unit (covered: config/validate.test.ts)
- [CFG-5] Malformed JSON in the editor disables Save and shows a located error strip; nothing reaches main, disk or the snapshot table - integration
- [CFG-6] A save whose base hash no longer matches disk is refused and the conflict carries the on-disk content - unit (covered: config/config.test.ts)
- [CFG-6] A file changed on disk while open shows a "changed on disk" banner, disables Save, and offers Reload - integration

### Config console - create, rename, delete

- [CFG-12 (crud)] Names are validated as the CLI addresses each kind; collisions and bad names are refused unwritten - unit (covered: config/create-rename-delete.test.ts)
- [CFG-12 (crud)] Scaffolds land where the CLI reads them (commands/ns/cmd.md = /ns:cmd), one create snapshot each - unit (covered: config/create-rename-delete.test.ts)
- [CFG-12 (crud)] The New dialog previews the target path and opens the created file in the editor after Create - integration
- [CFG-12 (crud)] On a collision or bad name the New dialog disables Create, shows the reason under the field, and stays open - integration
- [CFG-12B] User-scope create and remove go through the same guard and leave the rest of skills/ unchanged - unit (covered: config/create-rename-delete.test.ts)
- [CFG-13 (crud)] Renaming a skill moves its whole dir with bundled files and changes only its frontmatter name - unit (covered: config/create-rename-delete.test.ts)
- [CFG-13 (crud)] Renaming a command across namespaces moves it byte-identical and prunes the emptied namespace dir - unit (covered: config/create-rename-delete.test.ts)
- [CFG-13 (crud)] The rename dialog previews the destination path and closes on Apply - integration
- [CFG-13 (crud)] Rename is disabled, with the reason in its tooltip, for a file the CLI finds by exact name (settings.json) - integration
- [CFG-14 (crud)] Delete snapshots every file of a skill before removing any; restore returns them byte-identical - unit (covered: config/create-rename-delete.test.ts)
- [CFG-14 (crud)] The delete confirmation lists exactly the files to be removed, says Undo restores them, and focuses Cancel - integration
- [CFG-14 (crud)] After a delete a notice strip offers Undo, which puts the files back through config:restore - integration

### Config console - MCP, effective view and health

- [CFG-7] The add-server dialog previews the .mcp.json diff before anything runs; the file is untouched until Apply - integration (diff covered: config/config.test.ts)
- [CFG-7] Apply snapshots .mcp.json, then runs `claude mcp add-json --scope project`, and the server entry the CLI writes is there afterwards - integration
- [CFG-7] Approve adds the server to enabledMcpjsonServers in settings.local.json through a snapshotted write - integration
- [CFG-10] A server added and approved through the UI works in the next launched session (its tool returns its token) - tool
- [CFG-8] Effective view predicts <overlay>:<skill> names, shows a shared name under both namespaces, resolves settings per leaf - unit (covered: config/config.test.ts)
- [CFG-8] The Effective tab, for a chosen profile, paints one invocation row per resolved skill and flags names shared across overlays - integration
- [CFG-9] A live session on a profile resolves the predicted skills and sees the predicted settings winner, merged per leaf - tool
- [CFG-11] The doctor parse lays `Label: value` lines out as rows and leaves unrecognised lines to the raw text - unit
- [CFG-11] Health runs `claude doctor` on click and shows the CLI's raw output, the parsed rows and the exit status, without judging health - integration

### Shared code editor

- [HL-1] The editor stays a controlled textarea; typing makes the underlay mirror equal the value and marks dirty, reverting to disk bytes clears it - integration
- [HL-1] The highlight layer renders per-line spans carrying shiki colour properties - integration
- [HL-1] The underlay tracks textarea scroll vertically with wrap on and on both axes with wrap off, by transform and by actual position - e2e
- [HL-15] The content viewer's split editor is the same component (data-content-editor kept, surface "content") with its mirror and highlight - integration
- [HL-2] Textarea, mirror and highlight layers agree on font, size, line height, letter spacing, tab size, padding, border and white-space - e2e
- [HL-3] A file ending in several newlines has the same scroll height in the textarea and both underlay layers - e2e
- [HL-4] Tab indents by the file kind's unit at a caret and indents whole lines over a selection; Shift+Tab outdents - unit (covered: content/editing.test.ts)
- [HL-5] Enter keeps the line's indentation and opens an indented block between a bracket pair - unit (covered: content/editing.test.ts)
- [HL-6] Brackets auto-close, a closer is typed over, Backspace removes an empty pair; quotes close in JSON but not in prose - unit (covered: content/editing.test.ts)
- [HL-4, HL-5, HL-6] Tab, Shift+Tab, Enter, Backspace, brackets and quotes typed in the textarea apply those edits and place the caret - integration
- [HL-7] Find matches literally and case-insensitively without overlaps - unit (covered: content/editing.test.ts)
- [HL-7] Ctrl+F opens a find bar with a match count, paints matches in the underlay, and Next/Prev select and mark the current match - integration
- [HL-7] Ctrl+G opens go-to-line and Enter moves the caret to that line - integration
- [HL-8] The current line's gutter number is marked as the caret moves - integration
- [HL-8] Gutter numbers sit on each logical line's box, wrapped lines included, and the caret-line band sits on the caret's line - e2e
- [HL-9] Undo after a programmatic edit restores the previous typed state and redo reapplies it; edits never fall back to assigning .value - e2e
- [HL-10] Prose wraps by default and structured files do not - unit (covered: content/editing.test.ts)
- [HL-10] The wrap toggle flips wrapping for the open file; wrapped prose has no sideways overflow, unwrapped structure scrolls sideways - e2e
- [HL-11] Every keystroke is in the visible text layer by the next frame at every file size, including past the highlighting ceiling - e2e
- [HL-12] Re-highlighting is debounced after typing stops, the coloured state goes stale meanwhile, and colours return when the reply arrives - integration
- [HL-12] Above the windowing threshold the highlight layer renders only a visible slice while the mirror holds the whole file - integration
- [HL-12] Scrolling a 3,000-line file drops at most 2 frames over 50 ms, and a large paste does not delay the next keystroke past one frame - tool
- [HL-13] Above the size ceiling the main-process highlighter returns tooLarge with no lines or HTML - integration
- [HL-13] Past the ceiling the editor drops overlay and gutter, the textarea paints its own text, a footer says what is off, typing still works - integration
- [HL-14] Highlighted tokens carry both --shiki-light and --shiki-dark, so a theme flip needs no re-highlight - unit (covered: content/content.test.ts)
- [HL-14] Switching the theme changes an editor token's computed colour, and switching back restores it - e2e
- [HL-16] Editing without pressing Save writes nothing: typing, undo, find, wrap and theme flips issue no write - integration

### Driver machinery

- [CFG-Z] The user's settings.json is byte-identical after the run (the driver's own restore of a file it borrowed) - drop
- [CONT-0, CFG-0, HL-0] Fixtures are planted, profiles created for them, and the user scope backed up before the run - drop
- [CONT-*-THREW, CFG-*-THREW, CONT-NO-HARNESS] A group that throws, or a machine with no harness, becomes a failing report row - drop
- [CONT-5b] A harness with no HTML records a passing "nothing real was opened" row - drop
- [CFG-12/13/14 (crud)] Dialog screenshots in both themes are byte-distinct, proving the theme applied before capture - drop
- [CONT-7] The first search in a cold scope is timed and reported separately - drop
- [CFG-11] The panel's output agrees with a second `claude doctor` run made by the driver - drop
- [run-content, run-config] Restore the borrowed note or user settings from a backup, and fail when the report is missing or incomplete - drop

## Browser, templates, design and affordance

Sources: `browsercheck.ts` + `run-browser.mjs` (kept until its SECURITY lines are covered), `templatecheck.ts` + `run-template.mjs`,
`designshot.ts`, `affordancecheck.ts`. Coverage names a test file under `packages/core/src/`.

### Browser pane - navigation and address bar

- [BR-1] A tab opened from the strip loads an http page; the address bar and tab title show the page's own URL and title - e2e
- [BR-2] Back and forward buttons round-trip between two visited pages - e2e
- [BR-2] A bare port typed in the bar resolves to http://localhost:PORT/ - unit (covered: browser.test.ts)
- [BR-4] Main adds a URL to the recent list only on a successful navigation, newest first, max ten - integration (partly covered: store.test.ts)
- [BR-4] Clicking the address bar (no keystroke) opens the recent dropdown listing exactly the stored URLs in order; Escape closes it - integration
- [BR-24] A refused port is retried quietly and the page loads once the server starts, nothing pressed; only ERR_CONNECTION_REFUSED retries - integration
- [BR-25] Hard reload bypasses the cache (server sees cache-control: no-cache); an ordinary reload does not - integration
- [BR-26] Zoom in raises the page's own devicePixelRatio; zoom reset restores it - integration
- [BR-26] The phone width preset sizes the view to 390 DIP times window zoom; Full restores the original width - integration
- [BR-26] Clear storage empties the browser partition's cookie jar - integration
- [BR-26] Stopping find-in-page clears the find state (match counts are recorded, never asserted) - integration
- [BR-27] A tab opened beside a project lands on its last URL; one beside no project opens empty - integration (partly covered: store.test.ts)
- [BR-20] SECURITY The address bar never searches: a phrase paints a sentence and sends no request - integration (resolver covered: browser.test.ts)

### Browser pane - native view layout and visibility

- [BR-7] The view's bounds equal the placeholder rectangle in DIPs and track window resize and split moves live - e2e
- [BR-8] The view never enters the top 36px; main clamps a renderer-reported y=0 rather than obeying it - integration
- [BR-9] Switching to another tab stops the view painting while the page keeps running and keeps its history - e2e
- [BR-3] A hidden view (setVisible(false)) still captures a fresh frame, evaluates script and takes a synthesized click, and stays hidden - e2e
- [BR-6] A modal overlay hides the view (document.visibilityState hidden) and dismissing it shows the page again - e2e
- [BR-6] overlayOpen() is false before a dialog, true while one is up, false after; useBrowsers subscribes once - integration
- [BR-4] The view stands down while the address bar dropdown is open and paints again after Escape - e2e
- [BR-10] A tab drag takes the view off screen for its duration and restores it after - e2e
- [BR-10] A toast does not hide the view and is laid out clear of the view's rectangle - e2e
- [BR-5] The driver's pixel sampler can tell a shown view from a hidden one - drop

### Browser pane - console panel

- [BR-11] The console panel shows a page's log lines, the error chip starts at 0 and counts errors, and the level filter hides logs - integration
- [BR-12] The console input line evaluates in the browser page and prints the page's own value - e2e
- [BR-12] An HTML artifact's console chip toggles the panel open and shows log lines captured from the artifact iframe - e2e
- [BR-12] The artifact console is read-only: same panel, no input line, while the browser console has one - integration

### Browser pane - security posture

- [BR-13] SECURITY With browserReach=local a non-loopback URL is refused with a sentence naming the host, nothing is fetched, loopback still loads - integration
- [BR-13] SECURITY browserReachAllows intersects every restriction it is given (web plus local refuses a remote URL) - unit (covered: browser.test.ts)
- [BR-14] SECURITY Browser tabs use persist:helm-browser; a page's cookie is in that partition and absent from the window's own session - e2e
- [BR-14] SECURITY A browser page sees no process, no require and no window.helm (no preload, no node, sandbox on) - e2e
- [BR-15] SECURITY A file: URL is refused with a sentence and the tab stays on the URL it was on - integration (rule covered: browser.test.ts)
- [BR-15] SECURITY window.open without features (target=_blank) becomes a new Helm tab, not a window - e2e
- [BR-15] SECURITY Opening a tab past BROWSER_TABS_MAX (10) is refused with a problem sentence - integration
- [BR-16] SECURITY The navigation exemption registry holds exactly the live browser views' webContents ids, never the window's - integration
- [BR-23] SECURITY The app window cannot navigate itself away (its document is never replaced) and is not in the exemption registry - e2e
- [BR-17] SECURITY A self-signed certificate is accepted on 127.0.0.1 and refused on 127.0.0.2, with no click-through anywhere - e2e
- [BR-18] SECURITY A download is refused at will-download: nothing written, "does not download" sentence, console line, page stays put - integration
- [BR-19] SECURITY Every permission request on the browser partition is denied without a prompt (geolocation probed) - integration

### Browser pane - popups and self-closing pages

- [BR-38] A page calling window.close() retires its tab and the strip drops it; states, bounds and navigate on any id never throw afterwards - integration
- [BR-39] SECURITY window.open with features from a user tab opens a real popup window (not a tab) with a live handle and a working window.opener - e2e
- [BR-39] A popup that closes itself is visible to its opener, the window count returns to before, and the pane logs "popup window" - e2e
- [BR-40] SECURITY A popup to an out-of-reach URL returns null, creates no window, and the opener tab shows a "This machine only" sentence - e2e
- [BR-40] SECURITY window.open from an agent-opened tab makes another agent tab, never a window - integration
- [BR-40] SECURITY window.open from the app's own renderer returns null and creates no window - e2e
- [BR-40] BROWSER_POPUPS_MAX is positive (the per-tab popup cap itself is never exercised) - drop

### Browser pane - persistence

- [BR-21] A cookie a page sets is stored in persist:helm-browser - e2e
- [BR-22] That cookie survives an app restart and is sent to the page again (document.cookie) - e2e

### Browser agent endpoint (helm-browser MCP)

- [BR-28] SECURITY The MCP listener binds 127.0.0.1 on an ephemeral port - integration
- [BR-28] SECURITY No token or a token one character off is 401 before parsing; a wrong path is 404; GET is 405 - integration
- [BR-28] tools/list with a valid token serves exactly the ten browser_* tools - integration
- [BR-29] SECURITY All tool ticks off: start() binds nothing, register() mints no token, argv has no --mcp-config - integration (partly covered: plan.test.ts)
- [BR-30] browser_open opens a real tab attributed to the calling session and answers with its tab id, URL and title - integration
- [BR-30] browser_tabs marks that tab "yours", and the tab strip paints the opening session's name as a badge - integration
- [BR-31] browser_snapshot names page elements with refs, and browser_click by ref fires exactly one real click - e2e
- [BR-31] browser_type fills a field (clear: true), and browser_press Backspace removes exactly one character - e2e
- [BR-31] browser_evaluate returns the page's value; browser_console returns logs and a cursor, and a repeat with it says "(nothing new)" - e2e
- [BR-32] browser_screenshot returns a PNG of the page (not the window) at exact pixels, and a fresh one after the page repaints - e2e
- [BR-33] Every tool works on an agent tab never shown (parked at AGENT_VIEW_SIZE), and that tab never appears in the window - e2e
- [BR-34] SECURITY A tool reaches off-machine only with reach=web and LocalOnly off; else a sentence, nothing fetched - integration (rule covered: browser.test.ts)
- [BR-34] SECURITY browserMcpLocalOnly confines only the tools: the pane can still reach the same address by hand - integration
- [BR-35] SECURITY A tool cannot close another session's tab or the user's; the refusal names the owner and the tab stays - integration
- [BR-35] SECURITY A tool cannot snapshot (read) a tab the user opened - integration
- [BR-35] SECURITY A session can close its own tab; when it ends its tabs stay open under its name and its token gets 401 - integration
- [BR-36] A real claude launched by Helm uses the endpoint to open, snapshot and click a page and report the new title - tool
- [BR-37] SECURITY A session's --mcp-config file is under Helm's data dir, with a 127.0.0.1 URL and Bearer header - integration (partly covered: plan.test.ts)
- [BR-37] SECURITY Composing a launch never writes ~/.claude.json or the project's .mcp.json; no Helm server name appears in ~/.claude.json - integration
- [BR-37] The per-session --mcp-config file is removed when the session ends - integration
- [run-browser] Two-phase runner and the audit that every BR id reported - drop

### Harness templates - create and seed

- [TPL-1] The driver proves its byte comparator discriminating by flipping a fixture byte - drop
- [TPL-2] The New Harness picker row shows a template's label and description from template.yaml - integration (reader covered: templates.test.ts)
- [TPL-3] Create from template: dot-claude becomes .claude, .gitkeep dirs arrive empty, .tpl renamed, no template.yaml - unit (covered: templates.test.ts)
- [TPL-3] The New Harness dialog's "What gets written" list matches what is written, manifest first - integration (preview covered: templates.test.ts)
- [TPL-4] Substitution runs only in .tpl; other files with literal {{...}} stay byte-identical; unknown placeholders survive - unit (covered: templates.test.ts)
- [TPL-4] {{CREATED_AT}} in a rendered .tpl equals the manifest's created: value - unit (unsure if covered)
- [TPL-5] template: provenance is written to harness.yaml and carried through the projects cache - unit (covered: templates.test.ts, store.test.ts)
- [TPL-5] The harness's sidebar row meta and its project pane show the template name, including from discovery:cached on a cold start - integration
- [TPL-6] minimal writes exactly .claude, harness.yaml, repos; manifest keys name, template, version, created - unit (covered: harness.test.ts)
- [TPL-7] Seeding an absent templates dir writes README.md and the shipped example - unit (covered: templates.test.ts)
- [TPL-7] App startup (createServices) seeds the templates directory - integration (unsure if covered)
- [TPL-8] A later start overwrites no seeded file, edited or not - unit (covered: templates.test.ts)
- [TPL-9] Deleting the templates dir brings the original files back on the next start - unit (covered: templates.test.ts)
- [TPL-10] harness:create refuses a template name that is a path, with prose sentences, and writes nothing - unit (covered: templates.test.ts)
- [TPL-11] A junction inside a template is refused with a sentence, the rest is written, its target untouched - unit (covered: templates.test.ts)
- [run-template] Five-start orchestration (seed, edit, reseed) and the audit that every TPL id reported - drop

### Harness templates - authoring manager

- [TPL-12] The template manager opens from the New Harness dialog and from Settings - e2e
- [TPL-12] New scaffolds only template.yaml; Save writes label/description; rename keeps metadata - integration (engine covered: template-authoring.test.ts)
- [TPL-12] The manager lists exactly the template folders on disk; Delete with confirm removes one - integration (engine covered: template-authoring.test.ts)
- [TPL-13] The import picker offers config-console scopes, including the user ~/.claude scope - integration
- [TPL-13] Importing a skill copies its whole folder byte-identical, unsubstituted, and it survives into a harness - unit (covered: template-authoring.test.ts)
- [TPL-13] A scan started after roots:accept is not overwritten by an older startup scan finishing later (driver retries round it) - integration (unsure if covered)
- [TPL-14] Save as template defaults: harness.yaml, repos, .git unticked; .claude, CLAUDE.md, notes, tools ticked - unit (covered: template-authoring.test.ts)
- [TPL-14] Save as template states the size first, the total moves on untick, only ticked entries land - integration (engine covered: template-authoring.test.ts)
- [TPL-15] Save as template never follows a junction, and the junction's target is untouched - unit (covered: template-authoring.test.ts)
- [TPL-16] Deleting a template unlinks a junction it carries (listed in the manager first); the target survives - unit (covered: template-authoring.test.ts)
- [TPL-17] Folder import keeps dot-claude verbatim; the picker offers it; its harness gets .claude, .tpl filled - unit (covered: template-authoring.test.ts)
- [TPL-17] Import folder as template runs through the native directory picker and the folder-save dialog - e2e
- [TPL-18] The manager's file list badges .tpl files only, and its help line names {{NAME}}, {{CREATED_AT}}, {{TEMPLATE}} and {{PATH}} - integration
- [TPL-18] "Make substitutable" is offered on a plain file and renames it to .tpl on disk - integration (engine covered: template-authoring.test.ts)

### Design walk (design-shot asserts nothing; these are the expectations it prints)

- [DS:views] Screenshot walk of every main view in all three built-in themes plus shape-setting extremes, for design review - tool
- [DS:views] Writing theme, themeDark and density settings reaches <html> (dark class, data-theme, data-density) - integration (unsure if covered)
- [DS:views] A pinned path whose folder is gone renders as a "folder gone" row with no launch - integration
- [DS:views] History opens an archived transcript, and an unavailable panel for a session reaped before Helm saw it - integration
- [DS:views] Planted pull requests split into ACTIVE and STALE sections, Group: Repo draws headings, and review threads paint - integration
- [DS:views] The content source block is bounded by its pane (it scrolls inside; the pane does not) - e2e
- [DS:views] The wrap toggle folds long source lines with no horizontal overflow and indented continuations - e2e
- [DS:views] The project shell height setting clamps to its pixel floor at 10% and holds 30% and 50% - e2e
- [DS:states] Collapsing a config section hides its file rows and expanding restores them - integration
- [DS:states] The machine's pointer media queries are printed - drop
- [DS:responsive] Config and content scope headers neither overflow nor spill at window widths 900-1280 or at docked split widths - e2e
- [DS:tabs] A session tab can be renamed by double-click, and a pane's maximize button toggles it to full width and back - e2e
- [DS:tabs] Session dots show distinct tones for busy, waiting, shell and idle in both themes - tool
- [DS:split] Closing a tab whose session is live asks to confirm; Cancel keeps the session and Accept ends it - e2e

### Affordance (cursor and hover)

- [AFF-1] The driver's planted dead and live controls prove the probe discriminates - drop
- [AFF-0] Placeholder failure emitted when AFF-1 fails - drop
- [AFF-2] Every main view and modal (config sub-views, content tree, browser, profiles, template manager, scan-root project) opens from the chrome - e2e
- [AFF-3] Every enabled clickable control (button, tab, option, link, select, summary, checkbox, radio) computes cursor: pointer - e2e
- [AFF-4] Every enabled clickable control changes its own computed style under the pointer; only an active tab may answer via its close button - e2e
- [AFF-4] Hover states work on a machine with no fine pointer (theme.css overrides Tailwind's (hover: hover) gate) - e2e
- [AFF-7] The selected sidebar row changes its own fill under the pointer (ROW_SELECTED_GROUP) - e2e
- [AFF-5] Text inputs and textareas show the text cursor; disabled buttons and selects never show pointer - e2e
- [AFF-6] Each [role=separator] shows the resize cursor its aria-orientation calls for and responds to hover, and at least one exists - e2e

