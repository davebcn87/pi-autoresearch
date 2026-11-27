import assert from "node:assert/strict";
import test from "node:test";

import { RunParams } from "../extensions/pi-autoresearch/index.ts";

function collectKeyPaths(value, targetKey, path = "$", hits = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectKeyPaths(item, targetKey, `${path}[${index}]`, hits));
    return hits;
  }

  if (!value || typeof value !== "object") {
    return hits;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === targetKey) {
      hits.push(childPath);
    }
    collectKeyPaths(child, targetKey, childPath, hits);
  }

  return hits;
}

test("run_experiment schema should avoid patternProperties for Cloud Code Assist compatibility", () => {
  const patternPropertyPaths = collectKeyPaths(RunParams, "patternProperties");

  assert.equal(
    patternPropertyPaths.length,
    0,
    `unexpected patternProperties found in RunParams schema at: ${patternPropertyPaths.join(", ")}`,
  );

  const serialized = JSON.stringify(RunParams);
  assert.match(
    serialized,
    /"additionalProperties"/,
    "expected RunParams schema to keep dynamic object support via additionalProperties",
  );
});
