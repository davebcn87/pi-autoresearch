import { spawn } from "node:child_process";
import * as fs from "node:fs";

import { hasAutoresearchConfigHeader } from "./jsonl.ts";
import { hookScriptPath } from "./paths.ts";

const TIMEOUT_MS = 30_000;
const STDOUT_MAX_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "\n…[truncated: hook stdout exceeded 8KB]";

const NEWLINE = 0x0a;
const UTF8_CONT_MASK = 0xc0;
const UTF8_CONT = 0x80; // continuation byte: 10xxxxxx
const UTF8_LEAD = 0xc0; // multi-byte leader: 11xxxxxx

/** Trim at the last newline, falling back to the last complete UTF-8 character. */
function truncateAtBoundary(buf: Buffer): Buffer {
  const newlineEnd = buf.lastIndexOf(NEWLINE);
  if (newlineEnd >= 0) return buf.subarray(0, newlineEnd + 1);
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_CONT) end--;
  if (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_LEAD) end--;
  return buf.subarray(0, end);
}

export type HookStage = "before" | "after";

export interface SessionSnapshot {
  metric_name: string;
  metric_unit: string;
  direction: "lower" | "higher";
  baseline_metric: number | null;
  best_metric: number | null;
  run_count: number;
  goal: string;
}

export interface BeforeHookPayload {
  event: "before";
  cwd: string;
  next_run: number;
  last_run: Record<string, unknown> | null;
  session: SessionSnapshot;
}

export interface AfterHookPayload {
  event: "after";
  cwd: string;
  run_entry: Record<string, unknown>;
  session: SessionSnapshot;
}

export type HookPayload = BeforeHookPayload | AfterHookPayload;

export interface HookResult {
  fired: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const notFired: HookResult = {
  fired: false,
  stdout: "",
  stderr: "",
  exitCode: null,
  timedOut: false,
  durationMs: 0,
};

export async function runHook(payload: HookPayload): Promise<HookResult> {
  const script = hookScriptPath(payload.cwd, payload.event);
  if (!isExecutableFile(script)) return notFired;

  const t0 = Date.now();
  return new Promise<HookResult>((resolve) => {
    const child = spawn("bash", [script], { cwd: payload.cwd, timeout: TIMEOUT_MS });

    let stdout = "";
    let stdoutBytes = 0;
    let stdoutFull = false;
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutFull) return;
      const remaining = STDOUT_MAX_BYTES - stdoutBytes;
      if (chunk.length <= remaining) {
        stdout += chunk.toString("utf8");
        stdoutBytes += chunk.length;
        return;
      }
      const kept = truncateAtBoundary(chunk.subarray(0, remaining));
      stdout += kept.toString("utf8") + TRUNCATION_MARKER;
      stdoutFull = true;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const finish = (exitCode: number | null, extraErr = "") => {
      const combinedStderr = extraErr ? (stderr ? `${stderr}\n${extraErr}` : extraErr) : stderr;
      resolve({
        fired: true,
        stdout,
        stderr: combinedStderr,
        exitCode,
        timedOut: child.killed,
        durationMs: Date.now() - t0,
      });
    };

    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export function steerMessageFor(stage: HookStage, result: HookResult): string | null {
  if (!result.fired) return null;
  if (result.timedOut) return `[${stage} hook timed out after ${TIMEOUT_MS / 1000}s]`;
  if (result.exitCode !== 0) {
    const parts = [`[${stage} hook exited ${result.exitCode}]`];
    const err = result.stderr.trim();
    const out = result.stdout.trim();
    if (err) parts.push(err);
    if (out) parts.push(out);
    return parts.join("\n");
  }
  return result.stdout.trim() || null;
}

export function hookLogEntry(stage: HookStage, result: HookResult): Record<string, unknown> {
  return {
    type: "hook",
    stage,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout_bytes: Buffer.byteLength(result.stdout, "utf8"),
    timed_out: result.timedOut,
  };
}

function hasConfigHeader(jsonlPath: string): boolean {
  if (!fs.existsSync(jsonlPath)) return false;
  try {
    return hasAutoresearchConfigHeader(fs.readFileSync(jsonlPath, "utf-8"));
  } catch {
    return false;
  }
}

export function appendHookLogEntryIfConfigured(
  jsonlPath: string,
  stage: HookStage,
  result: HookResult,
): boolean {
  if (!result.fired) return false;
  if (!hasConfigHeader(jsonlPath)) return false;

  try {
    fs.appendFileSync(jsonlPath, JSON.stringify(hookLogEntry(stage, result)) + "\n");
    return true;
  } catch {
    return false;
  }
}
