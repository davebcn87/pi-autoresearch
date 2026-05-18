import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  buildHintPrompt,
  isHintConfigReady,
  requestAutoresearchHint,
  resolveHintConfig,
} from "../extensions/pi-autoresearch/hints.ts";
import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";

function sampleState() {
  return {
    name: "Speed up parser",
    metricName: "total_ms",
    metricUnit: "ms",
    bestDirection: "lower",
    bestMetric: 100,
    currentSegment: 0,
    confidence: 1.5,
    results: [
      {
        commit: "aaa1111",
        metric: 100,
        metrics: {},
        status: "keep",
        description: "baseline",
        timestamp: 1,
        segment: 0,
        confidence: null,
        asi: { hypothesis: "baseline" },
      },
      {
        commit: "bbb2222",
        metric: 130,
        metrics: {},
        status: "discard",
        description: "inline everything",
        timestamp: 2,
        segment: 0,
        confidence: 1.5,
        asi: {
          hypothesis: "inline hot parser path",
          rollback_reason: "larger function hurt optimizer",
          next_action_hint: "try cache shape metadata",
        },
      },
    ],
  };
}

test("hint config defaults to disabled", () => {
  const config = resolveHintConfig({});

  assert.equal(config.enabled, false);
  assert.equal(config.provider, null);
  assert.equal(config.model, null);
  assert.equal(config.thinkingLevel, "high");
  assert.equal(config.maxRecentRuns, 8);
  assert.equal(config.maxCallsPerSession, 5);
  assert.equal(config.timeoutSeconds, 120);
  assert.equal(isHintConfigReady(config), false);
});

test("hint config accepts enabled provider/model and clamps numeric limits", () => {
  const config = resolveHintConfig({
    hints: {
      enabled: true,
      provider: " anthropic ",
      model: " claude-opus ",
      thinkingLevel: "xhigh",
      maxRecentRuns: 100,
      maxCallsPerSession: 0,
      timeoutSeconds: 2,
    },
  });

  assert.equal(config.enabled, true);
  assert.equal(config.provider, "anthropic");
  assert.equal(config.model, "claude-opus");
  assert.equal(config.thinkingLevel, "xhigh");
  assert.equal(config.maxRecentRuns, 20);
  assert.equal(config.maxCallsPerSession, 1);
  assert.equal(config.timeoutSeconds, 10);
  assert.equal(isHintConfigReady(config), true);
});

test("hint config falls back on invalid thinking level and incomplete model config", () => {
  const config = resolveHintConfig({
    hints: {
      enabled: true,
      provider: "",
      model: "claude",
      thinkingLevel: "surprise",
    },
  });

  assert.equal(config.enabled, true);
  assert.equal(config.provider, null);
  assert.equal(config.model, "claude");
  assert.equal(config.thinkingLevel, "high");
  assert.equal(isHintConfigReady(config), false);
});

