---
type: reference
date: 2026-08-08
tags: [claude-gui, electron, spec, launch-scope, plugin-dir, v1]
---

# Helm - v1 Spec

A portable, configurable desktop shell **on top of** Claude Code. Not a client,
not a reimplementation. It hosts the real `claude` TUI and owns everything that
happens before and after a session.

> [!warning] Supersedes the SDK draft
> The first draft of this spec was built on `@anthropic-ai/claude-agent-sdk`,
> rendering its own transcript and permission UI. That is rebuilding Claude Code.
> **Rejected.** This version shells out to the `claude` CLI and hosts its TUI
> unmodified. The SDK is not a dependency.

---

## 1. The Problem

Claude Code resolves `.claude/` configuration relative to the working directory.
That forces a choice at launch time, and both options lose something:

| Launch from | You get | You lose |
|---|---|---|
| **Harness root** | cross-repo access, harness tools, 8 harness skills | ~43 project skills, project agents, project CLAUDE.md |
| **A single repo** | that repo's skills, agents, CLAUDE.md | cross-repo access, harness tooling |

Measured on this machine. The counts are the real census; the repository names
are anonymised, because they are private work and none of the argument depends
on what they are called. `atlas` and its siblings are one product's repositories,
which is what makes them worth composing together:

```
~/.claude/skills      0      ← nothing user-level
~/.claude/commands    0
~/.claude/agents      0

repos/atlas                 skills:7  agents:16  commands:1  CLAUDE.md
repos/atlas-reporting       skills:6  agents:12  commands:1  CLAUDE.md
repos/beacon                skills:6  agents:14  commands:1
repos/Atlas-Builder         skills:5  agents:16  commands:1  CLAUDE.md
repos/atlas-ui              skills:5  agents:12  commands:1  CLAUDE.md
repos/voxelcraft            skills:5  agents:12  commands:1  CLAUDE.md
repos/orchard-sim              skills:4  agents:14  commands:1  CLAUDE.md
repos/datapack              skills:4                          CLAUDE.md
repos/atlas-mobile          skills:1
harness root                skills:8  commands:1
```

**Every skill on this machine is project-local. None are user-level.** So working
from the harness root - which is the right call at work, where the product is many
microservices and reaching all of `repos/` matters - silently drops ~43 skills and
~96 agents on the floor.

That is the problem Helm exists to solve. Everything else is secondary.

---

## 2. The Mechanism

`claude --help`:

```
--plugin-dir <path>   Load a plugin from a directory or .zip for this session
                      only (repeatable: --plugin-dir A --plugin-dir B.zip)
--add-dir <dirs...>   Additional directories to allow tool access to
```

A plugin is just a directory. Verified against the installed `superpowers` and
`vercel` plugins, the manifest is minimal:

```jsonc
// .claude-plugin/plugin.json
{ "name": "vercel", "version": "0.45.1", "description": "..." }
```

with convention directories beside it: `skills/`, `commands/`, `agents/`, `hooks/`.

A repo's `.claude/` directory is *already almost that shape* - it just lacks the
manifest. So Helm synthesises a shim per project:

```
%TEMP%/helm/overlay-atlas/
├── .claude-plugin/plugin.json      generated
├── skills/     ──junction──▶  repos/atlas/.claude/skills
├── commands/   ──junction──▶  repos/atlas/.claude/commands
└── agents/     ──junction──▶  repos/atlas/.claude/agents
```

and launches:

```bash
claude \
  --add-dir     repos/atlas repos/atlas-reporting \
  -n "accruals" \
  --plugin-dir  <data>/overlays/overlay-atlas \
  --plugin-dir  <data>/overlays/overlay-atlas-reporting \
  --append-system-prompt-file <data>/overlays/memory-accruals.md \
  --model opus --effort high --permission-mode auto \
  "/recap"
# cwd = harness root
```

Result: harness root as the working directory, with project skills and agents
composed in. The tradeoff disappears.

