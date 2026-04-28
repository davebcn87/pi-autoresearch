import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { appendHookLogEntryIfConfigured } from "../extensions/pi-autoresearch/hooks.ts";
import {
  extractAutoresearchSessionName,
  hasAutoresearchConfigHeader,
  isAutoresearchConfigEntry,
  isAutoresearchRunEntry,
  parseJsonlEntry,
  reconstructJsonlState,
} from "../extensions/pi-autoresearch/jsonl.ts";

test("hook entries are skipped when identifying run entries", () => {
  const hookEntry = parseJsonlEntry('{"type":"hook","stage":"before","exit_code":0}');
  const runEntry = parseJsonlEntry('{"run":1,"metric":42}');

  assert.equal(isAutoresearchConfigEntry(hookEntry), false);
  assert.equal(isAutoresearchRunEntry(hookEntry), false);
  assert.equal(isAutoresearchRunEntry(runEntry), true);
});

test("hook-only jsonl does not count as having a config header", () => {
  const jsonl = '{"type":"hook","stage":"before","exit_code":0}\n';

  assert.equal(hasAutoresearchConfigHeader(jsonl), false);
});

test("session name comes from the first config entry, not the first line", () => {
  const jsonl = [
    '{"type":"hook","stage":"before","exit_code":0}',
    '{"type":"config","name":"Hook-safe session","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"run":1,"commit":"abc1234","metric":10,"status":"keep","description":"baseline","timestamp":1,"metrics":{}}',
  ].join("\n");

  assert.equal(hasAutoresearchConfigHeader(jsonl), true);
  assert.equal(extractAutoresearchSessionName(jsonl), "Hook-safe session");
});

test("reconstructJsonlState ignores hooks and preserves run segments", () => {
  const jsonl = [
    '{"type":"config","name":"Segmented session","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"type":"hook","stage":"before","exit_code":0}',
    '{"run":1,"commit":"aaa1111","metric":10,"status":"keep","description":"baseline","timestamp":1,"metrics":{"compile_ms":4}}',
    '{"type":"hook","stage":"after","exit_code":0}',
    '{"type":"config","name":"Segmented session","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"type":"hook","stage":"before","exit_code":0}',
    '{"run":2,"commit":"bbb2222","metric":7,"status":"keep","description":"new baseline","timestamp":2,"metrics":{"render_ms":2}}',
  ].join("\n");

  const state = reconstructJsonlState(jsonl);

  assert.equal(state.results.length, 2);
  assert.deepEqual(state.results.map((result) => result.metric), [10, 7]);
  assert.deepEqual(state.results.map((result) => result.segment), [0, 1]);
  assert.equal(state.currentSegment, 1);
  assert.deepEqual(state.secondaryMetrics.map((metric) => metric.name), ["render_ms"]);
});

test("hook observability does not create jsonl before config exists", () => {
  const tempDir = fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-hooks-"));
  const jsonlPath = path.join(tempDir, "autoresearch.jsonl");
  const result = {
    fired: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    durationMs: 5,
  };

  try {
    assert.equal(appendHookLogEntryIfConfigured(jsonlPath, "before", result), false);
    assert.equal(fs.existsSync(jsonlPath), false);

    fs.writeFileSync(jsonlPath, '{"type":"hook","stage":"before","exit_code":0}\n');
    assert.equal(appendHookLogEntryIfConfigured(jsonlPath, "after", result), false);
    assert.equal(
      fs.readFileSync(jsonlPath, "utf-8"),
      '{"type":"hook","stage":"before","exit_code":0}\n',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
