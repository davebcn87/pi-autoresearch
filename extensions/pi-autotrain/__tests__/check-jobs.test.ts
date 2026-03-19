import { describe, it, expect } from "vitest";
import { mapHfStatus, parseMetricLines } from "../index.js";

describe("mapHfStatus", () => {
  it("COMPLETED → completed", () => {
    expect(mapHfStatus("COMPLETED")).toBe("completed");
  });
  it("ERROR → error", () => {
    expect(mapHfStatus("ERROR")).toBe("error");
  });
  it("CANCELED → canceled", () => {
    expect(mapHfStatus("CANCELED")).toBe("canceled");
  });
  it("TIMEOUT → timeout", () => {
    expect(mapHfStatus("TIMEOUT")).toBe("timeout");
  });
  it("RUNNING → running", () => {
    expect(mapHfStatus("RUNNING")).toBe("running");
  });
  it("PENDING → running", () => {
    expect(mapHfStatus("PENDING")).toBe("running");
  });
  it("anything else → running", () => {
    expect(mapHfStatus("QUEUED")).toBe("running");
    expect(mapHfStatus("UNKNOWN")).toBe("running");
  });
});

describe("parseMetricLines", () => {
  it('parses "METRIC entity_f1=0.89"', () => {
    const result = parseMetricLines("some output\nMETRIC entity_f1=0.89\ndone");
    expect(result).toEqual({ entity_f1: 0.89 });
  });

  it("parses multiple METRIC lines → merged dict", () => {
    const result = parseMetricLines(
      "METRIC f1=0.89\nMETRIC loss=0.12\nMETRIC accuracy=0.95",
    );
    expect(result).toEqual({ f1: 0.89, loss: 0.12, accuracy: 0.95 });
  });

  it("no METRIC lines → null", () => {
    const result = parseMetricLines("just some logs\nno metrics here");
    expect(result).toBeNull();
  });

  it("ignores non-METRIC lines", () => {
    const result = parseMetricLines(
      "INFO: training started\nMETRIC val_f1=0.85\nINFO: done",
    );
    expect(result).toEqual({ val_f1: 0.85 });
  });
});
