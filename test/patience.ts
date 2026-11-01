/**
 * How long a TypeScript test waits for anything before it fails, naming what
 * it waited for: every `vi.waitFor`, Testing Library `waitFor` and `findBy`,
 * and `expect.poll` in the vitest tier, and every `expect` in the end-to-end
 * tier (`e2e/playwright.config.ts`), is bounded by it (docs/TESTING.md). The
 * Rust tests' `PATIENCE`, in the host's testkit, is the same 20 s.
 *
 * A passing test never comes near it; it is the bound for the slowest machine
 * the suite runs on. A wait that needs longer is waiting on the wrong thing.
 */
export const PATIENCE = 20_000

/**
 * How long one test in the vitest tier may take: a whole patience for its
 * wait, with room for the setup around it (a world, a pty, a store). Every
 * vitest run of the suite's sets it, the crash fixture's own run
 * (`packages/desktop/test/crash-run/vitest.config.ts`) included: vitest's own
 * 5 s is less than making a world takes on a slow runner.
 */
export const TEST_TIMEOUT = 30_000
