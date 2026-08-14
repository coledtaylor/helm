import type { ContentFileKind } from '@helm/core'
import { ArtifactIcon, CommandIcon, DocIcon, SlidersIcon } from '../components/icons'

/**
 * The glyph for a content kind, in one place.
 *
 * Both lists draw the same kinds and they have to agree: the curated list and
 * the file tree are two views of one disk, and a `.py` that is a chevron in one
 * and a page in the other reads as two different files.
 *
 * `source` is the chevron, because a script is a thing that runs rather than a
 * thing that is read - it is the one kind the pane gained in this split and the
 * one most worth telling apart at a glance. `text` and `binary` share the page:
 * a page is the honest glyph for "a file, and Helm has nothing more to say
 * about it", and a binary is already told apart by being greyed and by wearing
 * its extension.
 *
 * A table rather than a function, deliberately. A call that returns a component
 * reads as a component *factory* from inside a render, which is a real hazard
 * (a new type each render remounts the subtree) and which the lint rule cannot
 * tell from this. Indexing a constant map is unambiguous to both.
 */
export const CONTENT_KIND_ICON: Record<ContentFileKind, typeof DocIcon> = {
  markdown: DocIcon,
  html: ArtifactIcon,
  data: SlidersIcon,
  source: CommandIcon,
  text: DocIcon,
  binary: DocIcon
}