test("hint prompt includes bounded session, recent runs, rules, ideas, and question", () => {
  const workDir = fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-hints-"));
  try {
    fs.writeFileSync(path.join(workDir, "autoresearch.md"), `# Rules\n${"A".repeat(4000)}`);
    fs.writeFileSync(path.join(workDir, "autoresearch.ideas.md"), "- try memoization\n- try batching");

    const prompt = buildHintPrompt({
      state: sampleState(),
      workDir,
      question: "We have two discards; what should we try next?",
      extraContext: "Focus on low-risk parser optimizations.",
      maxRecentRuns: 1,
    });

    assert.match(prompt, /Goal: Speed up parser/);
    assert.match(prompt, /Metric: total_ms \(ms\); lower is better/);
    assert.doesNotMatch(prompt, /#1 \| keep/);
    assert.match(prompt, /#2 \| discard \| total_ms=130ms/);
    assert.match(prompt, /rollback_reason: larger function hurt optimizer/);
    assert.match(prompt, /try memoization/);
    assert.match(prompt, /We have two discards/);
    assert.match(prompt, /Focus on low-risk parser optimizations/);
    assert.match(prompt, /\[truncated to 3000 chars\]/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("requestAutoresearchHint uses injected completion and extracts text", async () => {
  let captured = null;
  const fakeComplete = async (model, context, options) => {
    captured = { model, context, options };
    return {
      role: "assistant",
      content: [{ type: "text", text: "Try one smaller cache experiment." }],
      timestamp: Date.now(),
      stopReason: "stop",
      usage: {
        input: 10,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 17,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
  };

  const result = await requestAutoresearchHint({
    model: { id: "hint-model" },
    apiKey: "key",
    headers: { "x-test": "1" },
    state: sampleState(),
    workDir: tmpdir(),
    question: "What next?",
    maxRecentRuns: 2,
    thinkingLevel: "off",
    timeoutSeconds: 10,
    complete: fakeComplete,
  });

  assert.equal(result.text, "Try one smaller cache experiment.");
  assert.equal(result.stopReason, "stop");
  assert.equal(result.usage.output, 7);
  assert.equal(captured.options.apiKey, "key");
  assert.equal(captured.options.headers["x-test"], "1");
  assert.equal(captured.options.reasoning, undefined);
  assert.match(captured.context.systemPrompt, /strategy advice only/);
});

function collectHintTool() {
  let hintTool = null;
  autoresearchExtension({
    on() {},
    registerCommand() {},
    registerShortcut() {},
    registerTool(tool) {
      if (tool.name === "ask_autoresearch_hint") hintTool = tool;
    },
  });
  return hintTool;
}

function fakeContext(workDir, modelRegistry) {
  return {
    cwd: workDir,
    sessionManager: {
      getSessionId() {
        return "hint-test-session";
      },
    },
    modelRegistry,
  };
}

test("hint tool disabled config does not touch model registry", async () => {
  const workDir = fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-hints-"));
  let findCalls = 0;
  try {
    const tool = collectHintTool();
    const result = await tool.execute(
      "call-1",
      { question: "What next?" },
      undefined,
      undefined,
      fakeContext(workDir, {
        find() {
          findCalls++;
        },
      }),
    );

    assert.equal(findCalls, 0);
    assert.match(result.content[0].text, /hints are disabled/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("hint tool incomplete config does not touch model registry", async () => {
  const workDir = fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-hints-"));
  let findCalls = 0;
  try {
    fs.writeFileSync(
      path.join(workDir, "autoresearch.config.json"),
      JSON.stringify({ hints: { enabled: true, model: "claude" } }),
    );

    const tool = collectHintTool();
    const result = await tool.execute(
      "call-1",
      { question: "What next?" },
      undefined,
      undefined,
      fakeContext(workDir, {
        find() {
          findCalls++;
        },
      }),
    );

    assert.equal(findCalls, 0);
    assert.match(result.content[0].text, /provider and hints\.model/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("hint tool blocks concurrent calls while auth is resolving", async () => {
  const workDir = fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-hints-"));
  try {
    fs.writeFileSync(
      path.join(workDir, "autoresearch.config.json"),
      JSON.stringify({
        hints: {
          enabled: true,
          provider: "anthropic",
          model: "claude",
        },
      }),
    );

    let resolveAuth;
    const authPromise = new Promise((resolve) => {
      resolveAuth = resolve;
    });

    const tool = collectHintTool();
    const ctx = fakeContext(workDir, {
      find() {
        return { id: "claude", provider: "anthropic", api: "anthropic-messages" };
      },
      getApiKeyAndHeaders() {
        return authPromise;
      },
    });

    const first = tool.execute("call-1", { question: "What next?" }, undefined, undefined, ctx);
    await new Promise((resolve) => setImmediate(resolve));

    const second = await tool.execute("call-2", { question: "What next?" }, undefined, undefined, ctx);
    assert.match(second.content[0].text, /already in flight/);

    resolveAuth({ ok: false, error: "missing key" });
    const firstResult = await first;
    assert.match(firstResult.content[0].text, /missing key/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
