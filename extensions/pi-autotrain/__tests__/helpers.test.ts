import { describe, it, expect } from "vitest";
import {
  commas,
  fmtNum,
  isBetter,
  findBaselineMetric,
  currentResults,
} from "../index.js";

describe("commas", () => {
  it("formats thousands", () => {
    expect(commas(15586)).toBe("15,586");
  });
  it("leaves small numbers alone", () => {
    expect(commas(999)).toBe("999");
  });
  it("handles zero", () => {
    expect(commas(0)).toBe("0");
  });
  it("handles millions", () => {
    expect(commas(1234567)).toBe("1,234,567");
  });
});

describe("fmtNum", () => {
  it("formats integers", () => {
    expect(fmtNum(1234)).toBe("1,234");
  });
  it("formats with decimals", () => {
    expect(fmtNum(1234.567, 2)).toBe("1,234.57");
  });
  it("handles negative numbers", () => {
    expect(fmtNum(-42.5, 1)).toBe("-42.5");
  });
  it("defaults to 0 decimals", () => {
    expect(fmtNum(999)).toBe("999");
  });
});

describe("isBetter", () => {
  it("lower direction: smaller is better", () => {
    expect(isBetter(5, 10, "lower")).toBe(true);
    expect(isBetter(15, 10, "lower")).toBe(false);
  });
  it("higher direction: larger is better", () => {
    expect(isBetter(15, 10, "higher")).toBe(true);
    expect(isBetter(5, 10, "higher")).toBe(false);
  });
  it("equal is not better", () => {
    expect(isBetter(10, 10, "lower")).toBe(false);
    expect(isBetter(10, 10, "higher")).toBe(false);
  });
});

describe("findBaselineMetric", () => {
  const results = [
    { commit: "a", metric: 0.5, metrics: {}, status: "keep" as const, description: "", timestamp: 0, segment: 0 },
    { commit: "b", metric: 0.7, metrics: {}, status: "keep" as const, description: "", timestamp: 0, segment: 0 },
    { commit: "c", metric: 0.9, metrics: {}, status: "keep" as const, description: "", timestamp: 0, segment: 1 },
  ];

  it("returns first result metric in segment", () => {
    expect(findBaselineMetric(results, 0)).toBe(0.5);
    expect(findBaselineMetric(results, 1)).toBe(0.9);
  });

  it("returns null when segment is empty", () => {
    expect(findBaselineMetric(results, 99)).toBeNull();
  });

  it("returns null for empty results", () => {
    expect(findBaselineMetric([], 0)).toBeNull();
  });
});

describe("currentResults", () => {
  const results = [
    { commit: "a", metric: 1, metrics: {}, status: "keep" as const, description: "", timestamp: 0, segment: 0 },
    { commit: "b", metric: 2, metrics: {}, status: "keep" as const, description: "", timestamp: 0, segment: 1 },
    { commit: "c", metric: 3, metrics: {}, status: "keep" as const, description: "", timestamp: 0, segment: 1 },
  ];

  it("filters by segment", () => {
    expect(currentResults(results, 0)).toHaveLength(1);
    expect(currentResults(results, 1)).toHaveLength(2);
  });

  it("returns empty for unknown segment", () => {
    expect(currentResults(results, 99)).toHaveLength(0);
  });
});
