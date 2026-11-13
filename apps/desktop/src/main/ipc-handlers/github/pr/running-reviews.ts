/**
 * Which PR reviews are running (or waiting for CI) in this process, so one can be cancelled
 * and a second one for the same PR is not started. Moved from pr-handlers.ts.
 */

/**
 * Sentinel value indicating a review is waiting for CI checks to complete.
 * Used as a placeholder in runningReviews before the actual process is spawned.
 */
export const CI_WAIT_PLACEHOLDER = Symbol("CI_WAIT_PLACEHOLDER");

export type CIWaitPlaceholder = typeof CI_WAIT_PLACEHOLDER;

/**
 * Registry of running PR review abort controllers
 * Key format: `${projectId}:${prNumber}`
 * Value can be:
 * - AbortController: actual running review (used to cancel)
 * - CI_WAIT_PLACEHOLDER: review is waiting for CI checks to complete
 */
export const runningReviews = new Map<string, AbortController | CIWaitPlaceholder>();

/**
 * Registry of abort controllers for CI wait cancellation
 * Key format: `${projectId}:${prNumber}`
 */
export const ciWaitAbortControllers = new Map<string, AbortController>();

/**
 * Get the registry key for a PR review
 */
export function getReviewKey(projectId: string, prNumber: number): string {
  return `${projectId}:${prNumber}`;
}
