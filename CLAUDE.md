# Helm - Agent Instructions

Desktop shell on top of Claude Code. Read [docs/SPEC.md](docs/SPEC.md) before
doing anything - it holds the measured evidence behind every design decision.
Do not re-litigate what is recorded there without new evidence.

**All UI work follows [docs/DESIGN.md](docs/DESIGN.md)** - the "Nocturne
Islands" design system. Semantic tokens only (no raw hex in components), islands
with hairline edges on a sunken canvas, the accent never solid-fills anything,
no shadows outside modals, no text weight past 500, mono for machine data. A
change that cannot be expressed in the system's tokens is a deliberate
DESIGN.md amendment or a change to reconsider.

Look at the app, not at the class names. `pnpm design-shot` walks every main
view in both themes and writes PNGs to
`%LOCALAPPDATA%\Helm\checks\design-shot\helm-data\screenshots\design` - its own
data directory, like every check, and never the `%APPDATA%\Helm` somebody is
using while it runs. A UI change is not done until you have looked at one, and
measuring a suspect edge in the PNG beats eyeballing it. `--only=` narrows the
walk; the **`checks`** skill has the groups.

For the question design-shot's fixed itinerary does not reach - what happens
two clicks in - `pnpm dev --drive` and `scripts/drive-dev.mjs` click through
the window you have open, and take the same capture. The **`dev`** skill has it.

## Where the rest of this lives

This file is the part that has to be in mind while doing *anything*. Everything
else is a skill, loaded when the work calls for it, and the argument behind any
rule is in a comment at the code site it governs - that is the copy that stays
true when the code moves.

| skill | read it before |
|---|---|
| **`dev`** | launching the app to look at a change, or driving the window you have open |
| **`checks`** | running or writing a real-window check, or deciding which one a change owes |
| **`surfaces`** | editing the terminal, the usage figures, the pull-request pane, or anything touching a `.claude` tree |
| **`procedures`** | adding an app setting, changing the schema, or building a release |

## Work tracking

ClickUp list **"Helm - Claude Code Shell"** (`901114291892`). Nothing in this
repository refers to a task by id. Each task has checkbox acceptance criteria
and is done when every box is checked, not before. When a task's claim and a
check disagree, the check is right.

## Layout

```
packages/
├── core/     # headless: discovery/, launch/, config/, content/, github/, usage/, archive/, store/
├── ui/       # React components
└── desktop/  # Electron main + preload + renderer + the spike harness
```

pnpm workspaces, `node-linker=hoisted` (see `.npmrc` for why). `core` and `ui`
export TypeScript source rather than a build output, so the bundler compiles
them in and there is one build step, not three. `pnpm check` is what CI runs.

## Boundaries

- **`packages/core/` never imports Electron.** Enforced by `no-electron-in-core`
  in `eslint.config.js` - static imports, `require()` and dynamic `import()`
  alike. If core needs something from the host, the host passes it in.
- **A value import into the browser bundle comes from `@helm/core/types`**,
  never the package root, which reaches the filesystem through `launch/` and
  `store/`. That fails at rollup, not at typecheck, so `pnpm typecheck` will not
  catch it. Types are erased and may come from anywhere. `EFFORT_LEVELS` and
  `PERMISSION_MODES` are the ones this comes up for.
- **Every renderer↔main channel is declared in `shared/ipc.ts` and nowhere
  else.** The preload exposes three generic functions; a feature adds a channel
  to the contract, not a method to the bridge. Two terminal families exist and
  never mix: `term:*` is the spike page's single pty, `session:*` is the app's
  many. Changing `term:*` changes what `pnpm fidelity` measures.
- **The main process owns process lifetime.** Rows are written on spawn, so a
  session that dies immediately still happened; `before-quit` ends sessions and
  `will-quit` releases the database. Nothing else may close the store - the
  window's own `close` handler still writes after `before-quit` has run.

## Credentials

- **Never handle or store one, Claude's or GitHub's.** A sign-in is detected
  only from the *existence* of an artefact - `.credentials.json`,
  `ANTHROPIC_API_KEY`, an onboarding record in `.claude.json` - or from what
  `gh` prints on its own streams. Nothing opens any of them, nor `hosts.yml`,
  the keyring or `GH_TOKEN`. The whole remedy for "not signed in" is a sentence
  naming `claude` or `gh auth login`.
- This is why the pull-request surface shells out to `gh` rather than calling
  the API. A remote URL carrying an embedded token is a credential too, so
  `parseGitHubRemote` strips the userinfo before anything reaches the database.
