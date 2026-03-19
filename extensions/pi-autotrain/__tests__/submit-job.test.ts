import { describe, it, expect } from "vitest";
import { hashCommand } from "../index.js";

describe("submit_job — smoke (unit logic)", () => {
  it("hashCommand produces consistent hashes for submit_job", () => {
    const hash = hashCommand("./autotrain.sh");
    expect(hash).toHaveLength(64);
    expect(hashCommand("./autotrain.sh")).toBe(hash);
  });

  it("different commands produce different hashes (script change detection)", () => {
    const a = hashCommand("./autotrain.sh --config a");
    const b = hashCommand("./autotrain.sh --config b");
    expect(a).not.toBe(b);
  });
});

describe("submit_job — full stage gate (unit logic)", () => {
  it("script hash comparison catches edits between smoke and full", () => {
    const smokeHash = hashCommand("./autotrain.sh v1");
    const fullHash = hashCommand("./autotrain.sh v2");
    expect(smokeHash).not.toBe(fullHash);
  });

  it("same command produces same hash (gate should pass)", () => {
    const cmd = "./autotrain.sh --flavor a10g-small";
    expect(hashCommand(cmd)).toBe(hashCommand(cmd));
  });
});

describe("submit_job — 24-char hex job ID parsing", () => {
  it("matches 24-char hex from typical hf jobs output", () => {
    const stdout = "abc123def456789012345678\nView at: https://huggingface.co/jobs/user/abc123def456789012345678";
    const match = stdout.match(/[0-9a-f]{24}/);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("abc123def456789012345678");
  });

  it("returns null when no hex ID present", () => {
    const stdout = "Error: something went wrong";
    const match = stdout.match(/[0-9a-f]{24}/);
    expect(match).toBeNull();
  });
});
