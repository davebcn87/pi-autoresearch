import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { firstSuccessfulRun, reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";
import { buildAutoresearchCompactionSummary, autoresearchSummaryPathsFor } from "../extensions/pi-autoresearch/compaction.ts";

test("baseline is the first finite kept measurement, never failed attempts or later improvements", () => {
  const attempts = [
    { run: 1, status: "crash", metric: 999, segment: 0 },
    { run: 2, status: "checks_failed", metric: 1, segment: 0 },
    { run: 3, status: "keep", metric: 20, segment: 0 },
    { run: 4, status: "keep", metric: 10, segment: 0 },
    { run: 5, status: "crash", metric: 0, segment: 1 },
    { run: 6, status: "keep", metric: NaN, segment: 1 },
    { run: 7, status: "keep", metric: 0, segment: 1 },
  ];
  assert.equal(firstSuccessfulRun(attempts.slice(0, 2), 0), undefined);
  assert.equal(firstSuccessfulRun(attempts, 0).run, 3);
  assert.equal(firstSuccessfulRun(attempts, 1).run, 7, "a real zero measurement is valid");
});

test("compaction preserves failed attempts in counts without using them as baseline", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "autoresearch-baseline-"));
  try {
    await mkdir(join(cwd, ".auto"));
    const config = { type: "config", name: "Baseline startup", metricName: "latency_ms", metricUnit: "ms", bestDirection: "lower" };
    const failures = [
      { run: 1, status: "crash", metric: 999, description: "build failed" },
      { run: 2, status: "checks_failed", metric: 1, description: "invalid output" },
    ];
    const file = join(cwd, ".auto/log.jsonl");
    const persist = async (runs) => writeFile(file, [config, ...runs].map(JSON.stringify).join("\n") + "\n");
    await persist(failures);
    let summary = buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(cwd));
    assert.match(summary, /Runs so far: 2 \(0 keep · 1 crash · 1 checks_failed\)/);
    assert.doesNotMatch(summary, /Baseline \(#/);
    await persist([...failures, { run: 3, status: "keep", metric: 20 }, { run: 4, status: "keep", metric: 10 }]);
    summary = buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(cwd));
    assert.match(summary, /Baseline \(#3\): 20ms/);
    assert.match(summary, /Best     \(#4\): 10ms \(-50.0%\)/);
    assert.match(summary, /#1 crash\s+999 \| desc: build failed/);
    assert.equal(firstSuccessfulRun(reconstructJsonlState(await readFile(file, "utf8")).results, 0).run, 3);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("create skill initializes before implementation and keeps failure history", async () => {
  const text = await readFile(new URL("../skills/autoresearch-create/SKILL.md", import.meta.url), "utf8");
  const setup = text.split("## Setup")[1].split("###")[0];
  assert.match(setup, /1\.[\s\S]*call `init_experiment` immediately/);
  assert.ok(setup.indexOf("init_experiment") < setup.indexOf("Create `autoresearch/"));
  assert.match(setup, /first successful run/);
  assert.match(setup, /neither establishes a baseline/);
});
