import { watch, type FSWatcher } from 'node:fs'
import { nativeTheme } from 'electron'
import {
  BUILTIN_THEMES,
  readUserThemes,
  resolveTheme,
  seedThemesDir,
  writeThemeCopy,
  type AppSettings,
  type ThemeDefinition,
  type ThemeListing,
  type ThemeProblem,
  type ThemeState
} from '@helm/core'

/**
 * The themes on this machine, kept current while the app runs.
 *
 * The built-ins are constants; the user's are the `*.json` files in
 * `themesDir`, re-read whenever that directory changes so a saved edit
 * repaints the window with no restart. The watch is the whole of "live":
 * nothing polls, and a theme file is read only when something in its
 * directory moved.
 */
export interface ThemeService {
  readonly dir: string
  listing(): ThemeListing
  /** The theme on screen for these settings, and what Windows says now. */
  state(settings: AppSettings): ThemeState
  /** Writes a complete copy of `id` into the directory and returns its path. */
  duplicate(id: string): string
  /** Creates the directory if somebody deleted it, and watches it again. */
  ensureDir(): void
  /** Called after the user themes were re-read. */
  onChange(listener: () => void): () => void
  stop(): void
}

/**
 * Coalesces a burst of events into one re-read. One save is several events on
 * Windows - an editor that writes a temp file and renames it over the original
 * reports both names, twice - and a half-written file read in the middle of
 * that is a parse error the pane would flash.
 */
const SETTLE_MS = 120

export function createThemeService(dir: string): ThemeService {
  const seeded = seedThemesDir(dir)
  if (seeded.problem !== null) console.warn(seeded.problem)
  else if (seeded.seeded) console.log(`created the themes directory at ${dir}`)

  let user: { themes: ThemeDefinition[]; errors: ThemeProblem[] } = readUserThemes(dir)
  let watcher: FSWatcher | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const listeners = new Set<() => void>()

  const reload = (): void => {
    timer = null
    if (stopped) return
    user = readUserThemes(dir)
    for (const listener of listeners) listener()
  }

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(reload, SETTLE_MS)
  }

  const arm = (): void => {
    if (watcher !== null || stopped) return
    try {
      watcher = watch(dir, { persistent: false }, schedule)
      // The directory itself going away - deleted, or a drive unplugged - is
      // an error on the watcher rather than an event. What it held is gone, so
      // it is reported as no user themes, and `ensureDir` re-arms it.
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
        schedule()
      })
    } catch {
      watcher = null
    }
  }
  arm()

  const find = (id: string): ThemeDefinition | undefined =>
    BUILTIN_THEMES.find((t) => t.id === id) ?? user.themes.find((t) => t.id === id)

  return {
    dir,
    listing: () => ({ dir, themes: [...BUILTIN_THEMES, ...user.themes], errors: user.errors }),
    state: (settings) => {
      const applied = resolveTheme(
        {
          preference: settings.theme,
          systemDark: nativeTheme.shouldUseDarkColors,
          themeDark: settings.themeDark,
          themeLight: settings.themeLight,
          accentColor: settings.accentColor
        },
        user.themes
      )
      return { preference: settings.theme, resolved: applied.kind, applied }
    },
    duplicate: (id) => {
      const source = find(id)
      if (!source) throw new Error(`there is no theme "${id}" to duplicate`)
      const file = writeThemeCopy(dir, source)
      arm()
      // Not left to the watcher: the pane that asked wants the new card on its
      // next paint, and a watcher that was not armed until this call may not
      // report the write that armed it.
      user = readUserThemes(dir)
      for (const listener of listeners) listener()
      return file
    },
    ensureDir: () => {
      seedThemesDir(dir)
      arm()
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      watcher?.close()
      watcher = null
      listeners.clear()
    }
  }
}
