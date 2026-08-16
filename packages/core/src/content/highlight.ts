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
  codeToTokens: (code: string, options: Record<string, unknown>) => ThemedTokens
  loadLanguage: (lang: unknown) => Promise<void>
  getLoadedLanguages: () => string[]
}

/**
 * One token, as `codeToTokens` hands it over with two themes loaded.
 *
 * `htmlStyle` is the pair of custom properties `codeToHtml` would have written
 * into the `style` attribute - `--shiki-light` and `--shiki-dark`, plus the
 * font-style and weight variants where the theme sets them. Shiki has emitted
 * it as an object since v2; the string form is still accepted below because a
 * structural type is a promise about a shape rather than a version.
 */
interface ThemedToken {
  content: string
  htmlStyle?: Record<string, string> | string
}

interface ThemedTokens {
  tokens: ThemedToken[][]
}

/**
 * The one node a transformer here touches: the `<span class="line">` element,
 * as hast. Structural for the same reason `Highlighter` is - the alternative is
 * a type-only dependency on shiki in a file whose whole design is to reach it
 * through `import()` and nothing else.
 */
interface LineElement {
  properties: Record<string, unknown>
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
/**
 * Each line's own leading indentation, written onto the line as `--line-indent`.
 *
 * The content viewer's wrapped source view hangs a continuation row by the
 * line's indentation plus the configured amount, so a row that is the rest of a
 * deeply nested line cannot be mistaken for a new shallow one. CSS cannot
 * measure that: `text-indent` is resolved against the content box, and the
 * whitespace it would need to count is *inside* the line.
 *
 * It is emitted here, into the HTML, rather than measured in the renderer, and
 * that is not a stylistic preference. The renderer injects this string with
 * `dangerouslySetInnerHTML`, and that subtree is rebuilt from the string
 * whenever the document pane re-renders - measured on a real window, every
 * `.line` node was a different object about a second later. Anything written
 * onto those nodes from an effect is wiped by the next render and does not come
 * back, because the effect's dependencies have not changed. Carried in the
 * string, it survives every rebuild by construction.
 *
 * A tab counts for `tab-size`, which the stylesheet sets to 2. Counting it as
 * one column would under-hang every tab-indented file.
 */
const TAB_COLUMNS = 2

function indentColumns(line: string): number {
  let columns = 0
  for (const ch of line) {
    if (ch === ' ') columns += 1
    else if (ch === '\t') columns += TAB_COLUMNS
    else break
  }
  return columns
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;'
}

/** Text going into an HTML text node. Three characters, and they are the three. */
function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (ch) => ESCAPES[ch] ?? ch)
}

/**
 * A theme's colours are the only thing allowed into a `style` attribute here.
 *
 * The values come from a bundled theme JSON rather than from anything a user
 * typed, so this is a belt on top of braces - but the string it guards is
 * assembled into markup by hand, and a hand-assembled string with no whitelist
 * on it is exactly the shape that stops being safe the day somebody adds a
 * caller. Anything outside the set is dropped rather than escaped: a colour
 * that needs a quote in it is not a colour.
 */
const SAFE_STYLE_VALUE = /^[#\w\s,.()%/+-]*$/
const SAFE_STYLE_PROP = /^--?[a-z-]+$/

function styleAttribute(htmlStyle: Record<string, string> | string | undefined): string {
  if (htmlStyle === undefined) return ''
  const pairs =
    typeof htmlStyle === 'string'
      ? htmlStyle
          .split(';')
          .map((part) => part.split(':'))
          .filter((part): part is [string, string] => part.length === 2)
          .map(([prop, value]) => [prop.trim(), value.trim()] as const)
      : Object.entries(htmlStyle)
  const kept = pairs.filter(
    ([prop, value]) => SAFE_STYLE_PROP.test(prop) && SAFE_STYLE_VALUE.test(value)
  )
  if (kept.length === 0) return ''
  return ` style="${kept.map(([prop, value]) => `${prop}:${value}`).join(';')}"`
}

/** What the editor's underlay is built from: one string of markup per line. */
export interface HighlightedLines {
  /** The inner HTML of each line, in source order. */
  lines: string[]
  language: string
  highlighted: boolean
}

/**
 * The same tokenise, handed over **per line** rather than as one block.
 *
 * The editor's underlay renders a window of the file rather than all of it, so
 * it needs the lines as separate strings; `codeToHtml` returns one `<pre>` and
 * splitting generated markup back apart with a regular expression is the kind
 * of thing that works until a theme adds a property. `codeToTokens` is the same
 * pass through the same grammar with the assembly left to the caller, so this
 * is not a second highlighter - it is the same one, stopped a step earlier.
 *
 * The markup written here is deliberately what `codeToHtml` writes: a `<span>`
 * per token carrying `--shiki-light` and `--shiki-dark` as custom properties,
 * so one stylesheet rule picks a side and a theme toggle re-colours the editor
 * with no re-highlight. `defaultColor` is not passed through anywhere - see the
 * note on `highlightCode`.
 *
 * A trailing newline produces a final empty line here, exactly as it does in a
 * textarea, because shiki tokenises it as one. That is the overlay's
 * height-parity bug solved by the tokeniser rather than by a fudge factor.
 */
export async function highlightLines(
  code: string,
  language: string
): Promise<HighlightedLines> {
  const plain = (): HighlightedLines => ({
    lines: code.split('\n').map(escapeText),
    language: 'plaintext',
    highlighted: false
  })

  const lang = await ensureLanguage(language)
  const core = await getHighlighter()
  if (!core || lang === 'plaintext') return plain()

  try {
    const { tokens } = core.codeToTokens(code, {
      lang,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false
    })
    return {
      lines: tokens.map((line) =>
        line
          .map((token) => `<span${styleAttribute(token.htmlStyle)}>${escapeText(token.content)}</span>`)
          .join('')
      ),
      language: lang,
      highlighted: true
    }
  } catch {
    return plain()
  }
}

export async function highlightCode(
  code: string,
  language: string
): Promise<{ html: string; language: string; highlighted: boolean }> {
  const lang = await ensureLanguage(language)
  const core = await getHighlighter()
  if (!core) return { html: '', language: 'plaintext', highlighted: false }
  // Indexed from the source rather than read back off the rendered node: the
  // transformer sees a token tree, and reassembling the text from it to count
  // spaces would be doing the tokeniser's work backwards.
  const indents = code.split('\n').map(indentColumns)
  try {
    const html = core.codeToHtml(code, {
      lang,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
      transformers: [
        {
          name: 'helm:line-indent',
          line(node: LineElement, line: number) {
            // `line` is 1-based.
            const columns = indents[line - 1] ?? 0
            if (columns === 0) return
            const props = node.properties
            const existing = typeof props.style === 'string' ? `${props.style};` : ''
            props.style = `${existing}--line-indent:${String(columns)}ch`
          }
        }
      ]
    })
    return { html, language: lang, highlighted: lang !== 'plaintext' }
  } catch {
    return { html: '', language: 'plaintext', highlighted: false }
  }
}
