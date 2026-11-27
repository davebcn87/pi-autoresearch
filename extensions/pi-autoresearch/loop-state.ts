/**
 * Pure finite state machine for the autoresearch loop lifecycle.
 *
 * Isolates all phase transitions, compaction handoffs, abort/stop fences, and
 * auto-resume decisions from Pi's I/O and UI side effects so every transition
 * is deterministic and exhaustively testable.
 */

export type LoopPhase = "inactive" | "idle" | "running" | "paused" | "stopping";

export interface RunningExperimentInfo {
  readonly startedAt: number;
  readonly command: string;
}

export interface LastRunChecks {
  readonly pass: boolean;
  readonly output: string;
  readonly duration: number;
}

export interface LoopState {
  readonly phase: LoopPhase;
  /** Number of experiments logged in the current run/iteration window. */
  readonly experimentsInRun: number;
  /** Number of experiments logged since the last compaction or segment init. */
  readonly experimentsSinceCompact: number;
  /** Total automatic resume continuations issued in this session. */
  readonly autoResumeTurns: number;
  /** Set when auto-compaction occurred during an active run; consumed at settle. */
  readonly compactedInRun: boolean;
  readonly runningExperiment: RunningExperimentInfo | null;
  readonly lastRunChecks: LastRunChecks | null;
  readonly lastRunDuration: number | null;
  readonly lastRunPassed: boolean | null;
}

export type LoopEvent =
  | { readonly type: "session_restored"; readonly active: boolean }
  | { readonly type: "activate"; readonly inActiveRun?: boolean; readonly resetTurns?: boolean }
  | { readonly type: "deactivate"; readonly inActiveRun?: boolean }
  | { readonly type: "pause"; readonly inActiveRun?: boolean }
  | { readonly type: "segment_reset" }
  | { readonly type: "agent_start" }
  | { readonly type: "experiment_started"; readonly startedAt: number; readonly command: string }
  | { readonly type: "experiment_finished"; readonly durationSeconds: number; readonly checks: LastRunChecks | null; readonly benchmarkPassed?: boolean }
  | { readonly type: "experiment_aborted" }
  | { readonly type: "experiment_logged"; readonly limitReached: boolean }
  | {
      readonly type: "session_compact";
      readonly reason: "manual" | "threshold" | "overflow";
      readonly willRetry: boolean;
      readonly isIdle: boolean;
      readonly stopReason: string | null;
    }
  | { readonly type: "session_compact_failed" }
  | {
      readonly type: "turn_end";
      readonly outcome: "completed" | "aborted" | "error";
      readonly compactEvery: number | null;
      readonly stopReason: string | null;
    }
  | { readonly type: "agent_end" }
  | {
      readonly type: "agent_before_settle";
      readonly outcome: "completed" | "aborted" | "error";
      readonly compactEvery: number | null;
      readonly stopReason: string | null;
    }
  | { readonly type: "agent_settled"; readonly aborted: boolean };

export type LoopEffect =
  | { readonly type: "abort" }
  | { readonly type: "notify_stop"; readonly reason: string }
  | {
      readonly type: "boundary_continue";
      readonly turn: number;
      readonly compact: boolean;
      readonly compacted: boolean;
    };

export interface LoopTransition {
  readonly state: LoopState;
  readonly effects: readonly LoopEffect[];
}

const NO_EFFECTS: readonly LoopEffect[] = [];

export function createLoopState(): LoopState {
  return {
    phase: "inactive",
    experimentsInRun: 0,
    experimentsSinceCompact: 0,
    autoResumeTurns: 0,
    compactedInRun: false,
    runningExperiment: null,
    lastRunChecks: null,
    lastRunDuration: null,
    lastRunPassed: null,
  };
}

export function isLoopActive(state: LoopState): boolean {
  return state.phase === "idle" || state.phase === "running";
}

function transition(state: LoopState, effects: readonly LoopEffect[] = NO_EFFECTS): LoopTransition {
  return { state, effects };
}

function clearedState(phase: LoopPhase): LoopState {
  return {
    ...createLoopState(),
    phase,
  };
}

