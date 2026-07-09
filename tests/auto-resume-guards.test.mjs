import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTORESUME_TURN_LIMIT,
  CONSECUTIVE_FAILURE_OVERRIDE_LIMIT,
  autoResumeStopReasonFor,
  countConsecutiveDiscardOrCrashResults,
} from "../extensions/pi-autoresearch/index.ts";

function result(status, segment = 0) {
  return {
    commit: status === "keep" ? "abcdef0" : "",
    metric: status === "crash" ? 0 : 10,
    metrics: {},
    status,
    description: status,
    timestamp: 0,
    segment,
    confidence: null,
  };
}

function state(results, currentSegment = 0) {
  return { results, currentSegment };
}

function runtime(autoResumeTurns, results, currentSegment = 0) {
  return {
    autoResumeTurns,
    state: state(results, currentSegment),
  };
}

test("auto-resume turn ceiling is 200", () => {
  assert.equal(AUTORESUME_TURN_LIMIT, 200);
  assert.equal(autoResumeStopReasonFor(runtime(199, [])), null);
  assert.match(
    autoResumeStopReasonFor(runtime(200, [])),
    /200 turns/,
  );
});

test("consecutive discard/crash override stops after more than 20 failures", () => {
  const failuresAtLimit = Array.from(
    { length: CONSECUTIVE_FAILURE_OVERRIDE_LIMIT },
    (_, index) => result(index % 2 === 0 ? "discard" : "crash"),
  );
  assert.equal(countConsecutiveDiscardOrCrashResults(state(failuresAtLimit)), 20);
  assert.equal(autoResumeStopReasonFor(runtime(0, failuresAtLimit)), null);

  const failuresPastLimit = [...failuresAtLimit, result("discard")];
  assert.equal(countConsecutiveDiscardOrCrashResults(state(failuresPastLimit)), 21);
  assert.match(
    autoResumeStopReasonFor(runtime(0, failuresPastLimit)),
    /21 consecutive discards\/crashes/,
  );
});

test("consecutive failure override resets on keep and ignores previous segments", () => {
  const failuresPastLimit = Array.from(
    { length: CONSECUTIVE_FAILURE_OVERRIDE_LIMIT + 1 },
    () => result("discard"),
  );

  assert.equal(
    countConsecutiveDiscardOrCrashResults(state([...failuresPastLimit, result("keep")])),
    0,
  );
  assert.equal(
    autoResumeStopReasonFor(runtime(0, [...failuresPastLimit, result("keep")])),
    null,
  );

  const previousSegmentFailures = failuresPastLimit.map((entry) => ({ ...entry, segment: 0 }));
  const currentSegmentFailure = result("crash", 1);
  assert.equal(
    countConsecutiveDiscardOrCrashResults(
      state([...previousSegmentFailures, currentSegmentFailure], 1),
    ),
    1,
  );
  assert.equal(
    autoResumeStopReasonFor(
      runtime(0, [...previousSegmentFailures, currentSegmentFailure], 1),
    ),
    null,
  );
});
