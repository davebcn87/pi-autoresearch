import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function dashboard() {
  const html = readFileSync(new URL("../assets/template.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace("    initializePage();", "");
  const nodes = new Map();
  const node = () => ({ textContent: "", style: {}, children: [], appendChild(child) { this.children.push(child); } });
  const document = {
    createElement: node,
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
  };
  const context = vm.createContext({ document });
  vm.runInContext(script + ";globalThis.api = { parseAutoresearchText, applyParsedData, renderCards, formatTimingSummary, session };", context);
  return { ...context.api, document };
}

test("browser uses current baseline while retaining the first comparable baseline", () => {
  const api = dashboard();
  const parsed = api.parseAutoresearchText([
    { type: "config", name: "First", metricName: "tps", metricUnit: "tok/s", bestDirection: "higher" },
    { run: 1, metric: 0, status: "crash" },
    { run: 2, metric: 100, status: "keep" },
    { type: "config", name: "Reset", metricName: "tps", metricUnit: "tok/s", bestDirection: "higher" },
    { run: 3, metric: 300, status: "keep" },
    { run: 4, metric: 400, status: "keep", timing: { loopSeconds: 422, runSeconds: 32, checksSeconds: 10, longest: { name: "build", seconds: 30 } } },
    { run: 5, metric: 9999, status: "checks_failed" },
  ].map(JSON.stringify).join("\n"));
  assert.equal(parsed.ok, true);
  api.applyParsedData(parsed.config, parsed.runs);
  assert.equal(api.session.baseline, 300);
  assert.equal(api.session.best, 400);
  assert.equal(api.session.firstBaseline.metric, 100);
  api.renderCards();
  assert.equal(api.document.getElementById("improvement").textContent, "33.3%");
  const note = api.document.getElementById("improvement").children[0];
  assert.equal(note.textContent, " (+300.0% from first baseline)");
  assert.equal(note.style.color, "var(--muted)");
  assert.equal(api.formatTimingSummary(parsed.runs[3].timing), "Loop 7m 2s · run 32s · checks 10s · longest: build 30s");
});

test("browser never compares baselines of different targets and excludes failed attempts", () => {
  const api = dashboard();
  const parsed = api.parseAutoresearchText([
    { type: "config", metricName: "tps", metricUnit: "tok/s", bestDirection: "higher" },
    { run: 1, metric: 100, status: "keep" },
    { type: "config", metricName: "latency", metricUnit: "ms", bestDirection: "lower" },
    { run: 2, metric: 1, status: "checks_failed" },
    { run: 3, metric: 10, status: "discard" },
    { run: 4, metric: 20, status: "keep" },
  ].map(JSON.stringify).join("\n"));
  api.applyParsedData(parsed.config, parsed.runs);
  assert.equal(api.session.baseline, 20);
  assert.equal(api.session.firstBaseline.metric, 20);
  assert.equal(api.session.best, 20);
  api.renderCards();
  assert.equal(api.document.getElementById("improvement").children.length, 0);
  assert.equal(api.document.getElementById("loop-timing").textContent, "");
});
