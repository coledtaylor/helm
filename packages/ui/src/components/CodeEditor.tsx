import type { ChangeEvent, CSSProperties, JSX, KeyboardEvent, ReactNode, RefObject } from 'react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { EditAction, EditorHighlight } from '@helm/core'
// Values, not types, so they come from `@helm/core/types` - the one entry point
// with no `node:` imports behind it (CLAUDE.md, hard rules).
import { caretAt, editorKeyAction, findMatchesIn, lineStarts, syntaxFor } from '@helm/core/types'
import { CaretIcon, CloseIcon, SearchIcon } from './icons'

/**
 * The one editor. Both of Helm's edit surfaces are this component.
 *
 * It is a `<textarea>` with a highlighted `<pre>` underneath it rather than a
 * code-editor framework, and SPEC records the four reasons and the condition
 * that decision is held under. The two that shape this file:
 *
 *   - **Glyphs never wait for colour.** The layer a person reads is rendered
 *     from the raw text, synchronously, on the same tick as the keystroke. The
 *     tokeniser runs in the main process behind a debounce, and when its answer
 *     comes back it replaces the markup of the lines it is still about. There
 *     is no file size at which pressing a key leaves the screen unchanged for a
 *     frame, and `--only=latency` is what says so.
 *   - **Every programmatic edit goes through `insertText`.** Tab, Enter,
 *     auto-close and pair-deletion all produce a patch that is applied over a
 *     selection with `execCommand`, never by assigning `.value`. Assigning is
 *     the obvious version and it silently empties Chromium's undo stack - the
 *     user presses Ctrl+Z after an auto-indent and gets a blank box. That
 *     failure is invisible until somebody hits it, so `data-editor-direct-writes`
 *     counts the times this had to fall back and the check requires it to be
 *     zero.
 *
 * ## The four boxes
 *
 * ```
 *   gutter | +- clip (overflow hidden) --------------------+
 *          | |  caret-line band        (translateY)        |
 *          | |  mirror    <pre>  whole file, transparent   |
 *          | |  highlight <pre>  a window, coloured        |
 *          | +- textarea  transparent text, real caret ----+
 * ```
 *
 * The **mirror** is the whole file as a single text node. It costs one layout
 * and no reconciliation, so it can hold a 5,000-line file at any size, and it
 * is what makes the window above it placeable: the coloured layer renders
 * `[start, end)` and is positioned at the mirror's own measurement of where
 * line `start` sits. Without it that offset could only be computed
 * analytically, which is exact when nothing wraps and guesswork when
 * everything does.
 *
 * It also carries the find matches, and that is not an economy - a match
 * painted by wrapping the actual characters in a `<mark>` is positioned by
 * *being* the text. Nothing is measured, so nothing can drift.
 *
 * The **highlight** layer is windowed above `WINDOW_THRESHOLD` lines and whole
 * below it, which is nearly every file in a `.claude` tree. Below the threshold
 * scrolling touches no React at all.
 */

/**
 * Above this many lines the coloured layer renders a window rather than the
 * whole file. Set above every file in a `.claude` tree this was measured
 * against, so the ordinary case pays nothing for the machinery.
 */
const WINDOW_THRESHOLD = 1200
/** Lines rendered either side of the viewport, so a flick of the wheel does
 *  not outrun the window before the next frame re-centres it. */
const WINDOW_MARGIN = 150
/**
 * How long after the last keystroke the tokeniser is asked.
 *
 * Short, because the whole budget is ~250 ms from typing stopping to colour
 * arriving and the round trip has to fit inside what is left. Not zero,
 * because a tokenise per keystroke is work the next keystroke throws away.
 */
const HIGHLIGHT_DEBOUNCE_MS = 110

export interface EditorStatus {
  language: string
  highlighted: boolean
  /** Past the highlighting ceiling: the text still edits, in one colour. */
  tooLarge: boolean
  lines: number
}