- The network posture is stated identically in four places - README,
  [docs/PACKAGING.md](docs/PACKAGING.md), the `update:check` comment in
  `shared/ipc.ts`, and SPEC 5. If it moves again, all four move together. It
  currently reads: *"Helm contacts nothing on its own initiative except the
  update check. Everything else on the network happens because you asked for
  it: the pull-request surface goes through your own `gh`, and the browser pane
  fetches the page you navigate to."*

  That sentence is about what Helm **contacts**, and M17 did not change it. What
  M17 did change is that Helm now **listens**, on loopback, for the sessions it
  hosts - see "The browser tools" below. That is stated separately, in the same
  four places, rather than folded into a sentence about outbound traffic.
- **The browser partition is not an exception to the credential rule, and it is
  the one place that has to say so out loud.** `persist:helm-browser` holds
  cookies and logins for whatever the user visits, under the app's data
  directory. Nothing in Helm reads it - no cookie, no storage, no header - and
  the only call the app ever makes against it is `clearStorageData`, from a
  button in the pane. A feature that wanted to read that partition would be a
  feature that made Helm handle credentials.

## The browser pane

Five rules, and each one is a thing that only shows up when it is broken.

- **The renderer's navigation lock is never loosened.** `will-navigate` and
  `setWindowOpenHandler` are denied on **every** web-contents in
  `main/index.ts`; browser views are exempted by a registry of `webContents.id`
  read *inside* those guards. Window-open still answers `deny` for everything -
  what the exemption adds is that a `window.open` inside a view becomes a new
  Helm tab, capped. A change that widens the guard instead of the registry is
  the change this rule exists to stop.
- **Every navigation goes through `browserReachAllows`, in `@helm/core`.** One
  function, taking as many restrictions as the caller has, allowing a URL only
  where all of them do - and the agent's restrictions are composed by
  `agentReach`, in the same file, so the pane's rule and the tools' rule cannot
  drift. It is also where the scheme rule lives: `file:` and custom schemes are
  refused by the same call.
- **A native view paints above all renderer DOM, so it hides for anything drawn
  over it.** The one subscribable answer is `overlayOpen()` in
  `packages/ui/src/lib/overlay.ts`, subscribed **once**, in `useBrowsers`. Two
  transient things get the same treatment for the same reason - a tab drag and
  the address bar's dropdown - and a **toast does not**, because it is not modal
  and is not transient; it is required to be drawn clear of the view instead
  (BR-10). The view must also never enter the top 36px, where Windows draws the
  window controls; main clamps that rather than trusting the layout.
- **Hiding is `setVisible(false)` because that leaves the page live.** M17 will
  drive tabs nobody is looking at, so hidden has to stay capturable, scriptable
  and clickable. Measured on Electron 43.3.0 and pinned by `BR-3`, which
  repaints the page a new colour *after* hiding it so a stale frame cannot pass.
  If that ever stops holding, the mechanism changes - parking the view outside
  the window is the fallback - and `BR-3` is what says so first.
- **Self-signed certificates are accepted for loopback and nowhere else**, and
  there is no click-through: Helm registers no `certificate-error` handler at
  all. Downloads are refused and handed to the system browser, every permission
  on the partition is denied, and the address bar never hands anything to a
  search engine. None of those is a setting; `browserReach` is the only one.

## The browser tools - the app's one inbound listener

A Claude session Helm hosts can drive that pane: open, read, screenshot, click,
type, press keys and evaluate. `main/browser-mcp.ts` serves MCP over HTTP and is
**the only thing in Helm that has ever listened for a connection**. Six rules,
and they are here rather than only at the code site because they are the ones a
future change would weaken without meaning to.

- **Loopback and a token, always.** `listen(0, '127.0.0.1')` - never
  `0.0.0.0`, never a chosen port. Every request carries `Authorization: Bearer`
  or it is 401 before anything is parsed, and there is **no unauthenticated
  route at all**, not even a health check: a route that answered without a token
  would tell a local process which port to start guessing at.
- **A token per session, minted at launch and revoked when the session ends.**
  It is also the *identity*: attribution is which token arrived, never something
  the caller says. That is what makes "only a tab this session opened" a
  comparison. `before-quit` stops the endpoint **before** sessions shut down, so
  nothing can still be driving a browser on behalf of a process that is gone.
- **`browserMcp` off is off.** No bind, no token, no `--mcp-config` - the app is
  then the process it was before M17. `BR-29` asserts all three.
- **Registration is `--mcp-config`, written per session under the data
  directory.** Never `claude mcp add-json`, which writes into the user's
  `~/.claude.json` on every launch and leaves the entry there. The file is
  removed with its session, and what a crash leaves is swept by the rule the
  overlay shims are swept by: the owning pid is asked about, and anything not
  provably dead is left alone.
