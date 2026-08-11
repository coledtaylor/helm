# Helm - Agent Instructions

Desktop shell on top of Claude Code. Read [docs/SPEC.md](docs/SPEC.md) before
doing anything - it contains the measured evidence and design decisions. Do not
re-litigate decisions recorded there without new evidence.

**All UI work follows [docs/DESIGN.md](docs/DESIGN.md)** - the "Nocturne
Islands" design system. Read it before touching anything a user sees. The
short version: semantic tokens only (no raw hex in components), islands with
hairline edges on a sunken canvas, the accent never solid-fills anything, no
shadows outside modals, no text weight past 500, mono for machine data. If a
change cannot be expressed in the system's tokens and rules, amend DESIGN.md
deliberately or reconsider the change.

Look at the app, not at the class names. `pnpm design-shot` opens the real
window, walks every main view in both themes and writes PNGs to
`%APPDATA%\Helm\screenshots\design`. A UI change is not done until you have
looked at one, and measuring a suspect edge in the PNG beats eyeballing it.

## Work tracking

Work is tracked in ClickUp: list **"Helm - Claude Code Shell"** (id `901114291892`)
[docs/TASKS.md](docs/TASKS.md) maps task IDs to scope.

- Pick tasks in priority order. The three spikes and M1-M6 are closed with
  recorded verdicts; M7 is built with one criterion that needs a second machine,
  and the transcript archive is deferred to v1.1. TASKS.md has the verdicts -
  read it there rather than assuming from this list.
- Each task has checkbox acceptance criteria. A task is done when every box is
  checked, not before. Update the ClickUp task with findings and check the boxes
  as you go.

## Layout

```
packages/
├── core/     # headless: discovery/, store/ (+ launch/, config/ to come)
├── ui/       # React components
└── desktop/  # Electron main + preload + renderer + the spike harness
```

pnpm workspaces, `node-linker=hoisted` (see `.npmrc` for why). `core` and `ui`
export TypeScript source rather than a build output, so the bundler compiles
them in and there is one build step, not three. `pnpm check` is what CI runs.

## Hard rules

- `packages/core/` must never import Electron. Enforced by the
  `no-electron-in-core` block in `eslint.config.js`, which blocks static
  imports, `require()`, and dynamic `import()`. If core needs something from the
  host, the host passes it in as an argument.
- The renderer and `packages/ui/` may import **types** from `@helm/core`
  anywhere - they are erased - but a **value** import must come from
  `@helm/core/types`, which has no `node:` imports behind it. The package root
  reaches the filesystem through `launch/` and `store/`, and pulling that into
  the browser bundle fails at rollup, not at typecheck, so `pnpm typecheck`
  will not catch it. `EFFORT_LEVELS` and `PERMISSION_MODES` are the ones this
  comes up for.
- Overlay shims live under the app data directory, never `%TEMP%`. Their
  subdirectories are junctions into the user's real repositories, and a temp
  cleaner that follows a reparse point rather than unlinking it deletes the
  repo's `.claude/skills`. For the same reason, anything that removes a shim
  must use a delete that unlinks junctions (`fs.rm`) and must never walk into
  one.
- Overlay shims are swept **only** at app start (`createServices`). Sweeping
  per launch would pull a plugin directory out from under a live session that a
  different profile started.
- The terminal configuration in `packages/desktop/src/renderer/src/terminal.ts`
  and `ptyEnv` in `packages/desktop/src/main/pty.ts` is load-bearing for TUI
  fidelity, and every line of it is there because Spike C measured the failure
  it prevents. Do not "simplify" it without reading
  [docs/SPIKE-C.md](docs/SPIKE-C.md). Its two checks render `spike.html`, a
  separate page from the app, so app layout changes cannot move the terminal
  under them.
  - Five of those values are now **settings** (M9): font family, font size,
    cursor style, cursor blink, scrollback. `TERMINAL_DEFAULTS` in the same
    file is what they default to, and it is exactly what was baked in before,
    so the documented baseline is unchanged - a setting nobody has touched
    produces the configuration Spike C proved. They reach a terminal by being
    **passed in**: `createTerminal(container, opts, hooks, prefs)`. The app
    hands down its effective preferences from `settings:changed` through
    `app/termprefs.ts`, and `spike.ts` calls the same function with three
    arguments and gets the defaults - which is why `pnpm fidelity` and
    `pnpm claude-check` still measure the proven configuration and why a
    setting must never be routed through the `term:*` channels to reach them.
  - Everything else in that file stays fixed and is not a setting:
    `minimumContrastRatio: 1`, `drawBoldTextInBrightColors: false`,
    `allowProposedApi` / Unicode 11, `lineHeight`, and the whole 24-bit
    `THEME`. The palette in particular is asserted pixel-for-pixel by fidelity
    C1; making colours settable is a deliberate DESIGN.md amendment, not a row
    in the settings pane.
  - `estimateGrid` (`app/terminals.ts`) reads the same preferences and must
    keep measuring the way xterm does: a **DOM span**, not a canvas - the two
    resolve a font stack by different rules and disagreed by 6% on this machine
    - then the WebGL renderer's device-pixel flooring across and rounding-up
    down, then FitAddon's flat 14px overview-ruler reserve. Each of those three
    is worth a column or more; without them the pty opens at a grid the pane
    does not have.
