import assert from "node:assert/strict";
import test from "node:test";
import { TimingCollector, summarizeTiming, formatDuration, parseTiming, timingSummary } from "../extensions/pi-autoresearch/timing.ts";
import { firstComparableBaseline, reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";

const span = (name, startedAt, endedAt, source = "custom") => ({ name, startedAt, endedAt, source });

test("durations are clean seconds, minutes and hours with correct carries", () => {
  for (const [seconds, expected] of [[0, "0s"], [32.2, "32s"], [59.6, "1m 0s"], [422, "7m 2s"], [3602, "1h 0m 2s"], [-1, "—"], [NaN, "—"]]) {
    assert.equal(formatDuration(seconds), expected);
  }
});

test("TIMING is fully optional", () => {
  const collector = new TimingCollector(100);
  collector.feed("METRIC latency_ms=42\nordinary output\n", "stdout", 200);
  assert.deepEqual(collector.finish(300), []);
  assert.deepEqual(collector.warnings, []);
});

test("markers accept precise Unix ms or use live receipt time", () => {
  const collector = new TimingCollector(1000);
  collector.feed("TIMING start build 1100\n", "stdout", 1500);
  collector.feed("TIMING end build 2100\nTIMING start benchmark\n", "stdout", 2200);
  collector.feed("TIMING end benchmark\n", "stdout", 2500);
  assert.deepEqual(collector.finish(2600), [span("build", 1100, 2100), span("benchmark", 2200, 2500)]);
});

test("chunk boundaries, CRLF and unterminated final line are supported", () => {
  const collector = new TimingCollector(1000);
  collector.feed(Buffer.from("TIMING sta"), "stdout", 1200);
  collector.feed(Buffer.from("rt build 1100\r\nTIMING end bu"), "stdout", 1300);
  collector.feed(Buffer.from("ild 1500"), "stdout", 1600);
  assert.deepEqual(collector.finish(1700), [span("build", 1100, 1500)]);
});

test("stdout and stderr partial lines never corrupt one another", () => {
  const collector = new TimingCollector(0);
  collector.feed("TIMING start bu", "stdout", 10);
  collector.feed("warning: slow compiler\n", "stderr", 12);
  collector.feed("ild\n", "stdout", 20);
  collector.feed("TIMING end build\n", "stderr", 30);
  assert.deepEqual(collector.finish(40), [span("build", 20, 30)]);
});

test("repeated names and nested spans are paired without overwriting starts", () => {
  const collector = new TimingCollector(0);
  collector.feed("TIMING start compile 10\nTIMING start compile 20\nTIMING end compile 30\nTIMING end compile 40\n", "stdout", 100);
  assert.deepEqual(collector.finish(100), [span("compile", 20, 30), span("compile", 10, 40)]);
});

test("invalid, reserved, unmatched and unclosed spans are advisory only", () => {
  const collector = new TimingCollector(1000);
  collector.feed("TIMING start run_experiment\nTIMING wat nope\nTIMING end missing\nTIMING start old 900\nTIMING start future 9999\nTIMING end future 10000\nTIMING start unfinished\n", "stdout", 1100);
  assert.deepEqual(collector.finish(1200), []);
  assert.ok(collector.warnings.length >= 4);
});

test("parser memory and warnings are bounded", () => {
  const collector = new TimingCollector(0);
  collector.feed("x".repeat(200000));
  collector.feed("\n" + "TIMING end absent\n".repeat(2000));
  assert.deepEqual(collector.finish(), []);
  assert.ok(collector.warnings.length <= 8);
});

test("full loop includes agent/other tools; named nested spans avoid wrapper double-counting", () => {
  const timing = summarizeTiming([
    span("run_experiment", 350000, 382000, "automatic"),
    span("build", 350000, 380000),
    span("benchmark", 380000, 382000),
    span("checks", 382000, 392000, "automatic"),
  ], 0, 422000);
  assert.equal(timing.loopSeconds, 422);
  assert.equal(timing.runSeconds, 32);
  assert.equal(timing.checksSeconds, 10);
  assert.deepEqual(timing.longest, { name: "agent/other", seconds: 380 });
  assert.equal(timingSummary(timing), "Loop 7m 2s · run 32s · checks 10s · longest: agent/other 6m 20s");
});

test("longest pole identifies build rather than its enclosing run_experiment wrapper", () => {
  const timing = summarizeTiming([span("run_experiment", 0, 32000, "automatic"), span("build", 0, 30000)], 0, 35000);
  assert.deepEqual(timing.longest, { name: "build", seconds: 30 });
});

test("overlapping stages do not over-subtract from agent/other wall time", () => {
  const timing = summarizeTiming([span("run_experiment", 0, 10000, "automatic"), span("left", 0, 7000), span("right", 3000, 10000)], 0, 12000);
  assert.equal(timing.longest.name, "left");
  assert.ok(timing.longest.seconds <= timing.loopSeconds);
  assert.equal(timing.loopSeconds, 12);
});

test("old JSONL has no invented timing; new timing round-trips", () => {
  const timing = summarizeTiming([span("run_experiment", 1000, 33000, "automatic")], 0, 40000);
  const state = reconstructJsonlState([
    { type: "config", metricName: "tps", metricUnit: "tok/s", bestDirection: "higher" },
    { run: 1, status: "keep", metric: 100 },
    { run: 2, status: "discard", metric: 90, timing },
  ].map(JSON.stringify).join("\n"));
  assert.equal(state.results[0].timing, undefined);
  assert.equal(state.results[1].timing.loopSeconds, 40);
  assert.equal(state.results[1].timing.runSeconds, 32);
  assert.equal(parseTiming({ runSeconds: -10, checksSeconds: 0, spans: [] }), undefined);
});

test("overall comparison survives baseline reset but never compares different metrics or units", () => {
  const state = reconstructJsonlState([
    { type: "config", metricName: "tps", metricUnit: "tok/s", bestDirection: "higher" },
    { run: 1, status: "crash", metric: 0 },
    { run: 2, status: "keep", metric: 100 },
    { type: "config", metricName: "latency", metricUnit: "ms", bestDirection: "lower" },
    { run: 3, status: "keep", metric: 20 },
    { type: "config", metricName: "tps", metricUnit: "tok/s", bestDirection: "higher" },
    { run: 4, status: "keep", metric: 300 },
  ].map(JSON.stringify).join("\n"));
  assert.equal(firstComparableBaseline(state.results, "tps", "tok/s", "higher").run, 2);
  assert.equal(firstComparableBaseline(state.results, "latency", "ms", "lower").run, 3);
  assert.equal(firstComparableBaseline(state.results, "tps", "ms", "higher"), undefined);
  assert.equal(firstComparableBaseline(state.results, "tps", "tok/s", "lower"), undefined);
});