- **The reach rule is an intersection with no special cases.** An agent
  navigation is allowed only where `browserReach` **and** `browserMcpLocalOnly`
  both allow it; the narrower always wins, and an agent can never exceed the
  reach of the pane it is driving. Both restrictions are composed by
  `agentReach` and handed to `browserReachAllows` - the same function the pane's
  `will-navigate` calls. `browser_evaluate` is an escape hatch by design and a
  page it navigates is still held to `browserReach`.
- **A tool drives only the tabs its own session opened.** Not just closing:
  a tab the user opened is a page they chose to be on, in a partition that holds
  their cookies, and a tool that could screenshot or script it would be the
  credential rule defeated through a picture. `browser_tabs` lists everything,
  because listing is not driving.

One more thing is worth knowing before touching `browser.ts`: **a view whose
document has never painted while shown is not scriptable in the ways M17
needs** - zero viewport, empty `capturePage`, clicks that land on nothing - and
an agent's tab is never mounted by the window. `AGENT_PEEK` is the answer and
the comment there has the three approaches that were measured and rejected.

## Overlays

- **Shims live under the app data directory, never `%TEMP%`.** Their
  subdirectories are junctions into real repositories, and a temp cleaner that
  follows a reparse point instead of unlinking it deletes the repo's
  `.claude/skills`. Anything that removes a shim must unlink junctions
  (`fs.rm`) and must never walk into one.
- **Shims are swept only at app start** (`createServices`). Sweeping per launch
  would pull a plugin directory out from under a live session that a different
  profile started.
- **The sweep removes only what it can prove is dead.** A shim's stamp names the
  processes holding it; `cleanStaleShims` asks the kernel about each, counts
  `EPERM` as *alive*, treats a claim from before this boot as dead however the
  pid probes, and **leaves the shim wherever the answer is unknown**. The
  asymmetry is the design: a stale directory is collected at the next start,
  where a live shim deleted is a session that has silently lost its skills.
  "Nothing else is running" is never a thing one process may assume - `PROF-10`
  is two of them, overlapping, and it is what says this still holds.

## Where the data lives

Four modes, and `appMode` in `paths.ts` is the authority. Only one of them
shares a directory with another Helm, and it is opt-in:

| run | data directory |
|---|---|
| installed | `%APPDATA%\Helm` |
| portable | `helm-data` beside the exe |
| `pnpm dev` | `%LOCALAPPDATA%\Helm\dev\helm-data` - its own database, Chromium profile and `overlays/`, seeded each launch from a `VACUUM INTO` copy of the real one. A synthetic `gh` (`--gh=`), so the pull-request pane is offline and every state reachable. `~/.claude` and `claude` are the real ones, because `CLAUDE_CONFIG_DIR` moves credentials and a dev app that cannot sign in cannot host a session. `--fresh` for the first-run state; a second `pnpm dev` gets `dev-2`. |
| `pnpm dev:live` | `%APPDATA%\Helm` - the installed app's. Kept deliberately, says so loudly on the console, and the status bar's mode chip reads `dev · live`. |

A check gets its own directory too, under `%LOCALAPPDATA%\Helm\checks\<name>`;
see the **`checks`** skill.

**Harness templates are the one thing not under the data directory**, and they
take the same branch rather than a mechanism of their own. `templatesDir` in
`paths.ts` reads `PORTABLE_EXECUTABLE_DIR`: set, it is `helm-data/templates`
beside the exe, so a portable install stays on the stick and leaves nothing on a
machine it is plugged into, and `pnpm dev` and every check get their own for
free through `isolate.mjs`. Unset - installed and `dev:live` - it is
**`~/.config/helm/templates`**, not `%APPDATA%`, because these are files a
person writes by hand and probably keeps in git, and that is where somebody
looks for those. The shipped README and example are written **only when the
directory is absent** and nothing there is ever overwritten: Helm keeps no
hashes, so it cannot tell an edited file from an untouched one. The accepted
consequence is that an improved example never reaches an existing install, and
deleting the directory is the whole of "reset".

**`pnpm dev` copies that directory once and then leaves it alone**, which is the
opposite of what it does to the database and is the same rule one level down.
The database is a mirror nobody authors into, so a fresh `VACUUM INTO` every
launch is right; a template is a thing a person *writes*, and the dev app can
write one - so wiping and re-copying at every launch would lose it. Nothing here
keeps hashes either, so nothing can tell a template authored in dev from a stale
copy of a real one, and when the two are indistinguishable the outcome that must
never happen decides. Dev's copy therefore diverges; the launch banner says so
every time, and `pnpm dev --fresh` re-copies.

