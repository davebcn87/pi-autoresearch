import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extensions/pi-autoresearch/index.ts", import.meta.url), "utf-8");

test("autoresearch guards UI cleanup against stale Pi contexts", () => {
  assert.match(source, /function runIgnoringStaleExtensionContext|const runIgnoringStaleExtensionContext/, "expected stale-context guard helper");
  assert.match(source, /runIgnoringStaleExtensionContext\(\(\) => \{\s*if \(ctx\.hasUI\)/s, "expected ctx.hasUI UI cleanup to be wrapped by stale-context guard");
});

test("autoresearch cancels pending resume timers before session shutdown UI work", () => {
  const shutdownIndex = source.indexOf('pi.on("session_shutdown"');
  assert.notEqual(shutdownIndex, -1, "expected session_shutdown handler");
  const shutdownBlock = source.slice(shutdownIndex, shutdownIndex + 500);
  assert.match(shutdownBlock, /cancelPendingResume/, "expected shutdown to cancel pending auto-resume timers");
  assert.ok(
    shutdownBlock.indexOf("cancelPendingResume") < shutdownBlock.indexOf("clearSessionUi"),
    "expected auto-resume cancellation before UI cleanup can touch stale ctx",
  );
});
