/**
 * autoresearch — Pi Extension
 *
 * Generic autonomous experiment loop infrastructure.
 * Domain-specific behavior comes from skills (what command to run, what to optimize).
 *
 * Provides:
 * - `run_experiment` tool — runs any command, times it, captures output, detects pass/fail
 * - `log_experiment` tool — records results with session-persisted state
 * - Status widget showing experiment count + best metric
 * - Fullscreen dashboard overlay via /autoresearch dashboard (opt-in shortcuts available)
 * - Adds autoresearch guidance via before_agent_start systemPromptOptions.sections (cache-safe)
 * - Auto-resumes cleanly via agent_before_settle (and supports optional compactEvery resets)
 */

import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBoundaryDraft,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type ServerResponse } from "node:http";

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

import {
  runHook,
  steerMessageFor,
  appendHookLogEntryIfConfigured,
  type HookPayload,
  type SessionSnapshot,
} from "./hooks.ts";
import {
  parseJsonlEntry,
  isAutoresearchRunEntry,
  extractAutoresearchSessionName,
  reconstructJsonlState,
  firstSuccessfulRun,
  firstComparableBaseline,
} from "./jsonl.ts";
import { TimingCollector, summarizeTiming, timingSummary, formatDuration, type ExperimentTiming } from "./timing.ts";
import {
  autoresearchSummaryPathsFor,
  buildAutoresearchCompactionSummary,
} from "./compaction.ts";
import { resolveAutoresearchShortcuts, SHORTCUT_ACTIONS } from "./shortcuts.ts";
import { getAutoresearchArgumentCompletions, isHelpRequest, renderAutoresearchHelp } from "./commands.ts";
import { sessionFilePath, sessionFileCandidates, ensureParentDir, AUTO_DIR } from "./paths.ts";
import {
  createLoopState,
  isLoopActive,
  transitionLoop,
  type LoopEffect,
  type LoopEvent,
  type LoopState,
} from "./loop-state.ts";

// ---------------------------------------------------------------------------
// Experiment output limits (sent to LLM — keep small to save context)
// ---------------------------------------------------------------------------
const EXPERIMENT_MAX_LINES = 10;
const EXPERIMENT_MAX_BYTES = 4 * 1024; // 4KB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Actionable Side Information (ASI) — free-form diagnostics per experiment run.
 * The agent decides what to record. Any key/value pair is valid.
 */
interface ASI {
  [key: string]: unknown;
}

interface ExperimentResult {
  commit: string;
  metric: number;
  /** Additional tracked metrics: { name: value } */
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  /** Segment index — increments on each config header. Current segment = highest. */
  segment: number;
  /** Session-level confidence score at the time this result was logged. null if insufficient data. */
  confidence: number | null;
  /** Actionable Side Information — structured diagnostics for this run */
  asi?: ASI;
  timing?: ExperimentTiming;
  metricName?: string;
  metricUnit?: string;
  direction?: "lower" | "higher";
}

interface MetricDef {
  name: string;
  unit: string;
}

interface ExperimentState {
  results: ExperimentResult[];
  /** Baseline primary metric (from first experiment in current segment) */
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  /** Definitions for secondary metrics (order preserved) */
  secondaryMetrics: MetricDef[];
  name: string | null;
  /** Current segment index (incremented on each init_experiment) */
  currentSegment: number;
  /** Maximum number of experiments before auto-stopping. null = unlimited. */
  maxExperiments: number | null;
  /** Optional periodic deterministic compaction cadence (every N logged experiments). null = disabled. */
  compactEvery: number | null;
  /** Token ceiling for deterministic compaction between iterations. null = disabled (default 180000). */
  compactAtTokens: number | null;
  /** Marginal confidence score (latest improvement over previous best / noise floor). null if insufficient data. */
  confidence: number | null;
}

export const DEFAULT_COMPACT_AT_TOKENS = 180_000;

export const AUTORESUME_TURN_LIMIT = 200;
export const CONSECUTIVE_FAILURE_OVERRIDE_LIMIT = 20;

type AutoResumeGuardState = Pick<ExperimentState, "results" | "currentSegment">;
type AutoResumeGuardRuntime = {
  autoResumeTurns: number;
  state: AutoResumeGuardState;
};

/** Count trailing discard/crash results in the current segment. */
export function countConsecutiveDiscardOrCrashResults(state: AutoResumeGuardState): number {
  let count = 0;
  for (let i = state.results.length - 1; i >= 0; i--) {
    const result = state.results[i];
    if (result.segment !== state.currentSegment) break;
    if (result.status === "discard" || result.status === "crash") {
      count++;
      continue;
    }
    break;
  }
  return count;
}

export function autoResumeStopReasonFor(runtime: AutoResumeGuardRuntime): string | null {
  if (runtime.autoResumeTurns >= AUTORESUME_TURN_LIMIT) {
    return `Autoresearch auto-resume limit reached (${AUTORESUME_TURN_LIMIT} turns)`;
  }
  const failures = countConsecutiveDiscardOrCrashResults(runtime.state);
  if (failures > CONSECUTIVE_FAILURE_OVERRIDE_LIMIT) {
    return `Autoresearch auto-resume stopped — ${failures} consecutive discards/crashes`;
  }
  return null;
}

interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  tailOutput: string;
  /** null = checks not run (no file or benchmark failed), true/false = ran */
  checksPass: boolean | null;
  checksTimedOut: boolean;
  checksOutput: string;
  checksDuration: number;
  /** Metrics parsed from METRIC lines in output. null if none found. */
  parsedMetrics: Record<string, number> | null;
  /** Primary metric value extracted from parsedMetrics (matching metricName). null if not found. */
  parsedPrimary: number | null;
  /** Name of the primary metric (for display) */
  metricName: string;
  metricUnit: string;
  timing?: ExperimentTiming;
}

interface LogDetails {
  experiment: ExperimentResult;
  state: ExperimentState;
  wallClockSeconds: number | null;
}

interface AutoresearchRuntime {
  loop: LoopState;
  state: ExperimentState;
  iterationStartedAt?: number;
  lastRunTiming?: ExperimentTiming;
  lastRunParsed?: { primary: number | null; metrics: Record<string, number> };
}

const AUTORESEARCH_RESUME_MESSAGE = "pi-autoresearch.resume";

interface AutoresearchResumeDetails {
  turn: number;
  compacted: boolean;
}

// ---------------------------------------------------------------------------
// Tool Schemas
// ---------------------------------------------------------------------------

const RunParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')",
  }),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: "Kill after this many seconds (default: 600)",
    })
  ),
  checks_timeout_seconds: Type.Optional(
    Type.Number({
      description:
        "Kill .auto/checks.sh after this many seconds (default: 300). Only relevant when the checks file exists.",
    })
  ),
});

const InitParams = Type.Object({
  name: Type.String({
    description:
      'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
  }),
  metric_name: Type.String({
    description:
      'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.',
  }),
  metric_unit: Type.Optional(
    Type.String({
      description:
        'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Affects number formatting. Default: ""',
    })
  ),
  direction: Type.Optional(
    StringEnum(["lower", "higher"] as const, {
      description:
        'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
    })
  ),
});

export const LogParams = Type.Object({
  commit: Type.Optional(Type.String({ description: "Git commit hash (short, 7 chars). Optional — auto-detected from HEAD (and updated after auto-commit on keep)." })),
  metric: Type.Optional(Type.Number({
    description:
      "The primary optimization metric value (e.g. seconds, val_bpb). Optional — auto-filled from the last run_experiment's parsed METRIC line (or 0 for crashes).",
  })),
  status: StringEnum(["keep", "discard", "crash", "checks_failed"] as const),
  description: Type.String({
    description: "Short description of what this experiment tried",
  }),
  metrics: Type.Optional(
    Type.Object({}, {
      additionalProperties: Type.Number(),
      description:
        'Additional metrics as { name: value } pairs. Optional — auto-filled from the last run_experiment\'s parsed METRIC lines; pass only to override or when the script did not emit METRIC lines.',
    })
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Set to true to allow adding a new secondary metric that wasn't tracked before. Only use for metrics that have proven very valuable to watch.",
    })
  ),
  asi: Type.Optional(
    Type.Object(
      {
        hypothesis: Type.Optional(
          Type.String({ description: "What hypothesis this experiment tested" })
        ),
        rollback_reason: Type.Optional(
          Type.String({ description: "Why this run was discarded or crashed" })
        ),
        next_action_hint: Type.Optional(
          Type.String({ description: "Best next step informed by this run" })
        ),
        revisits_run: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Earlier run number retried after its assumptions changed",
          })
        ),
      },
      {
        additionalProperties: Type.Unknown(),
        description:
          'Actionable Side Information — structured diagnostics for this run. Free-form key/value pairs are allowed alongside the common fields.',
      }
    )
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prefix for structured metric output lines: `METRIC name=value` */
const METRIC_LINE_PREFIX = "METRIC";

/**
 * Parse structured METRIC lines from command output.
 * Format: METRIC name=value (one per line)
 * Example:
 *   METRIC total_µs=15200
 *   METRIC compile_µs=4200
 *
 * Names must be word chars, dots, or µ (rejects `=` and other specials).
 * Values must be finite numbers (rejects Infinity, NaN, hex, etc.).
 * Duplicate names: last occurrence wins (allows scripts to refine values).
 * Returns a Map preserving insertion order of first occurrence per key.
 */
/** Metric names that could cause prototype pollution if used as object keys */
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`, "gm");
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}

/** Format a number with comma-separated thousands: 15586 → "15,586" */
function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

/** Format number with commas, preserving one decimal for fractional values */
function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  // Integers: no decimals
  if (value === Math.round(value)) return fmtNum(value) + u;
  // Fractional: 2 decimal places
  return fmtNum(value, 2) + u;
}

/** Lazy temp file allocator — returns the same path on subsequent calls */
function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString("hex");
      p = path.join(tmpdir(), `pi-experiment-${id}.log`);
    }
    return p;
  };
}

/** Format elapsed milliseconds as "Xm XXs" or "XXs" */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Kill a process tree (best effort, tries process group first) */
function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
}

/**
 * Check if a command's primary purpose is running the benchmark script.
 *
 * Strategy: strip common harmless prefixes (env vars, env/time/nice wrappers)
 * then check that the core command is the benchmark script invoked via a known
 * pattern. Rejects chaining tricks like "evil.py; measure.sh" because we require
 * the benchmark script to be the *first* real command.
 */
function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();

  // Strip leading env variable assignments: FOO=bar BAZ="qux" ...
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  // Strip known harmless command wrappers (env, time, nice, nohup) repeatedly
  // Allows flags and their numeric values: e.g. "nice -n 10 time env ..."
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);

  // Now the core command must be the benchmark script via a known invocation.
  // Current layout requires the `.auto/measure.sh` path; legacy `autoresearch.sh`
  // is still accepted for in-flight sessions. An optional path prefix allows
  //   ./.auto/measure.sh, /abs/path/.auto/measure.sh, bash [-flags] autoresearch.sh, etc.
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.sh|\.auto\/measure\.sh)(?:\s|$)/.test(cmd);
}

function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher"
): boolean {
  return direction === "lower" ? current < best : current > best;
}

/** Compute the median of a numeric array (returns 0 for empty arrays) */
function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute confidence score for the latest kept improvement vs. local noise floor.
 *
 * Uses the marginal gain of the best kept metric over the *previous* best kept
 * metric (falling back to baseline when only one improvement exists), divided by
 * a local noise floor: min(MAD of segment values, median adjacent step delta)
 * so monotonic progress across many runs doesn't mask a tiny marginal blip.
 *
 * Returns null when there are fewer than 3 valid data points or zero noise.
 */
export function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher"
): number | null {
  const cur = currentResults(results, segment).filter((r) => (r.status === "keep" || r.status === "discard") && r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  const stepDeltas: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const d = Math.abs(values[i] - values[i - 1]);
    if (d > 0) stepDeltas.push(d);
  }
  const stepMedian = stepDeltas.length > 0 ? sortedMedian(stepDeltas) : 0;
  const noiseFloor = mad > 0 && stepMedian > 0 ? Math.min(mad, stepMedian) : (mad || stepMedian);

  if (noiseFloor === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  // Track best and previous-best kept improvements in chronological order.
  let bestKept: number | null = null;
  let prevBestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null) {
        bestKept = r.metric;
      } else if (isBetter(r.metric, bestKept, direction)) {
        prevBestKept = bestKept;
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const reference = prevBestKept ?? baseline;
  const marginalDelta = Math.abs(bestKept - reference);
  return marginalDelta / noiseFloor;
}

/** Get results in the current segment only */
function currentResults(results: ExperimentResult[], segment: number): ExperimentResult[] {
  return results.filter((r) => r.segment === segment);
}

interface AutoresearchConfig {
  maxIterations?: number;
  compactEvery?: number;
  compactAtTokens?: number | false;
  workingDir?: string;
}

/** Read the config file (.auto/config.json, legacy autoresearch.config.json) from the given directory (always ctx.cwd) */
function readConfig(cwd: string): AutoresearchConfig {
  try {
    const configPath = autoresearchConfigPath(cwd);
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

/** Read maxExperiments from the config file (if it exists) */
function readMaxExperiments(cwd: string): number | null {
  const config = readConfig(cwd);
  return (typeof config.maxIterations === "number" && config.maxIterations > 0)
    ? Math.floor(config.maxIterations)
    : null;
}

/** Read optional periodic deterministic compaction cadence from config */
function readCompactEvery(cwd: string): number | null {
  const config = readConfig(cwd);
  return (typeof config.compactEvery === "number" && config.compactEvery > 0)
    ? Math.floor(config.compactEvery)
    : null;
}

/** Read token ceiling for deterministic compaction (default 180k; 0 or false disables). */
function readCompactAtTokens(cwd: string): number | null {
  const config = readConfig(cwd);
  if (config.compactAtTokens === false || config.compactAtTokens === 0) return null;
  if (typeof config.compactAtTokens === "number" && config.compactAtTokens > 0) {
    return Math.floor(config.compactAtTokens);
  }
  return DEFAULT_COMPACT_AT_TOKENS;
}

/**
 * Resolve the effective working directory.
 * Reads workingDir from the config file (.auto/config.json) in ctxCwd.
 * Returns ctxCwd if not set. Supports relative (resolved against ctxCwd) and absolute paths.
 */
function resolveWorkDir(ctxCwd: string): string {
  const config = readConfig(ctxCwd);
  if (!config.workingDir) return ctxCwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(ctxCwd, config.workingDir);
}

function canonicalPath(existingPath: string): string {
  try {
    return fs.realpathSync.native(existingPath);
  } catch {
    return path.resolve(existingPath);
  }
}

function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

const AUTORESEARCH_ACTIVATION_ENTRY = "pi-autoresearch.activation";

interface AutoresearchActivationEntryData {
  version?: number;
  workDir?: string;
  active?: boolean;
  paused?: boolean;
}

export function shouldAutoActivateAutoresearch(
  ctxCwd: string,
  workDir: string,
  hasSessionFiles: boolean,
  recordedDecision: boolean | null = null,
): boolean {
  if (!hasSessionFiles) return false;
  // An explicit `/autoresearch on|off` in this session always wins, so a manual
  // off survives /tree, compaction, and reloads instead of snapping back on.
  if (recordedDecision !== null) return recordedDecision;
  // With no recorded decision, same-cwd sessions default on (session files imply intent);
  // redirected workingDir sessions default off until this session opts in.
  return samePath(ctxCwd, workDir);
}

function autoresearchActivationData(
  entry: CustomEntry,
): (AutoresearchActivationEntryData & { workDir: string }) | null {
  if (entry.customType !== AUTORESEARCH_ACTIVATION_ENTRY) return null;

  const data = entry.data as AutoresearchActivationEntryData | undefined;
  if (typeof data?.workDir !== "string") return null;

  return { ...data, workDir: data.workDir };
}

function recordedActivationDecision(ctx: ExtensionContext, workDir: string): boolean | null {
  const canonicalWorkDir = canonicalPath(workDir);
  let decision: boolean | null = null;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom") continue;

    const data = autoresearchActivationData(entry);
    if (!data || canonicalPath(data.workDir) !== canonicalWorkDir) continue;

    decision = data.active === true;
  }

  return decision;
}

/**
 * Validate that the resolved working directory exists.
 * Returns an error message if it doesn't exist, or null if OK.
 */
function validateWorkDir(ctxCwd: string): string | null {
  const workDir = resolveWorkDir(ctxCwd);
  if (workDir === ctxCwd) return null;
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" (from .auto/config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from .auto/config.json) does not exist.`;
  }
  return null;
}

