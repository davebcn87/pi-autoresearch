import assert from "node:assert/strict";
import test from "node:test";

import {
  createLoopState,
  isLoopActive,
  transitionLoop,
} from "../extensions/pi-autoresearch/loop-state.ts";

function step(state, event) {
  return transitionLoop(state, event);
}

function runSequence(events, initial = createLoopState()) {
  let state = initial;
  const allEffects = [];
  for (const event of events) {
    const result = transitionLoop(state, event);
    state = result.state;
    allEffects.push(...result.effects);
  }
  return { state, effects: allEffects };
}

test("inactive state ignores agent, turn, and compaction events without emitting effects", () => {
  const { state, effects } = runSequence([
    { type: "agent_start" },
    { type: "experiment_logged", limitReached: false },
    { type: "session_compact", reason: "manual", willRetry: false, isIdle: true, stopReason: null },
    { type: "turn_end", outcome: "completed", compactEvery: 1, stopReason: null },
    { type: "agent_before_settle", outcome: "completed", compactEvery: 1, stopReason: null },
    { type: "agent_settled", aborted: false },
  ]);

  assert.equal(state.phase, "inactive");
  assert.equal(isLoopActive(state), false);
  assert.deepEqual(effects, []);
});

test("stopping fence blocks late turn_end, compaction, and settle from reviving a stopped loop", () => {
  let { state } = runSequence([
    { type: "activate", resetTurns: true },
    { type: "agent_start" },
    { type: "experiment_logged", limitReached: false },
  ]);
  assert.equal(state.phase, "running");

  const deact = step(state, { type: "deactivate", inActiveRun: true });
  assert.equal(deact.state.phase, "stopping");
  assert.equal(isLoopActive(deact.state), false);
  assert.deepEqual(deact.effects, [{ type: "abort" }]);

  // Late events arriving while the aborted run winds down must not resume.
  const late = runSequence([
    { type: "experiment_logged", limitReached: false },
    { type: "session_compact", reason: "threshold", willRetry: false, isIdle: false, stopReason: null },
    { type: "turn_end", outcome: "completed", compactEvery: 1, stopReason: null },
    { type: "agent_before_settle", outcome: "completed", compactEvery: 1, stopReason: null },
  ], deact.state);
  assert.equal(late.state.phase, "stopping");
  assert.deepEqual(late.effects, []);

  // Once Pi settles the aborted run, stopping transitions cleanly to inactive.
  const settled = step(late.state, { type: "agent_settled", aborted: true });
  assert.equal(settled.state.phase, "inactive");
  assert.deepEqual(settled.effects, []);
});

test("turn_end compaction resets experimentsInRun so a chat-only post-compaction turn cannot loop", () => {
  const { state: afterLog } = runSequence([
    { type: "activate", resetTurns: true },
    { type: "agent_start" },
    { type: "experiment_logged", limitReached: false },
  ]);

  const turnEnd = step(afterLog, {
    type: "turn_end",
    outcome: "completed",
    compactEvery: 1,
    stopReason: null,
  });
  assert.deepEqual(turnEnd.effects, [
    { type: "boundary_continue", turn: 1, compact: true, compacted: true },
  ]);
  assert.equal(turnEnd.state.experimentsInRun, 0);
  assert.equal(turnEnd.state.experimentsSinceCompact, 0);

  // If the post-compaction turn only chats (no experiment logged), settle stops cleanly.
  const settle = step(turnEnd.state, {
    type: "agent_before_settle",
    outcome: "completed",
    compactEvery: 1,
    stopReason: null,
  });
  assert.equal(settle.state.phase, "idle");
  assert.deepEqual(settle.effects, []);
});

test("stopReason reached during turn_end notifies once and does not re-notify at settle", () => {
  const { state: afterLog } = runSequence([
    { type: "activate", resetTurns: true },
    { type: "agent_start" },
    { type: "experiment_logged", limitReached: false },
  ]);

  const turnEnd = step(afterLog, {
    type: "turn_end",
    outcome: "completed",
    compactEvery: 1,
    stopReason: "Autoresearch auto-resume limit reached (200 turns)",
  });
  assert.deepEqual(turnEnd.effects, [
    { type: "notify_stop", reason: "Autoresearch auto-resume limit reached (200 turns)" },
  ]);

  const settle = step(turnEnd.state, {
    type: "agent_before_settle",
    outcome: "completed",
    compactEvery: 1,
    stopReason: "Autoresearch auto-resume limit reached (200 turns)",
  });
  assert.deepEqual(settle.effects, []);
  assert.equal(settle.state.phase, "idle");
});