- The checks below are the same idea for the app itself: they drive the **real
  window** and most of them spawn real `claude` sessions. They are the only
  coverage `packages/ui` and `packages/desktop` have - all 270 unit tests live
  in `packages/core` - so a change to a surface named here is not done until its
  check is green. They sit outside `pnpm check` deliberately: that stays fast
  and hermetic, these take minutes and cost tokens. The `mN` names are the
  ClickUp milestones whose acceptance criteria they encode, which is what
  TASKS.md maps. What each one actually does - its phases, why it is shaped the
  way it is, and its `--only` groups - is in the **`checks` skill**; the
  authority for the groups is the driver's own `GROUPS`, never prose.

  | check | covers | run after touching |
  |---|---|---|
  | `pnpm m2-check` | sessions, tabs, teardown | session lifecycle, the tab strip, shutdown |
  | `pnpm m3-check` | profiles, overlay shims, argv | `core/launch/`, the profile UI, the argv builder |
  | `pnpm m4-check` | session index, resume | history parsing, the history pane, resume |
  | `pnpm m5-check` | config console, effective view, MCP | `core/config/`, anything that writes into a `.claude` tree |
  | `pnpm m6-check` | markdown, artifacts, wikilinks, editor | `core/content/`, the content viewer |
  | `pnpm m7-check` | first run, packaging, personal-path audit | setup, portable mode, the installer |
  | `pnpm usage-check` | the status bar's usage figures | `core/usage/`, the status bar |
  | `pnpm settings-check` | the settings pane, every app setting, and the terminal/shell preferences | `core/store/settings.ts`, `SettingsPane`, `terminal.ts`, `estimateGrid`, `main/pterm.ts`, anything that writes a setting |
  | `pnpm pr-check` | the pull-request surface: fetch, cache, detail tab, the file diffs, review launch, degradation | `core/github/`, `main/pulls.ts`, `main/gh-cli.ts`, `PullsPane`, `PullRequestPane`, `SessionHost.review` |
  | `pnpm fidelity`, `pnpm claude-check` | TUI fidelity inside xterm | `terminal.ts`, `ptyEnv` |

  `terminal.ts` is under two of them and they answer different questions:
  fidelity says the baked configuration still renders a TUI correctly,
  `settings-check --only=terminal` says a preference reaches every live
  terminal without disturbing that. A change there is not done until both are
  green and fidelity's numbers have not moved.

- `dist:win` goes through `scripts/dist-win.mjs`, not straight to
  electron-builder. electron-builder resolves the package manager with `which`,
  which prefers `pnpm.EXE` over `pnpm.CMD` on Windows, and a stale standalone
  pnpm shadowing the managed one makes it fall back to the npm collector - which
  does not fail, it warns and ships an exe with **no `app.asar.unpacked`**, so
  the app dies on its first `dlopen`. The wrapper checks the resolved pnpm
  answers the declared version; `m7-check --only=package` asserts the prebuilds
  are there regardless.
- Never handle or store Claude credentials, and detect a sign-in only from the
  *existence* of one - `.credentials.json`, `ANTHROPIC_API_KEY`, or an
  onboarding record in `.claude.json`. Nothing opens any of them. The whole
  remedy for "not signed in" is a sentence telling the user to run `claude`.
