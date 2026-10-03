import type { ContentDocument, ContentFile, RenderedMarkdown } from '@helm/core'

/**
 * What `content:document` answers, built by hand for the window's tests: the
 * renderer only reads these fields back, so a real render would be a markdown
 * pipeline under test that is not the one being tested.
 */

export function contentFile(path: string, relPath: string, kind: ContentFile['kind'] = 'markdown'): ContentFile {
  const name = relPath.split('/').at(-1) ?? relPath
  return {
    path,
    relPath,
    root: '',
    rootKind: 'found',
    kind,
    slug: name.replace(/\.[^.]+$/, ''),
    ext: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '',
    title: name,
    size: 0,
    mtimeMs: 0,
    noteType: null,
    date: null,
    tags: []
  }
}

export function rendered(html: string): RenderedMarkdown {
  return {
    html,
    frontmatter: { present: false, fields: [], raw: '', error: null, endLine: 0 },
    headings: [],
    links: [],
    tags: [],
    words: html.split(/\s+/).filter(Boolean).length,
    counts: {
      tables: 0,
      taskItems: 0,
      taskItemsChecked: 0,
      codeBlocks: 0,
      highlightedBlocks: 0,
      callouts: 0,
      wikilinks: 0,
      brokenWikilinks: 0,
      tags: 0,
      headings: 0
    },
    unknownLanguages: [],
    tookMs: 1
  }
}

/** A note on disk with `content`, hashed as `hash`, rendered as `html`. */
export function noteDocument(path: string, relPath: string, content: string, hash: string, html = `<p>${content}</p>`): ContentDocument {
  return {
    file: contentFile(path, relPath),
    content: { path, exists: true, content, hash, size: content.length, mtimeMs: 0, binary: false },
    rendered: rendered(html),
    error: null
  }
}