Three details that are load-bearing rather than stylistic:

- **`--append-system-prompt-file`** carries the overlays' CLAUDE.md. Plugins do
  not (Spike A), and neither does `--add-dir` (M3, measured). See the risk table.
- **Argument order.** `--add-dir` is variadic, so `-n` follows it to terminate
  the list and the opening prompt goes last - a positional reachable from
  `--add-dir` is read as another directory.
- **The shim root is under the app's data directory, not `%TEMP%`.** A shim
  contains junctions into real repositories, and a temp cleaner that follows a
  reparse point instead of unlinking it deletes the repo's `.claude/skills`.

Windows note: **directory junctions**, which need no elevation, rather than
symlinks, which do - created with `fs.symlinkSync(target, path, 'junction')`
rather than by shelling out to `mklink /J`. Copy as a fallback.

> [!note] Proven by Spike A (2026-08-08)
> `--plugin-dir` accepts a synthesised junction-based shim: skills, agents, and
> commands from two composed overlays all resolved and invoked from the harness
> root. The platform namespaces everything automatically
> (`<plugin-name>:<skill>`), so cross-overlay name collisions are impossible.
> One caveat: **plugins do not carry the overlaid repo's CLAUDE.md** - and
> neither does `--add-dir`, which M3 measured and found wanting. Helm composes
> them into `--append-system-prompt-file` instead.
> See [SPIKE-A findings](../../../notes/reference-helm-spike-a-overlay-composition.md).

---

## 3. The Core Object: a Profile

Everything in Helm is organised around one saved, reusable thing.

```yaml
name: "Atlas cloud sync"
root: ~/.harness/dev              # cwd
overlays:                         # composed via --plugin-dir
  - repos/atlas
  - repos/atlas-reporting
access:                           # --add-dir
  - repos/atlas
  - repos/atlas-reporting
  - repos/atlas-mobile
model: opus
effort: high
permission_mode: auto
agent: null
mcp: [clickup]
opening_prompt: "/recap"
```

One click launches it. That composition is not expressible in the CLI today
without assembling the flags by hand every time, which is precisely the ceremony
worth eliminating.

Profiles live in SQLite, exportable to YAML so they travel with a harness.

---

## 4. The Surfaces

Three of them are the product - the launcher, the config console and the content
viewer - and the terminal is what they all point at. Settings (4.5) is the app's
own, added by M8 because every surface above it had a setting with nowhere to
live.

### 4.1 Launcher

- Tree of harnesses and projects, auto-detected (`harness.yaml`, then `repos/*`,
  degrading gracefully to "just a folder")
- Saved profiles, pinned and ordered
- Session list from `history.jsonl` - **799 sessions across 36 projects** at the
  time M4 landed, which `/resume` can never show you because it only sees the
  current directory
- Click a session to resume it into a tab

> [!note] Built by M4 (2026-08-09)
> The index mirrors `history.jsonl` into SQLite incrementally, and marks each
> session with whether it can actually be reopened. Three findings shaped it,
> all measured on 2.1.225:
>
> - **`--resume <id>` is resolved against the working directory.** The same id
>   that resumes from the session's own folder reports "No conversation found
>   with session ID" and exits 1 from anywhere else. So resuming needs the
>   recorded directory to still exist, and a deleted folder is as fatal as a
>   reaped transcript - the launcher distinguishes the two.
> - **A transcript cannot be found by deriving its path from the project.** The
>   directory under `projects/` carries whatever casing the CLI was started
>   with and `history.jsonl` records its own; two transcripts here live under
>   `...-repos-Atlas-Reporting` for sessions whose recorded project is
>   `...\repos\atlas-reporting`. The scan is by session id.
> - **Retention is 13%, not 9%** - 106 of 799. Still the reason resumability is
>   read off the disk on every pass rather than remembered.
>
> Search is `LIKE`, not FTS5: a filter box has to match `geofenc` inside
> `geofencing`, which a tokenising index does not. Measured p95 **3 ms** over
> 3,472 prompts against a 100 ms budget (`pnpm m4-check`, M4-4).
- Per-project git state at a glance: branch, dirty count, ahead/behind

