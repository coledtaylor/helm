# Testing Helm

Helm's tests come with the repository so that anyone working on it can ship
with confidence. There are two tiers of test, plus a set of diagnostic tools
that are not tests.

| tier | tool | covers | command |
|---|---|---|---|
| unit and integration | vitest | all app behaviour, as close to the code as it can be tested | `pnpm test` (part of `pnpm check`) |
| end to end | Playwright for Electron | the high-level user workflows, through the built app | `pnpm test:e2e` |

**Status.** Today only `packages/core` has tests. The `ui` and `desktop` unit
tiers and the end-to-end tier are being built; [TEST-BACKLOG.md](TEST-BACKLOG.md)
lists what they will cover, collected from the check drivers they replace.

## Unit and integration tests

- Live beside the code as `*.test.ts` or `*.test.tsx`.
- `packages/core`: pure logic, run in Node.
- `packages/ui`: components rendered in jsdom with Testing Library, found by
  role and accessible name.
- `packages/desktop`: main-process services, with Electron, the pty and the
  filesystem behind fakes the service is handed.
- Logic tangled with Electron or React moves into a module that can be tested
  on its own, as `core/layout/panes.ts` was for the pane layout.
- The whole tier runs in seconds. Tests use temporary directories and touch no
  network, no real `~/.claude`, and no real `claude` or `gh`.

## End-to-end tests

- One test per user workflow: starting a session, splitting panes, a setting
  surviving a restart. Detail belongs in the tier above; keep this tier small.
- Each run is hermetic: the app's own data directory (`PORTABLE_EXECUTABLE_DIR`),
  a temporary Claude home (`--claude-home=`), a fake `claude` CLI, the fake `gh`
  (`--gh=`), and fixture projects in a temporary directory. No tokens, no
  network, nothing of the user's touched.
- Find elements by role and accessible name, the way a user sees them. Avoid
  test-only attributes.
- Wait on conditions, never on sleeps.

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