export interface CodeEditorHandle {
  focus: () => void
  /** Selects an absolute range and scrolls it into view. */
  select: (start: number, end: number) => void
}

export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  /**
   * Which surface this is, which decides the data attribute the textarea
   * carries. Ten check sites across `configcheck.ts` and `contentcheck.ts`
   * query `textarea[data-config-editor]` and `textarea[data-content-editor]`
   * and drive them through the value setter; both names survive here verbatim,
   * which is the second of SPEC's reasons for a textarea.
   */
  surface: 'config' | 'content'
  /** The file. Its extension decides the language, the indent and the pairs. */
  path: string
  ariaLabel: string
  /** Tokenises a draft. Null paints the text in one colour and nothing else. */
  onHighlight: ((path: string, source: string) => Promise<EditorHighlight>) | null
  wrap: boolean
  /** The JSON is not valid, so the island's edge says so. */
  invalid?: boolean
  onCaretChange?: ((caret: { line: number; column: number }) => void) | undefined
  onStatusChange?: ((status: EditorStatus) => void) | undefined
  ref?: RefObject<CodeEditorHandle | null>
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const escapeText = (text: string): string => text.replace(/[&<>]/g, (ch) => ESCAPES[ch] ?? ch)

/** What the tokeniser last said, and what it said it about. */
interface Coloured {
  /** The exact lines the markup below describes. */
  source: string[]
  lines: string[]
  language: string
  highlighted: boolean
  tooLarge: boolean
}

/** A line box, in pixels from the top of the layer stack. */
interface Row {
  index: number
  top: number
  height: number
}

const sameRows = (a: Row[], b: Row[]): boolean =>
  a.length === b.length &&
  a.every((row, i) => {
    const other = b[i]
    return other !== undefined && row.index === other.index && row.top === other.top && row.height === other.height
  })