### 4.2 Config Console

The `.claude/` directory of whatever scope you point at, as a real interface.

- **Scope switcher:** user / harness root / project. Pick one, see its `.claude/`.
- Browse and edit `skills/`, `commands/`, `agents/`, `hooks/`, `settings.json`,
  `CLAUDE.md`, `.mcp.json`
- **Effective view:** given a profile, show what is *actually* active - which
  skills resolve and under which overlay namespace (deterministic per Spike A:
  `<overlay-name>:<skill-name>`), and which scope won for each setting (user vs
  project vs local) and why. This is the payoff of the composition model and the
  thing no file explorer can tell you.
- MCP managed by shelling out to `claude mcp add / get / add-json` rather than
  editing JSON by hand
- Every write snapshotted to SQLite first, with per-file undo history
- `claude doctor` surfaced as a health panel

> [!note] Built by M5 (2026-08-10)
> Four views over one scope switcher - files, effective, MCP, health - and the
> only surface in Helm that writes to a `.claude` tree. Three findings shaped
> it, all measured on 2.1.225:
>
> - **Settings merge per leaf, not per key.** A project `settings.json` setting
>   `env.A` and a `settings.local.json` setting `env.B` yield a session with
>   both, and the local file wins where they collide. A view keyed by top-level
>   key would have reported `env` as wholly replaced, which is wrong in the
>   direction that loses settings. The effective view is keyed by `env.A`, and
>   the winner is read back out of a live session rather than assumed.
> - **`CLAUDE_CONFIG_DIR` moves the credentials too**, so the user layer cannot
>   be measured against a fixture home - a session pointed at one cannot log
>   in. `pnpm m5-check` therefore borrows the real `~/.claude/settings.json`,
>   through the console's own snapshotted write, and hash-verifies it back.
> - **The JSON error position cannot be read out of V8's message.** On Node 24
>   a trailing comma reports `Unexpected token ',' ... is not valid JSON` with
>   no offset at all, and falling back to the end of the file marks a line
>   twenty below the mistake. Helm scans for the position itself.
>
> The namespace prediction needed no measurement - Spike A settled it. Overlay
> skills resolve as `<overlay>:<skill>`, which is decidable from the profile,
> so the view predicts names rather than detecting collisions. `pnpm m5-check`
> checks all of it against a second, independent read, and the effective view
> against a real session on haiku.

### 4.3 Content Viewer

Read what Claude writes without a detour through Explorer and a text editor.

- Rendered **markdown** with GFM: tables, task lists, callouts, code highlighting
- Rendered **HTML** in a sandboxed webview, for artifacts and generated reports
- Sources: `notes/` (the Obsidian vault - so `[[wikilinks]]` must resolve and be
  clickable), `context/*.yaml`, any `SKILL.md`, any file Claude produced
- Frontmatter parsed and shown as a header chip, not raw YAML noise
- Full-text search across notes and skills
- Edit-in-place with a split preview

### 4.4 Terminal

`xterm.js` + `node-pty` hosting the **real** `claude` TUI, in tabs. Helm renders no
messages, parses no output, handles no permissions. It supplies the argv, the cwd,
and the environment, then gets out of the way.

### 4.5 Settings

Helm's own configuration, and the permanent home for all of it. Distinct from
the config console by ownership: 4.2 edits the `.claude` trees that belong to
Claude Code and are shared with every other client on the machine, this edits
the app.

A `{kind:'settings'}` workspace pane, opened by the gear in the title bar beside
the theme toggle, laid out as one scrolling page of titled groups:

- **Claude CLI** - the resolved executable, its version and whether that version
  is inside the tested range, "Locate manually…", and **Clear override**
