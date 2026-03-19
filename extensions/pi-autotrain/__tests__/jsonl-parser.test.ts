import { describe, it, expect } from "vitest";
import { parseJsonlLine } from "../index.js";

describe("parseJsonlLine", () => {
  it("parses config entry", () => {
    const line = JSON.stringify({ type: "config", name: "test", metricName: "f1" });
    const result = parseJsonlLine(line);
    expect(result.kind).toBe("config");
    expect(result.data.name).toBe("test");
  });

  it("parses legacy result (has run field, no type)", () => {
    const line = JSON.stringify({ run: 1, commit: "abc1234", metric: 0.85, status: "keep" });
    const result = parseJsonlLine(line);
    expect(result.kind).toBe("result");
    expect(result.data.metric).toBe(0.85);
  });

  it("parses job_submitted", () => {
    const line = JSON.stringify({ type: "job_submitted", job_id: "abc123", experiment_id: 1, stage: "smoke" });
    const result = parseJsonlLine(line);
    expect(result.kind).toBe("job_submitted");
    expect(result.data.job_id).toBe("abc123");
  });

  it("parses job_completed", () => {
    const line = JSON.stringify({
      type: "job_completed",
      job_id: "abc123",
      experiment_id: 1,
      stage: "smoke",
      status: "completed",
      metrics: { f1: 0.89 },
    });
    const result = parseJsonlLine(line);
    expect(result.kind).toBe("job_completed");
    expect(result.data.metrics.f1).toBe(0.89);
  });

  it("returns skip for unknown type", () => {
    const line = JSON.stringify({ type: "unknown_thing", data: 123 });
    const result = parseJsonlLine(line);
    expect(result.kind).toBe("skip");
  });

  it("returns skip for malformed JSON", () => {
    const result = parseJsonlLine("not json{{{");
    expect(result.kind).toBe("skip");
  });

  it("REGRESSION GUARD: job_submitted is NEVER kind result", () => {
    const line = JSON.stringify({ type: "job_submitted", job_id: "x", experiment_id: 1, run: 5 });
    const result = parseJsonlLine(line);
    expect(result.kind).toBe("job_submitted");
    expect(result.kind).not.toBe("result");
  });

  it("REGRESSION GUARD: job_completed is NEVER kind result", () => {
    const line = JSON.stringify({ type: "job_completed", job_id: "x", run: 5, status: "completed" });
    const result = parseJsonlLine(line);
    expect(result.kind).toBe("job_completed");
    expect(result.kind).not.toBe("result");
  });
});