- The same rule for GitHub, and it is the reason the pull-request surface shells
  out to `gh` rather than calling the API. Helm never receives, stores or reads
  a GitHub token: `gh` owns it, every fetch runs on it, and a sign-in is
  detected **only from the exit code of `gh auth status`** - nothing opens
  `hosts.yml`, the keyring, or `GH_TOKEN`. The whole remedy for "not signed in"
  is a sentence telling the user to run `gh auth login`. A remote URL carrying
  an embedded token is a credential too, so `parseGitHubRemote` strips the
  userinfo before anything is written to the database.
  - This changed Helm's documented network posture and the change was made in
    the open rather than quietly: the update check is now the only **direct**
    request Helm makes, and `gh` makes others on the user's own token on a
    schedule the user sets. README, [docs/PACKAGING.md](docs/PACKAGING.md), the
    `update:check` comment in `shared/ipc.ts` and SPEC 5 all say the same
    sentence; if that posture moves again, all four move together.
  - The Files view paints the patch, which SPEC records as a **superseded**
    decision rather than a quiet reversal: "no diff viewer" is struck through
    and the note under it says what is still not done (syntax highlighting,
    whitespace modes, side-by-side, review threads). Three rules hold it
    together and are not negotiable without amending that note - GitHub's file
    list is the spine and the patch is matched onto it by path, the cache holds
    the **text** `gh pr diff` printed rather than the parse, and every ceiling
    it hits (`MAX_DIFF_BYTES`, `MAX_FILE_LINES`, a file with no patch) is
    counted and said on screen. A diff that quietly stopped halfway would read
    as complete.
  - A review launch composes its prompt in **main** and the window never sends
    one: `pr:review` carries `{repoPath, number, cols, rows}`, the same shape
    `profile:launch` takes and for the same reason. The detail pane renders the
    template too, but only to say what the button will run - when the preview
    and the argv disagree, the argv is right and the preview is the bug.
    `prCheckout: 'checkout'` is refused on a dirty tree rather than stashing;
    Helm does not move somebody's uncommitted work. `prReviewModel` and
    `prReviewEffort` are composed in the same place and are **null by default**,
    which passes no flag - a setting that defaulted to a model name would make
    Helm's launches differ from the CLI's own for no reason the user asked for.
    The model is deliberately not validated against a list of names: the CLI's
    aliases and ids move faster than this app releases, so the validator checks
    only that the value can be one argv word.
- Usage figures degrade to **nothing** rather than to a stale number. The
  server's own answer in `cachedUsageUtilization` is authoritative but dated, so
  a reading older than `USAGE_STALE_AFTER_MS`, one whose `resets_at` has already
  passed, a missing key, or a reshaped object all paint no number and put the
  reason in the tooltip. Measured on 2.1.225: the 5-hour window rolled over
  between two reads and the cached figure went 51% to 21%. The binding limit of
  a group is the one with the **highest percent**, not the one flagged
  `is_active` - that was observed set on the lower of the two.
- Dollar figures are **estimates and say so**, because `spend.enabled` is false
  on a subscription plan and every `*_dollars` the server sends is null. The
  price table's date lives in `PRICE_TABLE_DATE` and the UI reads it from there,
  so a stale table is visible rather than merely authoritative-looking. A model
  with no rate on file is counted, left unpriced, and named.
- **A check that can pass with no evidence behind it is worse than no check.**
  M3-4 asked a session to quote two skills' headings and compared against the
  files on disk - and when those files went missing, `firstHeading` returned
  `''`, the expected token became `SKILL1=`, and every answer matched. It
  reported green for weeks. Any probe that reads an expected value out of a
  fixture must assert the fixture is there and is discriminating.
- `~/.claude` is Claude Code's, and Helm only ever reads it - with one
  exception, which is the whole of M5: the config console **writes** to it.
  That is why the snapshot is not optional. Every byte Helm puts into a
  `.claude` tree goes through `config:write` -> `writeConfigFile`, which takes
  the previous content into `config_snapshots` *before* touching the file and
  aborts the write if the row cannot be taken. Two facts about the directory
  are load-bearing and were measured on 2.1.225, not assumed:
  - `--resume <id>` resolves the id **against the working directory**. From
    anywhere else it prints "No conversation found with session ID" and exits 1.
    So a resume must set cwd to the directory `history.jsonl` recorded, and a
    project that has been deleted makes a session unresumable even though its
    transcript is still there.
  - A transcript is found by **scanning `projects/*` for `<uuid>.jsonl`**, never
    by deriving a path from the recorded project. The directory name carries
    whatever casing the CLI was started with, `history.jsonl` records its own,
    and the two disagree on this machine - a derived path reports live
    conversations as reaped.
  Resuming passes no `-n`: the session already has a name, and renaming it
  would be a side effect of Helm having opened it. The tab's label is Helm's own.
- Settings layers merge **per leaf**, not per top-level key: a project
  `settings.json` setting `env.A` and a `settings.local.json` setting `env.B`
  produce a session with both, and where they name the same leaf the local one
  wins. Measured on 2.1.225 by reading `env` back out of a live session, which
  is why `EffectiveSetting` is keyed by `env.A` rather than by `env`.
  Precedence is local > project > user; enterprise policy and CLI flags sit
  above all three and are not files this console edits.
