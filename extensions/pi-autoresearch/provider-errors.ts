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
/** Added to every parsed wait — provider clocks and ours don't agree. */
export const RATE_LIMIT_BUFFER_MS = 60_000;

interface AssistantMessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: unknown;
  content?: unknown;
}

const WAIT_PATTERNS: Array<{ re: RegExp; ms: number }> = [
  { re: /(?:try again|retry|wait|reset)[^.\n]{0,40}?(\d+)\s*hours?/i, ms: 3_600_000 },
  { re: /(?:try again|retry|wait|reset)[^.\n]{0,40}?(\d+)\s*min/i, ms: 60_000 },
  { re: /retry[-\s]?after[":\s]*(\d+)\s*s(?:ec)?/i, ms: 1000 },
];

const RATE_LIMITED_RE = /rate.?limit|too many requests|usage limit|quota|429/i;

/** Wait before resuming after `text`, or null if it isn't a rate limit. */
export function rateLimitWaitMs(text: string): number | null {
  if (!RATE_LIMITED_RE.test(text)) return null;
  for (const { re, ms } of WAIT_PATTERNS) {
    const match = text.match(re);
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isNaN(value) || value <= 0) continue;
    return value * ms;
  }
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

/** Error text of the final assistant message, or null if the turn succeeded. */
export function lastAssistantError(messages: AssistantMessageLike[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    if (message.stopReason !== "error") return null;
    return typeof message.errorMessage === "string" && message.errorMessage.length > 0
      ? message.errorMessage
      : "Assistant turn failed";
  }
  return null;
}