/** Baseline = first successful (kept) measurement in the current segment. */
function findBaselineMetric(results: ExperimentResult[], segment: number): number | null {
  return firstSuccessfulRun(results, segment)?.metric ?? null;
}

/** Best = optimal metric across kept experiments in current segment (min for lower, max for higher) */
function findBestMetric(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher",
): number | null {
  const kept = currentResults(results, segment)
    .filter((r) => r.status === "keep")
    .map((r) => r.metric);
  if (kept.length === 0) return null;
  return direction === "lower" ? Math.min(...kept) : Math.max(...kept);
}

// -----------------------------------------------------------------------
// Session file paths (single source of truth for autoresearch.* filenames)
// -----------------------------------------------------------------------

const autoresearchJsonlPath  = (dir: string) => sessionFilePath(dir, "log");
const autoresearchMdPath     = (dir: string) => sessionFilePath(dir, "prompt");
const autoresearchIdeasPath  = (dir: string) => sessionFilePath(dir, "ideas");
const autoresearchChecksPath = (dir: string) => sessionFilePath(dir, "checks");
const autoresearchScriptPath = (dir: string) => sessionFilePath(dir, "measure");
const autoresearchConfigPath = (dir: string) => sessionFilePath(dir, "config");

function findBaselineRunNumber(results: ExperimentResult[], segment: number): number | null {
  const index = results.indexOf(firstSuccessfulRun(results, segment)!);
  return index >= 0 ? index + 1 : null;
}

/**
 * Find secondary metric baselines from the first successful experiment in current segment.
 * For metrics that didn't exist at baseline time, falls back to the first
 * occurrence of that metric in the current segment.
 */
function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[]
): Record<string, number> {
  const cur = currentResults(results, segment).filter((r) => r.status === "keep" || r.status === "discard");
  const baseline = firstSuccessfulRun(cur, segment);
  const base: Record<string, number> = { ...baseline?.metrics };

  // Fill in any known metrics missing from baseline with their first occurrence
  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] === undefined) {
        for (const r of cur) {
          const val = (r.metrics ?? {})[sm.name];
          if (val !== undefined) {
            base[sm.name] = val;
            break;
          }
        }
      }
    }
  }

  return base;
}

function cloneExperimentState(state: ExperimentState): ExperimentState {
  return {
    ...state,
    results: state.results.map((result) => ({
      ...result,
      metrics: { ...result.metrics },
    })),
    secondaryMetrics: state.secondaryMetrics.map((metric) => ({ ...metric })),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateDisplayText(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "…", true);
}

function joinPartsToWidth(parts: string[], width: number): string {
  let line = "";
  for (const part of parts) {
    if (!part) continue;
    const next = line + part;
    if (visibleWidth(next) <= width) {
      line = next;
      continue;
    }
    return truncateToWidth(line || part, width, "…", true);
  }
  return truncateToWidth(line, width, "…", true);
}

function appendRightAlignedAdaptiveHint(
  left: string,
  width: number,
  theme: Theme,
  candidates: string[]
): string {
  if (width <= 0) return "";
  const leftWidth = visibleWidth(left);
  for (const candidate of candidates) {
    const hint = theme.fg("dim", ` ${candidate}`);
    const hintWidth = visibleWidth(hint);
    if (hintWidth > width) continue;
    if (leftWidth + hintWidth <= width) {
      return left + " ".repeat(Math.max(0, width - leftWidth - hintWidth)) + hint;
    }
    const availableLeftWidth = Math.max(0, width - hintWidth);
    const truncatedLeft = truncateToWidth(left, availableLeftWidth, "…", true);
    const truncatedLeftWidth = visibleWidth(truncatedLeft);
    return truncatedLeft + " ".repeat(Math.max(0, width - truncatedLeftWidth - hintWidth)) + hint;
  }
  return truncateToWidth(left, width, "…", true);
}

function getTuiSize(tui: { terminal?: { columns?: number; rows?: number } }): { width: number; height: number } {
  return {
    width: tui.terminal?.columns ?? process.stdout.columns ?? 120,
    height: tui.terminal?.rows ?? process.stdout.rows ?? 40,
  };
}

function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
    maxExperiments: null,
    compactEvery: null,
    compactAtTokens: DEFAULT_COMPACT_AT_TOKENS,
    confidence: null,
  };
}

/** Refresh config-driven limits from .auto/config.json so live edits take effect immediately. */
function refreshConfigLimits(cwd: string, state: ExperimentState): void {
  state.maxExperiments = readMaxExperiments(cwd);
  state.compactEvery = readCompactEvery(cwd);
  state.compactAtTokens = readCompactAtTokens(cwd);
}

function createSessionRuntime(): AutoresearchRuntime {
  return {
    loop: createLoopState(),
    state: createExperimentState(),
  };
}

