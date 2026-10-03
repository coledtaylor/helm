# Testing Helm

Helm's tests come with the repository so that anyone working on it can ship
with confidence. There are two tiers of test, plus a set of diagnostic tools
that are not tests.

| tier | tool | covers | command |
|---|---|---|---|
| unit and integration | vitest | all app behaviour, as close to the code as it can be tested | `pnpm test` (part of `pnpm check`) |
| end to end | Playwright for Electron | the high-level user workflows, through the built app | `pnpm test:e2e` |

Both tiers run locally, before a change is merged. CI runs neither: it builds
and releases the app. Coverage is still being filled in:
[TEST-BACKLOG.md](TEST-BACKLOG.md) lists what the old check drivers asserted,
and each line moves into one of these tiers or is dropped.

## Running them

```bash
pnpm test                          # every vitest project
pnpm test --project ui             # one of core, ui, desktop
pnpm test:e2e                      # builds, then runs every workflow
pnpm --filter @helm/desktop exec playwright test -c e2e panes   # one spec, after a build
```

## Unit and integration tests

vitest runs three projects (`vitest.config.ts`):

- **core** - pure logic in `packages/core`, in Node.
- **ui** - components in `packages/ui` and modules in the renderer, in jsdom
  with Testing Library. Find elements by role and accessible name. jsdom does
  no layout, so anything about where something lands belongs in the tier
  below.
- **desktop** - main-process services, in Node. `vi.mock('electron')` with
  `test/electron.ts` stands in for Electron; ptys are real and run the fake
  `claude`. `sessions.test.ts` is the example.

Tests live beside the code as `*.test.ts` or `*.test.tsx`. Logic tangled with
Electron or React moves into a module that can be tested on its own, as
`core/layout/panes.ts` was for the pane layout. The tier runs in seconds and
touches no network, no real `~/.claude` and no real `claude` or `gh`.

## End-to-end tests

`packages/desktop/e2e/`. One test per user workflow: starting a session,
splitting panes, a setting surviving a restart. Detail belongs in the tier
above; keep this one small.

- **Each test gets a world** (`test/world.ts`): a temporary root with a space in
  its path, holding a home directory with its own `.claude`, the fake `claude`
  and the fake `gh` as `.cmd` shims, two git projects, and the app's data
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
- Wait on conditions (`expect`, `expect.poll`), never on sleeps.

## The fake `claude`

`packages/desktop/test/fake-claude.mjs` does what Helm can observe of the real
CLI and nothing more. It answers `--version` and `--help`, draws a prompt,
echoes what is typed, and writes the session registry record, `history.jsonl`
and a transcript. `--resume` works only in the directory the conversation was
recorded in. Everything it was given and received is logged to
`<claude dir>/fake-claude/<pid>.json`.

At its prompt: `/exit` and `/crash` end it with 0 and 3, `/wait` reports
"waiting" until `y` or `n`, `/busy <ms>` reports "busy", `/child` starts a
long-running child process, and anything else is a prompt it records and
answers.

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

Compatibility with the real `claude` CLI changes with every CLI release, and
depends on what is installed on the machine, so it cannot be deterministic.
The diagnostic drivers cover it on demand: `pnpm claude-check` and
`pnpm fidelity` for the terminal, `pnpm browser-check` for the browser pane's
native view, and `scripts/drive-dev.mjs` for looking at a running dev build.
The `dev` skill (`.claude/skills/dev`) describes them. None of them has to pass
before a change is done.
