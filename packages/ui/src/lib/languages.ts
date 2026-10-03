/**
 * What a grammar is called on screen, from shiki's id for it.
 *
 * The id is machine data (`tsx`, `shellscript`) and the file view's footer is
 * read by a person, so the common ones get the name an editor shows. Anything
 * not listed is shown as its id, which is still the honest answer - shiki
 * ships hundreds of grammars and a table that tried to name them all would be
 * a table nobody keeps current.
 */
const NAMES: Record<string, string> = {
  plaintext: 'Plain text',
  typescript: 'TypeScript',
  tsx: 'TypeScript JSX',
  javascript: 'JavaScript',
  jsx: 'JavaScript JSX',
  json: 'JSON',
  jsonc: 'JSON with comments',
  markdown: 'Markdown',
  mdx: 'MDX',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  python: 'Python',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  sql: 'SQL',
  shellscript: 'Shell',
  powershell: 'PowerShell',
  bat: 'Batch',
  csharp: 'C#',
  cpp: 'C++',
  c: 'C',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  ruby: 'Ruby',
  php: 'PHP',
  lua: 'Lua',
  dockerfile: 'Dockerfile',
  ini: 'INI',
  diff: 'Diff',
  vue: 'Vue',
  svelte: 'Svelte'
}

export function languageName(id: string): string {
  return NAMES[id] ?? id
}