- `CLAUDE_CONFIG_DIR` genuinely moves the config directory - credentials
  included - so a session pointed at a fixture home cannot log in. Anything
  that has to measure the *user* settings layer has to use the real
  `~/.claude/settings.json`, snapshot it, and put it back.
- Every renderer↔main channel is declared in
  `packages/desktop/src/shared/ipc.ts` and nowhere else. The preload exposes
  three generic functions; a feature adds a channel to the contract, not a
  method to the bridge. Two terminal families exist and do not mix: `term:*` is
  the spike page's single pty, `session:*` is the app's many. Changing `term:*`
  changes what `pnpm fidelity` and `pnpm claude-check` measure.
- A session's terminal lives in
  `packages/desktop/src/renderer/src/app/terminals.ts`, outside React, and is
  disposed when its tab closes rather than when a component unmounts. Scrollback
  cannot be rebuilt from props, so it must not depend on a render. Panes are
  hidden, never unmounted - and a hidden pane measures 0x0, which `FitAddon`
  turns into a 1x1 grid the pty acts on. That guard is in `terminal.ts`.
- The main process owns process lifetime: rows are written on spawn (so a
  session that dies immediately still happened), `before-quit` ends sessions,
  `will-quit` releases the database. Nothing else may close the store - the
  window's own `close` handler still writes to it after `before-quit` has run.
- Schema changes: edit `packages/core/src/store/schema.ts`, then
  `pnpm db:generate`. The generated SQL is embedded into the bundle, so a
  packaged exe carries its migrations rather than needing files beside it.
- **Adding an app setting** is four edits and no migration, because
  `app_settings` is JSON-per-key:
  1. the key and its default in `AppSettings` / `DEFAULT_SETTINGS`
     (`core/src/types.ts`) - that is the whole of the persistence step;
  2. a validator in `SETTING_VALIDATORS` (`core/src/store/settings.ts`). The map
     is `Record<keyof AppSettings, ...>`, so a key with no validator does not
     compile, and a value that fails one writes nothing and throws. Add its
     valid *and* invalid cases to the table in `store.test.ts`;
  3. a row in the matching group of `ui/src/components/SettingsPane.tsx`, with a
     `data-settings-*` hook so the driver can drive it;
  4. only if the value drives something outside the database, a branch in the
     `settings:write` ladder in `main/ipc.ts` - that ladder is the entire
     side-effect dispatch (theme retints the overlay, `claudePath` reaches the
     session host).

  Then extend `pnpm settings-check`: a setting with no assertion in it is a
  setting nothing proves round-trips. Reads stay tolerant (unknown keys ignored,
  bad JSON falls back per key) and writes stay strict - a row from another build
  is a fact about the past, a malformed write is a bug happening now. Internal
  state (`windowBounds`, `firstRunCompletedAt`) lives in the same table and is
  deliberately *not* in the pane: those are things Helm remembers, not things
  anyone chose. Settings for Helm go here; anything that edits a `.claude` tree
  is the config console's, and the two are not the same surface.
- Do not use `@anthropic-ai/claude-agent-sdk`. Helm shells out to the `claude`
  CLI. This is a deliberate architectural decision (see SPEC "Supersedes the SDK
  draft") - the app hosts the TUI, it does not reimplement the client.
- Helm renders no session messages, parses no session output, handles no
  permission prompts. If a feature seems to need that, it belongs in the
  transcript-archive backlog or it is out of scope.
- Windows-first: junctions (`mklink /J`) not symlinks; no elevation assumptions;
  test paths with spaces.

## Environment notes

Whatever is true of **one machine** - where its `claude` binary sits, what
directory this checkout lives in, which repositories happen to be beside it -
belongs in `CLAUDE.local.md`, which is gitignored and is not part of this
repository. This file describes the project, and a contributor should be able
to follow every rule in it without owning the machine it was written on.

Nothing in `packages/` may assume any of that either, and two checks say so
rather than trusting it:

- `pnpm m7-check --only=audit` fails if a personal path or name reaches what
  ships, and
- its publication audit fails if one reaches **anywhere in the repository** -
  docs, this file, the scripts and the check drivers included. That one reads
  the names it looks for from `.audit-private.local`, an uncommitted file, so
  the audit never publishes the list it polices. `.audit-private.local.example`
  says how to write one.

Both derive what to look for at runtime. Do not answer a failure by adding an
exemption: the hit is the finding.
