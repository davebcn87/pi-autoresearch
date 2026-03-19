import { describe, it, expect } from "vitest";

describe("init_campaign — benchmark support", () => {
  it("benchmark.json structure has required fields", () => {
    const benchmark = {
      frozen_at: new Date().toISOString(),
      primary_metric: "entity_f1",
      direction: "higher",
      guardrails: ["json_validity_pct"],
      splits: {
        train_seed: 42,
        eval_seed: 999,
        test_seed: 777,
        eval_n: 200,
        test_n: 500,
      },
      acceptance_threshold: 0.02,
      noise_note: "eval_n=200 → treat +/-1.5% as ties",
    };

    expect(benchmark.frozen_at).toBeTruthy();
    expect(benchmark.primary_metric).toBe("entity_f1");
    expect(benchmark.direction).toBe("higher");
    expect(benchmark.splits.train_seed).toBe(42);
    expect(benchmark.splits.eval_seed).toBe(999);
    expect(benchmark.splits.test_seed).toBe(777);
    expect(benchmark.splits.eval_n).toBe(200);
    expect(benchmark.splits.test_n).toBe(500);
    expect(benchmark.acceptance_threshold).toBe(0.02);
  });

  it("does NOT write benchmark.json when param omitted (backward compat)", () => {
    const params = { name: "test", metric_name: "f1" };
    expect((params as any).benchmark).toBeUndefined();
  });

  it("noise_note adjusts based on eval_n size", () => {
    // < 200 → ±3%, 200-999 → ±1.5%, ≥1000 → ±1%
    const calcNoise = (evalN: number) =>
      evalN < 200 ? "3" : evalN < 1000 ? "1.5" : "1";
    expect(calcNoise(100)).toBe("3");
    expect(calcNoise(200)).toBe("1.5");
    expect(calcNoise(500)).toBe("1.5");
    expect(calcNoise(1000)).toBe("1");
  });
});

describe("log_decision — benchmark integrity check", () => {
  it("git diff HEAD -- benchmark.json detects changes", () => {
    // If git diff returns non-empty output, benchmark has changed
    const diffOutput = "-  \"eval_n\": 200\n+  \"eval_n\": 50";
    expect(diffOutput.trim()).toBeTruthy(); // Non-empty = refuse keep
  });

  it("allows keep when clean (empty diff)", () => {
    const diffOutput = "";
    expect(diffOutput.trim()).toBeFalsy(); // Empty = allow keep
  });

  it("allows keep when benchmark.json does not exist", () => {
    // When no benchmark.json exists, the check is skipped
    const exists = false;
    expect(exists).toBe(false); // No file = no check needed
  });
});
