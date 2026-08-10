# Work Plan

Tracked in ClickUp: list **Helm - Claude Code Shell** (`901114291892`), space "the author's workspace".
Priority-ordered; work top-down. Full descriptions and acceptance criteria live on the tasks.

| ClickUp | Task | Gate |
|---|---|---|
| ~~[868knyagd](https://app.clickup.com/t/868knyagd)~~ | Spike A: Overlay composition via `--plugin-dir` | **GO** - the premise holds |
| ~~[868knyagj](https://app.clickup.com/t/868knyagj)~~ | Spike B: Portable packaging with native modules | **GO** - build config is the repo seed ([SPIKE-B.md](SPIKE-B.md)) |
| ~~[868knyagp](https://app.clickup.com/t/868knyagp)~~ | Spike C: Claude TUI fidelity inside xterm.js | **GO, embedded-first**, no external fallback ([SPIKE-C.md](SPIKE-C.md)) |
| ~~[868knyagz](https://app.clickup.com/t/868knyagz)~~ | M1: Foundation - shell, core, SQLite, discovery | **DONE** - monorepo, store, discovery, window shell |
| ~~[868knyah0](https://app.clickup.com/t/868knyah0)~~ | M2: Embedded terminal - claude in tabs | **DONE** - sessions, tabs, teardown; `pnpm m2-check` is the regression test. Spike C's human soak deferred into real use (`notes/task-helm-tui-soak.md`) |
| ~~[868knyah6](https://app.clickup.com/t/868knyah6)~~ | M3: Profiles + overlay composition | **GO - the premise holds.** Profiles in SQLite with YAML round-trip, junction shims, argv builder; `pnpm m3-check` is the regression test. `--add-dir` does not carry an overlay's CLAUDE.md; `--append-system-prompt-file` does |
| ~~[868knyah9](https://app.clickup.com/t/868knyah9)~~ | M4: Session launcher - resume across projects | **DONE** - 799 sessions / 36 projects indexed from `history.jsonl`, searchable in ~3 ms, resumable ones marked honestly (106 of 799); `pnpm m4-check` is the regression test. `--resume` resolves the id against the cwd, so a session can only be reopened from its own folder |
| [868knyahd](https://app.clickup.com/t/868knyahd) | M5: Config console + effective view | |
| [868knyahg](https://app.clickup.com/t/868knyahg) | M6: Content viewer - markdown/HTML/wikilinks | |
| [868knyahn](https://app.clickup.com/t/868knyahn) | M7: Portable packaging + first-run | Clean machine → session in <5 min |
| [868kp18rk](https://app.clickup.com/t/868kp18rk) | Status bar: session/weekly usage, % or estimated dollars | Percentages are free and real (`~/.claude.json` → `cachedUsageUtilization`); dollars are an estimate on a subscription plan and need a usage index over 217 MB of transcripts |
| [868knyahu](https://app.clickup.com/t/868knyahu) | Backlog: Transcript archive (v1.1) | Deferred |
