/**
 * What to call a session, derived from the prompts it recorded.
 *
 * `history.jsonl` carries no summary. Measured on this machine on 2026-08-15:
 * 0 of 275 surviving transcripts hold a `"type":"summary"` record, and the
 * types that are there are `message`, `assistant`, `user`, `tool_use`,
 * `tool_result`, `text`, `thinking`, `mode` and `attachment`. So a name that
 * says what a session was about has to be *derived* by Helm - there is nothing
 * to borrow.
 *
 * The opening prompt was the previous answer and it fails in three measurable
 * ways. Over 1,011 sessions on this machine: 291 open with a bare slash
 * command (`/exit` 114, `/usage` 43, `/model` 23 - a command carries no
 * subject), 15 open with an empty submission, and 353 prompts are nothing but
 * an `[Image #1]` placeholder where the subject was a screenshot. Reading past
 * the opener to the first prompt that *says something* retitles 132 of the
 * 1,011 and leaves the rest alone.
 *
 * Everything here is pure: text in, text out, no clock and no filesystem. The
 * indexer stores a rank per prompt (`titleRank`) so the aggregate can pick a
 * session's title prompt in SQL, and `deriveSessionTitle` turns that one prompt
 * into the string a row shows. `sessionTitleFrom` is the same journey in one
 * call over a whole session, which is what the unit tests exercise and what any
 * caller holding the prompts in memory should use - the two share their
 * primitives so they cannot drift apart.
 */

/**
 * The cap, in characters, on a derived title.
 *
 * Measured off the pane rather than chosen from taste. In a 1280px window the
 * list is 38% of the workspace and a row leaves 327px for its title, which a
 * design-shot puts at 63 glyphs of 12px Inter. So a title of 60 characters plus
 * its ellipsis is one the row shows **whole** - and a title shown whole is one
 * whose truncation lands where this file put it, on a word boundary, instead of
 * wherever CSS `text-overflow` happened to clip. Dock the pane beside a session
 * and the browser's ellipsis takes over again; what this cap buys is that the
 * ordinary case never reaches for it.
 */
export const TITLE_MAX = 60

/**
 * The placeholders the CLI writes into `display` where an attachment was.
 *
 * `[Image #1]` and `[Pasted text #1 +142 lines]` are what a screenshot and a
 * paste look like in the history file - they are not what anybody typed, and a
 * title reading "What is causing this [Image #1]" spends a third of its width
 * saying so.
 */
const PLACEHOLDER = /\[(?:Image #\d+|Pasted text #\d+(?: \+\d+ lines?)?)\]/g
const IMAGE = /\[Image #\d+\]/
const PASTED = /\[Pasted text/

/** A leading slash command: `/usage`, `/spec:quick`, `/speckit.specify`. */
const COMMAND = /^\/[A-Za-z0-9][\w.:-]*/

/** `--research`, `-n`. An argument that is a switch, not a subject. */
const FLAG = /(^|\s)--?[A-Za-z][\w-]*/g

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The prompt with the attachment placeholders taken out, on one line. */
export function cleanPrompt(text: string): string {
  return collapse(text.replace(PLACEHOLDER, ' '))
}

/**
 * Does this read as a subject - two words or more that are actually words.
 *
 * Two rather than one, because the one-word case is `continue`, `yes`, `1` and
 * `helm`, none of which distinguishes a session from the next one. A session
 * whose every prompt is like that still gets that text as its title through the
 * fallback below; this only decides whether to keep looking.
 */
function saysSomething(cleaned: string): boolean {
  return cleaned.split(' ').filter((word) => /[A-Za-z]{2,}/.test(word)).length >= 2
}

/**
 * How usable a prompt is as a title. Lower is better.
 *
 *   0  it says something - prose, or a command whose arguments are prose
 *   1  legible but says nothing on its own - `/usage`, `ok`, `1`
 *   2  nothing survives it - empty, or only an attachment placeholder
 *
 * A command is judged on what follows it with its switches removed, which is
 * the line between `/spec:execute-phase 1` (117 of these on this machine, and
 * the `1` is a phase number, not a subject) and `/spec:quick when a user goes
 * to the admin page...`, which is the whole prompt. The command itself is kept
 * in the title either way: it says what kind of session this was, and dropping
 * it would show text nobody typed.
 *
 * Stored per prompt by the indexer, so `MIN(seq)` per rank picks a session's
 * title prompt in SQL instead of pulling 284 KB of prompt text into JavaScript
 * on every pass.
 */
export function titleRank(text: string): 0 | 1 | 2 {
  const cleaned = cleanPrompt(text)
  if (cleaned === '') return 2

  const command = COMMAND.exec(cleaned)
  if (command === null) return saysSomething(cleaned) ? 0 : 1

  const args = collapse(cleaned.slice(command[0].length).replace(FLAG, ' '))
  return saysSomething(args) ? 0 : 1
}

/**
 * Cut to `TITLE_MAX`, on a word boundary, with the ellipsis that says so.
 *
 * The boundary is only honoured when there is one worth honouring: a single
 * unbroken 200-character URL has no space in it, and backing up to the last one
 * would return a title of two words followed by an ellipsis. Half the cap is
 * where that trade turns over.
 */
function truncate(text: string): string {
  if (text.length <= TITLE_MAX) return text
  const cut = text.slice(0, TITLE_MAX)
  const space = cut.lastIndexOf(' ')
  const kept = space >= TITLE_MAX / 2 ? cut.slice(0, space) : cut
  return `${kept.replace(/[\s,.;:!?-]+$/, '')}…`
}

/**
 * A title, and whether anybody actually said it.
 *
 * The flag is the difference between a name and a stand-in, and the pane draws
 * them differently - a stand-in is not something to show in the same weight as
 * a sentence somebody wrote. It is never the empty string: a row with no title
 * is a row nothing can be said about, which is worse than a row that says there
 * was nothing to read.
 */
export interface SessionTitle {
  text: string
  /** True when no prompt survived cleaning and `text` is Helm's own words. */
  fallback: boolean
}

/** Helm's own words for a session that recorded nothing readable. */
function fallbackFor(raw: string): string {
  if (IMAGE.test(raw)) return 'Image only'
  if (PASTED.test(raw)) return 'Pasted text only'
  return 'No prompt recorded'
}

/** One prompt as a title: cleaned, truncated, and never empty. */
export function deriveSessionTitle(text: string | null | undefined): SessionTitle {
  const raw = text ?? ''
  const cleaned = cleanPrompt(raw)
  return cleaned === ''
    ? { text: fallbackFor(raw), fallback: true }
    : { text: truncate(cleaned), fallback: false }
}

/**
 * A whole session's prompts as a title.
 *
 * The first prompt that says something; failing that the first that is at least
 * legible; failing that the opener, which then produces a stand-in. The same
 * order the indexer expresses in SQL, written once here so a test can hold the
 * rule rather than the query.
 */
export function sessionTitleFrom(prompts: readonly string[]): SessionTitle {
  const ranked = prompts.map((text) => ({ text, rank: titleRank(text) }))
  const chosen =
    ranked.find((p) => p.rank === 0) ?? ranked.find((p) => p.rank === 1) ?? ranked[0]
  return deriveSessionTitle(chosen?.text ?? '')
}
