import assert from "node:assert/strict";
import test from "node:test";

import { LogParams } from "../extensions/pi-autoresearch/index.ts";

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

test("log_experiment schema should avoid patternProperties for Cloud Code Assist compatibility", () => {
  const patternPropertyPaths = collectKeyPaths(LogParams, "patternProperties");

  assert.equal(
    patternPropertyPaths.length,
    0,
    `unexpected patternProperties found in LogParams schema at: ${patternPropertyPaths.join(", ")}`,
  );

  const serialized = JSON.stringify(LogParams);
  assert.match(
    serialized,
    /"additionalProperties"/,
    "expected LogParams schema to keep dynamic object support via additionalProperties",
  );
});
