/**
 * How long a TypeScript test waits for anything before it fails, naming what
 * it waited for: every `vi.waitFor`, Testing Library `waitFor` and `findBy`,
 * and `expect.poll` in the vitest tier is bounded by it (docs/TESTING.md).
 * The Rust tests' equivalent is `PATIENCE` in the host's testkit.
 *
 * A passing test never comes near it; it is the bound for the slowest machine
 * the suite runs on. A wait that needs longer is waiting on the wrong thing.
 */
export const PATIENCE = 10_000
