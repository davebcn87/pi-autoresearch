import { describe, it, expect } from "vitest";
import { rebuildActiveJobs, rebuildSmokeRegistry } from "../index.js";

describe("rebuildActiveJobs", () => {
  it("includes job_submitted with no matching job_completed", () => {
    const submitted = [{ job_id: "aaa", experiment_id: 1, stage: "smoke", command: "./run.sh", script_hash: "h1", timestamp: 100 }];
    const completed: any[] = [];
    const jobs = rebuildActiveJobs(submitted, completed);
    expect(jobs.size).toBe(1);
    expect(jobs.get("aaa")?.experiment_id).toBe(1);
  });

  it("excludes matched pairs (by job_id)", () => {
    const submitted = [{ job_id: "aaa", experiment_id: 1, stage: "smoke", command: "./run.sh", script_hash: "h1", timestamp: 100 }];
    const completed = [{ job_id: "aaa", experiment_id: 1, stage: "smoke", status: "completed", metrics: { f1: 0.9 }, timestamp: 200 }];
    const jobs = rebuildActiveJobs(submitted, completed);
    expect(jobs.size).toBe(0);
  });

  it("handles multiple jobs", () => {
    const submitted = [
      { job_id: "aaa", experiment_id: 1, stage: "smoke", command: "./run.sh", script_hash: "h1", timestamp: 100 },
      { job_id: "bbb", experiment_id: 2, stage: "full", command: "./run.sh", script_hash: "h2", timestamp: 110 },
      { job_id: "ccc", experiment_id: 3, stage: "smoke", command: "./run.sh", script_hash: "h3", timestamp: 120 },
    ];
    const completed = [{ job_id: "aaa", experiment_id: 1, stage: "smoke", status: "completed", timestamp: 200 }];
    const jobs = rebuildActiveJobs(submitted, completed);
    expect(jobs.size).toBe(2);
    expect(jobs.has("bbb")).toBe(true);
    expect(jobs.has("ccc")).toBe(true);
  });
});

describe("rebuildSmokeRegistry", () => {
  it("passed=true for completed smoke with metrics", () => {
    const submitted = [{ job_id: "aaa", experiment_id: 1, stage: "smoke", script_hash: "h1", timestamp: 100 }];
    const completed = [{ job_id: "aaa", experiment_id: 1, stage: "smoke", status: "completed", metrics: { f1: 0.9 }, timestamp: 200 }];
    const reg = rebuildSmokeRegistry(submitted, completed);
    expect(reg.get(1)?.passed).toBe(true);
  });

  it("passed=false for errored smoke", () => {
    const submitted = [{ job_id: "aaa", experiment_id: 1, stage: "smoke", script_hash: "h1", timestamp: 100 }];
    const completed = [{ job_id: "aaa", experiment_id: 1, stage: "smoke", status: "error", metrics: null, timestamp: 200 }];
    const reg = rebuildSmokeRegistry(submitted, completed);
    expect(reg.get(1)?.passed).toBe(false);
    expect(reg.get(1)?.failures).toBe(1);
  });

  it("counts failures per experiment_id", () => {
    const submitted = [
      { job_id: "a1", experiment_id: 1, stage: "smoke", script_hash: "h1", timestamp: 100 },
      { job_id: "a2", experiment_id: 1, stage: "smoke", script_hash: "h1", timestamp: 110 },
      { job_id: "a3", experiment_id: 1, stage: "smoke", script_hash: "h1", timestamp: 120 },
    ];
    const completed = [
      { job_id: "a1", experiment_id: 1, stage: "smoke", status: "error", metrics: null, timestamp: 200 },
      { job_id: "a2", experiment_id: 1, stage: "smoke", status: "error", metrics: null, timestamp: 210 },
      { job_id: "a3", experiment_id: 1, stage: "smoke", status: "completed", metrics: { f1: 0.8 }, timestamp: 220 },
    ];
    const reg = rebuildSmokeRegistry(submitted, completed);
    // 2 failures then 1 success — passed should be true (last wins)
    expect(reg.get(1)?.passed).toBe(true);
    expect(reg.get(1)?.failures).toBe(2);
  });

  it("carries script_hash from job_submitted", () => {
    const submitted = [{ job_id: "aaa", experiment_id: 1, stage: "smoke", script_hash: "deadbeef", timestamp: 100 }];
    const completed: any[] = [];
    const reg = rebuildSmokeRegistry(submitted, completed);
    expect(reg.get(1)?.script_hash).toBe("deadbeef");
  });

  it("ignores full-stage entries", () => {
    const submitted = [
      { job_id: "aaa", experiment_id: 1, stage: "smoke", script_hash: "h1", timestamp: 100 },
      { job_id: "bbb", experiment_id: 1, stage: "full", script_hash: "h1", timestamp: 110 },
    ];
    const completed = [
      { job_id: "bbb", experiment_id: 1, stage: "full", status: "completed", metrics: { f1: 0.9 }, timestamp: 200 },
    ];
    const reg = rebuildSmokeRegistry(submitted, completed);
    // Only smoke entry should be in registry, and it should not be marked passed
    expect(reg.get(1)?.passed).toBe(false);
  });
});
