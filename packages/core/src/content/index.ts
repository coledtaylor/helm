/**
 * The content viewer's headless half: finding readable files in a scope,
 * rendering markdown the way this vault writes it, searching it, and saving an
 * edit through the config console's snapshot mechanism.
 */

export {
  frontmatterString,
  frontmatterTags,
  parseNoteFrontmatter,
  type ParsedFrontmatter
} from './frontmatter'
export { contentFileKind, contentScope, readContentTree } from './roots'
export {
  buildWikiIndex,
  headingSlug,
  parseWikilink,
  resolveWikilink,
  type ParsedWikilink,
  type WikiIndex
} from './wikilinks'
export { renderMarkdown, type RenderMarkdownOptions } from './markdown'
export { DARK_THEME, LIGHT_THEME, ensureLanguage, normaliseLanguage } from './highlight'
export {
  buildCorpus,
  corpusIsCurrent,
  searchCorpus,
  type ContentCorpus
} from './search'
export { assertContentWritable, restoreContentSnapshot, writeContentFile } from './write'
