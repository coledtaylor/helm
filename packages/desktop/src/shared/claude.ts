/**
 * The range this build has been exercised against.
 *
 * Re-measured for 1.0.0 against the CLI on this machine, which answered
 * **2.1.233** - the build every real-window check for that release was run on.
 * The measurements written down in SPEC and CLAUDE.md were taken on 2.1.225,
 * and both are inside the range for the same reason the range is written this
 * way: the floor is the minor series rather than an exact build because nothing
 * here depends on a patch, and the ceiling is the next minor because that is
 * where the flags Helm passes could plausibly move.
 *
 * Re-measure this rather than carrying it forward. A range inherited across a
 * release is a claim nobody checked, and the whole value of the warning strip
 * is that somebody did.
 */
export const CLAUDE_TESTED_RANGE = { min: '2.1.0', max: '2.2.0' } as const
