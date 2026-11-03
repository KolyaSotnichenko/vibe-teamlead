/**
 * Rate limit detection utility for Claude CLI/SDK calls.
 * Detects rate limit errors in stdout/stderr output and provides context.
 */

import type { SDKRateLimitInfo } from '../shared/types';

export type { SDKRateLimitInfo };


/**
 * Regex pattern to detect Claude Code rate limit messages
 * Matches: "Limit reached · resets Dec 17 at 6am (Europe/Oslo)"
 */
const RATE_LIMIT_PATTERN = /Limit reached\s*[·•]\s*resets\s+(.+?)(?:\s*$|\n)/im;

/**
 * Additional patterns that might indicate rate limiting
 */
const RATE_LIMIT_INDICATORS = [
  /rate\s*limit/i,
  /usage\s*limit/i,
  /limit\s*reached/i,
  /exceeded.*limit/i,
  /too\s*many\s*requests/i,
];

/**
 * Patterns that indicate authentication failures
 * These patterns detect when Claude CLI/SDK fails due to missing or invalid auth
 *
 * IMPORTANT: These patterns must be specific enough to NOT match on AI response
 * content that discusses authentication topics (e.g., PRs about auth features).
 * The patterns should only match actual API error messages.
 */
const AUTH_FAILURE_PATTERNS = [
  // Match Claude API authentication_error type in JSON responses (most reliable)
  /["']?type["']?\s*:\s*["']?authentication_error["']?/i,
  // Match plain "API Error: 401" - this is a structured error format
  /API\s*Error:\s*401/i,
  // Match "OAuth token has expired" format from Claude API (specific phrasing)
  /oauth\s*token\s+has\s+expired/i,
  // Match "Please obtain a new token" or "refresh your existing token" - API specific
  /please\s+(obtain\s+a\s+new|refresh\s+your)\s+(existing\s+)?token/i,
  // Match Claude CLI specific auth messages (with context markers)
  /\[.*\]\s*authentication\s*(is\s*)?required/i,
  /\[.*\]\s*not\s*(yet\s*)?authenticated/i,
  /\[.*\]\s*login\s*(is\s*)?required/i,
  // Match 401 status codes in structured error output
  /status[:\s]+401/i,
  /HTTP\s*401/i,
  // Match specific error prefixes that indicate actual errors (not AI discussion)
  /Error:\s*.*(?:unauthorized|authentication|invalid\s*token)/i,
  // Match · Please run /login format from Claude CLI
  /·\s*Please\s+run\s+\/login/i,
];

/**
 * Patterns that indicate billing/credit failures
 * These patterns detect when Claude API fails due to insufficient credits or billing issues
 */
const BILLING_FAILURE_PATTERNS = [
  // Credit balance patterns
  /credit\s*balance\s*(is\s+)?(too\s+)?(insufficient|low|empty|zero|exhausted)/i,
  /insufficient\s*credit(s)?/i,
  /no\s*(remaining\s*)?credit(s)?/i,
  /credit(s)?\s*(are\s*)?(exhausted|depleted|used\s*up)/i,
  /out\s*of\s*credit(s)?/i,
  /credit\s*limit\s*(reached|exceeded)/i,
  // Billing error patterns
  /billing\s*(error|issue|problem|failure)/i,
  /payment\s*(required|failed|issue|problem)/i,
  /subscription\s*(expired|inactive|cancelled|canceled)/i,
  /account\s*(suspended|inactive)\s*(due\s*to\s*billing)?/i,
  // Usage limit patterns (billing-related, not rate limits)
  /usage\s*quota\s*(exceeded|reached)/i,
  /monthly\s*(usage\s*)?(limit|quota)\s*(exceeded|reached)/i,
  /plan\s*(limit|quota)\s*(exceeded|reached)/i,
  // API error patterns for billing
  /["']?type["']?\s*:\s*["']?billing_error["']?/i,
  /["']?type["']?\s*:\s*["']?insufficient_credits["']?/i,
  /["']?error["']?\s*:\s*["']?insufficient_credits["']?/i,
  // extra_usage patterns from Claude API
  /extra_usage\s*(exceeded|limit|error)?/i,
  // Match HTTP 402 Payment Required (require context to avoid false positives on "line 402" etc.)
  /(?:HTTP|status|code|error)\s*:?\s*402\b/i,
  /\b402\s+payment\s+required/i,
  /API\s*Error:\s*402/i,
  // Balance/funds patterns
  /insufficient\s*(funds|balance)/i,
  /balance\s*(is\s*)?(zero|empty|insufficient)/i,
  // Add funds/credits messages
  /please\s*(add|purchase)\s*(more\s*)?(credits?|funds)/i,
  /top\s*up\s*(your\s*)?(account|credits|balance)/i
];

/**
 * Maximum length for error messages sent to renderer.
 * Truncates to prevent exposing excessive internal details.
 */
const MAX_ERROR_LENGTH = 500;

/**
 * Sanitize error output before sending to renderer.
 * Truncates long output to prevent exposing excessive internal details
 * like full paths, API responses, or stack traces.
 */
function sanitizeErrorOutput(output: string): string {
  // Truncate long output to limit exposure of internal details
  if (output.length > MAX_ERROR_LENGTH) {
    return output.substring(0, MAX_ERROR_LENGTH) + '... (truncated)';
  }
  return output;
}

/**
 * Result of rate limit detection
 */
export interface RateLimitDetectionResult {
  /** Whether a rate limit was detected */
  isRateLimited: boolean;
  /** The reset time string if detected (e.g., "Dec 17 at 6am (Europe/Oslo)") */
  resetTime?: string;
  /** Type of limit: 'session' (5-hour) or 'weekly' (7-day) */
  limitType?: 'session' | 'weekly';
  /** Original error message (truncated to 500 chars for security) */
  originalError?: string;
}

/**
 * Result of authentication failure detection
 */
export interface AuthFailureDetectionResult {
  /** Whether an authentication failure was detected */
  isAuthFailure: boolean;
  /** The type of auth failure detected */
  failureType?: 'missing' | 'invalid' | 'expired' | 'unknown';
  /** User-friendly message describing the failure */
  message?: string;
  /** Original error message from the process output */
  originalError?: string;
}

/**
 * Result of billing failure detection
 */
export interface BillingFailureDetectionResult {
  /** Whether a billing failure was detected */
  isBillingFailure: boolean;
  /** The type of billing failure detected */
  failureType?: 'insufficient_credits' | 'payment_required' | 'subscription_inactive' | 'unknown';
  /** User-friendly message describing the failure */
  message?: string;
  /** Original error message from the process output */
  originalError?: string;
}

/**
 * Classify rate limit type based on reset time string
 */
function classifyLimitType(resetTimeStr: string): 'session' | 'weekly' {
  // Weekly limits mention specific dates like "Dec 17" or "Nov 1"
  // Session limits are typically just times like "11:59pm"
  const hasDate = /[A-Za-z]{3}\s+\d+/i.test(resetTimeStr);
  const hasWeeklyIndicator = resetTimeStr.toLowerCase().includes('week');

  return (hasDate || hasWeeklyIndicator) ? 'weekly' : 'session';
}

/**
 * Detect rate limit from output (stdout + stderr combined)
 */
export function detectRateLimit(output: string): RateLimitDetectionResult {
  const match = output.match(RATE_LIMIT_PATTERN);
  if (match) {
    const resetTime = match[1].trim();
    return {
      isRateLimited: true,
      resetTime,
      limitType: classifyLimitType(resetTime),
      originalError: sanitizeErrorOutput(output)
    };
  }

  for (const pattern of RATE_LIMIT_INDICATORS) {
    if (pattern.test(output)) {
      return { isRateLimited: true, originalError: sanitizeErrorOutput(output) };
    }
  }

  return { isRateLimited: false };
}

/**
 * Check if output contains rate limit error
 */
export function isRateLimitError(output: string): boolean {
  return detectRateLimit(output).isRateLimited;
}

/**
 * Extract reset time from rate limit message
 */
export function extractResetTime(output: string): string | null {
  const match = output.match(RATE_LIMIT_PATTERN);
  return match ? match[1].trim() : null;
}

/**
 * Classify the type of authentication failure based on the error message
 */
function classifyAuthFailureType(output: string): 'missing' | 'invalid' | 'expired' | 'unknown' {
  const lowerOutput = output.toLowerCase();

  if (/missing|not\s*(yet\s*)?authenticated|required/.test(lowerOutput)) {
    return 'missing';
  }
  // Check for expired tokens - includes "has expired", "obtain a new token", etc.
  if (/expired|session\s*expired|obtain\s*(a\s*)?new\s*token|refresh\s*(your\s*)?(existing\s*)?token/.test(lowerOutput)) {
    return 'expired';
  }
  // Check for invalid auth - includes 401, authentication_error, unauthorized
  if (/invalid|unauthorized|denied|401|authentication_error/.test(lowerOutput)) {
    return 'invalid';
  }
  return 'unknown';
}

/**
 * Get a user-friendly message for the authentication failure
 */
function getAuthFailureMessage(failureType: 'missing' | 'invalid' | 'expired' | 'unknown'): string {
  switch (failureType) {
    case 'missing':
      return 'Claude authentication required. Add an Anthropic API key in Settings > Claude.';
    case 'expired':
      return 'Your Claude session has expired. Update your key in Settings > Claude.';
    case 'invalid':
      return 'Invalid Claude credentials. Check your API key in Settings > Claude.';
    default:
      return 'Claude authentication failed. Check your API key in Settings > Claude.';
  }
}

/**
 * Classify the type of billing failure based on the error message
 */
function classifyBillingFailureType(output: string): 'insufficient_credits' | 'payment_required' | 'subscription_inactive' | 'unknown' {
  const lowerOutput = output.toLowerCase();

  // Check for credit-related failures (including extra_usage which indicates usage exhaustion)
  if (/credit\s*(balance|s)?|insufficient\s*(credit|funds|balance)|out\s*of\s*credit|no\s*(remaining\s*)?credit|extra_usage/.test(lowerOutput)) {
    return 'insufficient_credits';
  }
  // Check for subscription-related failures
  if (/subscription\s*(expired|inactive|cancelled|canceled)|account\s*(suspended|inactive)/.test(lowerOutput)) {
    return 'subscription_inactive';
  }
  // Check for payment-related failures
  if (/payment\s*(required|failed)|402|billing\s*(error|issue|problem|failure)/.test(lowerOutput)) {
    return 'payment_required';
  }
  return 'unknown';
}

/**
 * Get a user-friendly message for the billing failure
 */
function getBillingFailureMessage(failureType: 'insufficient_credits' | 'payment_required' | 'subscription_inactive' | 'unknown'): string {
  switch (failureType) {
    case 'insufficient_credits':
      return 'Your Claude API credit balance is too low. Please add credits to your account.';
    case 'payment_required':
      return 'A billing error occurred with your Claude API account. Please check your payment method.';
    case 'subscription_inactive':
      return 'Your Claude API subscription is inactive or expired. Please renew your subscription.';
    default:
      return 'A billing issue was detected with your Claude API account. Please check your account status.';
  }
}

/**
 * Detect authentication failure from output (stdout + stderr combined)
 */
export function detectAuthFailure(output: string): AuthFailureDetectionResult {
  // Rate limits are handled separately
  if (detectRateLimit(output).isRateLimited) {
    return { isAuthFailure: false };
  }

  for (const pattern of AUTH_FAILURE_PATTERNS) {
    if (pattern.test(output)) {
      const failureType = classifyAuthFailureType(output);
      return {
        isAuthFailure: true,
        failureType,
        message: getAuthFailureMessage(failureType),
        originalError: sanitizeErrorOutput(output)
      };
    }
  }

  return { isAuthFailure: false };
}

/**
 * Check if output contains authentication failure error
 */
export function isAuthFailureError(output: string): boolean {
  return detectAuthFailure(output).isAuthFailure;
}

/**
 * Detect billing failure from output (stdout + stderr combined)
 */
export function detectBillingFailure(output: string): BillingFailureDetectionResult {
  // Rate limits and auth errors are handled separately
  if (detectRateLimit(output).isRateLimited || detectAuthFailure(output).isAuthFailure) {
    return { isBillingFailure: false };
  }

  for (const pattern of BILLING_FAILURE_PATTERNS) {
    if (pattern.test(output)) {
      const failureType = classifyBillingFailureType(output);
      return {
        isBillingFailure: true,
        failureType,
        message: getBillingFailureMessage(failureType),
        originalError: sanitizeErrorOutput(output)
      };
    }
  }

  return { isBillingFailure: false };
}

/**
 * Check if output contains billing failure error
 */
export function isBillingFailureError(output: string): boolean {
  return detectBillingFailure(output).isBillingFailure;
}

/**
 * Create SDK rate limit info object for emitting to UI
 */
export function createSDKRateLimitInfo(
  source: SDKRateLimitInfo['source'],
  detection: RateLimitDetectionResult,
  options?: {
    projectId?: string;
    taskId?: string;
  }
): SDKRateLimitInfo {
  return {
    source,
    projectId: options?.projectId,
    taskId: options?.taskId,
    resetTime: detection.resetTime,
    limitType: detection.limitType,
    detectedAt: new Date(),
    originalError: detection.originalError
  };
}
