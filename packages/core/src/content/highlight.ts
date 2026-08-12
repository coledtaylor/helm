/**
 * Syntax highlighting, loaded one grammar at a time.
 *
 * Shiki is the highlighter the spec picked and it is the right one - it uses
 * VS Code's own TextMate grammars, so a fence marked `powershell` is coloured
 * by the same rules the editor beside this app uses. The cost is that the full
 * bundle is every grammar in existence, which is tens of megabytes nobody's
 * notes need. Three decisions keep that off the disk and out of startup:
 *
 *   - `createHighlighterCore` with no languages, rather than the `shiki`
 *     convenience bundle. Nothing is loaded until a fence asks for it.
 *   - The **JavaScript** regex engine rather than the Oniguruma one, so there
 *     is no `.wasm` file to locate at runtime. A WASM asset beside a bundled
 *     main process is a packaging problem, and `forgiving: true`
 *     degrades a grammar the JS engine cannot compile to plain text rather than
 *     throwing in the middle of a document.
 *   - Grammars are `import()`ed by name at the moment a fence needs one. That
 *     is a dynamic specifier, which is why these packages are listed in the
 *     desktop package's dependencies: they stay external, and Node resolves
 *     them the way it resolves any other dependency.
 *
 * Two themes are loaded, not one, and the output carries both as CSS custom
 * properties. Helm's theme is a class on `<html>` that can change without a
 * reload, and re-highlighting every open document on a theme toggle would be a
 * visible pause for a colour swap.
 */

/** Minimal structural types, so this file does not import shiki for its types. */
interface Highlighter {
  codeToHtml: (code: string, options: Record<string, unknown>) => string
  loadLanguage: (lang: unknown) => Promise<void>
  getLoadedLanguages: () => string[]
}

export const LIGHT_THEME = 'github-light'
export const DARK_THEME = 'one-dark-pro'

/**
 * What people actually type in a fence, mapped to a grammar name.
 *
 * Shiki knows most of these aliases itself, but only for languages it has
 * already loaded - and the lookup here happens *before* the load, to decide
 * what to load. `sh` and `console` resolving to `shellscript` is the difference
 * between a highlighted block and a grey one.
 */
const ALIASES: Record<string, string> = {
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  console: 'shellscript',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  cmd: 'bat',
  batch: 'bat',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  golang: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  htm: 'html',
  dockerfile: 'docker',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
  '': 'plaintext'
}

/** A grammar name safe to put in a module specifier. */
const SAFE_LANG = /^[a-z0-9][a-z0-9+._-]*$/

let highlighter: Highlighter | null = null
let starting: Promise<Highlighter | null> | null = null
const loaded = new Set<string>(['plaintext', 'text', 'txt', 'ansi'])
const unavailable = new Set<string>()

async function start(): Promise<Highlighter | null> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, dark, light] = await Promise.all(
    [
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('@shikijs/themes/one-dark-pro'),
      import('@shikijs/themes/github-light')
    ]
  )
  const core = (await createHighlighterCore({
    themes: [dark.default, light.default],
    langs: [],
    // `forgiving` is what keeps one uncompilable grammar from taking a whole
    // document down: the block falls back to plain text instead.
    engine: createJavaScriptRegexEngine({ forgiving: true })
  })) as unknown as Highlighter
  return core
}

/** Ready, or null if shiki could not be started at all. The caller falls back. */
export async function getHighlighter(): Promise<Highlighter | null> {
  if (highlighter) return highlighter
  starting ??= start()
    .then((made) => {
      highlighter = made
      return made
    })
    .catch(() => null)
  return starting
}

export function normaliseLanguage(raw: string): string {
  const lower = raw.trim().toLowerCase()
  return ALIASES[lower] ?? lower
}

/**
 * Makes sure a grammar is in memory. Returns the name to highlight with, which
 * is `plaintext` when the language is not one shiki has.
 */
export async function ensureLanguage(raw: string): Promise<string> {
  const name = normaliseLanguage(raw)
  if (name === 'plaintext' || loaded.has(name)) return name
  if (unavailable.has(name) || !SAFE_LANG.test(name)) return 'plaintext'

  const core = await getHighlighter()
  if (!core) return 'plaintext'
  if (core.getLoadedLanguages().includes(name)) {
    loaded.add(name)
    return name
  }

  try {
    const grammar: unknown = await import(`@shikijs/langs/${name}`)
    await core.loadLanguage((grammar as { default: unknown }).default)
    loaded.add(name)
    return name
  } catch {
    // A language nobody packaged a grammar for. Remembered, so a document with
    // forty `pseudocode` fences pays the failed resolution once.
    unavailable.add(name)
    return 'plaintext'
  }
}

/**
 * One code block as HTML, in both themes at once.
 *
 * `defaultColor: false` is what produces `--shiki-light` / `--shiki-dark`
 * custom properties instead of a committed colour, which is what lets the
 * stylesheet pick a side from the `dark` class without re-running any of this.
 */
export async function highlightCode(
  code: string,
  language: string
): Promise<{ html: string; language: string; highlighted: boolean }> {
  const lang = await ensureLanguage(language)
  const core = await getHighlighter()
  if (!core) return { html: '', language: 'plaintext', highlighted: false }
  try {
    const html = core.codeToHtml(code, {
      lang,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false
    })
    return { html, language: lang, highlighted: lang !== 'plaintext' }
  } catch {
    return { html: '', language: 'plaintext', highlighted: false }
  }
}
