/**
 * The opening prompt a review session is launched with.
 *
 * A template with `{placeholder}` holes rather than a fixed sentence, because
 * what "review this" means is the user's business and not Helm's: the default
 * runs Claude Code's own `/code-review` skill, and somebody whose team has its
 * own review command should be able to name it without a build of their own.
 *
 * Pure by construction, like `github/types.ts` and for the same reason - the
 * detail pane renders the same template to show what the button will run, so
 * this has to be importable from `@helm/core/types`. That the window and the
 * main process render it *separately* is deliberate rather than duplicated
 * work: the prompt that is actually launched is composed in main from the
 * cached pull request (see `pulls.ts`), and the window only ever renders a
 * preview of it. Nothing typed in the window reaches argv.
 */

/** What a template may name. The pull request, as the launcher knows it. */
export interface PullPromptFacts {
  number: number
  url: string
  /**
   * `headRefName` - the branch the pull request was opened *from*.
   *
   * Worth knowing before a template uses it: on a fork's pull request that
   * branch does not exist in the local checkout at all unless `prCheckout` is
   * on, so a prompt built around it is a prompt about something the session
   * cannot see. The default template uses only `{number}`, which `gh` resolves
   * against the remote.
   */
  branch: string
  title: string
  /** `owner/name`. */
  slug: string
}

/** The names a template may put in braces. Anything else is left alone. */
export const PR_PROMPT_PLACEHOLDERS = ['number', 'url', 'branch', 'title', 'slug'] as const

export type PullPromptPlaceholder = (typeof PR_PROMPT_PLACEHOLDERS)[number]

/**
 * The template a fresh install reviews with.
 *
 * `/code-review` is Claude Code's built-in skill, so the out-of-the-box
 * behaviour needs nothing installed and nothing configured. Only `{number}` is
 * in it on purpose - it is the one fact that is true whether or not the branch
 * exists locally.
 */
export const DEFAULT_PR_REVIEW_PROMPT = '/code-review {number}'

/**
 * A ceiling on the template, checked where it is saved.
 *
 * This ends up as one positional argument on a command line, and a command
 * line on Windows is capped at 32767 characters for all of it together. Two
 * thousand is far under that and far over any prompt anybody types into a
 * one-line field, which makes it a guard against a paste accident rather than
 * a limit anyone will meet.
 */
export const PR_REVIEW_PROMPT_MAX_LENGTH = 2000

/**
 * `{number}` becomes 42; everything else is left exactly as written.
 *
 * Three rules, and each of them is a decision:
 *
 * A name this does not know - `{author}`, or a typo for one it does - survives
 * into the prompt unchanged. Deleting it would make a misspelling invisible:
 * the session would start, the prompt would read a word short, and nothing
 * would ever say why. Left in place, the mistake is on screen in the pane's own
 * disclosure sentence before the button is ever pressed.
 *
 * One pass, so a substituted value is never rescanned. Pull request titles
 * contain braces often enough to matter - a title reading `{number} is wrong`
 * would otherwise expand a second time - and a template is a thing the user
 * wrote while a title is a thing a stranger wrote.
 *
 * Whitespace inside a value is collapsed to single spaces. The result is one
 * argument in an argv, and a newline arriving from a title would put a line
 * break into the CLI's opening message.
 */
export function renderPullPrompt(template: string, facts: PullPromptFacts): string {
  const values: Record<PullPromptPlaceholder, string> = {
    number: String(facts.number),
    url: facts.url,
    branch: facts.branch,
    title: facts.title,
    slug: facts.slug
  }

  return template.replace(/\{([a-z]+)\}/gi, (whole, name: string) => {
    const key = name.toLowerCase()
    return isPlaceholder(key) ? oneLine(values[key]) : whole
  })
}

function isPlaceholder(name: string): name is PullPromptPlaceholder {
  return (PR_PROMPT_PLACEHOLDERS as readonly string[]).includes(name)
}

/** Control characters out, runs of whitespace down to one space, ends trimmed. */
function oneLine(value: string): string {
  return value
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