- **Workspace** - the scan roots, with add *and remove*
- **Appearance** - theme, and what the status bar's usage segment shows

> [!note] Built by M8 (2026-08-11)
> Three things the app had been missing rather than three new settings:
> `claudePath` was reachable only during first run, so a wrong pick was
> permanent once `firstRunCompletedAt` was stamped; `roots:remove` had had a
> channel and a handler since M7 and **no caller at all**; and the usage mode
> was reachable only by clicking the status bar until it landed on what you
> wanted.
>
> The two quick accessors stay. A control beside the thing it changes is worth
> having - what was missing was somewhere to find the setting when you are not
> already looking at it. Both write `settings:write` and the pane renders
> `settings:changed`, so they cannot disagree; `pnpm settings-check` clicks each
> one and watches the pane follow.
>
> `app_settings` is JSON-per-key and needed no migration. What it did need was
> **validation**: there was none, so `{theme:'purple'}` persisted and reached
> `nativeTheme.themeSource`. Writes now validate per key and a patch applies as
> one edit - one bad value writes none of them - while reads stay tolerant of
> unknown keys and unparseable values. Strict in, forgiving out: a row from
> another build is a fact about the past, a malformed write is a bug happening
> now.
>
> Internal state (`windowBounds`, `firstRunCompletedAt`) is deliberately not
> shown. Those are things Helm remembers, not things anyone chose.

---

## 5. Architecture

```
helm/
├── packages/
│   ├── core/        # headless. ZERO electron imports.
│   │   ├── launch/    profile → argv, overlay shim generation
│   │   ├── discovery/ harnesses, projects, skills, agents, sessions
│   │   ├── config/    read/write/snapshot .claude trees
│   │   └── store/     SQLite: profiles, snapshots, session index
│   ├── ui/          # React components
│   └── desktop/     # Electron: main + preload + renderer + pty host
```

| Layer | Choice |
|---|---|
| Shell | Electron |
| Language | TypeScript strict |
| UI | React + Vite + shadcn/ui + Tailwind |
| Terminal | `xterm.js` + `node-pty` |
| DB | `better-sqlite3` + Drizzle |
| Markdown | `remark`/`rehype` + `shiki` |
| Packaging | `electron-builder`, portable + NSIS |

**The one discipline:** `core/` never imports Electron. That keeps the mobile
option open and is what makes the app genuinely portable.

### Portability

- **Harness-agnostic** - detects `harness.yaml`, falls back to plain folders. No
  hardcoded paths, no `dev/` assumptions. A harness is *any* folder with a
  manifest; its optional `repos:` key names where the repositories are, so a
  folder that already holds repos at its top level can become one without
  hiding them (M7).
- **Portable install** - single `.exe`, app data beside it when portable,
  `%APPDATA%` when installed. Both install-tested by `pnpm m7-check --only=package`;
  the NSIS build is per-user and needs no elevation. See [PACKAGING.md](PACKAGING.md).
- **Shareable** - real first-run setup, nothing specific to the machine it was
  written on, README. Enforced rather than asserted: `pnpm m7-check --only=audit`
  greps the checkout for personal paths and names, and proves it can catch one
  before believing that it found none.

---

## 6. Out of Scope for v1

- The Agent SDK, in any form
- Rendering messages, diffs, or permission dialogs
- Mobile, cloud sync, teams
- Transcript archival - **worth noting anyway: 106 transcripts survive for 799
  sessions, a 13% retention rate** (re-measured by M4; the first count of 9% was
  taken by deriving transcript paths from the recorded project, which misses the
  ones whose directory was created under a different casing). Prompts persist in
  `history.jsonl`; the conversations are reaped. Strong v1.1 candidate, and a
  pure-win feature since an external process copying files cannot break anything.
  M4 makes the case for it visible: 694 of the rows in the session launcher are
  history-only, and every one of them is a conversation that could have been kept.