export function transitionLoop(state: LoopState, event: LoopEvent): LoopTransition {
  switch (event.type) {
    case "session_restored":
      return transition(clearedState(event.active ? "idle" : "inactive"));

    case "activate": {
      const nextPhase: LoopPhase = event.inActiveRun ? "running" : "idle";
      return transition({
        ...state,
        phase: nextPhase,
        autoResumeTurns: event.resetTurns ? 0 : state.autoResumeTurns,
        compactedInRun: false,
      });
    }

    case "pause":
      return transition(
        { ...clearedState("paused"), autoResumeTurns: state.autoResumeTurns },
        event.inActiveRun || state.phase === "running" ? [{ type: "abort" }] : NO_EFFECTS,
      );

    case "deactivate": {
      const shouldAbort = event.inActiveRun === true || state.phase === "running";
      const nextPhase: LoopPhase = shouldAbort ? "stopping" : "inactive";
      return transition(
        clearedState(nextPhase),
        shouldAbort ? [{ type: "abort" }] : NO_EFFECTS,
      );
    }

    case "segment_reset":
      return transition({
        ...state,
        experimentsSinceCompact: 0,
        compactedInRun: false,
      });

    case "agent_start": {
      if (!isLoopActive(state)) return transition(state);
      return transition({
        ...state,
        phase: "running",
        // A low-level run can be a native retry or queued follow-up, not a
        // new iteration. Preserve work until the actionable/settled boundary.
        runningExperiment: null,
      });
    }

    case "experiment_started":
      return transition({
        ...state,
        runningExperiment: { startedAt: event.startedAt, command: event.command },
        lastRunPassed: null,
        lastRunChecks: null,
        lastRunDuration: null,
      });

    case "experiment_finished":
      return transition({
        ...state,
        runningExperiment: null,
        lastRunDuration: event.durationSeconds,
        lastRunChecks: event.checks,
        lastRunPassed: event.benchmarkPassed ?? null,
      });

    case "experiment_aborted":
      return transition({
        ...state,
        runningExperiment: null,
      });

    case "experiment_logged": {
      if (state.phase === "paused") return transition(state);
      if (event.limitReached) {
        return transition(clearedState("stopping"), [{ type: "abort" }]);
      }
      if (!isLoopActive(state)) {
        return transition({
          ...state,
          runningExperiment: null,
          lastRunChecks: null,
          lastRunDuration: null,
        });
      }
      return transition({
        ...state,
        phase: "running",
        experimentsInRun: state.experimentsInRun + 1,
        experimentsSinceCompact: state.experimentsSinceCompact + 1,
        runningExperiment: null,
        lastRunChecks: null,
        lastRunDuration: null,
      });
    }

    case "session_compact": {
      const resetState: LoopState = {
        ...state,
        experimentsSinceCompact: 0,
      };
      if (event.willRetry || !isLoopActive(resetState)) {
        return transition(resetState);
      }

      // Manual/idle compaction is not an agent continuation boundary. Never
      // launch a new run from this notification (it can race Esc). The user
      // resumes explicitly; automatic in-run compaction uses Pi's boundary.
      if (event.reason === "manual" || (resetState.phase !== "running" && event.isIdle)) {
        return transition({ ...resetState, phase: "paused", compactedInRun: false });
      }

      // Auto-compaction during a run (threshold or non-retrying overflow):
      // record that compaction occurred so agent_before_settle continues cleanly.
      return transition({
        ...resetState,
        compactedInRun: true,
      });
    }

    case "session_compact_failed":
      return transition({
        ...state,
        compactedInRun: false,
      });

    case "turn_end": {
      if (state.phase !== "running" || event.outcome !== "completed") {
        return transition(state);
      }
      if (event.compactEvery === null || state.experimentsSinceCompact < event.compactEvery) {
        return transition(state);
      }
      if (event.stopReason !== null) {
        return transition(
          {
            ...state,
            experimentsInRun: 0,
            experimentsSinceCompact: 0,
            compactedInRun: false,
          },
          [{ type: "notify_stop", reason: event.stopReason }],
        );
      }

      const nextTurn = state.autoResumeTurns + 1;
      return transition(
        {
          ...state,
          // Reset experimentsInRun so the post-compaction iteration must log
          // its own experiment rather than looping on chat-only output.
          experimentsInRun: 0,
          experimentsSinceCompact: 0,
          compactedInRun: false,
          autoResumeTurns: nextTurn,
        },
        [{ type: "boundary_continue", turn: nextTurn, compact: true, compacted: true }],
      );
    }

    case "agent_end":
      return transition({
        ...state,
        runningExperiment: null,
      });

    case "agent_before_settle": {
      const wasCompacted = state.compactedInRun;
      const base: LoopState = {
        ...state,
        compactedInRun: false,
        runningExperiment: null,
      };

      if (!isLoopActive(base)) {
        return transition(base);
      }

      if (event.outcome !== "completed") {
        // Pi has already exhausted its native retry/recovery before this hook.
        // An error is not permission to send a new prompt and restart retries.
        return transition({ ...base, phase: "paused", experimentsInRun: 0 });
      }

      // Chat-only turn gate: prevent infinite loops when the agent merely replies.
      if (!wasCompacted && base.experimentsInRun === 0) {
        return transition({ ...base, phase: "idle" });
      }

      if (event.stopReason !== null) {
        return transition(
          { ...base, phase: "idle", experimentsInRun: 0 },
          [{ type: "notify_stop", reason: event.stopReason }],
        );
      }

      const shouldCompact =
        !wasCompacted &&
        event.compactEvery !== null &&
        base.experimentsSinceCompact >= event.compactEvery;
      const nextTurn = base.autoResumeTurns + 1;
      const compacted = wasCompacted || shouldCompact;

      return transition(
        {
          ...base,
          phase: "running",
          experimentsInRun: 0,
          experimentsSinceCompact: shouldCompact ? 0 : base.experimentsSinceCompact,
          autoResumeTurns: nextTurn,
        },
        [{ type: "boundary_continue", turn: nextTurn, compact: shouldCompact, compacted }],
      );
    }

    case "agent_settled": {
      const nextPhase: LoopPhase =
        state.phase === "stopping"
          ? "inactive"
          : event.aborted && isLoopActive(state)
            ? "paused"
            : state.phase === "running"
              ? "idle"
              : state.phase;
      return transition({
        ...state,
        phase: nextPhase,
        experimentsInRun: 0,
        compactedInRun: false,
        runningExperiment: null,
      });
    }
  }
}
