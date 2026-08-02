/**
 * Provider error handling for auto-resume.
 *
 * A turn that died on a provider 429 ends like any other turn, so the default
 * settle-window resume fires straight back into the cooldown. Parse the wait
 * out of the error and delay the resume past it; for errors that are not
 * transient, don't resume at all — replaying them just burns the loop.
 */

/** Used when the provider says "rate limited" without saying for how long. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 30 * 60_000;
/** Added to every wait — provider clocks and ours don't agree. */
const BUFFER_MS = 60_000;

interface AssistantMessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: unknown;
}

const RATE_LIMITED_RE = /rate.?limit|too many requests|usage limit|quota|429/i;
const WAIT_RE = /(?:try again|retry|wait|reset)[^.\n]{0,40}?(\d+)\s*(h|m|s)/i;
const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000 };

/** How long to wait before resuming after `text`, or null if it isn't a rate limit. */
export function rateLimitWaitMs(text: string): number | null {
  if (!RATE_LIMITED_RE.test(text)) return null;
  const match = text.match(WAIT_RE);
  const value = match ? Number.parseInt(match[1], 10) : 0;
  if (match && value > 0) return value * UNIT_MS[match[2].toLowerCase()] + BUFFER_MS;
  return DEFAULT_RATE_LIMIT_WAIT_MS + BUFFER_MS;
}

/** Error text of the final assistant message, or null if the turn succeeded. */
export function lastAssistantError(messages: AssistantMessageLike[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    if (message.stopReason !== "error") return null;
    const error = message.errorMessage;
    return typeof error === "string" && error ? error : "Assistant turn failed";
  }
  return null;
}