**Helm has no in-app editor for a template file, on purpose.** A template is a
folder, `shell:showItem` opens it, and the user's own editor is a better one
than a pane in a modal. What the app does is what a file manager cannot:
`.tpl` awareness, importing a skill out of a `.claude` tree Helm can already
see, and freezing a harness into a layout. Anything that walks a template or a
folder being frozen **unlinks a reparse point rather than following it** - the
Overlays rule above, in the second place it is load-bearing, and `fs.rm` with
`recursive: true` is not the mechanism: it was measured returning successfully
with a junction still in place.

## Surfaces that degrade

Each of these has one rule that must survive contact with a refactor. The detail
is in the **`surfaces`** skill.

- **`terminal.ts` and `ptyEnv` are load-bearing for TUI fidelity.** Every line
  is there because a spike measured the failure it prevents. Do not "simplify"
  either without reading SPEC 8.3, and never route a setting through the
  `term:*` channels - that is the change that would alter what `pnpm fidelity`
  measures.
- **Usage figures paint nothing rather than a wrong number.** Age alone is the
  exception, painting lower bounds. Dollar figures are estimates and say so.
- **Pull requests degrade the opposite way**: cached rows stay with their age on
  them. One condition stops a fetch pass - there is no `gh` binary. Every other
  reason is a claim about a server, and a claim about a server may never gate
  the request that would correct it (`PR-20`).
- **`~/.claude` is Claude Code's and Helm only reads it**, with exactly one
  exception: the config console writes, through a snapshot taken *before* the
  file is touched that aborts the write if the row cannot be taken. The
  transcript archive is **not** a second exception - it reads those files and
  copies what it reads into `helm.db`, and `pnpm transcript-check`'s T-5 hashes
  the whole tree either side of a full pass to say so.
- **`CLAUDE_CONFIG_DIR` moves credentials too**, so a session pointed at a
  fixture home cannot log in. Measuring the user settings layer means using the
  real `~/.claude/settings.json`, snapshotted and put back.

## Checks

They drive the **real window** and most spawn real `claude` sessions. They are
the only coverage `packages/ui` and `packages/desktop` have - every unit test
lives in `packages/core` - so **a change to a surface a check covers is not done
until that check is green.** They sit outside `pnpm check` deliberately: that
stays fast and hermetic, these take minutes and cost tokens.

The **`checks`** skill has the table of which one a change owes, what each does,
and how to narrow a re-run. Two rules belong here rather than there:

- **A check that can pass with no evidence behind it is worse than no check.**
  `PROF-4` compared a session's answer against headings read from fixture files;
  when the files went missing the expected value became `''`, every answer
  matched, and it reported green for weeks. Any probe that reads an expected
  value out of a fixture must assert the fixture is there and is discriminating.
- **A check gets its own data directory**, reached through
  `PORTABLE_EXECUTABLE_DIR` - never `%APPDATA%\Helm`, which is the app somebody
  is using while the check runs. A new driver calls `isolate(name)` and threads
  its `env` into every spawn.

## Scope

- **Do not use `@anthropic-ai/claude-agent-sdk`.** Helm shells out to the
  `claude` CLI - see SPEC "Supersedes the SDK draft". The app hosts the TUI, it
  does not reimplement the client.
- **Helm renders nothing for a live session.** It parses no session output,
  handles no permission prompts, and puts nothing of its own between the user
  and the TUI it hosts. A feature that seems to need that is out of scope.

  **Amended when the transcript archive landed**, and the line is worth stating
  rather than deleting. Claude Code writes a transcript per session and reaps it
  on its own schedule - 744 sessions recorded on this machine, 68 transcripts
  surviving, 91% of the conversations already gone. Helm now reads those files
  before they are deleted and can render an **archived** one. That is not
  hosting a client: it is read-only, retrospective, over a record on disk, and
  never in the path of a running session. The boundary is *live*, not *messages*
  - while a session is running Helm still shows a terminal and gets out of the
  way. See `core/archive/`, `main/archive.ts` and `pnpm transcript-check`.
- Windows-first: junctions (`mklink /J`) not symlinks, no elevation
  assumptions, test paths with spaces.

## Environment notes

Whatever is true of **one machine** - where its `claude` binary sits, what
directory this checkout lives in, which repositories happen to be beside it -
belongs in `CLAUDE.local.md`, which is gitignored. This file describes the
project, and a contributor should be able to follow every rule in it without
owning the machine it was written on.

Nothing in `packages/` may assume any of that either, and two checks say so:
`pnpm packaging-check --only=audit` fails if a personal path or name reaches
what ships, and its publication audit fails if one reaches **anywhere in the
repository** - docs, this file, the scripts and the drivers included. That one
reads the names it looks for from `.audit-private.local`, an uncommitted file,
so the audit never publishes the list it polices; `.audit-private.local.example`
says how to write one.

Both derive what to look for at runtime. Do not answer a failure by adding an
exemption: the hit is the finding.
