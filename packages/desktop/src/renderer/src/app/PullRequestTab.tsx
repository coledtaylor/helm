import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import { PullRequestPane, type LaunchedReviewNote } from '@helm/ui'
import { renderPullPrompt, type EffortLevel, type PrCheckoutMode } from '@helm/core/types'
import type { LaunchedReview } from '../../../shared/ipc'
import { usePullDetail } from './usePullDetail'

/**
 * The pull-request pane, with a fetch behind it.
 *
 * A component of its own rather than a branch inside `App`, for the reason
 * `ProjectShellPane` is one: the state belongs to *this* pull request, so the
 * hook has to mount and unmount with the tab, and a hook called from `App`
 * would either be called conditionally or would have to hold every open tab's
 * answer at once. The review state below is here for the same reason - two open
 * pull request tabs are two independent launches.
 */

/** Electron prefixes a renderer-side rejection with the channel it came from. */
function readable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '')
}

export function PullRequestTab({
  repoPath,
  number,
  reviewTemplate,
  checkout,
  reviewModel,
  reviewEffort,
  onReview,
  onOpenExternal,
  compact
}: {
  repoPath: string
  number: number
  /** `prReviewPrompt`, for the disclosure sentence. Never sent anywhere. */
  reviewTemplate: string
  /** `prCheckout`, for the same sentence. */
  checkout: PrCheckoutMode
  /**
   * `prReviewModel` and `prReviewEffort`, for the same sentence again. Null for
   * either means the launch passes no flag, so the sentence says nothing about
   * it rather than naming a default Helm did not choose.
   */
  reviewModel: string | null
  reviewEffort: EffortLevel | null
  /**
   * Invokes `pr:review` and puts the session in the strip. `App`'s, not this
   * component's, because it is the pane element there that decides the grid and
   * the strip there that adopts - exactly as a resume works. Rejects with
   * whatever main refused with.
   */
  onReview: (repoPath: string, number: number) => Promise<LaunchedReview>
  onOpenExternal: (url: string) => void
  compact: boolean
}): JSX.Element {
  const detail = usePullDetail(repoPath, number)
  const [reviewing, setReviewing] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState<LaunchedReviewNote | null>(null)

  /**
   * What the button will run, rendered here for the sentence beside it.
   *
   * A preview and nothing more. `pr:review` carries `{repoPath, number, cols,
   * rows}` and the prompt that is actually launched is composed in the main
   * process from the same template and the same cached pull request - so this
   * is a second, independent rendering of the same inputs rather than the
   * source of the argv. When the two disagree, the argv is right and this is
   * the bug, which is exactly the direction that is safe.
   */
  const preview =
    detail.view === null
      ? ''
      : renderPullPrompt(reviewTemplate, {
          number: detail.view.summary.number,
          url: detail.view.summary.url,
          branch: detail.view.summary.headRefName,
          title: detail.view.summary.title,
          slug: detail.view.slug
        })

  const review = useCallback(() => {
    setReviewing(true)
    setReviewError(null)
    // The note is about the last launch from this tab, so a new attempt clears
    // it: "Started PR #42 review" sitting above the reason a second attempt was
    // refused reads as though the refusal happened to the session that is
    // running perfectly well in the strip.
    setReviewed(null)
    void onReview(repoPath, number)
      .then((launched) => {
        setReviewed({
          session: launched.session.name,
          prompt: launched.prompt,
          checkedOut: launched.checkedOut,
          warnings: launched.warnings
        })
      })
      .catch((err: unknown) => setReviewError(readable(err)))
      .finally(() => setReviewing(false))
  }, [onReview, repoPath, number])

  return (
    <PullRequestPane
      view={detail.view}
      loading={detail.loading}
      error={detail.error}
      onRefresh={detail.refresh}
      refreshing={detail.refreshing}
      onOpenExternal={onOpenExternal}
      compact={compact}
      onReview={review}
      reviewing={reviewing}
      reviewPrompt={preview}
      reviewCheckout={checkout === 'checkout'}
      reviewModel={reviewModel}
      reviewEffort={reviewEffort}
      reviewError={reviewError}
      onDismissReviewError={() => setReviewError(null)}
      reviewed={reviewed}
    />
  )
}
