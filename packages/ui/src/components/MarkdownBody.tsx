import type { JSX, MouseEvent } from 'react'
import { useLayoutEffect, useMemo, useRef } from 'react'
import type { RenderedMarkdown } from '@helm/core'
import { cn } from '../lib/cn'
import { ListIcon } from './icons'

/**
 * The rendered document.
 *
 * `dangerouslySetInnerHTML` is doing what it says, and the reason it is
 * acceptable is upstream: this string was produced by `rehype-sanitize` in the
 * main process over a schema that is GitHub's, and the renderer never evaluates
 * any of it. What the renderer *does* own is the click handling - a wikilink is
 * an `<a>` with a data attribute and no destination, so navigation happens here
 * or not at all.
 *
 * Shared by the content viewer and the config console, which is the whole
 * point: a `SKILL.md` is markdown by every rule this applies to a note, and a
 * second renderer in the console would be a second set of typography, a second
 * shiki wrapper and a second answer to "what does a table look like".
 *
 * What differs between the two is named rather than forked. A `.claude` tree is
 * not a vault, so the console passes no `onOpenPath` and a `[[wikilink]]` there
 * is inert; and `toc` is off where the pane is a column beside a list rather
 * than a page.
 */
export function MarkdownBody({
  path,
  rendered,
  stale = false,
  compact = false,
  toc: wantsToc = true,
  highlight = null,
  surface = 'content',
  gutter,
  onOpenPath,
  onOpenExternal
}: {
  path: string
  rendered: RenderedMarkdown | null
  stale?: boolean
  compact?: boolean
  /**
   * The horizontal gutter, as a class. Given where the pane above this has a
   * gutter of its own to line up with: a body four pixels to the right of the
   * title it belongs to reads as a rendering mistake, and four pixels is
   * exactly what `px-6` under a `px-5` header produces.
   */
  gutter?: string
  /** A contents column, where there is both something to list and room for it. */
  toc?: boolean
  /** A term to mark and scroll to - the search hit a document was opened from. */
  highlight?: string | null
  /** Which pane this is, so a driver can tell two rendered bodies apart. */
  surface?: 'content' | 'config'
  /** Omitted where `[[wikilinks]]` mean nothing, which makes them inert. */
  onOpenPath?: ((path: string, heading: string | null) => void) | undefined
  onOpenExternal: (url: string) => void
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const toc = useMemo(
    () =>
      wantsToc
        ? (rendered?.headings ?? []).filter((heading) => heading.depth >= 2 && heading.depth <= 3)
        : [],
    [rendered, wantsToc]
  )

  // Scroll back to the top when a different document arrives. Without this a
  // note opened from halfway down another one starts halfway down itself.
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [rendered?.html])

  /**
   * Marks the term the document was opened from, and scrolls to it.
   *
   * Done over text nodes rather than by rewriting the HTML: the string has
   * already been rendered, and a search-and-replace on markup would match
   * inside attributes and tag names. A TreeWalker sees only text.
   */
  useLayoutEffect(() => {
    const root = bodyRef.current
    if (!root || highlight === null) return
    const needle = highlight.trim().toLowerCase()
    if (needle.length < 2) return

    const walker = window.document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const targets: Text[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue ?? ''
      if (value.toLowerCase().includes(needle)) targets.push(node as Text)
      if (targets.length >= 200) break
    }

    let first: HTMLElement | null = null
    for (const node of targets) {
      const value = node.nodeValue ?? ''
      const fragment = window.document.createDocumentFragment()
      let at = 0
      for (;;) {
        const found = value.toLowerCase().indexOf(needle, at)
        if (found < 0) break
        if (found > at) fragment.append(value.slice(at, found))
        const mark = window.document.createElement('mark')
        mark.className = 'md-hit'
        mark.textContent = value.slice(found, found + needle.length)
        fragment.append(mark)
        first ??= mark
        at = found + needle.length
      }
      if (at < value.length) fragment.append(value.slice(at))
      node.replaceWith(fragment)
    }
    first?.scrollIntoView({ block: 'center' })
  }, [rendered?.html, highlight])

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    const anchor = target?.closest('a')
    if (!anchor) return

    const linked = anchor.getAttribute('data-wikilink-path')
    if (linked !== null) {
      event.preventDefault()
      if (onOpenPath) onOpenPath(linked, anchor.getAttribute('data-wikilink-heading'))
      return
    }
    if (anchor.hasAttribute('data-wikilink-broken')) {
      // Nothing to open. The styling has already said so; following it would
      // either do nothing silently or create a file nobody asked for.
      event.preventDefault()
      return
    }

    const href = anchor.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      event.preventDefault()
      const slug = href.slice(1).toLowerCase()
      const heading = bodyRef.current?.querySelector(`[data-heading="${CSS.escape(slug)}"]`)
      heading?.scrollIntoView({ block: 'start' })
      return
    }
    if (/^https?:|^mailto:/i.test(href)) {
      event.preventDefault()
      onOpenExternal(href)
    }
  }

  if (rendered === null) {
    return (
      <div className="min-w-0 flex-1 px-8 py-6">
        <p className="text-[12px] text-fg-subtle">Rendering&hellip;</p>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      data-content-scroll
      className="min-w-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div className={cn('flex gap-8 py-6', gutter ?? (compact ? 'px-6' : 'px-8'))}>
        <div
          ref={bodyRef}
          data-content-body
          data-markdown-surface={surface}
          // The path the painted HTML belongs to. A driver clicking through a
          // hundred notes has to know the body it is reading is the one it
          // asked for and not the one still on screen from the click before.
          data-content-path={path}
          onClick={onClick}
          className={cn('markdown min-w-0 flex-1 select-text', stale && 'opacity-70 transition-opacity')}
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />

        {/* A contents column, but only when there is both something to list and
            room to list it. Below 1280px the pane is narrow enough that the
            measure and a sidebar cannot both have their width. */}
        {toc.length >= 3 && !compact && (
          <nav
            aria-label="Contents"
            data-content-toc={toc.length}
            // Bounded and scrollable: a fifty-section document has a contents
            // list taller than the window, and a `sticky` element taller than
            // its viewport stops being sticky.
            className="sticky top-6 hidden h-fit max-h-[calc(100vh-11rem)] w-52 shrink-0 overflow-y-auto overscroll-contain xl:block"
          >
            <p className="flex items-center gap-1.5 bg-surface pb-1.5 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
              <ListIcon width={10} height={10} />
              Contents
            </p>
            <ol className="space-y-0.5 border-l border-border">
              {toc.map((heading) => (
                <li key={heading.slug}>
                  <button
                    type="button"
                    onClick={() =>
                      bodyRef.current
                        ?.querySelector(`[data-heading="${CSS.escape(heading.slug)}"]`)
                        ?.scrollIntoView({ block: 'start' })
                    }
                    className={cn(
                      '-ml-px block w-full truncate border-l border-transparent py-0.5 text-left',
                      'text-[11px] text-fg-subtle transition-colors hover:border-accent hover:text-fg',
                      heading.depth === 2 ? 'pl-2.5' : 'pl-5'
                    )}
                    title={heading.text}
                  >
                    {heading.text}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
      </div>
    </div>
  )
}

/**
 * The frontmatter, as a header rather than as the first eight lines of the file.
 *
 * Shared for the same reason the body is. In a note `type`, `date` and `tags`
 * are what it is filed under; in a `SKILL.md` `description` is the field that
 * decides whether the skill is ever selected. Both are the same thing - the
 * metadata a reader needs without scrolling - and neither should ever be raw
 * YAML on screen.
 */
export function FrontmatterChips({
  fields,
  count
}: {
  fields: RenderedMarkdown['frontmatter']['fields']
  /** Overrides the count a driver reads, where a pane shows a subset. */
  count?: number
}): JSX.Element | null {
  if (fields.length === 0) return null
  return (
    <div
      data-frontmatter-chips={count ?? fields.length}
      className="flex flex-wrap items-center gap-1.5"
    >
      {fields.map((chip) =>
        chip.key === 'tags' ? (
          chip.values.map((value) => (
            <span
              key={`tag-${value}`}
              data-chip="tags"
              className="rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] text-accent-text"
            >
              #{value}
            </span>
          ))
        ) : (
          <span
            key={chip.key}
            data-chip={chip.key}
            title={`${chip.key}: ${chip.value}`}
            className="flex max-w-[22rem] items-baseline gap-1.5 rounded-full border border-border px-2 py-0.5"
          >
            <span className="shrink-0 text-[9.5px] tracking-wide text-fg-subtle uppercase">
              {chip.key}
            </span>
            <span className="min-w-0 truncate text-[10.5px] text-fg-muted">{chip.value}</span>
          </span>
        )
      )}
    </div>
  )
}