test("session_compact_failed clears compactedInRun so aborted compaction does not trigger settle resume", () => {
  const { state: afterCompact } = runSequence([
    { type: "activate", resetTurns: true },
    { type: "agent_start" },
    { type: "session_compact", reason: "threshold", willRetry: false, isIdle: false, stopReason: null },
    { type: "session_compact_failed" },
  ]);
  assert.equal(afterCompact.compactedInRun, false);

  const settle = step(afterCompact, {
    type: "agent_before_settle",
    outcome: "completed",
    compactEvery: null,
    stopReason: null,
  });
  assert.deepEqual(settle.effects, []);
  assert.equal(settle.state.phase, "idle");
});

test("limitReached on experiment_logged enters stopping and emits abort", () => {
  const { state: running } = runSequence([
    { type: "activate", resetTurns: true },
    { type: "agent_start" },
    { type: "experiment_started", startedAt: 1000, command: "./.auto/measure.sh" },
    { type: "experiment_finished", durationSeconds: 1.5, checks: { pass: true, output: "", duration: 0.2 } },
  ]);

  const logged = step(running, { type: "experiment_logged", limitReached: true });
  assert.equal(logged.state.phase, "stopping");
  assert.equal(logged.state.runningExperiment, null);
  assert.equal(logged.state.lastRunChecks, null);
  assert.equal(logged.state.lastRunDuration, null);
  assert.deepEqual(logged.effects, [{ type: "abort" }]);
});

test("Esc latches pause before work, after a logged experiment, and during a proposed continuation", () => {
  for (const suffix of [
    [],
    [{ type: "experiment_logged", limitReached: false }],
    [{ type: "experiment_logged", limitReached: false }, { type: "agent_before_settle", outcome: "completed", compactEvery: null, stopReason: null }],
    [{ type: "experiment_logged", limitReached: false }, { type: "turn_end", outcome: "completed", compactEvery: 1, stopReason: null }],
  ]) {
    const running = runSequence([{ type: "activate" }, { type: "agent_start" }, ...suffix]).state;
    const paused = step(running, { type: "agent_settled", aborted: true });
    assert.equal(paused.state.phase, "paused");
    assert.deepEqual(paused.effects, []);
    const late = runSequence([
      { type: "agent_end" },
      { type: "session_compact", reason: "threshold", willRetry: false, isIdle: true, stopReason: null },
      { type: "experiment_logged", limitReached: false },
      { type: "agent_start" },
      { type: "agent_before_settle", outcome: "completed", compactEvery: 1, stopReason: null },
      { type: "agent_settled", aborted: false },
    ], paused.state);
    assert.equal(late.state.phase, "paused");
    assert.deepEqual(late.effects, []);
  }
});

test("native retries may complete more low-level runs; only exhausted recovery pauses", () => {
  const running = runSequence([
    { type: "activate" }, { type: "agent_start" },
    { type: "experiment_logged", limitReached: false }, // work before error survives retry
    { type: "agent_end" }, // transient provider error, Pi owns backoff/retry
    { type: "agent_start" }, // Pi's retry, not a new extension prompt
    { type: "agent_end" },
  ]);
  assert.deepEqual(running.effects, []);
  const completed = step(running.state, { type: "agent_before_settle", outcome: "completed", compactEvery: null, stopReason: null });
  assert.equal(completed.effects[0].type, "boundary_continue");
  const exhausted = step(running.state, { type: "agent_before_settle", outcome: "error", compactEvery: null, stopReason: null });
  assert.equal(exhausted.state.phase, "paused");
  assert.deepEqual(exhausted.effects, []);
  assert.equal(step(exhausted.state, { type: "agent_settled", aborted: false }).state.phase, "paused");
});

