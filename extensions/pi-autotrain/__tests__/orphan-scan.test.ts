import { describe, it, expect } from "vitest";
import { rebuildActiveJobs, mapHfStatus, parseMetricLines } from "../index.js";

describe("orphan scan logic", () => {
  it("identifies unmatched job_submitted as potential orphans", () => {
    const submitted = [
      { job_id: "aaa", experiment_id: 1, stage: "smoke" as const, command: "./run.sh", script_hash: "h1", timestamp: 100 },
      { job_id: "bbb", experiment_id: 2, stage: "full" as const, command: "./run.sh", script_hash: "h2", timestamp: 110 },
    ];
    const completed = [
      { job_id: "aaa", experiment_id: 1, stage: "smoke" as const, status: "completed", timestamp: 200 },
    ];
    const active = rebuildActiveJobs(submitted, completed);
    // bbb should be an orphan candidate
    expect(active.size).toBe(1);
    expect(active.has("bbb")).toBe(true);
  });

  it("mapHfStatus correctly maps terminal states for orphan resolution", () => {
    expect(mapHfStatus("COMPLETED")).toBe("completed");
    expect(mapHfStatus("ERROR")).toBe("error");
    expect(mapHfStatus("CANCELED")).toBe("canceled");
    expect(mapHfStatus("TIMEOUT")).toBe("timeout");
  });

  it("still-running jobs remain in activeJobs", () => {
    expect(mapHfStatus("RUNNING")).toBe("running");
    expect(mapHfStatus("PENDING")).toBe("running");
  });

  it("parseMetricLines works for orphan log parsing", () => {
    const logs = "Training step 10\nMETRIC loss=0.45\nMETRIC f1=0.88\nDone";
    const metrics = parseMetricLines(logs);
    expect(metrics).toEqual({ loss: 0.45, f1: 0.88 });
  });

  it("handles inspect failure gracefully (null metrics)", () => {
    const metrics = parseMetricLines("");
    expect(metrics).toBeNull();
  });
});
