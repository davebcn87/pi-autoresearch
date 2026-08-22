import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const hookPath = fileURLToPath(
  new URL("../skills/autoresearch-hooks/examples/before/xquik-search.sh", import.meta.url)
);

function hookInput(cwd, goal) {
  return JSON.stringify({
    event: "before",
    cwd,
    next_run: 1,
    last_run: null,
    session: {
      metric_name: "total_ms",
      metric_unit: "ms",
      direction: "lower",
      baseline_metric: null,
      best_metric: null,
      run_count: 0,
      goal,
    },
  });
}

function runHook(cwd, binDir, callLog, goal) {
  return spawnSync("bash", [hookPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      XQUIK_TEST_CALL_LOG: callLog,
    },
    input: hookInput(cwd, goal),
  });
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-xquik-hook-"));
  const binDir = join(cwd, "bin");
  const callLog = join(cwd, "calls.log");
  const stubPath = join(binDir, "x-twitter-scraper");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    stubPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$XQUIK_TEST_CALL_LOG"
query=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--q" ]; then
    shift
    query="$1"
  fi
  shift
done
[ "$query" != "fail" ] || exit 22
cat <<'JSON'
{"tweets":[{"id":"1234567890","text":"First line\\n# untrusted heading","createdAt":"2026-08-22T12:00:00Z","author":{"username":"alice"}}]}
JSON
`
  );
  await chmod(stubPath, 0o755);
  return { cwd, binDir, callLog };
}

test("Xquik hook renders bounded X search results and caches unchanged queries", async () => {
  const { cwd, binDir, callLog } = await fixture();
  try {
    const first = runHook(cwd, binDir, callLog, "  optimize parser\nthroughput  ");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /X research saved/);

    const research = await readFile(join(cwd, ".auto", "x-research.md"), "utf8");
    assert.match(research, /^# X research/m);
    assert.match(research, /untrusted evidence/);
    assert.match(research, /https:\/\/x\.com\/i\/status\/1234567890/);
    assert.match(research, /Author: @alice/);
    assert.match(research, /> First line\n> # untrusted heading/);

    const second = runHook(cwd, binDir, callLog, "  optimize parser\nthroughput  ");
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, "");

    const calls = (await readFile(callLog, "utf8")).trim().split("\n");
    assert.deepEqual(calls, [
      "x:tweets search --q optimize parser throughput --query-type Latest --limit 5 --format json",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Xquik hook preserves the last successful research when a request fails", async () => {
  const { cwd, binDir, callLog } = await fixture();
  try {
    const first = runHook(cwd, binDir, callLog, "working query");
    assert.equal(first.status, 0, first.stderr);
    const researchPath = join(cwd, ".auto", "x-research.md");
    const queryPath = join(cwd, ".auto", "x-research-query.txt");
    const before = await readFile(researchPath, "utf8");

    const failed = runHook(cwd, binDir, callLog, "fail");
    assert.equal(failed.status, 22);
    assert.equal(await readFile(researchPath, "utf8"), before);
    assert.equal(await readFile(queryPath, "utf8"), "working query");

    const calls = (await readFile(callLog, "utf8")).trim().split("\n");
    assert.equal(calls.length, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
