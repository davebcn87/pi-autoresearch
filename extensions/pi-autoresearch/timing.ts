import { StringDecoder } from "node:string_decoder";

export interface TimingSpan {
  name: string;
  startedAt: number;
  endedAt: number;
  source: "custom" | "automatic";
}
export interface ExperimentTiming {
  loopSeconds?: number;
  runSeconds: number;
  checksSeconds: number;
  spans: TimingSpan[];
  longest?: { name: string; seconds: number };
  warnings?: string[];
}

/** Rounded whole seconds, with compact minute/hour formatting. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor(total / 60) % 60}m ${total % 60}s`;
}

/** Parse optional markers before output truncation; stdout/stderr have separate decoders. */
export class TimingCollector {
  readonly spans: TimingSpan[] = [];
  readonly warnings: string[] = [];
  private streams = new Map<string, { decoder: StringDecoder; pending: string }>();
  private open = new Map<string, number[]>();
  private markers = 0;
  private startedAt: number;
  constructor(startedAt: number) { this.startedAt = startedAt; }

  private warn(message: string) { if (this.warnings.length < 8) this.warnings.push(message); }

  feed(chunk: Buffer | string, stream = "stdout", now = Date.now()): void {
    let state = this.streams.get(stream);
    if (!state) {
      state = { decoder: new StringDecoder("utf8"), pending: "" };
      this.streams.set(stream, state);
    }
    state.pending += typeof chunk === "string" ? chunk : state.decoder.write(chunk);
    const lines = state.pending.split("\n");
    state.pending = lines.pop()!;
    for (const line of lines) this.line(line.trim(), now);
    if (state.pending.length > 4096) state.pending = ""; // bounded even for noisy binary output
  }

  private line(line: string, now: number): void {
    if (!line.startsWith("TIMING ")) return;
    if (++this.markers > 512) { this.warn("TIMING marker limit reached (512)"); return; }
    const match = /^TIMING (start|end) ([a-zA-Z0-9_.:/-]{1,80})(?: (\d+(?:\.\d+)?))?$/.exec(line);
    if (!match) { this.warn("Ignored malformed TIMING marker"); return; }
    const [, event, name, timestamp] = match;
    if (["run_experiment", "checks", "agent/other"].includes(name)) {
      this.warn(`Reserved TIMING span name: ${name}`); return;
    }
    const at = timestamp === undefined ? now : Number(timestamp);
    if (!Number.isFinite(at) || at < this.startedAt) { this.warn(`Invalid TIMING timestamp: ${name}`); return; }
    const stack = this.open.get(name) || [];
    if (event === "start") { stack.push(at); this.open.set(name, stack); return; }
    const start = stack.pop();
    if (start === undefined || at < start) { this.warn(`Unmatched TIMING end: ${name}`); return; }
    this.spans.push({ name, startedAt: start, endedAt: at, source: "custom" });
  }

  finish(endedAt = Date.now()): TimingSpan[] {
    for (const state of this.streams.values()) this.line((state.pending + state.decoder.end()).trim(), endedAt);
    this.streams.clear();
    for (const [name, starts] of this.open) if (starts.length) this.warn(`Unclosed TIMING span: ${name}`);
    this.open.clear();
    return this.spans.filter((span) => {
      if (span.endedAt <= endedAt) return true;
      this.warn(`TIMING span outside run: ${span.name}`); return false;
    });
  }
}

function unionMilliseconds(spans: readonly TimingSpan[], start: number, end: number): number {
  const intervals = spans.map((span) => [Math.max(start, span.startedAt), Math.min(end, span.endedAt)])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let covered = 0, cursor = start;
  for (const [a, b] of intervals) { if (b > cursor) covered += b - Math.max(a, cursor); cursor = Math.max(cursor, b); }
  return covered;
}

/** Exclusive phase costs: nested spans and automatic wrappers are not double-counted. */
export function summarizeTiming(spans: TimingSpan[], loopStart?: number, loopEnd?: number): ExperimentTiming {
  const seconds = (name: string) => spans.filter((span) => span.source === "automatic" && span.name === name)
    .reduce((sum, span) => sum + Math.max(0, span.endedAt - span.startedAt) / 1000, 0);
  const hasLoop = loopStart !== undefined && loopEnd !== undefined && loopEnd >= loopStart;
  const phases = new Map<string, number>();
  const exclusiveIntervals = new Map<string, TimingSpan[]>();
  for (const span of spans) {
    const children = spans.filter((other) => other !== span &&
      other.startedAt >= span.startedAt && other.endedAt <= span.endedAt &&
      (other.startedAt > span.startedAt || other.endedAt < span.endedAt || span.source === "automatic" && other.source === "custom"));
    const intervals = exclusiveIntervals.get(span.name) || [];
    let cursor = span.startedAt;
    for (const child of children.sort((a, b) => a.startedAt - b.startedAt)) {
      if (child.startedAt > cursor) intervals.push({ ...span, startedAt: cursor, endedAt: child.startedAt });
      cursor = Math.max(cursor, child.endedAt);
    }
    if (cursor < span.endedAt) intervals.push({ ...span, startedAt: cursor });
    exclusiveIntervals.set(span.name, intervals);
  }
  for (const [name, intervals] of exclusiveIntervals) phases.set(name, unionMilliseconds(intervals, -Infinity, Infinity) / 1000);
  if (hasLoop) phases.set("agent/other", Math.max(0, loopEnd! - loopStart! - unionMilliseconds(spans, loopStart!, loopEnd!)) / 1000);
  const longest = [...phases.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    ...(hasLoop ? { loopSeconds: (loopEnd! - loopStart!) / 1000 } : {}),
    runSeconds: seconds("run_experiment"), checksSeconds: seconds("checks"), spans,
    ...(longest ? { longest: { name: longest[0], seconds: longest[1] } } : {}),
  };
}

/** Read old logs without manufacturing timings for historical experiments. */
export function parseTiming(value: unknown): ExperimentTiming | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as ExperimentTiming;
  if (!Number.isFinite(item.runSeconds) || item.runSeconds < 0 || !Number.isFinite(item.checksSeconds) || item.checksSeconds < 0 || !Array.isArray(item.spans)) return undefined;
  const spans = item.spans.filter((span) => span && typeof span.name === "string" &&
    Number.isFinite(span.startedAt) && Number.isFinite(span.endedAt) && span.endedAt >= span.startedAt &&
    (span.source === "custom" || span.source === "automatic"));
  return {
    ...item, spans,
    loopSeconds: Number.isFinite(item.loopSeconds) && item.loopSeconds! >= 0 ? item.loopSeconds : undefined,
    longest: item.longest && typeof item.longest.name === "string" && Number.isFinite(item.longest.seconds) && item.longest.seconds >= 0 ? { ...item.longest } : undefined,
    warnings: Array.isArray(item.warnings) ? item.warnings.filter((warning) => typeof warning === "string").slice(0, 8) : undefined,
  };
}

export function timingSummary(timing: ExperimentTiming): string {
  const loop = timing.loopSeconds === undefined ? "" : `Loop ${formatDuration(timing.loopSeconds)} · `;
  return `${loop}run ${formatDuration(timing.runSeconds)}${timing.checksSeconds ? ` · checks ${formatDuration(timing.checksSeconds)}` : ""}` +
    (timing.longest ? ` · longest: ${timing.longest.name} ${formatDuration(timing.longest.seconds)}` : "");
}