function createRuntimeStore() {
  const runtimes = new Map<string, AutoresearchRuntime>();

  return {
    ensure(sessionKey: string): AutoresearchRuntime {
      let runtime = runtimes.get(sessionKey);
      if (!runtime) {
        runtime = createSessionRuntime();
        runtimes.set(sessionKey, runtime);
      }
      return runtime;
    },

    clear(sessionKey: string): void {
      runtimes.delete(sessionKey);
    },
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dashboard table renderer (pure function, no UI deps)
// ---------------------------------------------------------------------------

function renderDashboardLines(
  st: ExperimentState,
  width: number,
  th: Theme,
  maxRows: number = 6,
  headerHints: string[] = []
): string[] {
  const lines: string[] = [];

  if (st.results.length === 0) {
    lines.push(`  ${th.fg("dim", "No experiments yet.")}`);
    return lines;
  }

  const cur = currentResults(st.results, st.currentSegment);
  const kept = cur.filter((r) => r.status === "keep").length;
  const discarded = cur.filter((r) => r.status === "discard").length;
  const crashed = cur.filter((r) => r.status === "crash").length;
  const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

  const baseline = st.bestMetric;
  const baselineRunNumber = findBaselineRunNumber(st.results, st.currentSegment);
  const baselineSec = findBaselineSecondary(st.results, st.currentSegment, st.secondaryMetrics);

  // Find best kept primary metric and its run number (current segment only)
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment) continue;
    if (r.status === "keep" && r.metric > 0) {
      if (bestPrimary === null || isBetter(r.metric, bestPrimary, st.bestDirection)) {
        bestPrimary = r.metric;
        bestSecondary = r.metrics ?? {};
        bestRunNum = i + 1;
      }
    }
  }

  // Runs summary
  const confSuffix = st.confidence !== null
    ? (() => {
        const confStr = st.confidence!.toFixed(1);
        const confColor: Parameters<typeof th.fg>[0] = st.confidence! >= 2.0 ? "success" : st.confidence! >= 1.0 ? "warning" : "error";
        return `  ${th.fg(confColor, `(conf: ${confStr}×)`)}`;
      })()
    : "";
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Runs:")} ${th.fg("text", String(st.results.length))}` +
        `  ${th.fg("success", `${kept} kept`)}` +
        confSuffix +
        (discarded > 0 ? `  ${th.fg("warning", `${discarded} discarded`)}` : "") +
        (crashed > 0 ? `  ${th.fg("error", `${crashed} crashed`)}` : "") +
        (checksFailed > 0 ? `  ${th.fg("error", `${checksFailed} checks failed`)}` : ""),
      width
    )
  );

  // Baseline: first run's primary metric
  const baselineSuffix = baselineRunNumber === null ? "" : ` #${baselineRunNumber}`;
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Baseline:")} ${th.fg("muted", `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)}${baselineSuffix}`)}`,
      width
    )
  );


  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine = `  ${th.fg("muted", "Progress:")} ${th.fg("warning", th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg("dim", ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? "+" : "";
      const color = isBetter(bestPrimary, baseline, st.bestDirection) ? "success" : "error";
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    const original = firstComparableBaseline(st.results, st.metricName, st.metricUnit, st.bestDirection);
    if (original && original.segment !== st.currentSegment && original.metric !== 0) {
      const pct = ((bestPrimary - original.metric) / Math.abs(original.metric)) * 100;
      progressLine += th.fg("dim", ` (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% from first baseline)`);
    }
    // Keep both comparisons readable in narrow panes and with long metric
    // names. Truncating this line silently hid the first-baseline suffix.
    lines.push(...wrapTextWithAnsi(progressLine, Math.max(1, width)));

    // Progress secondary metrics — wrap into lines that fit width, indented
    if (st.secondaryMetrics.length > 0) {
      const indent = "            "; // 12 chars to align under progress value
      const maxLineW = width - 2 - indent.length; // 2 for leading "  "

      // Build individually-colored parts
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = bestSecondary[sm.name];
        const bv = baselineSec[sm.name];
        if (val !== undefined) {
          let part = th.fg("muted", `${sm.name}: ${formatNum(val, sm.unit)}`);
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? "+" : "";
            const c = val <= bv ? "success" : "error";
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }

      // Flow-wrap parts into lines
      if (secParts.length > 0) {
        let curLine = "";
        let curVisW = 0;
        for (const part of secParts) {
          const partVisW = visibleWidth(part);
          const sep = curLine ? "  " : "";
          if (curLine && curVisW + sep.length + partVisW > maxLineW) {
            lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
            curLine = part;
            curVisW = partVisW;
          } else {
            curLine += sep + part;
            curVisW += sep.length + partVisW;
          }
        }
        if (curLine) {
          lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
        }
      }
    }
  }

  const latestTiming = cur.at(-1)?.timing;
  if (latestTiming) lines.push(truncateToWidth(`  ${th.fg("muted", timingSummary(latestTiming))}`, width));
  lines.push("");

  // Determine visible rows once — used for both column sizing and rendering
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const rowsToRender = st.results.slice(startIdx);

  // Only show secondary metric columns that have at least one value in rendered rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    rowsToRender.some((r) => (r.metrics ?? {})[sm.name] !== undefined)
  );

  // Column definitions
  // Primary column: "★ " prefix (2 visible) + metric name + 1 padding, clamped to 25% of width
  const primaryLabel = "★ " + (st.metricName || "metric");
  const primaryW = Math.max(11, Math.min(Math.floor(width * 0.25), visibleWidth(primaryLabel) + 1));
  const col = { idx: 3, commit: 8, primary: primaryW, status: 15 };
  const minDescW = Math.max(10, Math.floor(width * 0.25));
  const fixedW = col.idx + col.commit + col.primary + col.status + 6;

  // Compute each secondary column width from actual content: max(name, widest value) + 1 padding
  const secColWidths: number[] = secMetrics.map((sm) => {
    let maxW = visibleWidth(sm.name);
    for (const r of rowsToRender) {
      const val = (r.metrics ?? {})[sm.name];
      if (val !== undefined) {
        maxW = Math.max(maxW, visibleWidth(formatNum(val, sm.unit)));
      }
    }
    return maxW + 1;
  });

  const totalSecWidth = () => secColWidths.slice(0, visibleSecMetrics.length).reduce((a, b) => a + b, 0);

  // Drop secondary columns from the right until they fit
  let visibleSecMetrics = secMetrics;
  while (visibleSecMetrics.length > 0 && totalSecWidth() > width - fixedW - minDescW) {
    visibleSecMetrics = visibleSecMetrics.slice(0, -1);
  }

  const descW = Math.max(minDescW, width - fixedW - totalSecWidth());

  // Table header — primary metric name bolded with ★
  let headerLine =
    `  ${th.fg("muted", "#".padEnd(col.idx))}` +
    `${th.fg("muted", "commit".padEnd(col.commit))}` +
    `${th.fg("warning", th.bold(truncateToWidth(primaryLabel, col.primary - 1).padEnd(col.primary)))}`;

  for (let si = 0; si < visibleSecMetrics.length; si++) {
    const sm = visibleSecMetrics[si];
    headerLine += th.fg(
      "muted",
      sm.name.padEnd(secColWidths[si])
    );
  }

  headerLine +=
    `${th.fg("muted", "status".padEnd(col.status))}` +
    `${th.fg("muted", "description")}`;

  lines.push(
    headerHints.length > 0
      ? appendRightAlignedAdaptiveHint(headerLine, width, th, headerHints)
      : truncateToWidth(headerLine, width, "…", true)
  );
  lines.push(
    truncateToWidth(
      `  ${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`,
      width
    )
  );

  // Baseline values for delta display (current segment only)
  const baselinePrimary = findBaselineMetric(st.results, st.currentSegment);
  const baselineSecondary = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics
  );

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `… ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)}`,
        width
      )
    );
  }

  const baselineIndex = st.results.indexOf(firstSuccessfulRun(st.results, st.currentSegment)!);

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    const isBaseline = !isOld && i === baselineIndex;

    const color = isOld
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning";

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = isOld ? "dim" : "text";
    if (!isOld) {
      if (isBaseline) {
        primaryColor = "text"; // baseline row — normal text
      } else if (
        baselinePrimary !== null &&
        r.status === "keep" &&
        r.metric > 0
      ) {
        if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
          primaryColor = "success";
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error";
        }
      }
    }

    const idxStr = th.fg("dim", String(i + 1).padEnd(col.idx));
    const commitStr = isOld
      ? "(old)".padEnd(col.commit)
      : r.status !== "keep"
        ? "—".padStart(Math.ceil(col.commit / 2)).padEnd(col.commit)
        : r.commit.padEnd(col.commit);

    let rowLine =
      `  ${idxStr}` +
      `${th.fg(isOld ? "dim" : "accent", commitStr)}` +
      `${th.fg(primaryColor, isOld ? primaryStr.padEnd(col.primary) : th.bold(primaryStr.padEnd(col.primary)))}`;

    // Secondary metrics (only visible columns)
    const rowMetrics = r.metrics ?? {};
    for (let si = 0; si < visibleSecMetrics.length; si++) {
      const sm = visibleSecMetrics[si];
      const colW = secColWidths[si];
      const val = rowMetrics[sm.name];
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = "dim";
        if (!isOld) {
          const bv = baselineSecondary[sm.name];
          if (isBaseline) {
            secColor = "text";
          } else if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? "success" : "error";
          }
        }
        rowLine += th.fg(secColor, secStr.padEnd(colW));
      } else {
        rowLine += th.fg("dim", "—".padEnd(colW));
      }
    }

    rowLine +=
      `${th.fg(color, r.status.padEnd(col.status))}` +
      `${th.fg("muted", r.description.slice(0, descW))}`;

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoresearchExtension(pi: ExtensionAPI) {
  const BENCHMARK_GUARDRAIL =
    "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

  const shortcuts = resolveAutoresearchShortcuts();

  // The widget shows the first hint that fits its width, so a configured
  // shortcut must come before the longer subcommand or it is never shown.
  const dashboardHintVariants = (): string[] => {
    const shortcut = shortcuts.fullscreenDashboard;
    return shortcut ? [`${shortcut} fullscreen`, shortcut] : ["/autoresearch dashboard"];
  };

  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));

  // Registering through this gates the tool with defaultActive: false so it is
  // never exposed until autoresearch mode is explicitly activated.
  const gatedToolNames = new Set<string>();
  const registerGatedTool = <TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void => {
    gatedToolNames.add(tool.name);
    pi.registerTool({ ...tool, defaultActive: false });
  };

  // Sync Pi's active tool loadout with the loop state machine's active flag.
  const syncGatedTools = (enabled: boolean): void => {
    const activeTools = new Set(pi.getActiveTools()); // setActiveTools replaces the whole set
    for (const tool of gatedToolNames) {
      enabled ? activeTools.add(tool) : activeTools.delete(tool);
    }
    pi.setActiveTools([...activeTools]);
  };

  const isAutoresearchActive = (runtime: AutoresearchRuntime): boolean =>
    isLoopActive(runtime.loop);

  const currentStopReason = (runtime: AutoresearchRuntime): string | null =>
    autoResumeStopReasonFor({
      autoResumeTurns: runtime.loop.autoResumeTurns,
      state: runtime.state,
    });

  const recordAutoresearchActivation = (workDir: string, active: boolean, paused = false): void => {
    pi.appendEntry(AUTORESEARCH_ACTIVATION_ENTRY, {
      version: 1,
      workDir: canonicalPath(workDir),
      active,
      paused,
    });
  };

  const notifyAutoResumeLimitReached = (ctx: ExtensionContext, reason?: string | null): void => {
    ctx.ui.notify(reason ?? `Autoresearch auto-resume limit reached`, "info");
  };

  // Single state-machine dispatcher: updates runtime.loop, keeps gated tools
  // in lockstep with active/inactive transitions, and executes non-boundary
  // side effects while returning any boundary_continue effect to the caller.
  const dispatchLoop = (
    ctx: ExtensionContext,
    event: LoopEvent,
    options?: { forceSyncTools?: boolean },
  ): Extract<LoopEffect, { type: "boundary_continue" }> | null => {
    const runtime = getRuntime(ctx);
    const wasActive = isLoopActive(runtime.loop);
    if (event.type === "pause" || event.type === "deactivate" || event.type === "session_restored") {
      runtime.iterationStartedAt = undefined;
      runtime.lastRunTiming = undefined;
      runtime.lastRunParsed = undefined;
    }
    const { state: nextLoop, effects } = transitionLoop(runtime.loop, event);
    runtime.loop = nextLoop;
    // Automatic safety/iteration limits must not leave a playbook-backed loop
    // silently inactive. Persist the same visible pause as a user pause.
    const limited = (event.type === "experiment_logged" && event.limitReached) || effects.some((effect) => effect.type === "notify_stop");
    if (limited && hasAutoresearchRules(ctx)) {
      runtime.loop = { ...nextLoop, phase: "paused", runningExperiment: null };
    }
    // Esc (including during boundary handlers), exhausted retries, and manual
    // compaction latch a pause. Notifications must never schedule a new run.
    const newlyPaused = wasActive && runtime.loop.phase === "paused";
    if (newlyPaused) {
      runtime.iterationStartedAt = undefined;
      runtime.lastRunTiming = undefined;
      runtime.lastRunParsed = undefined;
      // Explicit pause records its decision at the command boundary already.
      if (event.type !== "pause") recordAutoresearchActivation(resolveWorkDir(ctx.cwd), false, true);
    }

    const nowActive = isLoopActive(runtime.loop);
    if (nowActive && runtime.iterationStartedAt === undefined) runtime.iterationStartedAt = Date.now();
    if (options?.forceSyncTools || wasActive !== nowActive) {
      syncGatedTools(nowActive);
    }

    let boundaryContinue: Extract<LoopEffect, { type: "boundary_continue" }> | null = null;
    for (const effect of effects) {
      switch (effect.type) {
        case "abort":
          ctx.abort();
          break;
        case "notify_stop":
          notifyAutoResumeLimitReached(ctx, effect.reason);
          break;
        case "boundary_continue":
          boundaryContinue = effect;
          break;
      }
    }
    if (newlyPaused) updateWidget(ctx);
    return boundaryContinue;
  };

  const buildBoundaryContinuation = (
    ctx: ExtensionContext,
    existingEntries: readonly SessionBoundaryDraft[],
    effect: Extract<LoopEffect, { type: "boundary_continue" }>,
    canContinue = false,
  ): { entries: SessionBoundaryDraft[]; continue: true } => {
    const entries: SessionBoundaryDraft[] = [...existingEntries];
    if (effect.compact) {
      entries.push({
        type: "compaction",
        summary: buildAutoresearchCompactionSummary(
          autoresearchSummaryPathsFor(resolveWorkDir(ctx.cwd)),
        ),
        firstKeptEntryId: null,
      });
    } else if (!canContinue) {
      // Pi's boundary validator rejects `continue: true` when the trailing LLM
      // message has role "assistant". A hidden (`display: false`) custom_message
      // supplies runnable model context without cluttering the chat transcript,
      // and Pi still suppresses continuation if the user presses Esc.
      entries.push({
        type: "custom_message",
        customType: AUTORESEARCH_RESUME_MESSAGE,
        content: effect.compacted
          ? "Continue the next autoresearch iteration from the compaction summary."
          : "Continue the next autoresearch iteration.",
        display: false,
        details: { turn: effect.turn, compacted: effect.compacted },
      });
    }
    return { entries, continue: true };
  };

  // Render old session history only; new continuations never append messages.
  pi.registerMessageRenderer?.<AutoresearchResumeDetails>(
    AUTORESEARCH_RESUME_MESSAGE,
    (message, { expanded }, theme) => {
      const turn = message.details?.turn;
      const compacted = message.details?.compacted === true;
      const label = compacted
        ? `↻ Autoresearch continuing after compaction${turn ? ` (turn ${turn})` : ""}`
        : `↻ Autoresearch continuing${turn ? ` (turn ${turn})` : ""}`;
      const body = typeof message.content === "string" ? message.content : "";
      const text = expanded && body
        ? `${theme.fg("accent", label)}\n${theme.fg("dim", body)}`
        : theme.fg("dim", label);
      return new Text(text, 0, 0);
    },
  );

  const autoresearchCompactionFor = (
    ctx: ExtensionContext,
    event: SessionBeforeCompactEvent,
  ) => {
    if (!isAutoresearchActive(getRuntime(ctx))) return undefined;
    return {
      compaction: {
        summary: buildAutoresearchCompactionSummary(
          autoresearchSummaryPathsFor(resolveWorkDir(ctx.cwd)),
        ),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  };

  // Without `expandPromptTemplates` a `/skill:<name>` kickoff reaches the model as literal text.
  const sendWhenReady = (ctx: ExtensionContext, message: string): void => {
    if (ctx.isIdle()) {
      pi.sendUserMessage(message, { expandPromptTemplates: true });
      return;
    }
    pi.sendUserMessage(message, { expandPromptTemplates: true, deliverAs: "followUp" });
  };

  const hasAutoresearchRules = (ctx: ExtensionContext): boolean =>
    fs.existsSync(autoresearchMdPath(resolveWorkDir(ctx.cwd)));

  const hasLoggedExperiment = (ctxCwd: string): boolean => {
    try {
      const jsonlPath = autoresearchJsonlPath(resolveWorkDir(ctxCwd));
      if (!fs.existsSync(jsonlPath)) return false;
      return reconstructJsonlState(fs.readFileSync(jsonlPath, "utf-8")).results.length > 0;
    } catch {
      return false;
    }
  };

  const readJsonlLines = (workDir: string): string[] => {
    const jsonlPath = autoresearchJsonlPath(workDir);
    if (!fs.existsSync(jsonlPath)) return [];
    return fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  };

  const readLastRun = (workDir: string): Record<string, unknown> | null => {
    const lines = readJsonlLines(workDir);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseJsonlEntry(lines[i]);
      if (isAutoresearchRunEntry(entry)) return entry;
    }
    return null;
  };

  const buildSessionSnapshot = (state: ExperimentState): SessionSnapshot => ({
    metric_name: state.metricName,
    metric_unit: state.metricUnit,
    direction: state.bestDirection,
    baseline_metric: state.bestMetric,
    best_metric: findBestMetric(state.results, state.currentSegment, state.bestDirection),
    run_count: state.results.length,
    goal: state.name ?? "",
  });

  const fireHook = async (payload: HookPayload): Promise<string | null> => {
    const result = await runHook(payload);
    appendHookLogEntryIfConfigured(autoresearchJsonlPath(payload.cwd), payload.event, result);
    return steerMessageFor(payload.event, result);
  };

  // Running experiment state (for spinner in fullscreen overlay)
  let overlayTui: { requestRender: () => void } | null = null;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const clearOverlay = () => {
    overlayTui = null;
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
  };

  const clearSessionUi = (ctx: ExtensionContext) => {
    clearOverlay();
    if (ctx.hasUI) {
      ctx.ui.setWidget("autoresearch", undefined);
      ctx.ui.setStatus?.("autoresearch", undefined);
    }
  };

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = (ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    runtime.state = createExperimentState();

    let state = runtime.state;

    // Resolve effective working directory (config stays in ctx.cwd, files in workDir)
    const workDir = resolveWorkDir(ctx.cwd);

    // Primary: read from .auto/log.jsonl (alongside .auto/prompt.md and .auto/measure.sh)
    const jsonlPath = autoresearchJsonlPath(workDir);
    const hasPersistedLog = fs.existsSync(jsonlPath);
    let loadedFromJsonl = false;
    try {
      if (hasPersistedLog) {
        const reconstructed = reconstructJsonlState(fs.readFileSync(jsonlPath, "utf-8"));
        state.name = reconstructed.name;
        state.metricName = reconstructed.metricName;
        state.metricUnit = reconstructed.metricUnit;
        state.bestDirection = reconstructed.bestDirection;
        state.currentSegment = reconstructed.currentSegment;
        state.results = reconstructed.results.map((result) => ({
          ...result,
          metrics: { ...result.metrics },
        }));
        state.secondaryMetrics = reconstructed.secondaryMetrics.map((metric) => ({ ...metric }));

        if (state.results.length > 0) {
          loadedFromJsonl = true;
          state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
          state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
        }
      }
    } catch {
      // Fall through to session history
    }

    // Fallback: reconstruct from session history (backward compat)
    if (!loadedFromJsonl) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "log_experiment")
          continue;
        const details = msg.details as LogDetails | undefined;
        if (details?.state) {
          runtime.state = cloneExperimentState(details.state);
          state = runtime.state;
          if (!state.secondaryMetrics) state.secondaryMetrics = [];
          if (state.metricUnit === "s" && state.metricName === "metric") {
            state.metricUnit = "";
          }
          for (const r of state.results) {
            if (!r.metrics) r.metrics = {};
            if (r.confidence === undefined) r.confidence = null;
          }
          if (state.confidence === undefined) {
            state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
          }
        }
      }
    }


    // Read max experiments and optional compaction cadence from config file
    refreshConfigLimits(ctx.cwd, state);

    // A playbook already establishes intent, even before the first tool-managed
    // log exists. Manual off and redirected-workingDir isolation still win.
    const shouldActivate = shouldAutoActivateAutoresearch(
      ctx.cwd,
      workDir,
      hasPersistedLog || hasAutoresearchRules(ctx),
      recordedActivationDecision(ctx, workDir),
    );
    dispatchLoop(ctx, { type: "session_restored", active: shouldActivate }, { forceSyncTools: true });
    const lastActivation = ctx.sessionManager.getBranch()
      .filter((entry): entry is CustomEntry => entry.type === "custom")
      .map(autoresearchActivationData)
      .filter((data) => data && samePath(data.workDir!, workDir)).at(-1);
    if (!shouldActivate && lastActivation?.paused && (hasPersistedLog || hasAutoresearchRules(ctx))) dispatchLoop(ctx, { type: "pause" });
    if (hasPersistedLog || hasAutoresearchRules(ctx)) sessionsWithFiles.add(getSessionKey(ctx));

    updateWidget(ctx);
  };

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const runtime = getRuntime(ctx);
    const state = runtime.state;

    if (runtime.loop.phase === "paused") {
      ctx.ui.setWidget("autoresearch", ["🔬 autoresearch paused — /autoresearch resume to continue"]);
      ctx.ui.setStatus?.("autoresearch", "autoresearch paused");
      return;
    }
    ctx.ui.setStatus?.("autoresearch", undefined);
    if (!isAutoresearchActive(runtime)) {
      ctx.ui.setWidget("autoresearch", undefined);
      return;
    }

    if (state.results.length === 0) {
      if (!runtime.loop.runningExperiment) {
        ctx.ui.setWidget("autoresearch", [runtime.state.name
          ? `🔬 autoresearch: ${runtime.state.name} — awaiting first successful baseline`
          : "🔬 autoresearch active — initialize the experiment now with init_experiment"]);
        return;
      }

      ctx.ui.setWidget("autoresearch", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const runningLine = joinPartsToWidth(
            [
              theme.fg("accent", "🔬"),
              theme.fg("warning", " running…"),
              state.name ? theme.fg("dim", ` │ ${state.name}`) : "",
              theme.fg("dim", ` │ ${runtime.loop.runningExperiment?.command ?? ""}`),
              theme.fg("dim", " │ waiting for first logged result"),
            ],
            safeWidth
          );
          return [runningLine];
        },
        invalidate(): void {},
      }));
      return;
    }

    // Full dashboard table rendered as widget
    ctx.ui.setWidget("autoresearch", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const title = truncateDisplayText(
            `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
            Math.max(0, safeWidth - 5)
          );
          const fillLen = Math.max(0, safeWidth - 3 - 1 - visibleWidth(title) - 1);
          const rows = safeWidth < 95 ? 4 : 6;

          return [
            truncateToWidth(
              theme.fg("borderMuted", "───") +
                theme.fg("accent", ` ${title} `) +
                theme.fg("borderMuted", "─".repeat(fillLen)),
              safeWidth,
              "…",
              true
            ),
            ...renderDashboardLines(
              state,
              safeWidth,
              theme,
              rows,
              dashboardHintVariants()
            ),
          ];
        },
        invalidate(): void {},
      }));
  };

  // Skill commands expand after `input`. Enter mode before expansion so the
  // first model request can actually call the tools named by the create skill.
  const isCreateSkillRequest = (text: string): boolean =>
    /^\/(?:skill:)?autoresearch-create(?:\s|$)/.test(text.trim());

  const activateFromCreateSkill = (ctx: ExtensionContext): void => {
    const runtime = getRuntime(ctx);
    if (isAutoresearchActive(runtime) || runtime.loop.phase === "stopping") return;
    recordAutoresearchActivation(resolveWorkDir(ctx.cwd), true);
    dispatchLoop(ctx, { type: "activate", inActiveRun: !ctx.isIdle(), resetTurns: true });
    updateWidget(ctx);
    ctx.ui.notify("Autoresearch mode ON — create skill activated experiment tools", "info");
  };

  // Session files can appear after startup (e.g. the create skill writes them).
  // Reconcile at request/turn boundaries instead of waiting for /reload. Never
  // revive a stopping loop, a manual off, or another session's redirected work.
  const sessionsWithFiles = new Set<string>();
  const recoverModeFromSessionFiles = (ctx: ExtensionContext): boolean => {
    const runtime = getRuntime(ctx);
    const workDir = resolveWorkDir(ctx.cwd);
    const hasFiles = fs.existsSync(autoresearchJsonlPath(workDir)) || hasAutoresearchRules(ctx);
    const key = getSessionKey(ctx);
    if (hasFiles) sessionsWithFiles.add(key);
    else if (sessionsWithFiles.delete(key)) {
      // Deleting .auto is an explicit stop, including from a paused session.
      dispatchLoop(ctx, { type: "deactivate", inActiveRun: false }, { forceSyncTools: true });
      updateWidget(ctx);
      return false;
    }
    if (runtime.loop.phase !== "inactive") return false;
    if (!shouldAutoActivateAutoresearch(
      ctx.cwd,
      workDir,
      fs.existsSync(autoresearchJsonlPath(workDir)) || hasAutoresearchRules(ctx),
      recordedActivationDecision(ctx, workDir),
    )) return false;
    reconstructState(ctx);
    dispatchLoop(ctx, { type: "activate", inActiveRun: !ctx.isIdle() });
    recordAutoresearchActivation(workDir, true);
    ctx.ui.notify("Autoresearch mode ON — recovered from session files", "info");
    return true;
  };

  pi.on("input", async (event, ctx) => {
    if (isCreateSkillRequest(event.text)) activateFromCreateSkill(ctx);
  });

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_before_switch", async () => {
    clearOverlay();
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    clearSessionUi(ctx);
    runtimeStore.clear(getSessionKey(ctx));
    sessionsWithFiles.delete(getSessionKey(ctx));
    ctx.ui.setStatus?.("autoresearch", undefined);
    stopDashboardServer();
  });

  pi.on("agent_start", async (_event, ctx) => {
    dispatchLoop(ctx, { type: "agent_start" });
  });

  pi.on("session_before_compact", async (event, ctx) => {
    return autoresearchCompactionFor(ctx, event);
  });

  pi.on("session_compact", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    dispatchLoop(ctx, {
      type: "session_compact",
      reason: event.reason,
      willRetry: event.willRetry,
      isIdle: ctx.isIdle(),
      stopReason: currentStopReason(runtime),
    });
  });

  pi.on("session_compact_failed", async (_event, ctx) => {
    dispatchLoop(ctx, { type: "session_compact_failed" });
  });

  const isContextOverCompactionLimit = (ctx: ExtensionContext, state: ExperimentState): boolean => {
    if (state.compactAtTokens === null) return false;
    const tokens = ctx.getContextUsage?.()?.tokens;
    return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= state.compactAtTokens;
  };

  pi.on("turn_end", async (event, ctx) => {
    const recovered = event.outcome === "completed" && recoverModeFromSessionFiles(ctx);
    const runtime = getRuntime(ctx);
    refreshConfigLimits(ctx.cwd, runtime.state);
    const cont = dispatchLoop(ctx, {
      type: "turn_end",
      outcome: event.outcome,
      compactEvery: runtime.state.compactEvery,
      contextOverLimit: isContextOverCompactionLimit(ctx, runtime.state),
      stopReason: currentStopReason(runtime),
    });
    if (cont) return buildBoundaryContinuation(ctx, event.entries, cont, event.context?.canContinue === true);
    if (recovered && !currentStopReason(runtime)) {
      // One repair turn, not a fake logged experiment. The normal chat-only
      // guard remains in charge of every subsequent continuation.
      return {
        entries: [...event.entries, {
          type: "custom_message" as const,
          customType: "pi-autoresearch.activation",
          content: "Autoresearch mode is now active; init_experiment, run_experiment and log_experiment are available. Use these tools, not manual shell/log substitutes. If no tool-managed config exists, call init_experiment and measure a fresh baseline. Preserve existing work and history; do not invent historical tool runs.",
          display: true,
        }],
        continue: true,
      };
    }
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    dispatchLoop(ctx, { type: "agent_end" });
    if (overlayTui) overlayTui.requestRender();
  });

  // Final actionable boundary: fires only after Pi has finished retries,
  // auto-compaction, and queued user follow-ups.
  pi.on("agent_before_settle", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    refreshConfigLimits(ctx.cwd, runtime.state);
    const cont = dispatchLoop(ctx, {
      type: "agent_before_settle",
      outcome: event.outcome,
      compactEvery: runtime.state.compactEvery,
      contextOverLimit: isContextOverCompactionLimit(ctx, runtime.state),
      stopReason: currentStopReason(runtime),
    });
    return cont ? buildBoundaryContinuation(ctx, event.entries, cont, event.context?.canContinue === true) : undefined;
  });

  pi.on("agent_settled", async (event, ctx) => {
    dispatchLoop(ctx, { type: "agent_settled", aborted: event.aborted });
    if (overlayTui) overlayTui.requestRender();
  });

  // When in autoresearch mode, attach a structured prompt section instead of
  // forcing a full systemPrompt override — Pi diffs sections mid-conversation
  // so toggling checks/ideas or autoresearch mode preserves the prompt cache.
  pi.on("before_agent_start", async (event, ctx) => {
    // Also handle callers that already expanded the skill before delivery.
    if (isCreateSkillRequest(event.prompt ?? "") || /^<skill\s+name=["']autoresearch-create["'](?:\s|>)/.test((event.prompt ?? "").trim())) {
      activateFromCreateSkill(ctx);
    }
    recoverModeFromSessionFiles(ctx);
    const runtime = getRuntime(ctx);
    const sections = event.systemPromptOptions?.sections;

    if (!isAutoresearchActive(runtime)) {
      if (sections) delete sections.autoresearch;
      return;
    }

    refreshConfigLimits(ctx.cwd, runtime.state);

    const workDir = resolveWorkDir(ctx.cwd);
    const mdPath = autoresearchMdPath(workDir);
    const ideasPath = autoresearchIdeasPath(workDir);
    const hasIdeas = fs.existsSync(ideasPath);

    const checksPath = autoresearchChecksPath(workDir);
    const hasChecks = fs.existsSync(checksPath);

    let extra =
      "## Autoresearch Mode (ACTIVE)" +
      "\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop." +
      "\nCall init_experiment as soon as the objective and metric are known, before implementation or optimization. Do not wait for a working benchmark. Then use run_experiment and log_experiment for every attempt; the first successful run (benchmark and required checks pass) is kept as the baseline. Failed attempts are logged but never establish the baseline. NEVER STOP until interrupted." +
      `\nExperiment rules: ${mdPath} — read this file at the start of every session and after compaction.` +
      "\nWrite promising but deferred optimizations as bullet points to .auto/ideas.md — don't let good ideas get lost." +
      `\n${BENCHMARK_GUARDRAIL}` +
      "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.";

    if (hasChecks) {
      extra +=
        "\n\n## Backpressure Checks (ACTIVE)" +
        `\n${checksPath} exists and runs automatically after every passing benchmark in run_experiment.` +
        "\nIf the benchmark passes but checks fail, run_experiment will report it clearly." +
        "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
        "\nYou cannot use status 'keep' when checks have failed." +
        "\nThe checks execution time does NOT affect the primary metric.";
    }

    if (hasIdeas) {
      extra += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
    }

    if (sections) {
      sections.autoresearch = extra;
      return;
    }

    return {
      systemPrompt: event.systemPrompt + "\n\n" + extra,
    };
  });

  // -----------------------------------------------------------------------
  // init_experiment tool — one-time setup
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "init_experiment",
    label: "Init Experiment",
    description:
      "Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to .auto/log.jsonl.",
    promptSnippet:
      "Initialize experiment session (name, metric, unit, direction). Call once before first run.",
    promptGuidelines: [
      "Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment.",
      "If the session log (.auto/log.jsonl) already exists with a config, do NOT call init_experiment again.",
      "If the optimization target changes (different benchmark, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.",
    ],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: InitParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }

      const isReinit = state.results.length > 0;

      state.name = params.name;
      state.metricName = params.metric_name;
      state.metricUnit = params.metric_unit ?? "";
      if (params.direction === "lower" || params.direction === "higher") {
        state.bestDirection = params.direction;
      }
      // Start a new segment — keep history for dashboard, but reset baseline tracking.
      // Old results remain accessible (filtered by segment in rendering).
      if (isReinit) {
        state.currentSegment++;
      }
      state.bestMetric = null;
      state.secondaryMetrics = [];
      state.confidence = null;

      // Read config limits from config file (config always in ctx.cwd)
      refreshConfigLimits(ctx.cwd, state);
      if (isReinit) {
        dispatchLoop(ctx, { type: "segment_reset" });
      }

      // Write config header to jsonl (append for re-init, create for first)
      const workDir = resolveWorkDir(ctx.cwd);
      try {
        const jsonlPath = autoresearchJsonlPath(workDir);
        ensureParentDir(jsonlPath);
        const config = JSON.stringify({
          type: "config",
          name: state.name,
          metricName: state.metricName,
          metricUnit: state.metricUnit,
          bestDirection: state.bestDirection,
        });
        if (fs.existsSync(jsonlPath)) {
          fs.appendFileSync(jsonlPath, config + "\n");
        } else {
          fs.writeFileSync(jsonlPath, config + "\n");
        }
        broadcastDashboardUpdate(workDir);
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `⚠️ Failed to write .auto/log.jsonl: ${e instanceof Error ? e.message : String(e)}`,
          }],
          details: {},
        };
      }

      const wasInactive = !isAutoresearchActive(runtime);
      recordAutoresearchActivation(workDir, true);
      dispatchLoop(ctx, { type: "activate", inActiveRun: true }, { forceSyncTools: true });
      updateWidget(ctx);

      if (wasInactive) {
        const steer = await fireHook({
          event: "before",
          cwd: workDir,
          next_run: state.results.length + 1,
          last_run: readLastRun(workDir),
          session: buildSessionSnapshot(state),
        });
        if (steer) pi.sendUserMessage(steer, { deliverAs: "steer" });
      }

      const reinitNote = isReinit ? " (re-initialized — previous results archived, new baseline needed)" : "";
      const limitNote = state.maxExperiments !== null ? `\nMax iterations: ${state.maxExperiments} (from .auto/config.json)` : "";
      const workDirNote = workDir !== ctx.cwd ? `\nWorking directory: ${workDir}` : "";
      return {
        content: [{
          type: "text",
          text: `✅ Experiment initialized: "${state.name}"${reinitNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}\nConfig written to .auto/log.jsonl. Now run the baseline with run_experiment.`,
        }],
        details: { state: cloneExperimentState(state) },
      };
    },

    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("init_experiment "));
      text += theme.fg("accent", args.name ?? "");
      const comp = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      comp.setText(text);
      return comp;
    },

    renderResult(result, _options, _theme, context) {
      const t = result.content[0];
      const comp = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      comp.setText(t?.type === "text" ? t.text : "");
      return comp;
    },
  });

  // -----------------------------------------------------------------------
  // run_experiment tool
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "run_experiment",
    label: "Run Experiment",
    description:
      `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Output is truncated to last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Use for any autoresearch experiment.`,
    promptSnippet:
      "Run a timed experiment command (captures duration, output, exit code)",
    promptGuidelines: [
      "Use run_experiment instead of bash when running experiment commands — it handles timing and output capture automatically.",
      "After run_experiment, always call log_experiment to record the result.",
      "If the benchmark script outputs structured METRIC lines (e.g. 'METRIC total_µs=15200'), run_experiment will parse them automatically and suggest exact values for log_experiment. Use these parsed values directly instead of extracting them manually from the output.",

    ],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    parameters: RunParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }
      const workDir = resolveWorkDir(ctx.cwd);

      refreshConfigLimits(ctx.cwd, state);

      // Block if max experiments limit already reached
      if (state.maxExperiments !== null) {
        const segCount = currentResults(state.results, state.currentSegment).length;
        if (segCount >= state.maxExperiments) {
          return {
            content: [{ type: "text", text: `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.` }],
            details: {},
          };
        }
      }

      const timeout = (params.timeout_seconds ?? 600) * 1000;

      // Guard: if the benchmark script exists, only allow running it
      const autoresearchShPath = autoresearchScriptPath(workDir);
      const benchmarkScriptRel = path.relative(workDir, autoresearchShPath) || path.basename(autoresearchShPath);
      if (fs.existsSync(autoresearchShPath) && !isAutoresearchShCommand(params.command)) {
        return {
          content: [{
            type: "text",
            text: `❌ ${benchmarkScriptRel} exists — you must run it instead of a custom command.\n\nFound: ${autoresearchShPath}\nYour command: ${params.command}\n\nUse: run_experiment({ command: "bash ${benchmarkScriptRel}" }) or run_experiment({ command: "./${benchmarkScriptRel}" })`,
          }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
          } as RunDetails,
        };
      }

      dispatchLoop(ctx, {
        type: "experiment_started",
        startedAt: Date.now(),
        command: params.command,
      });
      updateWidget(ctx);
      if (overlayTui) overlayTui.requestRender();

      const t0 = Date.now();
      const collector = new TimingCollector(t0);
      const iterationStartedAt = runtime.iterationStartedAt;
      const canRecordTiming = () => isAutoresearchActive(runtime) && runtime.iterationStartedAt === iterationStartedAt;
      let runTiming: ExperimentTiming;
      let runEndedAt = t0;
      runtime.lastRunTiming = undefined;
      runtime.lastRunParsed = undefined;
      const automaticStart = `TIMING start run_experiment ${t0}`;
      onUpdate?.({ content: [{ type: "text", text: automaticStart }], details: {} });

      // Spawn the process directly (like the bash tool) for streaming output
      const getTempFile = createTempFileAllocator();
      const { exitCode, killed: timedOut, output, tempFilePath: streamTempFile, actualTotalBytes } = await new Promise<{
        exitCode: number | null;
        killed: boolean;
        output: string;
        tempFilePath: string | undefined;
        actualTotalBytes: number;
      }>((resolve, reject) => {
        let processTimedOut = false;

        const child = spawn("bash", ["-c", params.command], {
          cwd: workDir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        // Rolling buffer for tail truncation (keep 2x what we need)
        const chunks: Buffer[] = [];
        let chunksBytes = 0;
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        // Temp file for full output when it overflows
        let tempFilePath: string | undefined;
        let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
        let totalBytes = 0;

        // Cache for Buffer.concat — only rebuild when chunks change
        let chunksGeneration = 0;
        let cachedGeneration = -1;
        let cachedText = "";

        function getBufferText(): string {
          if (cachedGeneration === chunksGeneration) return cachedText;
          cachedText = Buffer.concat(chunks).toString("utf-8");
          cachedGeneration = chunksGeneration;
          return cachedText;
        }

        // Timer interval — update every second with elapsed time + tail output
        const timerInterval = setInterval(() => {
          if (!onUpdate) return;
          const elapsed = formatElapsed(Date.now() - t0);
          const trunc = truncateTail(getBufferText(), {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });
          onUpdate({
            content: [{ type: "text", text: trunc.content || "" }],
            details: {
              phase: "running",
              elapsed,
              truncation: trunc.truncated ? trunc : undefined,
              fullOutputPath: tempFilePath,
            },
          });
        }, 1000);

        const handleData = (data: Buffer) => {
          totalBytes += data.length;

          // Start writing to temp file once we exceed the threshold
          if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
            tempFilePath = getTempFile();
            tempFileStream = createWriteStream(tempFilePath);
            for (const chunk of chunks) {
              tempFileStream.write(chunk);
            }
          }

          if (tempFileStream) {
            tempFileStream.write(data);
          }

          // Keep rolling buffer of recent data
          chunks.push(data);
          chunksBytes += data.length;

          // Evict old chunks, then trim the first surviving chunk to a line
          // boundary. This avoids splitting multi-byte UTF-8 characters that
          // straddle chunk boundaries (which would produce U+FFFD on decode).
          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift()!;
            chunksBytes -= removed.length;
          }
          // Trim first surviving chunk to a newline boundary
          if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
            const buf = chunks[0];
            const nlIdx = buf.indexOf(0x0a); // '\n'
            if (nlIdx !== -1 && nlIdx < buf.length - 1) {
              chunks[0] = buf.subarray(nlIdx + 1);
              chunksBytes -= nlIdx + 1;
            }
          }

          chunksGeneration++;
        };

        if (child.stdout) child.stdout.on("data", (data: Buffer) => { collector.feed(data, "stdout"); handleData(data); });
        if (child.stderr) child.stderr.on("data", (data: Buffer) => { collector.feed(data, "stderr"); handleData(data); });

        // Timeout
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        if (timeout > 0) {
          timeoutHandle = setTimeout(() => {
            processTimedOut = true;
            if (child.pid) killTree(child.pid);
          }, timeout);
        }

        // Abort signal — kill immediately if pid exists, otherwise queue for spawn.
        // Using child.kill() as fallback ensures the signal is never silently swallowed.
        const onAbort = () => {
          if (child.pid) killTree(child.pid);
          else {
            // pid not yet assigned — try child.kill() which works without pid,
            // and also queue killTree for spawn in case child.kill() isn't enough
            // to clean up the full process tree.
            child.kill();
            child.once("spawn", () => { if (child.pid) killTree(child.pid); });
          }
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        child.on("error", (err) => {
          clearInterval(timerInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (tempFileStream) tempFileStream.end();
          reject(err);
        });

        child.on("close", (code) => {
          clearInterval(timerInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (tempFileStream) tempFileStream.end();

          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }

          const fullBuffer = Buffer.concat(chunks);
          resolve({
            exitCode: code,
            killed: processTimedOut,
            output: fullBuffer.toString("utf-8"),
            tempFilePath,
            actualTotalBytes: totalBytes,
          });
        });
      }).finally(() => {
        runEndedAt = Date.now();
        const spans = collector.finish(runEndedAt);
        spans.push({ name: "run_experiment", startedAt: t0, endedAt: runEndedAt, source: "automatic" });
        runTiming = { ...summarizeTiming(spans), warnings: [...collector.warnings] };
        if (canRecordTiming()) runtime.lastRunTiming = runTiming;
        onUpdate?.({ content: [{ type: "text", text: `${automaticStart}\nTIMING end run_experiment ${runEndedAt}` }], details: { timing: runTiming } });
        dispatchLoop(ctx, { type: "experiment_aborted" });
        updateWidget(ctx);
        if (overlayTui) overlayTui.requestRender();
      });

      const durationSeconds = (runEndedAt - t0) / 1000;
      const benchmarkPassed = exitCode === 0 && !timedOut;

      // Run backpressure checks if benchmark passed and checks file exists
      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksOutput = "";
      let checksDuration = 0;

      const checksPath = autoresearchChecksPath(workDir);
      if (benchmarkPassed && fs.existsSync(checksPath)) {
        const checksTimeout = (params.checks_timeout_seconds ?? 300) * 1000;
        const ct0 = Date.now();
        try {
          const checksResult = await pi.exec("bash", [checksPath], {
            signal,
            timeout: checksTimeout,
            cwd: workDir,
          });
          checksDuration = (Date.now() - ct0) / 1000;
          checksTimedOut = !!checksResult.killed;
          checksPass = checksResult.code === 0 && !checksResult.killed;
          checksOutput = (checksResult.stdout + "\n" + checksResult.stderr).trim();
        } catch (e) {
          checksDuration = (Date.now() - ct0) / 1000;
          checksPass = false;
          checksOutput = e instanceof Error ? e.message : String(e);
        }
        runTiming!.spans.push({ name: "checks", startedAt: ct0, endedAt: Date.now(), source: "automatic" });
      }
      runTiming = { ...summarizeTiming(runTiming!.spans), warnings: [...collector.warnings] };
      if (canRecordTiming()) runtime.lastRunTiming = runTiming;

      // Store run timing & checks result for log_experiment gate
      dispatchLoop(ctx, {
        type: "experiment_finished",
        durationSeconds,
        benchmarkPassed,
        checks: checksPass !== null ? { pass: checksPass, output: checksOutput, duration: checksDuration } : null,
      });

      const passed = benchmarkPassed && (checksPass === null || checksPass);

      // Reuse streaming temp file if it exists, otherwise create one for large output
      let fullOutputPath: string | undefined = streamTempFile;
      const totalLines = output.split("\n").length;
      if (!fullOutputPath && (actualTotalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES)) {
        fullOutputPath = getTempFile();
        fs.writeFileSync(fullOutputPath, output);
      }

      // Wider truncation for TUI display (details.tailOutput)
      const displayTruncation = truncateTail(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      // Tight truncation for LLM context (10 lines / 4KB)
      const llmTruncation = truncateTail(output, {
        maxLines: EXPERIMENT_MAX_LINES,
        maxBytes: EXPERIMENT_MAX_BYTES,
      });

      // Parse structured METRIC lines from output
      const parsedMetricMap = parseMetricLines(output);
      const parsedMetrics = parsedMetricMap.size > 0
        ? Object.fromEntries(parsedMetricMap)
        : null;
      const parsedPrimary = parsedMetricMap.get(state.metricName) ?? null;
      const parsedSecondary: Record<string, number> = {};
      if (parsedMetrics) {
        for (const [k, v] of Object.entries(parsedMetrics)) {
          if (k !== state.metricName) parsedSecondary[k] = v;
        }
      }
      if (canRecordTiming()) {
        runtime.lastRunParsed = { primary: parsedPrimary, metrics: parsedSecondary };
      }

      const details: RunDetails = {
        command: params.command,
        exitCode,
        durationSeconds,
        passed,
        crashed: !passed,
        timedOut,
        tailOutput: displayTruncation.content,
        checksPass,
        checksTimedOut,
        checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
        checksDuration,
        parsedMetrics,
        parsedPrimary,
        metricName: state.metricName,
        metricUnit: state.metricUnit,
        timing: runTiming,
      };

      // Build LLM response
      let text = "";
      if (details.timedOut) {
        text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
      } else if (!benchmarkPassed) {
        text += `💥 FAILED (exit code ${exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
      } else if (checksTimedOut) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `⏰ CHECKS TIMEOUT (.auto/checks.sh) after ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
      } else if (checksPass === false) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `💥 CHECKS FAILED (.auto/checks.sh) in ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
      } else {
        text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
        if (checksPass === true) {
          text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
        }
      }

      text += `${automaticStart}\nTIMING end run_experiment ${runEndedAt}\n`;
      text += `⏱ ${timingSummary(runTiming)}\n`;
      if (collector.warnings.length) text += `Timing notes: ${collector.warnings.join("; ")}\n`;
      const bestKept = findBestMetric(state.results, state.currentSegment, state.bestDirection);
      if (bestKept !== null) {
        text += `📊 Current best ${state.metricName}: ${formatNum(bestKept, state.metricUnit)}\n`;
      }

      // Show parsed METRIC lines to the LLM
      if (parsedMetrics) {
        const secondary = Object.entries(parsedMetrics).filter(([k]) => k !== state.metricName);

        // Human-readable summary
        text += `\n📐 Parsed metrics:`;
        if (parsedPrimary !== null) {
          text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`;
        }
        for (const [name, value] of secondary) {
          // Infer unit from name suffix for display
          const sm = state.secondaryMetrics.find((m) => m.name === name);
          const unit = sm?.unit ?? "";
          text += ` ${name}=${formatNum(value, unit)}`;
        }

        text += `\n(log_experiment auto-fills metric, metrics, and commit from this run unless overridden)\n`;
      }

      text += `\n${llmTruncation.content}`;

      if (llmTruncation.truncated) {
        if (llmTruncation.truncatedBy === "lines") {
          text += `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`;
        } else {
          text += `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
        }
        if (fullOutputPath) {
          text += ` Full output: ${fullOutputPath}`;
        }
        text += `]`;
      }

      if (checksPass === false) {
        text += `\n\n── Checks output (last 80 lines) ──\n${details.checksOutput}`;
      }

      return {
        content: [{ type: "text", text }],
        details: { ...details, truncation: llmTruncation.truncated ? llmTruncation : undefined, fullOutputPath },
      };
    },

    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("run_experiment "));
      text += theme.fg("muted", args.command);
      if (args.timeout_seconds) {
        text += theme.fg("dim", ` (timeout: ${args.timeout_seconds}s)`);
      }
      const comp = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      comp.setText(text);
      return comp;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const PREVIEW_LINES = 5;
      const toText = (content: string) => {
        const comp = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        comp.setText(content);
        return comp;
      };

      if (isPartial) {
        // Streaming: show elapsed timer + tail of output
        const d = result.details as { phase?: string; elapsed?: string; truncation?: any; fullOutputPath?: string } | undefined;
        const elapsed = d?.elapsed ?? "";
        const outputText = result.content[0]?.type === "text" ? result.content[0].text : "";

        let text = theme.fg("warning", `⏳ Running${elapsed ? ` ${elapsed}` : ""}…`);

        // Always show tail of streaming output (like bash tool shows preview lines)
        if (outputText) {
          const lines = outputText.split("\n");
          const maxLines = expanded ? 20 : PREVIEW_LINES;
          const tail = lines.slice(-maxLines).join("\n");
          if (tail.trim()) {
            text += "\n" + theme.fg("dim", tail);
          }
        }

        return toText(text);
      }

      const d = result.details as (RunDetails & { truncation?: any; fullOutputPath?: string }) | undefined;
      if (!d) {
        const t = result.content[0];
        return toText(t?.type === "text" ? t.text : "");
      }

      // Helper: append tail output preview or full output
      const appendOutput = (text: string, output: string): string => {
        if (!output) return text;
        const lines = output.split("\n");
        if (expanded) {
          text += "\n" + theme.fg("dim", output.slice(-2000));
        } else {
          const tail = lines.slice(-PREVIEW_LINES).join("\n");
          if (tail.trim()) {
            const hidden = lines.length - PREVIEW_LINES;
            if (hidden > 0) {
              const expandHint = context?.keyHint ? ` (${context.keyHint("app.tools.expand", "to expand")})` : "";
              text += "\n" + theme.fg("muted", `… ${hidden} more lines`) + expandHint;
            }
            text += "\n" + theme.fg("dim", tail);
          }
        }
        return text;
      };

      if (d.timedOut) {
        let text = theme.fg("error", `⏰ TIMEOUT ${formatDuration(d.durationSeconds)}`);
        text = appendOutput(text, d.tailOutput);
        return toText(text);
      }

      // Helper: format parsed primary metric suffix (empty string if not available)
      const parsedSuffix = d.parsedPrimary !== null
        ? theme.fg("accent", `, ${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`)
        : "";

      if (d.checksTimedOut) {
        let text =
          theme.fg("success", `✅ wall: ${formatDuration(d.durationSeconds)}`) +
          parsedSuffix +
          theme.fg("error", ` ⏰ checks timeout ${formatDuration(d.checksDuration)}`);
        text = appendOutput(text, d.checksOutput);
        return toText(text);
      }

      if (d.checksPass === false) {
        let text =
          theme.fg("success", `✅ wall: ${formatDuration(d.durationSeconds)}`) +
          parsedSuffix +
          theme.fg("error", ` 💥 checks failed ${formatDuration(d.checksDuration)}`);
        text = appendOutput(text, d.checksOutput);
        return toText(text);
      }

      if (d.crashed) {
        let text = theme.fg("error", `💥 FAIL exit=${d.exitCode} ${formatDuration(d.durationSeconds)}`) + parsedSuffix;
        text = appendOutput(text, d.tailOutput);
        return toText(text);
      }

      let text = theme.fg("success", "✅ ");

      // Show wall-clock and parsed primary metric together
      const parts: string[] = [`wall: ${formatDuration(d.durationSeconds)}`];
      if (d.parsedPrimary !== null) {
        parts.push(`${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`);
      }
      text += theme.fg("accent", parts.join(", "));

      if (d.checksPass === true) {
        text += theme.fg("success", ` ✓ checks ${formatDuration(d.checksDuration)}`);
      }

      if (d.truncation?.truncated && d.fullOutputPath) {
        text += theme.fg("warning", " (truncated)");
      }

      if (d.timing) text += "\n" + theme.fg("muted", timingSummary(d.timing));
      text = appendOutput(text, d.tailOutput);

      if (expanded && d.truncation?.truncated && d.fullOutputPath) {
        if (d.truncation.truncatedBy === "lines") {
          text += "\n" + theme.fg("warning", `[Truncated: showing ${d.truncation.outputLines} of ${d.truncation.totalLines} lines. Full output: ${d.fullOutputPath}]`);
        } else {
          text += "\n" + theme.fg("warning", `[Truncated: ${d.truncation.outputLines} lines shown (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${d.fullOutputPath}]`);
        }
      }

      return toText(text);
    },
  });

  // -----------------------------------------------------------------------
  // log_experiment tool
  // -----------------------------------------------------------------------

  registerGatedTool({
    name: "log_experiment",
    label: "Log Experiment",
    description:
      "Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment.",
    promptSnippet:
      "Log experiment result (status, description; metric, metrics, commit auto-fill from last run_experiment)",
    promptGuidelines: [
      "Always call log_experiment after run_experiment to record the result. metric, secondary metrics, and commit are auto-filled from run_experiment / HEAD unless you override them.",
      "log_experiment automatically stages and commits code changes (excluding .auto/ session files) on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (preserving .auto/ files). Do NOT commit or revert manually.",
      "Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. Secondary metrics are for monitoring — they almost never affect keep/discard. Only discard a primary improvement if a secondary metric degraded catastrophically, and explain why in the description.",
      "On 'keep', log_experiment reports marginal confidence (gain over previous best vs. local noise floor) after 3+ runs. ≥2.0× = likely real, <1.0× = within noise — consider a verification rerun before keeping. Advisory only.",
      "If you discover complex but promising optimizations you won't pursue immediately, append them as bullet points to .auto/ideas.md. Don't let good ideas get lost.",
      "Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}. On discard/crash, also include rollback_reason and next_action_hint. Add any other key/value pairs that capture what you learned — dead ends, surprising findings, error details, bottlenecks. This is the only structured memory that survives reverts.",
      "When log_experiment records a retry of a previously discarded idea after its assumptions changed, set asi.revisits_run to the earlier run number (a positive integer) and explain what changed in description. Omit revisits_run for new ideas and verification reruns.",
    ],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: LogParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }
      const workDir = resolveWorkDir(ctx.cwd);
      refreshConfigLimits(ctx.cwd, state);
      const status = params.status as ExperimentResult["status"];
      const parsed = runtime.lastRunParsed;
      const metric = typeof params.metric === "number" && Number.isFinite(params.metric)
        ? params.metric
        : status === "crash"
          ? 0
          : parsed?.primary ?? null;
      if (metric === null) {
        return {
          content: [{ type: "text", text: `❌ Missing metric — pass metric explicitly or emit "METRIC ${state.metricName}=<value>" from run_experiment.` }],
          details: {},
        };
      }
      const secondaryMetrics: Record<string, number> = {
        ...(status === "crash" ? {} : (parsed?.metrics ?? {})),
        ...((params.metrics ?? {}) as Record<string, number>),
      };

      if (status === "keep" && runtime.loop.lastRunPassed === false) {
        return {
          content: [{ type: "text", text: "❌ Cannot keep — the benchmark failed or timed out. Log as 'crash'; failed attempts cannot establish the baseline." }],
          details: {},
        };
      }

      // Gate: prevent "keep" when last run's checks failed
      if (status === "keep" && runtime.loop.lastRunChecks && !runtime.loop.lastRunChecks.pass) {
        return {
          content: [{
            type: "text",
            text: `❌ Cannot keep — .auto/checks.sh failed.\n\n${runtime.loop.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`,
          }],
          details: {},
        };
      }

      // Validate secondary metrics consistency (after first experiment establishes them).
      // Crashes often abort before printing metrics, so don't reject missing metrics on crash.
      if (state.secondaryMetrics.length > 0 && status !== "crash") {
        const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
        const providedNames = new Set(Object.keys(secondaryMetrics));

        // Check for missing metrics
        const missing = [...knownNames].filter((n) => !providedNames.has(n));
        if (missing.length > 0) {
          return {
            content: [{
              type: "text",
              text: `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
            }],
            details: {},
          };
        }

        // Check for new metrics not yet tracked
        const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
        if (newMetrics.length > 0 && !params.force) {
          return {
            content: [{
              type: "text",
              text: `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
            }],
            details: {},
          };
        }
      }

      // Resolve commit SHA from explicit arg or current git HEAD.
      let commitSha = typeof params.commit === "string" ? params.commit.trim().slice(0, 7) : "";
      if (!commitSha) {
        try {
          const headResult = await pi.exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: workDir, timeout: 5000 });
          if (headResult.code === 0) commitSha = (headResult.stdout || "").trim().slice(0, 7);
        } catch {
          // Non-git workdir: leave commit empty
        }
      }

      // ASI: agent-supplied free-form diagnostics
      const mergedASI = (params.asi && Object.keys(params.asi).length > 0)
        ? params.asi as ASI
        : undefined;

      // Capture previous best BEFORE recording this run so we can report marginal delta.
      const prevBest = findBestMetric(state.results, state.currentSegment, state.bestDirection);

      // Cycle boundaries are log-entry to log-entry: the previous log's git/hooks,
      // agent reasoning, editing/other tools, benchmark and checks are all covered.
      const loopEndedAt = Date.now();
      const timing = runtime.lastRunTiming ? {
        ...summarizeTiming(runtime.lastRunTiming.spans, runtime.iterationStartedAt, loopEndedAt),
        warnings: runtime.lastRunTiming.warnings,
      } : undefined;
      runtime.iterationStartedAt = loopEndedAt;
      runtime.lastRunTiming = undefined;
      runtime.lastRunParsed = undefined;
      const experiment: ExperimentResult = {
        commit: commitSha,
        metric,
        metrics: secondaryMetrics,
        status,
        description: params.description,
        timestamp: Date.now(),
        segment: state.currentSegment,
        confidence: null,
        asi: mergedASI,
        timing,
        metricName: state.metricName,
        metricUnit: state.metricUnit,
        direction: state.bestDirection,
      };

      state.results.push(experiment);

      // Register any new secondary metric names
      for (const name of Object.keys(secondaryMetrics)) {
        if (!state.secondaryMetrics.find((m) => m.name === name)) {
          let unit = "";
          if (name.endsWith("µs")) unit = "µs";
          else if (name.endsWith("_ms")) unit = "ms";
          else if (name.endsWith("_s") || name.endsWith("_sec")) unit = "s";
          else if (name.endsWith("_kb")) unit = "kb";
          else if (name.endsWith("_mb")) unit = "mb";
          state.secondaryMetrics.push({ name, unit });
        }
      }

      // Baseline = first successful kept run in current segment
      state.bestMetric = findBaselineMetric(state.results, state.currentSegment);

      // Compute marginal confidence score (latest kept gain / local noise floor)
      state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
      experiment.confidence = state.confidence;

      // Build response text
      const segmentCount = currentResults(state.results, state.currentSegment).length;
      let text = `Logged #${state.results.length}: ${experiment.status} — ${experiment.description}`;

      if (state.bestMetric !== null) {
        text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
        if (segmentCount > 1 && metric > 0 && (status === "keep" || status === "discard")) {
          const deltas: string[] = [];
          if (prevBest !== null && prevBest !== 0 && metric !== prevBest) {
            const db = metric - prevBest;
            const pb = ((db / Math.abs(prevBest)) * 100).toFixed(1);
            deltas.push(`${db > 0 ? "+" : ""}${pb}% vs best`);
          }
          if (state.bestMetric !== 0 && metric !== state.bestMetric) {
            const d0 = metric - state.bestMetric;
            const p0 = ((d0 / Math.abs(state.bestMetric)) * 100).toFixed(1);
            deltas.push(`${d0 > 0 ? "+" : ""}${p0}% vs baseline`);
          }
          text += ` | this: ${formatNum(metric, state.metricUnit)}${deltas.length ? ` (${deltas.join(", ")})` : ""}`;
        }
      }

      if (timing) text += `\n⏱ ${timingSummary(timing)}`;
      const original = firstComparableBaseline(state.results, state.metricName, state.metricUnit, state.bestDirection);
      if (original && original.segment !== state.currentSegment && original.metric !== 0 && status === "keep") {
        const pct = (metric - original.metric) / Math.abs(original.metric) * 100;
        text += `\nOverall: ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% from first baseline`;
      }

      // Show secondary metrics
      if (Object.keys(secondaryMetrics).length > 0) {
        const baselines = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
        const parts: string[] = [];
        for (const [name, value] of Object.entries(secondaryMetrics)) {
          const def = state.secondaryMetrics.find((m) => m.name === name);
          const unit = def?.unit ?? "";
          let part = `${name}: ${formatNum(value, unit)}`;
          const bv = baselines[name];
          if (bv !== undefined && state.results.length > 1 && bv !== 0) {
            const d = value - bv;
            const p = ((d / bv) * 100).toFixed(1);
            const s = d > 0 ? "+" : "";
            part += ` (${s}${p}%)`;
          }
          parts.push(part);
        }
        text += `\nSecondary: ${parts.join("  ")}`;
      }

      // Show ASI summary
      if (mergedASI) {
        const asiParts: string[] = [];
        for (const [k, v] of Object.entries(mergedASI)) {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
        }
        if (asiParts.length > 0) {
          text += `\n📋 ASI: ${asiParts.join(" | ")}`;
        }
      }

      // Show marginal confidence score on kept improvements only (never say "likely real" on a discard/crash)
      if (status === "keep" && state.confidence !== null) {
        const confStr = state.confidence.toFixed(1);
        if (state.confidence >= 2.0) {
          text += `\n📊 Marginal confidence: ${confStr}× noise floor — gain over previous best is likely real`;
        } else if (state.confidence >= 1.0) {
          text += `\n📊 Marginal confidence: ${confStr}× noise floor — gain over previous best is marginal`;
        } else {
          text += `\n⚠️ Marginal confidence: ${confStr}× noise floor — gain over previous best is within noise. Consider a verification rerun.`;
        }
      }

      text += `\n(${segmentCount} experiments`;
      if (state.maxExperiments !== null) {
        text += ` / ${state.maxExperiments} max`;
      }
      text += `)`;

      const gitExcludes = [
        `:(exclude,glob)**/${AUTO_DIR}`,
        `:(exclude,glob)**/${AUTO_DIR}/**`,
        `:(exclude,glob)**/autoresearch.*`,
        `:(exclude,glob)**/autoresearch.*/**`,
      ];

      // Auto-commit code changes only on keep — keep .auto/ session files out of code commits
      if (status === "keep") {
        try {
          const resultData: Record<string, unknown> = {
            status,
            [state.metricName || "metric"]: metric,
            ...secondaryMetrics,
          };
          const trailerJson = JSON.stringify(resultData);
          const commitMsg = `${params.description}\n\nResult: ${trailerJson}`;

          const execOpts = { cwd: workDir, timeout: 10000 };
          const addResult = await pi.exec("git", ["add", "-A", "--", ".", ...gitExcludes], execOpts);
          if (addResult.code !== 0) {
            const addErr = (addResult.stdout + addResult.stderr).trim();
            throw new Error(`git add failed (exit ${addResult.code}): ${addErr.slice(0, 200)}`);
          }

          const diffResult = await pi.exec("git", ["diff", "--cached", "--quiet"], execOpts);
          if (diffResult.code === 0) {
            text += `\n📝 Git: nothing to commit (working tree clean)`;
          } else {
            const gitResult = await pi.exec("git", ["commit", "-m", commitMsg], execOpts);
            const gitOutput = (gitResult.stdout + gitResult.stderr).trim();
            if (gitResult.code === 0) {
              const firstLine = gitOutput.split("\n")[0] || "";
              text += `\n📝 Git: committed — ${firstLine}`;

              try {
                const shaResult = await pi.exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: workDir, timeout: 5000 });
                const newSha = (shaResult.stdout || "").trim();
                if (newSha && newSha.length >= 7) {
                  experiment.commit = newSha;
                }
              } catch {
                // Keep the original commit hash if rev-parse fails
              }
            } else {
              text += `\n⚠️ Git commit failed (exit ${gitResult.code}): ${gitOutput.slice(0, 200)}`;
            }
          }
        } catch (e) {
          text += `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      const jsonlEntry: Record<string, unknown> = {
        run: state.results.length,
        ...experiment,
      };
      if (!mergedASI) delete jsonlEntry.asi;
      const jsonlLine = JSON.stringify(jsonlEntry);

      try {
        const jsonlPath = autoresearchJsonlPath(workDir);
        ensureParentDir(jsonlPath);
        fs.appendFileSync(jsonlPath, jsonlLine + "\n");
        broadcastDashboardUpdate(workDir);
      } catch (e) {
        text += `\n⚠️ Failed to write .auto/log.jsonl: ${e instanceof Error ? e.message : String(e)}`;
      }

      if (status !== "keep") {
        try {
          const revertScript = `
            git reset -q HEAD -- . ':(exclude,glob)**/${AUTO_DIR}' ':(exclude,glob)**/${AUTO_DIR}/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**' 2>/dev/null || true
            git checkout -- . ':(exclude,glob)**/${AUTO_DIR}' ':(exclude,glob)**/${AUTO_DIR}/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'
            git clean -fd -e '${AUTO_DIR}' -e '**/${AUTO_DIR}/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' 2>/dev/null
          `;
          await pi.exec("bash", ["-c", revertScript], { cwd: workDir, timeout: 10000 });
          text += `\n📝 Git: reverted changes (${status}) — autoresearch files preserved`;
        } catch (e) {
          text += `\n⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      const afterSteer = await fireHook({
        event: "after",
        cwd: workDir,
        run_entry: jsonlEntry,
        session: buildSessionSnapshot(state),
      });
      if (afterSteer) pi.sendUserMessage(afterSteer, { deliverAs: "steer" });

      const wallClockSeconds = runtime.loop.lastRunDuration;
      const limitReached = state.maxExperiments !== null && segmentCount >= state.maxExperiments;
      if (limitReached) {
        text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`;
        recordAutoresearchActivation(workDir, false);
        dispatchLoop(ctx, { type: "experiment_logged", limitReached: true });
      } else {
        dispatchLoop(ctx, { type: "experiment_logged", limitReached: false });
        if (isAutoresearchActive(runtime)) {
          text += "\n\nBefore choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.";
          const beforeSteer = await fireHook({
            event: "before",
            cwd: workDir,
            next_run: state.results.length + 1,
            last_run: jsonlEntry,
            session: buildSessionSnapshot(state),
          });
          if (beforeSteer) pi.sendUserMessage(beforeSteer, { deliverAs: "steer" });
        }
      }

      updateWidget(ctx);

      // Refresh fullscreen overlay if open
      if (overlayTui) overlayTui.requestRender();

      return {
        content: [{ type: "text", text }],
        details: {
          experiment: { ...experiment, metrics: { ...experiment.metrics } },
          state: cloneExperimentState(state),
          wallClockSeconds,
        } as LogDetails,
      };
    },

    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("log_experiment "));
      const color =
        args.status === "keep"
          ? "success"
          : args.status === "crash" || args.status === "checks_failed"
            ? "error"
            : "warning";
      const status = String(args.status ?? "");
      text += theme.fg(color, status);
      text += " " + theme.fg("dim", args.description);
      const comp = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      comp.setText(text);
      return comp;
    },

    renderResult(result, _options, theme, context) {
      const toText = (content: string) => {
        const comp = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        comp.setText(content);
        return comp;
      };
      const d = result.details as LogDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return toText(t?.type === "text" ? t.text : "");
      }

      const { experiment: exp, state: s } = d;
      const color =
        exp.status === "keep"
          ? "success"
          : exp.status === "crash" || exp.status === "checks_failed"
            ? "error"
            : "warning";
      const icon =
        exp.status === "keep" ? "✓" : exp.status === "crash" ? "✗" : exp.status === "checks_failed" ? "⚠" : "–";

      let text =
        theme.fg(color, `${icon} `) +
        theme.fg("accent", `#${s.results.length}`);

      // Show wall-clock and primary metric together
      const metricParts: string[] = [];
      if (d.wallClockSeconds !== null && d.wallClockSeconds !== undefined) {
        metricParts.push(`wall: ${formatDuration(d.wallClockSeconds)}`);
      }
      if (exp.metric > 0) {
        metricParts.push(`${s.metricName}: ${formatNum(exp.metric, s.metricUnit)}`);
      }
      if (metricParts.length > 0) {
        text += theme.fg("dim", " (") + theme.fg("warning", metricParts.join(theme.fg("dim", ", "))) + theme.fg("dim", ")");
      }

      text += " " + theme.fg("muted", exp.description);

      // Show best metric for context (overall best, not just this run)
      if (s.bestMetric !== null) {
        // Find the actual best kept metric in the current segment
        let best = s.bestMetric;
        for (const r of s.results) {
          if (r.segment === s.currentSegment && r.status === "keep" && r.metric > 0) {
            if (isBetter(r.metric, best, s.bestDirection)) best = r.metric;
          }
        }
        text +=
          theme.fg("dim", " │ ") +
          theme.fg("warning", `★ best: ${formatNum(best, s.metricUnit)}`);
      }

      // Show secondary metrics inline
      if (Object.keys(exp.metrics).length > 0) {
        const parts: string[] = [];
        for (const [name, value] of Object.entries(exp.metrics)) {
          const def = s.secondaryMetrics.find((m) => m.name === name);
          parts.push(`${name}=${formatNum(value, def?.unit ?? "")}`);
        }
        text += theme.fg("dim", `  ${parts.join(" ")}`);
      }

      if (exp.timing) text += "\n" + theme.fg("muted", timingSummary(exp.timing));

      const revisitsRun = exp.asi?.revisits_run;
      if (typeof revisitsRun === "number" && Number.isInteger(revisitsRun) && revisitsRun > 0) {
        text += "\n" + theme.fg("accent", `↻ Revisiting #${revisitsRun}`);
      }

      return toText(text);
    },
  });

  // -----------------------------------------------------------------------
  // Fullscreen scrollable dashboard overlay
  // -----------------------------------------------------------------------

  function canOpenFullscreenDashboard(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui";
  }

  async function openFullscreenDashboard(ctx: ExtensionContext): Promise<void> {
    if (!canOpenFullscreenDashboard(ctx)) {
      ctx.ui.notify("The fullscreen dashboard is only available in TUI mode", "info");
      return;
    }

    const runtime = getRuntime(ctx);
    const state = runtime.state;
    if (!isAutoresearchActive(runtime)) {
      ctx.ui.notify("Autoresearch mode is not active", "info");
      return;
    }
    if (state.results.length === 0) {
      ctx.ui.notify("No experiments yet", "info");
      return;
    }

    await ctx.ui.custom<void>(
      (tui, theme, kb, done) => {
      let scrollOffset = 0;
      let lastViewportRows = 8;
      let lastTotalRows = 0;
      overlayTui = tui;

      spinnerInterval = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
        if (runtime.loop.runningExperiment) tui.requestRender();
      }, 80);

      const buildOverlayContent = (renderWidth: number): string[] => {
        const content = renderDashboardLines(state, renderWidth, theme, 0);
        if (runtime.loop.runningExperiment) {
          const elapsed = formatElapsed(Date.now() - runtime.loop.runningExperiment.startedAt);
          const frame = SPINNER[spinnerFrame % SPINNER.length];
          const nextIdx = state.results.length + 1;
          content.push(
            truncateToWidth(
              `  ${theme.fg("dim", String(nextIdx).padEnd(3))}` +
                theme.fg("warning", `${frame} running… ${elapsed}`),
              renderWidth,
              "…",
              true
            )
          );
        }
        return content;
      };

      return {
        render(width: number): string[] {
          const { height } = getTuiSize(tui);
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          // Match overlayOptions.maxHeight so pi doesn't clip the footer.
          const overlayRows = Math.max(4, Math.floor(height * 0.9));
          const viewportRows = Math.max(1, overlayRows - 3);
          const content = buildOverlayContent(Math.max(4, safeWidth - 2));

          const totalRows = content.length;
          const maxScroll = Math.max(0, totalRows - viewportRows);
          scrollOffset = clamp(scrollOffset, 0, maxScroll);
          lastViewportRows = viewportRows;
          lastTotalRows = totalRows;

          const out: string[] = [];

          // Full box border: the overlay floats over the transcript, so every
          // row must be padded to full width or the background bleeds through.
          const innerWidth = Math.max(4, safeWidth - 2);
          const border = (text: string) => theme.fg("border", text);
          const boxRow = (line: string): string => {
            const clipped = truncateToWidth(line, innerWidth, "…", true);
            const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
            return border("│") + clipped + pad + border("│");
          };

          const title = truncateDisplayText(
            `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
            Math.max(0, innerWidth - 2)
          );

          out.push(border(`╭${"─".repeat(innerWidth)}╮`));
          out.push(boxRow(` ${theme.fg("accent", title)}`));

          const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
          for (const line of visible) out.push(boxRow(line));
          for (let i = visible.length; i < viewportRows; i++) out.push(boxRow(""));

          const scrollInfo = totalRows > viewportRows
            ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, totalRows)}/${totalRows}`
            : "";
          const helpText = safeWidth >= 85
            ? ` ↑↓/j/k scroll • pgup/pgdn • g/G • esc close${scrollInfo} `
            : ` j/k scroll • esc close${scrollInfo} `;
          const footFill = Math.max(0, safeWidth - 2 - visibleWidth(helpText));

          out.push(
            truncateToWidth(
              border("╰" + "─".repeat(footFill)) + theme.fg("dim", helpText) + border("╯"),
              safeWidth,
              "…",
              true
            )
          );

          return out;
        },

        handleInput(data: string): void {
          const maxScroll = Math.max(0, lastTotalRows - lastViewportRows);

          if ((kb ? kb.matches(data, "tui.select.cancel") : matchesKey(data, "escape")) || data === "q") {
            done(undefined);
            return;
          }
          if ((kb ? kb.matches(data, "tui.select.up") : matchesKey(data, "up")) || data === "k") {
            scrollOffset = Math.max(0, scrollOffset - 1);
          } else if ((kb ? kb.matches(data, "tui.select.down") : matchesKey(data, "down")) || data === "j") {
            scrollOffset = Math.min(maxScroll, scrollOffset + 1);
          } else if ((kb ? kb.matches(data, "tui.select.pageUp") : matchesKey(data, "pageUp")) || data === "u") {
            scrollOffset = Math.max(0, scrollOffset - lastViewportRows);
          } else if ((kb ? kb.matches(data, "tui.select.pageDown") : matchesKey(data, "pageDown")) || data === "d") {
            scrollOffset = Math.min(maxScroll, scrollOffset + lastViewportRows);
          } else if (data === "g") {
            scrollOffset = 0;
          } else if (data === "G") {
            scrollOffset = maxScroll;
          }
          tui.requestRender();
        },

        invalidate(): void {},

        dispose(): void {
          clearOverlay();
        },
      };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "95%",
          maxHeight: "90%",
          anchor: "center" as const,
        },
      }
    );
  }

  // -----------------------------------------------------------------------
  // Opt-in keyboard shortcuts (none bound by default; see shortcuts.ts)
  // -----------------------------------------------------------------------

  const shortcutActions: Record<
    (typeof SHORTCUT_ACTIONS)[number],
    { description: string; handler: (ctx: ExtensionContext) => Promise<void> | void }
  > = {
    fullscreenDashboard: {
      description: "Fullscreen autoresearch dashboard",
      handler: openFullscreenDashboard,
    },
    export: {
      description: "Open the autoresearch browser dashboard",
      handler: (ctx) => exportDashboard(ctx),
    },
    off: {
      description: "Turn autoresearch mode off",
      handler: (ctx) => turnAutoresearchOff(ctx),
    },
  };

  for (const action of SHORTCUT_ACTIONS) {
    const chord = shortcuts[action];
    if (chord) pi.registerShortcut(chord, shortcutActions[action]);
  }

  // -----------------------------------------------------------------------
  // Export: local live dashboard
  // -----------------------------------------------------------------------

  const TITLE_PLACEHOLDER = "__AUTORESEARCH_TITLE__";
  const LOGO_PLACEHOLDER = "__AUTORESEARCH_LOGO__";

  let cachedPackageRoot: string | null = null;

  function packageRoot(): string {
    if (cachedPackageRoot) return cachedPackageRoot;
    const extensionDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
    cachedPackageRoot = path.resolve(extensionDir, "../..");
    return cachedPackageRoot;
  }

  function templatePath(): string {
    return path.join(packageRoot(), "assets/template.html");
  }

  function readTemplate(): string {
    return fs.readFileSync(templatePath(), "utf-8");
  }

  let cachedLogoDataUrl: string | null = null;

  function logoDataUrl(): string {
    if (cachedLogoDataUrl) return cachedLogoDataUrl;
    const logoPath = path.join(packageRoot(), "assets/logo.webp");
    const bytes = fs.readFileSync(logoPath);
    cachedLogoDataUrl = `data:image/webp;base64,${bytes.toString("base64")}`;
    return cachedLogoDataUrl;
  }

  function readJsonlContent(workDir: string): string {
    return fs.readFileSync(autoresearchJsonlPath(workDir), "utf-8").trim();
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function injectDataIntoTemplate(template: string, title: string): string {
    const escapedTitle = escapeHtml(title);
    return template.replace(TITLE_PLACEHOLDER, () => escapedTitle);
  }

  let dashboardServer: Server | null = null;
  let dashboardServerPort: number | null = null;
  let dashboardServerWorkDir: string | null = null;
  let dashboardServerHtmlPath: string | null = null;
  let dashboardExportDir: string | null = null;
  const dashboardSseClients = new Set<ServerResponse>();

  function cleanupDashboardExportDir(dir: string | null): void {
    if (!dir) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  function openInBrowser(url: string): void {
    const child = process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], {
          detached: true,
          shell: true,
          stdio: "ignore",
        })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
          detached: true,
          stdio: "ignore",
        });
    // Swallow launcher errors (e.g. xdg-open missing); caller prints the URL
    // so the user can open it manually.
    child.on("error", () => { /* ignore */ });
    child.unref();
  }

  function stopDashboardServer(): void {
    for (const client of dashboardSseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    dashboardSseClients.clear();

    if (dashboardServer) {
      try { dashboardServer.close(); } catch { /* ignore */ }
    }

    cleanupDashboardExportDir(dashboardExportDir);
    dashboardServer = null;
    dashboardServerPort = null;
    dashboardServerWorkDir = null;
    dashboardServerHtmlPath = null;
    dashboardExportDir = null;
  }

  function writeDashboardFile(workDir: string): { exportDir: string; htmlPath: string } {
    const jsonlContent = readJsonlContent(workDir);
    const sessionName = extractAutoresearchSessionName(jsonlContent);
    const html = injectDataIntoTemplate(readTemplate(), sessionName)
      .replace(LOGO_PLACEHOLDER, logoDataUrl());
    const exportDir = fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-dashboard-"));
    const htmlPath = path.join(exportDir, "index.html");
    fs.writeFileSync(htmlPath, html);
    return { exportDir, htmlPath };
  }

  const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".jsonl": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
  };

  function fileContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return CONTENT_TYPES[ext] ?? "application/octet-stream";
  }

  function resolveServedFile(workDir: string, requestPath: string): string | null {
    if (requestPath === "/") return dashboardServerHtmlPath;
    if (requestPath === "/autoresearch.jsonl") return autoresearchJsonlPath(workDir);
    return null;
  }

  function registerSseClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    dashboardSseClients.add(res);
    res.on("close", () => dashboardSseClients.delete(res));
  }

  function broadcastDashboardUpdate(workDir: string): void {
    if (!dashboardServer || dashboardServerWorkDir !== workDir) return;
    for (const res of dashboardSseClients) {
      try {
        res.write("event: jsonl-updated\n");
        res.write(`data: ${Date.now()}\n\n`);
      } catch {
        dashboardSseClients.delete(res);
      }
    }
  }

  function startStaticServer(
    workDir: string,
    dashboardHtmlPath: string,
    exportDir: string,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const resolvedWorkDir = path.resolve(workDir);
      const resolvedDashboardHtmlPath = path.resolve(dashboardHtmlPath);

      if (dashboardServer && dashboardServerWorkDir === resolvedWorkDir && dashboardServerPort) {
        cleanupDashboardExportDir(dashboardExportDir);
        dashboardExportDir = exportDir;
        dashboardServerHtmlPath = resolvedDashboardHtmlPath;
        resolve(dashboardServerPort);
        return;
      }

      stopDashboardServer();
      dashboardExportDir = exportDir;
      dashboardServerHtmlPath = resolvedDashboardHtmlPath;

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (url.pathname === "/events") {
          registerSseClient(res);
          return;
        }

        const filePath = resolveServedFile(resolvedWorkDir, url.pathname);
        if (!filePath) {
          res.writeHead(404);
          res.end();
          return;
        }

        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": fileContentType(filePath) });
          res.end(data);
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to bind dashboard server"));
          return;
        }
        dashboardServer = server;
        dashboardServerPort = address.port;
        dashboardServerWorkDir = resolvedWorkDir;
        resolve(address.port);
      });

      server.on("error", reject);
    });
  }

  async function exportDashboard(ctx: ExtensionContext): Promise<void> {
    const workDir = resolveWorkDir(ctx.cwd);
    const jsonlPath = autoresearchJsonlPath(workDir);

    if (!fs.existsSync(jsonlPath)) {
      ctx.ui.notify(`No ${path.basename(jsonlPath)} found \u2014 run some experiments first`, "error");
      return;
    }

    try {
      const { exportDir, htmlPath } = writeDashboardFile(workDir);
      const port = await startStaticServer(workDir, htmlPath, exportDir);
      const url = `http://127.0.0.1:${port}`;
      openInBrowser(url);
      ctx.ui.notify(`Dashboard at ${url} (live updates)`, "info");
    } catch (error) {
      ctx.ui.notify(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  }

  // -----------------------------------------------------------------------
  // /autoresearch command — enter autoresearch mode
  // -----------------------------------------------------------------------

  function stopAutoresearchLoop(ctx: ExtensionContext): void {
    recordAutoresearchActivation(resolveWorkDir(ctx.cwd), false);
    dispatchLoop(ctx, { type: "deactivate", inActiveRun: !ctx.isIdle() }, { forceSyncTools: true });
    stopDashboardServer();
    clearSessionUi(ctx);
  }

  function pauseAutoresearch(ctx: ExtensionContext): void {
    recordAutoresearchActivation(resolveWorkDir(ctx.cwd), false, true);
    dispatchLoop(ctx, { type: "pause", inActiveRun: !ctx.isIdle() }, { forceSyncTools: true });
    updateWidget(ctx);
    ctx.ui.notify("Autoresearch paused — resume with '/autoresearch resume'; stop with finalize or delete .auto", "info");
  }

  function turnAutoresearchOff(ctx: ExtensionContext): void {
    if (hasAutoresearchRules(ctx)) {
      pauseAutoresearch(ctx);
      return;
    }
    const wasRunning = !ctx.isIdle();
    stopAutoresearchLoop(ctx);
    ctx.ui.notify(
      wasRunning ? "Autoresearch mode OFF — aborting current run" : "Autoresearch mode OFF",
      "info"
    );
  }

  const FINALIZE_KICKOFF = "/skill:autoresearch-finalize";

  async function finalizeAutoresearch(ctx: ExtensionCommandContext): Promise<void> {
    if (!hasLoggedExperiment(ctx.cwd) && hasAutoresearchRules(ctx)) {
      await turnOffAndSettle(ctx);
      return;
    }
    if (!hasLoggedExperiment(ctx.cwd)) {
      ctx.ui.notify("No logged experiments to finalize — use '/autoresearch <goal>' to start a session", "error");
      return;
    }
    if (isAutoresearchActive(getRuntime(ctx)) || getRuntime(ctx).loop.phase === "paused") await turnOffAndSettle(ctx);
    ctx.ui.notify("Loading autoresearch-finalize skill", "info");
    sendWhenReady(ctx, FINALIZE_KICKOFF);
  }

  // An aborted run never drains its queue, so a skill queued as a follow-up
  // would be stranded there. Waiting out the abort lets it start a fresh turn.
  async function turnOffAndSettle(ctx: ExtensionCommandContext): Promise<void> {
    stopAutoresearchLoop(ctx);
    ctx.ui.notify("Autoresearch finalized — loop stopped", "info");
    await ctx.waitForIdle();
  }

  pi.registerCommand("autoresearch", {
    description: "Start, stop, finalize, clear, export, or open dashboards for autoresearch mode",
    getArgumentCompletions: getAutoresearchArgumentCompletions,
    handler: async (args, ctx) => {
      const runtime = getRuntime(ctx);
      const trimmedArgs = (args ?? "").trim();
      const command = trimmedArgs.toLowerCase();

      if (isHelpRequest(command)) {
        ctx.ui.notify(renderAutoresearchHelp(), "info");
        return;
      }

      if (command === "pause") {
        pauseAutoresearch(ctx);
        return;
      }

      if (command === "off") {
        turnAutoresearchOff(ctx);
        return;
      }

      if (command === "finalize") {
        await finalizeAutoresearch(ctx);
        return;
      }

      if (command === "export") {
        await exportDashboard(ctx);
        return;
      }

      if (command === "dashboard") {
        await openFullscreenDashboard(ctx);
        return;
      }

      if (command === "clear") {
        const workDir = resolveWorkDir(ctx.cwd);
        const jsonlPaths = sessionFileCandidates(workDir, "log");
        const paused = hasAutoresearchRules(ctx);
        recordAutoresearchActivation(workDir, false, paused);
        dispatchLoop(ctx, { type: paused ? "pause" : "deactivate", inActiveRun: !ctx.isIdle() }, { forceSyncTools: true });
        runtime.state = createExperimentState();
        stopDashboardServer();
        updateWidget(ctx);

        const deletedPaths: string[] = [];
        for (const jsonlPath of Object.values(jsonlPaths)) {
          if (!fs.existsSync(jsonlPath)) continue;
          try {
            fs.unlinkSync(jsonlPath);
            deletedPaths.push(path.relative(workDir, jsonlPath) || path.basename(jsonlPath));
          } catch (error) {
            ctx.ui.notify(
              `Failed to delete ${path.relative(workDir, jsonlPath) || path.basename(jsonlPath)}: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
            return;
          }
        }

        if (deletedPaths.length > 0) {
          ctx.ui.notify(`Deleted ${deletedPaths.join(", ")}. Autoresearch ${paused ? "paused" : "OFF"}`, "info");
        } else {
          ctx.ui.notify(`No session log found. Autoresearch ${paused ? "paused" : "OFF"}`, "info");
        }
        return;
      }

      if (command === "resume" && !hasAutoresearchRules(ctx) && !fs.existsSync(autoresearchJsonlPath(resolveWorkDir(ctx.cwd)))) {
        ctx.ui.notify("No autoresearch session to resume — start with '/autoresearch <goal>'", "info");
        return;
      }

      if (isAutoresearchActive(runtime)) {
        ctx.ui.notify("Autoresearch already active — use '/autoresearch pause' to pause or finalize to stop", "info");
        return;
      }

      const workDir = resolveWorkDir(ctx.cwd);
      recordAutoresearchActivation(workDir, true);
      dispatchLoop(ctx, { type: "activate", resetTurns: true }, { forceSyncTools: true });
      updateWidget(ctx);
      const rulesLoaded = hasAutoresearchRules(ctx);
      const goalText = command === "resume" || command === "on" ? "" : trimmedArgs;
      // No .auto/prompt.md yet — load the create skill so the agent follows the
      // setup guidelines. `/skill:<name>` is expanded to the full SKILL.md when
      // sent with `expandPromptTemplates` (see sendWhenReady), and trailing args
      // are appended as the session goal. Must be sent as its own message that
      // STARTS with `/skill:` so expansion triggers — don't prepend hook output.
      const kickoff = rulesLoaded
        ? ["Autoresearch mode active.", goalText, BENCHMARK_GUARDRAIL].filter(Boolean).join(" ")
        : ["/skill:autoresearch-create", goalText, BENCHMARK_GUARDRAIL].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

      ctx.ui.notify(
        rulesLoaded
          ? "Autoresearch mode ON — rules loaded from .auto/prompt.md"
          : "Autoresearch mode ON — no .auto/prompt.md found, loading autoresearch-create skill",
        "info",
      );

      const state = runtime.state;
      const activationSteer = await fireHook({
        event: "before",
        cwd: workDir,
        next_run: state.results.length + 1,
        last_run: readLastRun(workDir),
        session: buildSessionSnapshot(state),
      });

      // Prepend hook output only when prompt.md exists; otherwise the message
      // must stay `/skill:...`-prefixed for command expansion.
      const message = activationSteer && rulesLoaded ? `${activationSteer}\n\n${kickoff}` : kickoff;
      sendWhenReady(ctx, message);
    },
  });
}
