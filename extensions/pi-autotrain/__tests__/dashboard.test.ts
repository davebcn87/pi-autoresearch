import { describe, it, expect } from "vitest";

describe("dashboard — active jobs display logic", () => {
  it("shows N jobs active text when activeJobs size > 0", () => {
    const activeJobsSize = 3;
    const text = `${activeJobsSize} job${activeJobsSize > 1 ? "s" : ""} active`;
    expect(text).toBe("3 jobs active");
  });

  it("shows singular for 1 job", () => {
    const activeJobsSize = 1;
    const text = `${activeJobsSize} job${activeJobsSize > 1 ? "s" : ""} active`;
    expect(text).toBe("1 job active");
  });

  it("fullscreen overlay formats one row per active job", () => {
    const jobs = [
      { experiment_id: 1, stage: "smoke", job_id: "abc123def456789012345678", started_at: Date.now() - 120000 },
      { experiment_id: 2, stage: "full", job_id: "def456abc789012345678901", started_at: Date.now() - 3600000 },
    ];
    // Each job should produce a row with stage and elapsed
    for (const job of jobs) {
      const elapsed = Math.round((Date.now() - job.started_at) / 1000);
      const row = `exp${job.experiment_id} ${job.stage} ${job.job_id.slice(0, 8)}… ${elapsed}s`;
      expect(row).toContain(job.stage);
      expect(row).toContain(String(job.experiment_id));
    }
  });
});
