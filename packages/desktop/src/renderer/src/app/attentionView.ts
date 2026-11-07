import type { StandingNotice } from '@helm/core/types'
import type { AwayRowView, TreeNotice } from '@helm/ui'
import type { NeedsYouToastView } from './needsYou'

/**
 * What the toast, While you were away and the limit notice say, from the
 * notices the host keeps. The wording lives here so the views only draw.
 */

/** The three things the host names a wait by, with their article; null for the agent's own words. */
function waitsOnPhrase(text: string): string | null {
  switch (text) {
    case 'permission prompt':
      return 'a permission prompt'
    case 'question':
      return 'a question'
    case 'sign-in':
      return 'a sign-in'
    default:
      return null
  }
}

/** What a wait is on, as a sentence: the kinds the host names, or the agent's own words. */
export function waitsOnSentence(text: string): string {
  const phrase = waitsOnPhrase(text)
  if (phrase !== null) return `It is waiting on ${phrase}.`
  return text.toLowerCase().startsWith('waiting') ? `It is ${text}.` : `It says: ${text}`
}

/** The toast's sentence: what the child waits on and who started it, which has been told of it too. */
export function toastDetail(toast: Pick<NeedsYouToastView, 'waitsOn' | 'startedBy'>): string {
  return `${waitsOnSentence(toast.waitsOn)} Started by ${toast.startedBy}, which has been told.`
}

/** The clock time a notice began, as the list says it ("03:12"). */
export function clockTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(at.getHours())}:${two(at.getMinutes())}`
}

/** What a standing notice is about, in a few words. */
export function awayTitle(notice: StandingNotice): string {
  switch (notice.kind) {
    case 'needs-you':
      return `${notice.childName ?? 'A session'} needs you`
    case 'limit':
      return `${notice.parentName} was refused a start`
    case 'error':
      return `${notice.childName ?? notice.parentName} ended in error`
  }
}

/** The sentence under it. */
export function awayDetail(notice: StandingNotice): string {
  if (notice.kind !== 'needs-you') return notice.text
  const phrase = waitsOnPhrase(notice.text)
  const what = phrase === null ? notice.text.replace(/\.$/, '') : `waiting on ${phrase}`
  const said = `${what.charAt(0).toUpperCase()}${what.slice(1)} since ${clockTime(notice.since)}`
  return `${said}. Started by ${notice.parentName}, which was told.`
}

export interface AwayActions {
  /** Peek: the child where it is on screen here, or its peek. */
  show: (childId: number) => void
  /** Open: the child as a tab. */
  open: (childId: number) => void
  dismiss: (id: string) => void
}

/** The While you were away rows for the notices standing when the connection opened. */
export function awayRows(away: readonly StandingNotice[], actions: AwayActions): AwayRowView[] {
  return away.map((notice) => {
    const childId = notice.childId
    return {
      key: `${notice.id}\n${notice.since}`,
      tone: notice.kind === 'error' ? 'danger' : 'needs',
      title: awayTitle(notice),
      detail: awayDetail(notice),
      actions:
        notice.kind === 'needs-you' && childId !== null
          ? [
              { label: 'Peek', onPress: () => actions.show(childId) },
              { label: 'Open', onPress: () => actions.open(childId) }
            ]
          : [{ label: 'Dismiss', onPress: () => actions.dismiss(notice.id) }]
    }
  })
}

/**
 * The limit notice each parent shows under its children: the newest refusal
 * standing for that parent, by the parent's row id. `keyOf` names a notice to
 * the tree's actions.
 */
export function limitNoticesByParent(
  notices: readonly StandingNotice[],
  keyOf: (notice: StandingNotice) => string
): Map<number, TreeNotice> {
  const newest = new Map<number, StandingNotice>()
  for (const notice of notices) {
    if (notice.kind !== 'limit') continue
    const held = newest.get(notice.parentId)
    if (held === undefined || held.since <= notice.since) newest.set(notice.parentId, notice)
  }
  return new Map(
    [...newest].map(([parent, notice]) => [
      parent,
      { key: keyOf(notice), text: notice.text, allowMore: notice.limit === 'starts' ? notice.allowMore : null }
    ])
  )
}
