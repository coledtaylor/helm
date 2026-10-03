import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUILTIN_THEMES,
  parseThemeFile,
  serializeTheme,
  THEME_FILE_MAX_BYTES,
  THEME_ID_MAX_LENGTH,
  themeIdFromFileName,
  type ThemeDefinition,
  type ThemeProblem
} from './themes'

/**
 * User themes on disk: one `*.json` per theme, in one flat directory.
 *
 * The directory is a sibling of the templates one and takes the same branch
 * (`themesDir` in `paths.ts`): `~/.config/helm/themes` for an installed Helm,
 * because these are files a person writes by hand and may keep in git, and
 * `helm-data/themes` beside a portable exe or under a check's own data
 * directory. Read here, never written except by `seedThemesDir` and
 * `writeThemeCopy`, both of which only ever create a file that was not there.
 */

export interface UserThemes {
  themes: ThemeDefinition[]
  errors: ThemeProblem[]
}

/**
 * Every theme file in `dir`, parsed. A missing directory is no themes rather
 * than an error - it is the state of every install that never made one.
 *
 * Only regular files are read: `isFile()` is false for a symlink or junction,
 * so nothing here follows a reparse point anywhere (CLAUDE.md "Overlays").
 * Sorted by name so the pane's order does not depend on the filesystem's.
 */
export function readUserThemes(dir: string): UserThemes {
  const themes: ThemeDefinition[] = []
  const errors: ThemeProblem[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { themes, errors }
  }

  const seen = new Map<string, string>()
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
    const file = entry.name
    const path = join(dir, file)
    let text: string
    try {
      if (statSync(path).size > THEME_FILE_MAX_BYTES) {
        errors.push({ file, message: `larger than ${String(THEME_FILE_MAX_BYTES / 1024)} KB - not a palette` })
        continue
      }
      text = readFileSync(path, 'utf8')
    } catch (err) {
      errors.push({ file, message: `could not be read: ${err instanceof Error ? err.message : String(err)}` })
      continue
    }

    const parsed = parseThemeFile(file, text.replace(/^\uFEFF/, ''))
    if (!parsed.ok) {
      errors.push({ file, message: parsed.message })
      continue
    }
    // `My Theme.json` and `my-theme.json` are one id. The first in sort order
    // keeps it and the other says so, rather than one silently winning.
    const earlier = seen.get(parsed.theme.id)
    if (earlier !== undefined) {
      errors.push({ file, message: `has the same id as ${earlier} ("${parsed.theme.id}") - rename one of them` })
      continue
    }
    seen.set(parsed.theme.id, file)
    themes.push(parsed.theme)
  }
  return { themes, errors }
}

/** The README written into a new themes directory. Never rewritten. */
export const THEMES_README = `# Helm themes

One theme per \`.json\` file in this folder. Helm watches it: save a file and
the window repaints, no restart. Pick a theme in Settings, Appearance.

The quickest start is **Duplicate** in that pane, which writes a complete copy
of the theme on screen here. A theme can also say only what it changes:

\`\`\`json
{
  "name": "Nocturne, warmer",
  "extends": "nocturne",
  "colors": {
    "bg": "#16131a",
    "accent": "#d9a066"
  }
}
\`\`\`

- \`kind\` is \`"dark"\` or \`"light"\`, and is needed unless \`extends\` names a
  built-in (\`nocturne\`, \`graphite\` or \`daylight\`). It decides which slot
  the theme can fill when Helm follows Windows.
- Every colour left out comes from the theme extended, or the built-in of the
  same kind.
- Colours are \`#rrggbb\`, \`#rrggbbaa\` or \`rgb()\`. Only \`border\`,
  \`border-strong\`, \`accent-soft\` and \`accent-soft-hover\` may be
  translucent; grounds and text must be solid.
- The file name is the theme's id: \`My Theme.json\` is \`my-theme\`.

The terminal's colours are not part of a theme. They are fixed so that Claude
Code renders the same under every one.

Helm wrote this file once, when it created the folder, and will not write it
again. Delete it if you like.
`

export interface ThemesSeedResult {
  seeded: boolean
  problem: string | null
}

/**
 * Creates the directory and its README, only when the directory is absent -
 * the rule `seedTemplates` follows and for the same reason: Helm keeps no
 * record of what it wrote, so it cannot tell an edited file from an untouched
 * one, and the only safe time to write is when there is nothing there.
 */
export function seedThemesDir(dir: string): ThemesSeedResult {
  if (existsSync(dir)) return { seeded: false, problem: null }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), THEMES_README, { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    return {
      seeded: false,
      problem: `the themes directory could not be created: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return { seeded: true, problem: null }
}

/**
 * Writes `theme` as a new file in `dir` and returns its path: `<id>-copy.json`,
 * or `-copy-2` and on while that is taken. `wx`, so an existing file is never
 * overwritten even by a race with another Helm.
 */
export function writeThemeCopy(dir: string, theme: ThemeDefinition): string {
  mkdirSync(dir, { recursive: true })
  const taken = new Set(BUILTIN_THEMES.map((t) => t.id))
  for (let n = 1; n < 1000; n += 1) {
    const suffix = n === 1 ? '-copy' : `-copy-${String(n)}`
    const stem = `${theme.id.slice(0, THEME_ID_MAX_LENGTH - suffix.length)}${suffix}`
    const id = themeIdFromFileName(stem)
    if (id === null || taken.has(id)) continue
    const path = join(dir, `${stem}.json`)
    try {
      writeFileSync(path, serializeTheme(theme, copyName(theme.name, n)), {
        encoding: 'utf8',
        flag: 'wx'
      })
      return path
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw err
    }
  }
  throw new Error(`no free name for a copy of ${theme.id} in ${dir}`)
}

function copyName(name: string, n: number): string {
  return n === 1 ? `${name} copy` : `${name} copy ${String(n)}`
}
