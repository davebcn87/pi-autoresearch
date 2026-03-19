import { describe, it, expect } from "vitest";
import { hashCommand } from "../index.js";

describe("hashCommand", () => {
  it("returns 64-char hex string", () => {
    const hash = hashCommand("./autotrain.sh");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const a = hashCommand("./autotrain.sh");
    const b = hashCommand("./autotrain.sh");
    expect(a).toBe(b);
  });

  it("different inputs produce different hashes", () => {
    const a = hashCommand("./autotrain.sh");
    const b = hashCommand("./other.sh");
    expect(a).not.toBe(b);
  });
});