export function CodeEditor({
  value,
  onChange,
  surface,
  path,
  ariaLabel,
  onHighlight,
  wrap,
  invalid = false,
  onCaretChange,
  onStatusChange,
  ref
}: CodeEditorProps): JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLPreElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const layersRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)

  const [coloured, setColoured] = useState<Coloured | null>(null)
  const [caret, setCaret] = useState({ line: 1, column: 1 })
  const [view, setView] = useState({ first: 0, last: 80 })
  const [rows, setRows] = useState<Row[]>([])
  const [caretBox, setCaretBox] = useState<{ top: number; height: number } | null>(null)
  const [find, setFind] = useState({ open: false, mode: 'find' as 'find' | 'line', query: '', at: 0 })
  const [directWrites, setDirectWrites] = useState(0)

  const syntax = useMemo(() => syntaxFor(path), [path])
  const lines = useMemo(() => value.split('\n'), [value])
  const starts = useMemo(() => lineStarts(value), [value])

  const windowed = lines.length > WINDOW_THRESHOLD
  const winStart = windowed ? Math.max(0, view.first - WINDOW_MARGIN) : 0
  const winEnd = windowed ? Math.min(lines.length, view.last + WINDOW_MARGIN) : lines.length

  // -------------------------------------------------------------------------
  // Colour
  // -------------------------------------------------------------------------

  /**
   * One tokenise in flight, and a stale answer is dropped.
   *
   * The counter is a ref rather than state because it is compared inside a
   * promise callback: a `useState` copy captured when the request went out is
   * the value *then*, which is exactly the comparison this has to avoid.
   */
  const revision = useRef(0)
  useEffect(() => {
    revision.current += 1
    const mine = revision.current
    if (onHighlight === null) return
    const timer = setTimeout(() => {
      const source = value
      void onHighlight(path, source)
        .then((out) => {
          if (revision.current !== mine) return
          setColoured({
            source: source.split('\n'),
            lines: out.lines,
            language: out.language,
            highlighted: out.highlighted,
            tooLarge: out.tooLarge
          })
        })
        .catch(() => {
          // A tokenise that failed leaves a document with no colour in it,
          // which is the state it was already in. Nothing to report, and
          // nothing that would make the text harder to read.
        })
    }, HIGHLIGHT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [value, path, onHighlight])

  /**
   * Which of the last answer's lines still describe the text on screen.
   *
   * A common prefix and a common suffix, which is the whole diff this needs: an
   * edit is one contiguous region, so everything above it and everything below
   * it is still the same source line and still correctly coloured. Typing on
   * line 40 of a 900-line file therefore leaves 899 lines coloured and turns
   * one of them plain until the tokeniser answers - rather than dropping the
   * colour of the whole document for 110 ms on every keypress.
   *
   * Indices rather than a map, because an insert shifts every line below it and
   * comparing `lines[i]` to `source[i]` would call all of them changed.
   */
  /**
   * Past the ceiling the overlay is taken away altogether.
   *
   * Not just the colour. A layer holding the whole file is a second full text
   * layout on every keystroke, and on a megabyte of wrapped prose that is the
   * frame going from milliseconds to most of a second - which is "getting
   * slow", and the criterion says *degrade*. So above the ceiling the textarea
   * paints its own glyphs and both layers render nothing: the line-number
   * gutter, the current-line band and match painting go with them, and the
   * footer says so. Typing, find and go-to-line all still work.
   *
   * Measured on this machine, typing into a 1.29 MB file: 1,920 ms to the frame
   * carrying the glyph with the overlay up, 8 ms with it gone.
   */
  const plain = coloured?.tooLarge === true

  const drift = useMemo(() => {
    if (coloured === null || coloured.tooLarge) return null
    const source = coloured.source
    const n = lines.length
    const m = source.length
    let head = 0
    while (head < n && head < m && lines[head] === source[head]) head += 1
    let tail = 0
    while (tail < n - head && tail < m - head && lines[n - 1 - tail] === source[m - 1 - tail]) {
      tail += 1
    }
    return { head, tail, n, m }
  }, [coloured, lines])

  const markup = useMemo(() => {
    if (plain) return '<code></code>'
    const parts: string[] = []
    for (let i = winStart; i < winEnd; i += 1) {
      let inner: string | null = null
      if (drift !== null) {
        const j = i < drift.head ? i : i >= drift.n - drift.tail ? drift.m - (drift.n - i) : -1
        if (j >= 0) inner = coloured?.lines[j] ?? null
      }
      parts.push(`<span class="line">${inner ?? escapeText(lines[i] ?? '')}</span>`)
    }
    return `<code>${parts.join('')}</code>`
  }, [coloured, drift, lines, winStart, winEnd, plain])

  // Held stable so React only re-applies the subtree when the markup actually
  // changed - the same rule the content viewer's source body follows, and for
  // the same reason: a rebuilt subtree is a fresh set of `.line` nodes, and
  // every measurement below would be of elements that no longer exist.
  const injected = useMemo(() => ({ __html: markup }), [markup])

  /** True when what is painted is what the tokeniser last said about *this*
   *  text. `--only=latency` polls it to time colour arriving. */
  const settled =
    coloured !== null && drift !== null && drift.head + drift.tail >= Math.max(drift.n, drift.m)

  /**
   * Told to the host, and only when it changed.
   *
   * Guarded rather than fired every render because the host reacts by setting
   * state, and a host that also passes an inline callback would otherwise have
   * built a render loop out of two correct-looking pieces.
   */
  const lastStatus = useRef('')
  useEffect(() => {
    const status: EditorStatus = {
      language: coloured?.language ?? 'plaintext',
      highlighted: coloured?.highlighted ?? false,
      tooLarge: coloured?.tooLarge ?? false,
      lines: lines.length
    }
    const key = `${status.language}|${String(status.highlighted)}|${String(status.tooLarge)}|${String(status.lines)}`
    if (lastStatus.current === key) return
    lastStatus.current = key
    onStatusChange?.(status)
  }, [coloured, lines.length, onStatusChange])

  const lastCaret = useRef('')
  useEffect(() => {
    const key = `${String(caret.line)}:${String(caret.column)}`
    if (lastCaret.current === key) return
    lastCaret.current = key
    onCaretChange?.(caret)
  }, [caret, onCaretChange])

  // -------------------------------------------------------------------------
  // Find, and go to line
  // -------------------------------------------------------------------------

  const matches = useMemo(
    () => (find.open && find.mode === 'find' ? findMatchesIn(value, find.query) : []),
    [find.open, find.mode, find.query, value]
  )

  /**
   * The mirror's children: the file, cut at every match.
   *
   * One text node when nothing is being searched for, which is the state it is
   * in while somebody types - so the whole-file layer costs one string
   * assignment per keystroke rather than a reconciliation. `offsetOfLine`
   * depends on that, and says so.
   */
  const mirrorNodes = useMemo((): ReactNode => {
    if (plain) return ''
    if (matches.length === 0) return value
    const out: JSX.Element[] = []
    const width = find.query.length
    let cursor = 0
    matches.forEach((at, index) => {
      if (at > cursor) out.push(<span key={`t${String(at)}`}>{value.slice(cursor, at)}</span>)
      out.push(
        <mark
          key={`m${String(at)}`}
          data-editor-match={index}
          data-editor-match-current={index === find.at}
        >
          {value.slice(at, at + width)}
        </mark>
      )
      cursor = at + width
    })
    if (cursor < value.length) out.push(<span key="tail">{value.slice(cursor)}</span>)
    return out
  }, [matches, value, find.query.length, find.at, plain])

  // -------------------------------------------------------------------------
  // Scrolling
  // -------------------------------------------------------------------------

  /**
   * The scroll sync, written straight onto three elements.
   *
   * By transform rather than by scrolling three boxes, because only one element
   * here can have a scrollbar and be driven by the wheel - and because a
   * transform is a compositor move where a scroll is a layout position that
   * three elements have to agree on within the same frame.
   *
   * Not through state: this runs on every scroll event, and a React render per
   * wheel tick is exactly the stutter it is avoiding.
   */
  const syncScroll = useCallback((): void => {
    const area = areaRef.current
    if (!area) return
    const x = String(-area.scrollLeft)
    const y = String(-area.scrollTop)
    if (layersRef.current) layersRef.current.style.transform = `translate(${x}px, ${y}px)`
    if (rowsRef.current) rowsRef.current.style.transform = `translateY(${y}px)`
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${y}px)`
  }, [])

  /** The line height as the browser resolved it, for the estimates that only
   *  have to be close - a scroll target, and which lines to window around. */
  const lineHeightOf = (area: HTMLTextAreaElement): number =>
    parseFloat(getComputedStyle(area).lineHeight) || 18

  const reveal = useCallback((start: number, end: number): void => {
    const area = areaRef.current
    if (!area) return
    area.focus()
    area.setSelectionRange(start, end)
    // Scrolling to a selection has no API, so this puts the line about a third
    // of the way down the box rather than at its very top - which is where a
    // person looking for it expects to find it.
    const before = area.value.slice(0, start).split('\n').length - 1
    area.scrollTop = Math.max(0, before * lineHeightOf(area) - area.clientHeight / 3)
    syncScroll()
  }, [syncScroll])

  // -------------------------------------------------------------------------
  // Applying an edit
  // -------------------------------------------------------------------------

  /**
   * The one route from a patch to the document.
   *
   * `setSelectionRange` then `insertText`, so Chromium records the change on
   * its own undo stack and Ctrl+Z gives back the state before it. React does
   * not fight this: the `input` event puts the same string into state that the
   * DOM already holds, so the controlled re-render finds `node.value` already
   * equal and writes nothing - and a write is what would clear the stack.
   */
  const apply = useCallback((area: HTMLTextAreaElement, action: EditAction): void => {
    if (action.kind === 'move') {
      area.setSelectionRange(action.selectionStart, action.selectionEnd)
      return
    }
    area.focus()
    if (action.kind === 'delete') {
      area.setSelectionRange(action.from, action.to)
      if (!document.execCommand('delete')) setDirectWrites((n) => n + 1)
      return
    }
    area.setSelectionRange(action.from, action.to)
    if (document.execCommand('insertText', false, action.text)) {
      area.setSelectionRange(action.selectionStart, action.selectionEnd)
      return
    }
    // Counted rather than hidden. This is the branch that would lose the undo
    // stack, so "it has not been taken" has to be a fact somebody can read
    // rather than a thing the code hopes.
    setDirectWrites((n) => n + 1)
  }, [])

  const readCaret = useCallback((): void => {
    const area = areaRef.current
    if (!area) return
    const at = caretAt(area.value, area.selectionStart)
    setCaret((previous) =>
      previous.line === at.line && previous.column === at.column ? previous : at
    )
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => areaRef.current?.focus(),
      select: (start: number, end: number) => {
        reveal(start, end)
        readCaret()
      }
    }),
    [reveal, readCaret]
  )

  const goToMatch = useCallback(
    (index: number): void => {
      if (matches.length === 0) return
      const wrapped = ((index % matches.length) + matches.length) % matches.length
      setFind((state) => ({ ...state, at: wrapped }))
      const at = matches[wrapped] ?? 0
      const area = areaRef.current
      if (!area) return
      // The caret goes to the match without taking focus off the find box: a
      // find that stole focus back on every Enter could not be pressed twice.
      area.setSelectionRange(at, at + find.query.length)
      const before = value.slice(0, at).split('\n').length - 1
      area.scrollTop = Math.max(0, before * lineHeightOf(area) - area.clientHeight / 3)
      syncScroll()
    },
    [matches, find.query.length, value, syncScroll]
  )

  const openFind = useCallback((mode: 'find' | 'line'): void => {
    setFind((state) => ({ ...state, open: true, mode, at: 0 }))
    // After the input exists. A ref read in this tick is still null.
    setTimeout(() => findInputRef.current?.select(), 0)
  }, [])

  const closeFind = useCallback((): void => {
    setFind((state) => ({ ...state, open: false }))
    areaRef.current?.focus()
  }, [])

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const area = areaRef.current
    if (!area) return
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase()
      if (key === 'f' && !event.shiftKey) {
        event.preventDefault()
        openFind('find')
      } else if (key === 'g' && !event.shiftKey) {
        event.preventDefault()
        openFind('line')
      }
      // Everything else with a modifier belongs to somebody else: Ctrl+Z is
      // Chromium's undo, Ctrl+Tab is the app's tab ring. Taking `Tab` below
      // without this guard would break the ring from inside the editor.
      return
    }
    if (event.altKey) return
    if (event.key === 'Escape' && find.open) {
      event.preventDefault()
      closeFind()
      return
    }
    const action = editorKeyAction(
      area.value,
      area.selectionStart,
      area.selectionEnd,
      event.key,
      event.shiftKey,
      syntax
    )
    if (action === null) return
    event.preventDefault()
    apply(area, action)
    readCaret()
  }

  const onChangeValue = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(event.target.value)
    readCaret()
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /**
   * The textarea's own content width, handed to the layers as a variable.
   *
   * A vertical scrollbar takes width out of the textarea and out of nothing
   * else. A layer sized to the container therefore wraps one column later than
   * the text does, and the two drift apart by a word per paragraph - visible
   * only on files long enough to scroll, which is to say on the files it
   * matters for.
   */
  useEffect(() => {
    const area = areaRef.current
    const root = area?.closest('.helm-editor')
    if (!area || !(root instanceof HTMLElement)) return
    const measure = (): void => {
      root.style.setProperty('--editor-view-width', `${String(area.clientWidth)}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    return () => observer.disconnect()
  }, [])

  /**
   * Where the window sits, and where every visible line sits inside it.
   *
   * One measurement is taken off the **mirror** - the top of the window's first
   * line - and everything else is read off the coloured layer's own `.line`
   * elements, which are laid out already and so are free to ask. That split is
   * what keeps this cheap: the expensive question ("where is line 3,000 when
   * everything wraps") is asked once per layout, and the cheap one is asked of
   * elements that exist.
   *
   * A layout effect rather than an effect, because the answer *positions* the
   * coloured layer. Measured after paint, the window would be one frame in the
   * wrong place every time it moved.
   */
  useLayoutEffect(() => {
    const layers = layersRef.current
    const mirror = mirrorRef.current
    const pre = highlightRef.current
    const area = areaRef.current
    if (!layers || !mirror || !pre || !area) return
    // Past the ceiling both layers render nothing, so the loop below finds no
    // line boxes, produces an empty gutter and no caret band, and costs
    // nothing. That falls out of the general path rather than needing a branch
    // of its own - which is the version that cannot drift from it.

    const base = layers.getBoundingClientRect().top
    const top =
      winStart === 0
        ? 0
        : (offsetOfLine(mirror, starts, lines, winStart) ??
          // The mirror could not answer - it has been cut up by a find, or the
          // line is empty and the collapsed range measured nothing. An even
          // line height is the estimate, and it is exact whenever nothing
          // wraps, which is the mode long files are usually read in.
          parseFloat(getComputedStyle(mirror).paddingTop) + winStart * lineHeightOf(area))
    pre.style.top = `${String(top)}px`

    const lineEls = pre.querySelectorAll<HTMLElement>('.line')
    const scrollTop = area.scrollTop
    const height = area.clientHeight
    const next: Row[] = []
    let firstVisible = -1
    let lastVisible = -1
    for (let k = 0; k < lineEls.length; k += 1) {
      const el = lineEls[k]
      if (!el) continue
      const rect = el.getBoundingClientRect()
      const rowTop = rect.top - base
      if (rowTop + rect.height < scrollTop || rowTop > scrollTop + height) continue
      if (firstVisible === -1) firstVisible = winStart + k
      lastVisible = winStart + k
      next.push({ index: winStart + k, top: rowTop, height: rect.height })
    }
    setRows((previous) => (sameRows(previous, next) ? previous : next))

    // The caret band, off the same elements. Absent when the caret's line is
    // outside the window, which is only reachable by scrolling a very long file
    // away from the caret - and a band drawn at a guessed position would be
    // worse than none.
    const caretEl = lineEls[caret.line - 1 - winStart]
    const box = caretEl
      ? {
          top: caretEl.getBoundingClientRect().top - base,
          height: caretEl.getBoundingClientRect().height
        }
      : null
    setCaretBox((previous) =>
      previous?.top === box?.top && previous?.height === box?.height ? previous : box
    )

    if (windowed && firstVisible !== -1) {
      setView((state) =>
        state.first === firstVisible && state.last === lastVisible
          ? state
          : { first: firstVisible, last: lastVisible }
      )
    }
    syncScroll()
  }, [markup, mirrorNodes, wrap, caret.line, winStart, windowed, starts, lines, syncScroll, plain])

  /**
   * Scrolling, when the file is long enough to be windowed.
   *
   * Below the threshold the whole file is already rendered and a scroll touches
   * no React at all - it is three transforms and nothing else, which is what
   * makes scrolling free for every file in a `.claude` tree. Above it, the
   * window is re-centred from an estimate; where it lands is still *measured*,
   * so a bad estimate costs margin rather than alignment.
   */
  const onScroll = (): void => {
    syncScroll()
    if (!windowed) return
    const area = areaRef.current
    if (!area) return
    const lineHeight = lineHeightOf(area)
    const first = Math.max(0, Math.floor(area.scrollTop / lineHeight))
    const last = Math.min(lines.length, Math.ceil((area.scrollTop + area.clientHeight) / lineHeight))
    if (first < winStart || last > winEnd) setView({ first, last })
  }

  // -------------------------------------------------------------------------

  const digits = String(lines.length).length
  const style = {
    '--editor-gutter-width': `${String(Math.max(2.75, digits * 0.62 + 1.4))}rem`
  } as CSSProperties

  return (
    <div
      data-editor
      data-editor-surface={surface}
      data-editor-wrap={wrap ? 'on' : 'off'}
      data-editor-lines={lines.length}
      data-editor-rendered={winEnd - winStart}
      data-editor-windowed={windowed}
      data-editor-language={coloured?.language ?? 'plaintext'}
      data-editor-highlighted={coloured?.highlighted ?? false}
      data-editor-too-large={coloured?.tooLarge ?? false}
      data-editor-plain={plain}
      data-editor-coloured={settled && (coloured?.highlighted ?? false)}
      data-editor-direct-writes={directWrites}
      data-editor-invalid={invalid}
      className="helm-editor"
      style={style}
    >
      <div className="helm-editor-gutter" data-editor-gutter>
        <div ref={gutterRef} className="helm-editor-gutter-rows">
          {rows.map((row) => (
            <span
              key={row.index}
              data-editor-line-number={row.index + 1}
              data-editor-current={row.index === caret.line - 1}
              className="helm-editor-number"
              style={{ top: `${String(row.top)}px` }}
            >
              {row.index + 1}
            </span>
          ))}
        </div>
      </div>

      <div className="helm-editor-body">
        <div className="helm-editor-clip">
          <div ref={rowsRef} className="helm-editor-rows">
            {caretBox !== null && (
              <div
                data-editor-caret-line
                className="helm-editor-caret-line"
                style={{ top: `${String(caretBox.top)}px`, height: `${String(caretBox.height)}px` }}
              />
            )}
          </div>
          <div ref={layersRef} className="helm-editor-layers">
            <pre
              ref={mirrorRef}
              data-editor-underlay
              aria-hidden
              className="helm-editor-layer helm-editor-mirror"
            >
              {mirrorNodes}
            </pre>
            <pre
              ref={highlightRef}
              data-editor-highlight
              aria-hidden
              className="helm-editor-layer helm-editor-highlight shiki"
              // Produced by shiki in the main process from bytes this window
              // already has; the renderer injects it and evaluates nothing in
              // it - the same argument the markdown body makes.
              dangerouslySetInnerHTML={injected}
            />
          </div>
        </div>

        <textarea
          ref={areaRef}
          {...(surface === 'config'
            ? { 'data-config-editor': true }
            : { 'data-content-editor': true })}
          value={value}
          onChange={onChangeValue}
          onKeyDown={onKeyDown}
          onKeyUp={readCaret}
          onClick={readCaret}
          onSelect={readCaret}
          onScroll={onScroll}
          spellCheck={false}
          wrap={wrap ? 'soft' : 'off'}
          aria-label={ariaLabel}
          className="helm-editor-layer helm-editor-input"
        />
      </div>

      {find.open && (
        <FindBar
          mode={find.mode}
          query={find.query}
          at={find.at}
          count={matches.length}
          lines={lines.length}
          inputRef={findInputRef}
          onQueryChange={(query) => setFind((state) => ({ ...state, query, at: 0 }))}
          onStep={(delta) => goToMatch(find.at + delta)}
          onGoToLine={(line) => {
            const index = Math.min(Math.max(1, line), lines.length) - 1
            const at = starts[index] ?? 0
            reveal(at, at)
            readCaret()
            closeFind()
          }}
          onClose={closeFind}
        />
      )}
    </div>
  )
}