test("manual compaction never schedules a model request", () => {
  const active = runSequence([{ type: "activate" }, { type: "agent_start" }]).state;
  const compacted = step(active, { type: "session_compact", reason: "manual", willRetry: false, isIdle: true, stopReason: null });
  assert.equal(compacted.state.phase, "paused");
  assert.deepEqual(compacted.effects, []);
});

test("randomized transition fuzzing preserves all loop state machine invariants", () => {
  // Deterministic PRNG (Mulberry32) so failures are 100% reproducible.
  let seed = 0x5eed1234;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const outcomes = ["completed", "aborted", "error"];
  const reasons = ["manual", "threshold", "overflow"];
  const compactCadences = [null, 1, 2, 5];
  const stopReasons = [null, null, null, "limit reached"];

  const randomEvent = () => {
    const kind = Math.floor(rand() * 15);
    switch (kind) {
      case 0: return { type: "session_restored", active: rand() > 0.5 };
      case 1: return { type: "activate", inActiveRun: rand() > 0.5, resetTurns: rand() > 0.5 };
      case 2: return { type: "deactivate", inActiveRun: rand() > 0.5 };
      case 3: return { type: "segment_reset" };
      case 4: return { type: "agent_start" };
      case 5: return { type: "experiment_started", startedAt: 100, command: "bench" };
      case 6: return { type: "experiment_finished", durationSeconds: 1.0, checks: null };
      case 7: return { type: "experiment_aborted" };
      case 8: return { type: "experiment_logged", limitReached: rand() > 0.85 };
      case 9:
        return {
          type: "session_compact",
          reason: pick(reasons),
          willRetry: rand() > 0.5,
          isIdle: rand() > 0.5,
          stopReason: pick(stopReasons),
        };
      case 10: return { type: "session_compact_failed" };
      case 11:
        return {
          type: "turn_end",
          outcome: pick(outcomes),
          compactEvery: pick(compactCadences),
          stopReason: pick(stopReasons),
        };
      case 12: return { type: "agent_end" };
      case 14: return { type: "pause", inActiveRun: rand() > 0.5 };
      case 13:
        return rand() > 0.3
          ? {
              type: "agent_before_settle",
              outcome: pick(outcomes),
              compactEvery: pick(compactCadences),
              stopReason: pick(stopReasons),
            }
          : { type: "agent_settled", aborted: rand() > 0.5 };
    }
  };

  for (let trial = 0; trial < 500; trial++) {
    let state = createLoopState();
    for (let i = 0; i < 40; i++) {
      const event = randomEvent();
      const prev = state;
      const { state: next, effects } = transitionLoop(prev, event);

      // Universal numeric invariants
      assert.ok(next.experimentsInRun >= 0);
      assert.ok(next.experimentsSinceCompact >= 0);
      assert.ok(next.autoResumeTurns >= 0);

      // Inactive or stopping phases must never emit continuation or resume effects.
      if (!isLoopActive(prev)) {
        for (const effect of effects) {
          assert.notEqual(effect.type, "boundary_continue");
          assert.notEqual(effect.type, "send_resume_message");
        }
      }

      // Aborted or errored settle must never continue.
      if (event.type === "agent_before_settle" && event.outcome !== "completed") {
        assert.deepEqual(effects, []);
        assert.equal(next.compactedInRun, false);
        assert.equal(next.runningExperiment, null);
      }

      // Overflow retry compaction must never emit resume or arm compactedInRun.
      if (event.type === "session_compact" && event.willRetry) {
        assert.deepEqual(effects, []);
        assert.equal(next.experimentsSinceCompact, 0);
      }

      // agent_settled always leaves clean non-running, non-stopping phase.
      if (event.type === "agent_settled") {
        assert.equal(next.runningExperiment, null);
        assert.equal(next.compactedInRun, false);
        assert.notEqual(next.phase, "running");
        assert.notEqual(next.phase, "stopping");
      }

      // Any stopReason prevents incrementing autoResumeTurns or continuing.
      if ("stopReason" in event && event.stopReason !== null) {
        for (const effect of effects) {
          assert.notEqual(effect.type, "boundary_continue");
          assert.notEqual(effect.type, "send_resume_message");
        }
        assert.equal(next.autoResumeTurns, prev.autoResumeTurns);
      }

      state = next;
    }
  }
});
