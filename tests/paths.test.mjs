import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  sessionFilePath,
  sessionFileCandidates,
  hookScriptPath,
  ensureParentDir,
  AUTO_DIR,
} from "../extensions/pi-autoresearch/paths.ts";

function freshDir() {
  return fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-paths-"));
}

test("a brand-new session resolves to the .auto layout", () => {
  const dir = freshDir();
  assert.equal(sessionFilePath(dir, "log"), path.join(dir, AUTO_DIR, "log.jsonl"));
  assert.equal(sessionFilePath(dir, "prompt"), path.join(dir, AUTO_DIR, "prompt.md"));
  assert.equal(sessionFilePath(dir, "config"), path.join(dir, AUTO_DIR, "config.json"));
});

test("an existing legacy file is read in place for backwards compatibility", () => {
  const dir = freshDir();
  const legacy = path.join(dir, "autoresearch.jsonl");
  fs.writeFileSync(legacy, "{}\n");
  assert.equal(sessionFilePath(dir, "log"), legacy);
});

test("the .auto layout wins when both new and legacy files exist", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "autoresearch.jsonl"), "{}\n");
  const current = path.join(dir, AUTO_DIR, "log.jsonl");
  ensureParentDir(current);
  fs.writeFileSync(current, "{}\n");
  assert.equal(sessionFilePath(dir, "log"), current);
});

test("current sessions do not inherit stale legacy peer files", () => {
  const dir = freshDir();
  const currentLog = path.join(dir, AUTO_DIR, "log.jsonl");
  ensureParentDir(currentLog);
  fs.writeFileSync(currentLog, "{}\n");
  fs.writeFileSync(path.join(dir, "autoresearch.config.json"), '{"maxIterations":1}\n');
  fs.writeFileSync(path.join(dir, "autoresearch.checks.sh"), "#!/usr/bin/env bash\n");

  assert.equal(sessionFilePath(dir, "config"), path.join(dir, AUTO_DIR, "config.json"));
  assert.equal(sessionFilePath(dir, "checks"), path.join(dir, AUTO_DIR, "checks.sh"));
});

test("legacy files are used only when no current layout exists", () => {
  const dir = freshDir();
  const legacyConfig = path.join(dir, "autoresearch.config.json");
  fs.writeFileSync(legacyConfig, '{"maxIterations":1}\n');
  assert.equal(sessionFilePath(dir, "config"), legacyConfig);
});

test("session file candidates expose both paths for cleanup", () => {
  const dir = freshDir();
  assert.deepEqual(sessionFileCandidates(dir, "log"), {
    current: path.join(dir, AUTO_DIR, "log.jsonl"),
    legacy: path.join(dir, "autoresearch.jsonl"),
  });
});

test("hook scripts prefer .auto/hooks and fall back to the legacy directory", () => {
  const dir = freshDir();
  assert.equal(hookScriptPath(dir, "before"), path.join(dir, AUTO_DIR, "hooks", "before.sh"));

  const legacyHook = path.join(dir, "autoresearch.hooks", "after.sh");
  ensureParentDir(legacyHook);
  fs.writeFileSync(legacyHook, "#!/usr/bin/env bash\n");
  assert.equal(hookScriptPath(dir, "after"), legacyHook);
});

test("current sessions ignore stale legacy hooks", () => {
  const dir = freshDir();
  const currentLog = path.join(dir, AUTO_DIR, "log.jsonl");
  ensureParentDir(currentLog);
  fs.writeFileSync(currentLog, "{}\n");
  const legacyHook = path.join(dir, "autoresearch.hooks", "after.sh");
  ensureParentDir(legacyHook);
  fs.writeFileSync(legacyHook, "#!/usr/bin/env bash\n");

  assert.equal(hookScriptPath(dir, "after"), path.join(dir, AUTO_DIR, "hooks", "after.sh"));
});

test("ensureParentDir creates missing parent directories", () => {
  const dir = freshDir();
  const target = path.join(dir, AUTO_DIR, "log.jsonl");
  ensureParentDir(target);
  assert.ok(fs.existsSync(path.dirname(target)));
});