/**
 * Where a line starts, in pixels, measured on the mirror.
 *
 * A `Range` over the one text node the mirror is made of, which is exact in
 * both wrap modes - the alternative is `index * lineHeight`, which is right
 * until a line wraps and then wrong by a row for every wrap above it.
 *
 * Returns null when the mirror is not a single text node, which is what a find
 * makes of it, and null for an empty line, whose collapsed range measures
 * nothing. Both fall back to the even-line-height estimate at the call site.
 */
function offsetOfLine(
  mirror: HTMLElement,
  starts: number[],
  lines: string[],
  index: number
): number | null {
  const node = mirror.firstChild
  const start = starts[index]
  if (node === null || node.nodeType !== Node.TEXT_NODE || start === undefined) return null
  const text = node as Text
  if (start > text.data.length) return null
  const range = document.createRange()
  range.setStart(text, start)
  range.setEnd(text, Math.min(start + (lines[index]?.length ?? 0), text.data.length))
  const rect = range.getBoundingClientRect()
  if (rect.height === 0) return null
  return rect.top - mirror.getBoundingClientRect().top
}

// ---------------------------------------------------------------------------

/**
 * Find, and go to line, in one strip.
 *
 * One control rather than two, because they are the same gesture - "take me to
 * a place in this file" - and two floating boxes fighting for the same corner
 * is worse than one that knows which question it was opened with.
 */
