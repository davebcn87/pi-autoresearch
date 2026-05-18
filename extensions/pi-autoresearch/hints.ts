import { completeSimple, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_MAX_RECENT_RUNS = 8;
const MIN_MAX_RECENT_RUNS = 1;
const MAX_MAX_RECENT_RUNS = 20;

const DEFAULT_MAX_CALLS_PER_SESSION = 5;
const MIN_MAX_CALLS_PER_SESSION = 1;
const MAX_MAX_CALLS_PER_SESSION = 20;

const DEFAULT_TIMEOUT_SECONDS = 120;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 600;

const DEFAULT_THINKING_LEVEL: HintThinkingLevel = "high";
const HINT_FILE_MAX_CHARS = 3000;
const EXTRA_CONTEXT_MAX_CHARS = 1500;
const ASI_VALUE_MAX_CHARS = 180;

type HintThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface HintConfig {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  thinkingLevel: HintThinkingLevel;
  maxRecentRuns: number;
  maxCallsPerSession: number;
  timeoutSeconds: number;
}

export interface HintRun {
  run?: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  segment: number;
  confidence: number | null;
  asi?: Record<string, unknown>;
}

export interface HintExperimentState {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  bestMetric: number | null;
  currentSegment: number;
  results: HintRun[];
  confidence: number | null;
}

export interface HintPromptInput {
  state: HintExperimentState;
  workDir: string;
  question: string;
  extraContext?: string;
  maxRecentRuns: number;
  readFile?: (filePath: string) => string;
}

export interface HintRequestInput extends HintPromptInput {
  model: Model;
  apiKey?: string;
  headers?: Record<string, string>;
  thinkingLevel: HintThinkingLevel;
  timeoutSeconds: number;
  signal?: AbortSignal;
  complete?: typeof completeSimple;
}

export interface HintRequestResult {
  text: string;
  durationMs: number;
  promptBytes: number;
  stopReason: AssistantMessage["stopReason"];
  usage: AssistantMessage["usage"] | null;
}

const HINT_SYSTEM_PROMPT = [
  "You are a senior research advisor for pi-autoresearch.",
  "Give concise strategy advice only. You cannot edit files, run commands, commit, or revert changes.",
  "Return a likely diagnosis, 1-3 next experiments, and key failure modes.",
  "The caller must validate every suggestion with run_experiment and log_experiment.",
].join(" ");

const HINT_THINKING_LEVELS = new Set<HintThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const ASI_HINT_KEYS = [
  "hypothesis",
  "next_action_hint",
  "next_focus",
  "rollback_reason",
  "learned",
  "bottleneck",
  "failure_mode",
  "error",
];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trimString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function thinkingLevelFrom(value: unknown): HintThinkingLevel {
  return typeof value === "string" && HINT_THINKING_LEVELS.has(value as HintThinkingLevel)
    ? value as HintThinkingLevel
    : DEFAULT_THINKING_LEVEL;
}

export function resolveHintConfig(config: { hints?: unknown } | null | undefined): HintConfig {
  const raw = isObjectRecord(config?.hints) ? config.hints : null;
  if (!raw || raw.enabled !== true) {
    return {
      enabled: false,
      provider: null,
      model: null,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      maxRecentRuns: DEFAULT_MAX_RECENT_RUNS,
      maxCallsPerSession: DEFAULT_MAX_CALLS_PER_SESSION,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    };
  }

  return {
    enabled: true,
    provider: trimString(raw.provider),
    model: trimString(raw.model),
    thinkingLevel: thinkingLevelFrom(raw.thinkingLevel),
    maxRecentRuns: clampNumber(
      raw.maxRecentRuns,
      DEFAULT_MAX_RECENT_RUNS,
      MIN_MAX_RECENT_RUNS,
      MAX_MAX_RECENT_RUNS,
    ),
    maxCallsPerSession: clampNumber(
      raw.maxCallsPerSession,
      DEFAULT_MAX_CALLS_PER_SESSION,
      MIN_MAX_CALLS_PER_SESSION,
      MAX_MAX_CALLS_PER_SESSION,
    ),
    timeoutSeconds: clampNumber(
      raw.timeoutSeconds,
      DEFAULT_TIMEOUT_SECONDS,
      MIN_TIMEOUT_SECONDS,
      MAX_TIMEOUT_SECONDS,
    ),
  };
}

export function isHintConfigReady(config: HintConfig): config is HintConfig & { provider: string; model: string } {
  return config.enabled && !!config.provider && !!config.model;
}

function readFileOrEmpty(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n[truncated to ${maxChars} chars]`;
}

function formatMetric(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Number.isInteger(value) ? value : value.toFixed(3)}${unit}`;
}

function isBetter(value: number, current: number, direction: "lower" | "higher"): boolean {
  return direction === "lower" ? value < current : value > current;
}

function findBestMetric(state: HintExperimentState): number | null {
  let best: number | null = null;
  for (const run of state.results) {
    if (run.segment !== state.currentSegment) continue;
    if (run.status !== "keep" || !Number.isFinite(run.metric) || run.metric <= 0) continue;
    if (best === null || isBetter(run.metric, best, state.bestDirection)) best = run.metric;
  }
  return best;
}

function formatAsi(asi: Record<string, unknown> | undefined): string {
  if (!asi) return "";
  const parts: string[] = [];
  for (const key of ASI_HINT_KEYS) {
    const value = asi[key];
    if (value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text || text.trim() === "") continue;
    parts.push(`${key}: ${truncateText(text.trim(), ASI_VALUE_MAX_CHARS).replace(/\n/g, " ")}`);
  }
  return parts.join(" | ");
}

function formatRun(run: HintRun, index: number, state: HintExperimentState): string {
  const runNumber = run.run ?? index + 1;
  const parts = [
    `#${runNumber}`,
    run.status,
    `${state.metricName}=${formatMetric(run.metric, state.metricUnit)}`,
    run.commit ? `commit=${run.commit}` : "",
    run.description ? `desc=${run.description}` : "",
    formatAsi(run.asi),
  ].filter(Boolean);
  return `- ${parts.join(" | ")}`;
}

function section(title: string, body: string): string {
  const trimmed = body.trim();
  return trimmed ? `## ${title}\n${trimmed}` : "";
}

export function buildHintPrompt(input: HintPromptInput): string {
  const readFile = input.readFile ?? readFileOrEmpty;
  const state = input.state;
  const currentRuns = state.results.filter((run) => run.segment === state.currentSegment);
  const recentRuns = currentRuns.slice(-input.maxRecentRuns);
  const bestMetric = findBestMetric(state);

  const sessionLines = [
    `Goal: ${state.name ?? "-"}`,
    `Metric: ${state.metricName}${state.metricUnit ? ` (${state.metricUnit})` : ""}; ${state.bestDirection} is better`,
    `Runs in current segment: ${currentRuns.length}`,
    `Baseline: ${formatMetric(state.bestMetric, state.metricUnit)}`,
    `Best kept: ${formatMetric(bestMetric, state.metricUnit)}`,
    state.confidence !== null ? `Confidence: ${state.confidence.toFixed(2)}x noise floor` : "",
  ].filter(Boolean);

  const recentRunsText = recentRuns.length > 0
    ? recentRuns.map((run, i) => formatRun(run, state.results.indexOf(run), state)).join("\n")
    : "No runs yet.";

  const rules = truncateText(readFile(path.join(input.workDir, "autoresearch.md")).trim(), HINT_FILE_MAX_CHARS);
  const ideas = truncateText(readFile(path.join(input.workDir, "autoresearch.ideas.md")).trim(), HINT_FILE_MAX_CHARS);
  const extraContext = truncateText((input.extraContext ?? "").trim(), EXTRA_CONTEXT_MAX_CHARS);

  return [
    section("Session", sessionLines.join("\n")),
    section(`Recent Runs (last ${recentRuns.length})`, recentRunsText),
    section("Experiment Rules Excerpt", rules),
    section("Ideas Backlog Excerpt", ideas),
    section("Current Agent Question", input.question),
    section("Extra Context From Current Agent", extraContext),
    section(
      "Response Contract",
      [
        "Give advice only; do not claim to have changed files or run tools.",
        "Keep it short and actionable.",
        "Recommend 1-3 next experiments and mention likely failure modes.",
        "Favor changes that can be validated by the existing benchmark and checks.",
      ].join("\n"),
    ),
  ].filter(Boolean).join("\n\n");
}

function textFromAssistantMessage(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function createTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

export async function requestAutoresearchHint(input: HintRequestInput): Promise<HintRequestResult> {
  const prompt = buildHintPrompt(input);
  const timeout = createTimeoutSignal(input.signal, input.timeoutSeconds * 1000);
  const t0 = Date.now();
  const completionOptions: SimpleStreamOptions = {
    apiKey: input.apiKey,
    headers: input.headers,
    signal: timeout.signal,
    reasoning: input.thinkingLevel === "off" ? undefined : input.thinkingLevel,
  };

  try {
    const response = await (input.complete ?? completeSimple)(
      input.model,
      {
        systemPrompt: HINT_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        }],
      },
      completionOptions,
    );

    if (timeout.didTimeout()) {
      throw new Error(`Hint model timed out after ${input.timeoutSeconds}s`);
    }
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "Hint model returned an error");
    }
    if (response.stopReason === "aborted") {
      throw new Error(input.signal?.aborted ? "Hint model call was aborted" : "Hint model call was aborted or timed out");
    }

    const text = textFromAssistantMessage(response);
    if (!text) throw new Error("Hint model returned no text");

    return {
      text,
      durationMs: Date.now() - t0,
      promptBytes: Buffer.byteLength(prompt, "utf-8"),
      stopReason: response.stopReason,
      usage: response.usage ?? null,
    };
  } catch (error) {
    if (timeout.didTimeout()) {
      throw new Error(`Hint model timed out after ${input.timeoutSeconds}s`);
    }
    if (input.signal?.aborted) {
      throw new Error("Hint model call was aborted");
    }
    throw error;
  } finally {
    timeout.dispose();
  }
}
