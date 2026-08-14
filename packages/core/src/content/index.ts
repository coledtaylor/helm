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
export {
  CURATED_SKIPPED_DIRS,
  contentExtension,
  contentFileKind,
  contentScope,
  countsAsContent,
  readContentTree
} from './roots'
export {
  contentTreeRootLabel,
  readContentDir,
  type ReadContentDirOptions
} from './filetree'
export {
  WIKILINK_RE,
  buildWikiIndex,
  headingSlug,
  parseWikilink,
  resolveWikilink,
  type ParsedWikilink,
  type WikiIndex
} from './wikilinks'
export { renderMarkdown, type RenderMarkdownOptions } from './markdown'
export {
  DARK_THEME,
  LIGHT_THEME,
  ensureLanguage,
  highlightCode,
  normaliseLanguage
} from './highlight'
export {
  buildCorpus,
  corpusIsCurrent,
  searchCorpus,
  type ContentCorpus
} from './search'
export { assertContentWritable, restoreContentSnapshot, writeContentFile } from './write'