function FindBar({
  mode,
  query,
  at,
  count,
  lines,
  inputRef,
  onQueryChange,
  onStep,
  onGoToLine,
  onClose
}: {
  mode: 'find' | 'line'
  query: string
  at: number
  count: number
  lines: number
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange: (query: string) => void
  onStep: (delta: number) => void
  onGoToLine: (line: number) => void
  onClose: () => void
}): JSX.Element {
  const [line, setLine] = useState('')

  return (
    <div
      data-editor-find-bar={mode}
      className="helm-editor-find"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          return
        }
        if (event.key !== 'Enter') return
        event.preventDefault()
        if (mode === 'line') {
          const parsed = Number.parseInt(line, 10)
          if (Number.isFinite(parsed)) onGoToLine(parsed)
          return
        }
        onStep(event.shiftKey ? -1 : 1)
      }}
    >
      {mode === 'find' ? (
        <>
          <SearchIcon width={11} height={11} className="shrink-0 text-fg-subtle" />
          <input
            ref={inputRef}
            data-editor-find
            value={query}
            placeholder="Find"
            spellCheck={false}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <span
            data-editor-find-count={count}
            className="shrink-0 tabular-nums text-[10.5px] text-fg-subtle"
          >
            {query === '' ? '' : count === 0 ? 'No results' : `${String(at + 1)} of ${String(count)}`}
          </span>
          <button
            type="button"
            data-editor-find-prev
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            onClick={() => onStep(-1)}
            className="grid size-5 place-items-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <CaretIcon width={11} height={11} className="-rotate-90" />
          </button>
          <button
            type="button"
            data-editor-find-next
            aria-label="Next match"
            title="Next match (Enter)"
            onClick={() => onStep(1)}
            className="grid size-5 place-items-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <CaretIcon width={11} height={11} className="rotate-90" />
          </button>
        </>
      ) : (
        <>
          <span className="shrink-0 text-[10.5px] text-fg-subtle">Go to line</span>
          <input
            ref={inputRef}
            data-editor-goto
            value={line}
            inputMode="numeric"
            placeholder={`1-${String(lines)}`}
            onChange={(event) => setLine(event.target.value.replace(/[^0-9]/g, ''))}
          />
        </>
      )}
      <button
        type="button"
        data-editor-find-close
        aria-label="Close"
        title="Close (Escape)"
        onClick={onClose}
        className="grid size-5 place-items-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        <CloseIcon width={11} height={11} />
      </button>
    </div>
  )
}
