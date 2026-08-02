import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RATE_LIMIT_WAIT_MS,
  lastAssistantError,
  rateLimitWaitMs,
} from "../extensions/pi-autoresearch/provider-errors.ts";

// Every wait carries a 1 min buffer on top of what the provider said.
const BUFFER = 60_000;

test("parses the wait out of rate limit errors", () => {
  assert.equal(rateLimitWaitMs("rate limit exceeded, try again in 17 minutes"), 17 * 60_000 + BUFFER);
  assert.equal(rateLimitWaitMs("usage limit reached · resets in 2 hours"), 2 * 3_600_000 + BUFFER);
  assert.equal(rateLimitWaitMs('{"type":"rate_limit_error"} retry-after: 45s'), 45_000 + BUFFER);
});

test("falls back to a default wait when no duration is given", () => {
  const fallback = DEFAULT_RATE_LIMIT_WAIT_MS + BUFFER;
  assert.equal(rateLimitWaitMs("429 Too Many Requests"), fallback);
  assert.equal(rateLimitWaitMs("quota exceeded for this key"), fallback);
  assert.equal(rateLimitWaitMs("rate limit hit, try again in 0 min"), fallback);
});

test("non rate limit errors are not waits", () => {
  assert.equal(rateLimitWaitMs("400 invalid request: context length exceeded"), null);
  assert.equal(rateLimitWaitMs("connection reset by peer"), null);
});

test("reads the error off the final assistant message only", () => {
  const failed = [
    { role: "assistant", stopReason: "stop" },
    { role: "user", content: "go" },
    { role: "assistant", stopReason: "error", errorMessage: "429 rate limit" },
  ];
  assert.equal(lastAssistantError(failed), "429 rate limit");

  const recovered = [
    { role: "assistant", stopReason: "error", errorMessage: "429 rate limit" },
    { role: "assistant", stopReason: "stop" },
  ];
  assert.equal(lastAssistantError(recovered), null);

  assert.equal(lastAssistantError([]), null);
  assert.equal(
    lastAssistantError([{ role: "assistant", stopReason: "error" }]),
    "Assistant turn failed",
  );
});