- WIP dashboard (dirty repos, stale branches) beyond the git chips in the launcher

---

## 7. Milestones

| # | Milestone | Proves |
|---|---|---|
| 0 | **Spike A** - overlay composition | The premise holds |
| 1 | Electron shell + `core` + SQLite + project discovery | Foundation |
| 2 | Embedded pty, launch `claude` in a tab at chosen cwd | Hosting works |
| 3 | **Profiles: compose overlays, launch, skills resolve** | **The product** |
| 4 | Session list from `history.jsonl`, resume into tabs | Beats `/resume` |
| 5 | Config console: browse + edit + effective view | Second surface |
| 6 | Content viewer: markdown + HTML + wikilinks | Third surface |
| 7 | Portable packaging, first-run, README | Shippable |

Milestone 3 is go/no-go. If a root-launched session with overlays does not
actually expose project skills, the premise is wrong and it is cheap to learn there.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| ~~**`--plugin-dir` may not accept a synthesised dir**~~ | **Closed by Spike A.** Junction-based shims work; two overlays composed in one session. Copy fallback exists but was not needed. |
| ~~**Skill name collisions** across composed overlays~~ | **Closed by Spike A.** The platform namespaces every overlay automatically (`<plugin-name>:<skill>`); same-named skills in two overlays coexist. Helm only sanitizes plugin manifest names. |
| ~~**Project CLAUDE.md not carried by `--plugin-dir`**~~ (Spike A finding) | **Closed by M3, but not the way the mitigation guessed.** `--add-dir` does *not* pull in an overlaid repo's CLAUDE.md - measured on 2.1.225, a session launched from the harness root with both flags reported only the user and cwd instruction files. Helm composes the overlays' CLAUDE.md into one document and passes it to **`--append-system-prompt-file`**. A file, not `--append-system-prompt` inline: two repos here total 34 KB against a 32,767-character Windows command line. |
| **Junctions on Windows** | `mklink /J` needs no elevation. Fall back to copy + watch. |
| **Native modules** (`node-pty`, `better-sqlite3`) vs portable exe | Spike B: package a hello-world with both. |
| **CLI flag drift** across Claude Code releases | Flags are a stable public surface, far safer than the 0.3.x SDK. Pin a tested version, assert on `claude --version` at startup. |
| ~~**TUI inside xterm.js** feels wrong (resize, mouse, colour)~~ | **Closed by Spike C.** Fidelity holds; latency is within noise of no terminal at all. The residual risk moved: an *unconfigured* pane degrades the TUI five ways at once, so the configuration in `terminal.ts` and `ptyEnv` is load-bearing and each fix has a regression check. |

---

## 9. Spikes

- [x] **Spike A - Composition.** Synthesise an overlay plugin for
      `repos/atlas/.claude`, launch `claude` from the harness root with
      `--plugin-dir`, confirm a project skill resolves. *Everything depends on this.*
      **GO** - automatic namespacing makes cross-overlay collisions impossible;
      CLAUDE.md is not carried by plugins (M3 verifies `--add-dir` covers it).
      Headless (`-p`) only; M3's first profile launch doubles as the interactive
      proof. See `notes/reference-helm-spike-a-overlay-composition.md`.
- [x] **Spike B - Packaging.** Electron + `node-pty` + `better-sqlite3` built as a
      portable exe. **GO** - see [SPIKE-B.md](SPIKE-B.md).
- [x] **Spike C - Terminal fidelity.** Real `claude` TUI in xterm.js: resize,
      mouse, 24-bit colour, paste, Ctrl-C. **GO, embedded-first, no external
      fallback** - see [SPIKE-C.md](SPIKE-C.md). Fidelity requires five host-side
      fixes, all landed in `src/renderer/src/terminal.ts` and `src/main/pty.ts`.

---

## Related

- [[reference-electron-migration-plan]] - prior Electron work in this harness
- `context/harness-map.yaml` - harness detection reads this when present
