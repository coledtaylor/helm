---
name: procedures
description: The repeatable multi-step jobs in Helm - adding an app setting, changing the database schema, and building a Windows release. Use when asked to add or change a setting, add or alter a table or column, run db:generate, or produce dist:win artefacts.
---

## Helm's procedures

Three jobs in this repository have a fixed order of steps, and each has a step
people skip. What follows is the order and the step.

## Adding an app setting

Four edits and no migration, because `app_settings` is JSON-per-key:

1. **The key and its default** in `AppSettings` / `DEFAULT_SETTINGS`
   (`core/src/types.ts`). That is the whole of the persistence step - there is
   no table change and no migration.
2. **A validator** in `SETTING_VALIDATORS` (`core/src/store/settings.ts`). The
   map is `Record<keyof AppSettings, ...>`, so a key with no validator does not
   compile, and a value that fails one writes nothing and throws. Add its valid
   *and* invalid cases to the table in `store.test.ts`.
3. **A row** in the matching group of `ui/src/components/SettingsPane.tsx`, with
   a `data-settings-*` hook so the driver can drive it.
4. **Only if the value drives something outside the database**, a branch in the
   `settings:write` ladder in `main/ipc.ts`. That ladder is the entire
   side-effect dispatch: theme retints the overlay, `claudePath` reaches the
   session host. A setting that only needs to be read back does not belong in
   it.

Then **extend `pnpm settings-check`**. This is the step that gets skipped: a
setting with no assertion in it is a setting nothing proves round-trips.

Two rules that shape all of the above:

- **Reads stay tolerant, writes stay strict.** Unknown keys are ignored and bad
  JSON falls back per key, because a row from another build is a fact about the
  past. A malformed write is a bug happening now, so it writes nothing and
  throws.
- **Internal state is not a setting.** `windowBounds` and `firstRunCompletedAt`
  live in the same table and are deliberately absent from the pane - they are
  things Helm remembers, not things anyone chose.

Settings for Helm go here. Anything that edits a `.claude` tree belongs to the
config console, and the two are not the same surface.

## Changing the schema

Edit `core/src/store/schema.ts`, then run `pnpm db:generate`.

The generated SQL is **embedded into the bundle**, not read from disk at
runtime, so a packaged exe carries its own migrations rather than needing files
shipped beside it. Skipping `db:generate` therefore produces a build whose code
expects a column its migrations never create.

## Cutting a release

Two edits and a merge:

1. **The version** in `packages/desktop/package.json`. That bump is the whole
   trigger - merging it to `main` tags it, builds on a clean runner and
   publishes. No tag to push, no button.
2. **A `## <version>` section in `CHANGELOG.md`**, which becomes the release
   body. **Without one the release fails**, deliberately: writing it is the step
   a person can skip.

Then run `pnpm packaging-check` green **with Helm closed** before merging. CI
runs only the fast tier - typecheck, lint, tests, build - so nothing else covers
the artefact somebody actually downloads.

**The changelog is for somebody deciding whether to download an exe.** Not a
commit log: no probe ids, no check names, no `pnpm` commands, no refactors, no
fixtures. The commits are one click away under "Full changelog" on every release
page. Group entries by what a reader would look for - the surface that changed -
and say what is different for them, not what was done to the repository.

This was learned the expensive way. Through 0.4.0 the body was `git log`
subjects, which put fifty-nine lines on the page, most of them naming a probe,
and three identical lines from one cherry-pick onto three branches. Deriving it
by path was tried and cannot work: the same file is touched for a reason a
reader sees and for a reason they never will. The workflow now refuses a section
carrying those fingerprints, but the guard only catches a pasted commit log -
whether an entry is worth telling anyone about is still yours to judge.

## Building a Windows release

`pnpm dist:win` goes through `scripts/dist-win.mjs`, never straight to
electron-builder.

electron-builder resolves the package manager with `which`, which prefers
`pnpm.EXE` over `pnpm.CMD` on Windows. A stale standalone pnpm shadowing the
managed one makes it fall back to the npm collector - and that path does not
fail. It warns, and ships an exe with **no `app.asar.unpacked`**, which dies on
its first `dlopen`. The wrapper checks that the resolved pnpm answers the
declared version.

`pnpm packaging-check --only=package` asserts the prebuilds are present in the
artefact regardless of how it was built, and `pnpm verify:artifact` unwraps a
finished exe and checks the same thing from the outside. Full release process:
[docs/PACKAGING.md](../../../docs/PACKAGING.md).
