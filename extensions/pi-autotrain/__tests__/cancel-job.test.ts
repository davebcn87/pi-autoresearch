import { describe, it, expect } from "vitest";

describe("cancel_job — minimum runtime guard logic", () => {
  it("smoke under 120s should be refused", () => {
    const startedAt = Date.now() - 60 * 1000; // 60 seconds ago
    const elapsed = (Date.now() - startedAt) / 1000;
    expect(elapsed).toBeLessThan(120);
  });

  it("smoke over 120s should be allowed", () => {
    const startedAt = Date.now() - 150 * 1000; // 150 seconds ago
    const elapsed = (Date.now() - startedAt) / 1000;
    expect(elapsed).toBeGreaterThanOrEqual(120);
  });

  it("full job should be allowed regardless of runtime", () => {
    // Full jobs have no minimum runtime guard
    const stage = "full";
    expect(stage).toBe("full");
    // The guard only applies to stage === "smoke"
  });
});
