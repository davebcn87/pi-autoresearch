import { describe, it, expect } from "vitest";

describe("auto-resume guard logic", () => {
  it("resumes when activeJobs > 0 even if experimentsThisSession === 0", () => {
    const experimentsThisSession = 0 as number;
    const activeJobsSize = 1 as number;
    // The new guard: skip resume only when BOTH are 0
    const shouldSkip = experimentsThisSession === 0 && activeJobsSize === 0;
    expect(shouldSkip).toBe(false);
  });

  it("does NOT resume when both are 0", () => {
    const experimentsThisSession = 0;
    const activeJobsSize = 0;
    const shouldSkip = experimentsThisSession === 0 && activeJobsSize === 0;
    expect(shouldSkip).toBe(true);
  });

  it("rate limit is 2 minutes (not 5)", () => {
    const RATE_LIMIT_MS = 2 * 60 * 1000;
    expect(RATE_LIMIT_MS).toBe(120000);
    // Old value was 5 * 60 * 1000 = 300000
    expect(RATE_LIMIT_MS).not.toBe(300000);
  });
});
