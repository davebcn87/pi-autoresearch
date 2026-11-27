import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import autoresearchExtension, {
  shouldAutoActivateAutoresearch,
} from "../extensions/pi-autoresearch/index.ts";

const ACTIVATION_ENTRY = "pi-autoresearch.activation";
const AUTORESEARCH_TOOLS = ["init_experiment", "log_experiment", "run_experiment"];
const FINALIZE_KICKOFF = { content: "/skill:autoresearch-finalize", options: { expandPromptTemplates: true } };

function createHarness({ cwd, branch = [], initialActiveTools = [], busy = false }) {
  const commands = new Map();
  const handlers = new Map();
  const messageRenderers = new Map();
  const tools = new Map();
  const widgets = [];
  const statuses = [];
  const notifications = [];
  const appendedEntries = [];
  const sentMessages = [];
  const customMessages = [];
  let activeTools = [...initialActiveTools];
  let aborted = false;
  let agentBusy = busy;

  autoresearchExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
      branch.push({ type: "custom", customType, data });
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer(customType, renderer) {
      messageRenderers.set(customType, renderer);
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerShortcut() {},
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(nextTools) {
      activeTools = [...nextTools];
    },
    sendUserMessage(content, options) {
      sentMessages.push({ content, options });
    },
    sendMessage(message, options) {
      customMessages.push({ message, options });
    },
  });

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    isIdle: () => !agentBusy,
    hasPendingMessages: () => false,
    abort() {
      aborted = true;
    },
    // Stands in for pi letting the current run finish, or wind down after an abort.
    async waitForIdle() {
      agentBusy = false;
    },
    sessionManager: {
      getSessionId: () => `test:${cwd}`,
      getBranch: () => branch,
    },
    ui: {
      setWidget(name, widget) {
        widgets.push({ name, widget });
      },
      setStatus(name, value) { statuses.push({ name, value }); },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  return {
    appendedEntries,
    commands,
    customMessages,
    handlers,
    messageRenderers,
    ctx,
    notifications,
    sentMessages,
    tools,
    widgets,
    statuses,
    activeTools: () => activeTools,
    aborted: () => aborted,
  };
}

function activationEntry(workDir, active = true) {
  return {
    type: "custom",
    customType: ACTIVATION_ENTRY,
    data: {
      version: 1,
      workDir,
      active,
    },
  };
}

function staleLogExperimentEntry() {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "log_experiment",
      details: {
        state: {
          results: [
            {
              commit: "abcdef0",
              metric: 12,
              metrics: {},
              status: "crash",
              description: "stale run from deleted log",
              timestamp: Date.now(),
              segment: 0,
              confidence: null,
            },
          ],
          bestMetric: 12,
          bestDirection: "lower",
          metricName: "quote_field_usec",
          metricUnit: "µs",
          secondaryMetrics: [],
          name: "PickPeriod backend quote field optimization",
          currentSegment: 0,
          maxExperiments: null,
          confidence: null,
        },
      },
    },
  };
}

async function writeRedirectedSession(cwd, workDir, config = {}) {
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(
    join(cwd, ".auto", "config.json"),
    JSON.stringify({ workingDir: workDir, ...config }) + "\n",
  );
  await mkdir(join(workDir, ".auto"), { recursive: true });
  await writeFile(
    join(workDir, ".auto", "log.jsonl"),
    [
      JSON.stringify({
        type: "config",
        name: "Redirected research",
        metricName: "runtime_ms",
        metricUnit: "ms",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "abcdef0",
        metric: 10,
        metrics: {},
        status: "crash",
        description: "baseline",
        timestamp: Date.now(),
      }),
    ].join("\n") + "\n",
  );
}

async function writeSameCwdLog(cwd) {
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(
    join(cwd, ".auto", "log.jsonl"),
    [
      JSON.stringify({
        type: "config",
        name: "Same-cwd research",
        metricName: "runtime_ms",
        metricUnit: "ms",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "abcdef0",
        metric: 10,
        metrics: {},
        status: "crash",
        description: "baseline",
        timestamp: Date.now(),
      }),
    ].join("\n") + "\n",
  );
}

for (const command of ["/skill:autoresearch-create", "/skill:autoresearch-create optimize TPS", "/autoresearch-create optimize TPS"]) {
  test(`create skill activates tools before expansion: ${command}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-skill-"));
    try {
      const harness = createHarness({ cwd, initialActiveTools: ["bash"] });
      await harness.handlers.get("session_start")({}, harness.ctx);
      assert.deepEqual(harness.activeTools(), ["bash"]);
      const result = await harness.handlers.get("input")({ text: command, source: "interactive" }, harness.ctx);
      assert.equal(result, undefined, "skill expansion must still run");
      assert.deepEqual(harness.activeTools().sort(), ["bash", ...AUTORESEARCH_TOOLS].sort());
      assert.equal(harness.appendedEntries.at(-1).data.active, true);
      assert.equal(harness.sentMessages.length, 0, "do not duplicate the skill kickoff");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

test("already-expanded create skills activate before the first provider request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-skill-"));
  try {
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    const sections = {};
    await harness.handlers.get("before_agent_start")({ prompt: '<skill name="autoresearch-create" location="/skills/SKILL.md">instructions</skill>', systemPromptOptions: { sections } }, harness.ctx);
    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
    assert.match(sections.autoresearch, /Autoresearch Mode \(ACTIVE\)/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("mentioning the create skill or other skills does not activate mode", async () => {
  const harness = createHarness({ cwd: "/tmp/no-autoresearch-project" });
  for (const text of ["explain /skill:autoresearch-create", "/skill:autoresearch-finalize", "/skill:autoresearch-create-extra", "/autoresearch help"]) {
    await harness.handlers.get("input")({ text, source: "interactive" }, harness.ctx);
  }
  assert.deepEqual(harness.activeTools(), []);
  assert.equal(harness.appendedEntries.length, 0);
});

for (const point of ["startup", "before_agent_start", "turn_end"]) {
  for (const artifact of ["prompt", "log"]) {
    test(`${point} discovers ${artifact} session files and activates real tools`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-live-files-"));
      try {
        const harness = createHarness({ cwd, busy: point === "turn_end" });
        if (point !== "startup") await harness.handlers.get("session_start")({}, harness.ctx);
        if (artifact === "log") await writeSameCwdLog(cwd);
        else {
          await mkdir(join(cwd, ".auto"), { recursive: true });
          await writeFile(join(cwd, ".auto", "prompt.md"), "# Optimize TPS\n");
        }
        const sections = {};
        const event = { prompt: "continue", systemPromptOptions: { sections }, outcome: "completed", entries: [], toolResults: [] };
        const result = await harness.handlers.get(point === "startup" ? "session_start" : point)(event, harness.ctx);
        assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
        if (point === "before_agent_start") assert.match(sections.autoresearch, /Autoresearch Mode \(ACTIVE\)/);
        if (point === "turn_end") {
          assert.equal(result.continue, true);
          assert.match(result.entries.at(-1).content, /not manual shell\/log substitutes/);
          const repeated = await harness.handlers.get("turn_end")(event, harness.ctx);
          assert.equal(repeated, undefined, "recover only once; do not fake logged experiments");
          const settle = await harness.handlers.get("agent_before_settle")(event, harness.ctx);
          assert.equal(settle, undefined, "chat-only guard still applies");
        }
      } finally { await rm(cwd, { recursive: true, force: true }); }
    });
  }
}

test("live discovery respects manual off, clear, and finalize and never revives stopping", async () => {
  for (const command of ["off", "clear", "finalize"]) {
    const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-off-files-"));
    try {
      await writeSameCwdLog(cwd);
      const harness = createHarness({ cwd, busy: true });
      await harness.handlers.get("session_start")({}, harness.ctx);
      await harness.commands.get("autoresearch").handler(command, harness.ctx);
      // clear may remove the log, but a late tool can write another file.
      await writeSameCwdLog(cwd);
      const event = { prompt: "continue", systemPromptOptions: { sections: {} }, outcome: "completed", entries: [] };
      assert.equal(await harness.handlers.get("turn_end")(event, harness.ctx), undefined);
      await harness.handlers.get("agent_settled")({ aborted: true }, harness.ctx);
      await harness.handlers.get("before_agent_start")(event, harness.ctx);
      assert.deepEqual(harness.activeTools(), []);
      assert.equal("autoresearch" in event.systemPromptOptions.sections, false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
});

test("live discovery never activates unrelated redirected working directories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-workdir-"));
  try {
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await writeRedirectedSession(cwd, workDir);
    const event = { prompt: "hello", systemPromptOptions: { sections: {} }, outcome: "completed", entries: [] };
    await harness.handlers.get("before_agent_start")(event, harness.ctx);
    assert.equal(await harness.handlers.get("turn_end")(event, harness.ctx), undefined);
    assert.deepEqual(harness.activeTools(), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("off with a playbook pauses visibly, survives reload/late events, and resume reactivates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-pause-"));
  const branch = [];
  try {
    await writeSameCwdLog(cwd);
    await writeFile(join(cwd, ".auto/prompt.md"), "# Optimize TPS");
    let harness = createHarness({ cwd, branch, busy: true });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.commands.get("autoresearch").handler("off", harness.ctx);
    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.aborted(), true);
    assert.deepEqual(harness.statuses.at(-1), { name: "autoresearch", value: "autoresearch paused" });
    assert.match(harness.widgets.at(-1).widget[0], /autoresearch paused/);
    await harness.handlers.get("agent_settled")({ aborted: true }, harness.ctx);
    const event = { prompt: "chat", outcome: "completed", entries: [], systemPromptOptions: { sections: {} } };
    await harness.handlers.get("before_agent_start")(event, harness.ctx);
    assert.equal(await harness.handlers.get("turn_end")(event, harness.ctx), undefined);
    assert.deepEqual(harness.activeTools(), []);
    harness = createHarness({ cwd, branch });
    await harness.handlers.get("session_start")({}, harness.ctx);
    assert.match(harness.widgets.at(-1).widget[0], /autoresearch paused/);
    await harness.commands.get("autoresearch").handler("resume", harness.ctx);
    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
    assert.equal(harness.statuses.at(-1).value, undefined);
    assert.equal(harness.sentMessages.length, 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("clear cannot stop a playbook-backed session; finalize can, without deleting the playbook", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-finalize-"));
  const branch = [];
  try {
    await writeSameCwdLog(cwd);
    await writeFile(join(cwd, ".auto/prompt.md"), "# Optimize TPS");
    const harness = createHarness({ cwd, branch });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.commands.get("autoresearch").handler("clear", harness.ctx);
    assert.match(harness.widgets.at(-1).widget[0], /autoresearch paused/);
    await harness.commands.get("autoresearch").handler("finalize", harness.ctx);
    assert.equal(harness.widgets.at(-1).widget, undefined);
    assert.equal(existsSync(join(cwd, ".auto/prompt.md")), true);
    const reloaded = createHarness({ cwd, branch });
    await reloaded.handlers.get("session_start")({}, reloaded.ctx);
    assert.deepEqual(reloaded.activeTools(), []);
    assert.equal(reloaded.widgets.at(-1).widget, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

for (const paused of [false, true]) {
  test(`deleting .auto stops an ${paused ? "paused" : "active"} session`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-delete-"));
    try {
      await writeSameCwdLog(cwd);
      await writeFile(join(cwd, ".auto/prompt.md"), "# Optimize TPS");
      const harness = createHarness({ cwd });
      await harness.handlers.get("session_start")({}, harness.ctx);
      if (paused) await harness.commands.get("autoresearch").handler("pause", harness.ctx);
      await rm(join(cwd, ".auto"), { recursive: true, force: true });
      await harness.handlers.get("before_agent_start")({ prompt: "chat", systemPromptOptions: { sections: {} } }, harness.ctx);
      assert.deepEqual(harness.activeTools(), []);
      assert.equal(harness.widgets.at(-1).widget, undefined);
      assert.equal(harness.statuses.at(-1).value, undefined);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

test("failed attempts leave baseline unset until the first kept measurement, including reload", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-first-success-"));
  try {
    const harness = createHarness({ cwd });
    await harness.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", direction: "higher" }, undefined, undefined, harness.ctx);
    assert.match(harness.widgets.at(-1).widget[0], /awaiting first successful baseline/);
    for (const [index, status] of ["crash", "checks_failed", "keep"].entries()) {
      const result = await harness.tools.get("log_experiment").execute(`run${index}`, { commit: "abcdef0", status, metric: 10 + index, description: status, metrics: {}, asi: { hypothesis: "test" } }, undefined, undefined, harness.ctx);
      assert.equal(result.details.state.bestMetric, status === "keep" ? 12 : null);
    }
    const reloaded = createHarness({ cwd });
    await reloaded.handlers.get("session_start")({}, reloaded.ctx);
    const view = reloaded.widgets.at(-1).widget({}, PLAIN_THEME).render(120).join("\n");
    assert.match(view, /Baseline:.*12.*#3/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("iteration limits leave a playbook-backed loop visibly paused across reloads", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-limit-pause-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(join(cwd, ".auto/prompt.md"), "Optimize TPS\n");
    await writeFile(join(cwd, ".auto/config.json"), JSON.stringify({ maxIterations: 1 }));
    const harness = createHarness({ cwd });
    await harness.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", direction: "higher" }, undefined, undefined, harness.ctx);
    await harness.tools.get("log_experiment").execute("log", { commit: "abcdef0", status: "keep", metric: 100, metrics: {}, description: "measurement", asi: {} }, undefined, undefined, harness.ctx);
    assert.match(harness.widgets.at(-1).widget.join("\n"), /autoresearch paused/);
    const reloaded = createHarness({ cwd, branch: harness.appendedEntries.map((entry) => ({ type: "custom", ...entry })) });
    await reloaded.handlers.get("session_start")({}, reloaded.ctx);
    assert.match(reloaded.widgets.at(-1).widget.join("\n"), /autoresearch paused/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("run_experiment always emits automatic TIMING and persists untruncated optional spans", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-timing-"));
  try {
    const harness = createHarness({ cwd });
    await harness.tools.get("init_experiment").execute("init", { name: "Timing", metric_name: "tps", metric_unit: "tok/s", direction: "higher" }, undefined, undefined, harness.ctx);
    await writeFile(join(cwd, ".auto/measure.sh"), "printf 'TIMING start build\\n'; printf 'line\\n%.0s' {1..2000}; printf 'TIMING end build\\nMETRIC tps=100\\n'\n");
    const run = await harness.tools.get("run_experiment").execute("run", { command: "bash .auto/measure.sh" }, undefined, undefined, harness.ctx);
    assert.match(run.content[0].text, /TIMING start run_experiment \d+/);
    assert.match(run.content[0].text, /TIMING end run_experiment \d+/);
    assert.ok(run.details.timing.spans.some((span) => span.name === "build"));
    const logged = await harness.tools.get("log_experiment").execute("log", { commit: "abcdef0", status: "keep", metric: 100, metrics: {}, description: "first", asi: {} }, undefined, undefined, harness.ctx);
    assert.ok(logged.details.experiment.timing.loopSeconds >= logged.details.experiment.timing.runSeconds);
    assert.match(logged.content[0].text, /Loop .* · run .* · longest:/);
    const reloaded = createHarness({ cwd });
    await reloaded.handlers.get("session_start")({}, reloaded.ctx);
    const view = reloaded.widgets.at(-1).widget({}, PLAIN_THEME).render(160).join("\n");
    assert.match(view, /Loop .*longest:/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("failed run gets automatic timing and cannot be kept as baseline", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-timing-fail-"));
  try {
    const harness = createHarness({ cwd });
    await harness.tools.get("init_experiment").execute("init", { name: "Timing", metric_name: "tps", direction: "higher" }, undefined, undefined, harness.ctx);
    const run = await harness.tools.get("run_experiment").execute("run", { command: "exit 1" }, undefined, undefined, harness.ctx);
    assert.equal(run.details.passed, false);
    assert.match(run.content[0].text, /TIMING end run_experiment/);
    const params = { commit: "abcdef0", status: "keep", metric: 100, metrics: {}, description: "bad baseline", asi: {} };
    const blocked = await harness.tools.get("log_experiment").execute("log", params, undefined, undefined, harness.ctx);
    assert.match(blocked.content[0].text, /Cannot keep.*benchmark failed/);
    const logged = await harness.tools.get("log_experiment").execute("log", { ...params, status: "crash", metric: 0 }, undefined, undefined, harness.ctx);
    assert.equal(logged.details.state.bestMetric, null);
    assert.ok(logged.details.experiment.timing);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("timing end is emitted for timed-out and aborted commands too", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-timing-abort-"));
  try {
    const harness = createHarness({ cwd });
    await harness.tools.get("init_experiment").execute("init", { name: "Timing", metric_name: "tps", direction: "higher" }, undefined, undefined, harness.ctx);
    const command = `node -e 'console.log("ready"); setInterval(() => {}, 1000)'`;
    const timedOut = await harness.tools.get("run_experiment").execute("timeout", { command, timeout_seconds: 0.01 }, undefined, undefined, harness.ctx);
    assert.equal(timedOut.details.timedOut, true);
    assert.match(timedOut.content[0].text, /TIMING end run_experiment/);
    const controller = new AbortController();
    const updates = [];
    await assert.rejects(harness.tools.get("run_experiment").execute("abort", { command }, controller.signal, (update) => {
      updates.push(update);
      if (update.content[0]?.text.includes("ready")) controller.abort();
    }, harness.ctx), /aborted/);
    assert.ok(updates.some((update) => /TIMING end run_experiment/.test(update.content[0]?.text)));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Progress appends overall delta after a baseline reset, including after reload", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-overall-"));
  try {
    const harness = createHarness({ cwd });
    const init = async () => harness.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", metric_unit: "tok/s", direction: "higher" }, undefined, undefined, harness.ctx);
    const log = async (metric) => harness.tools.get("log_experiment").execute("log", { commit: "abcdef0", status: "keep", metric, metrics: {}, description: "measurement", asi: {} }, undefined, undefined, harness.ctx);
    await init(); await log(100); await init(); await log(300); await log(400);
    const render = (value) => value.widgets.at(-1).widget({}, PLAIN_THEME).render(200).join("\n");
    assert.match(render(harness), /Progress:.*\(\+33.3%\).*\(\+300.0% from first baseline\)/);
    const reloaded = createHarness({ cwd });
    await reloaded.handlers.get("session_start")({}, reloaded.ctx);
    assert.match(render(reloaded), /\(\+300.0% from first baseline\)/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("first-baseline comparison stays visible with the live metric name in narrow panes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-overall-width-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    const config = { type: "config", name: "Beat vLLM", metricName: "proj_c1_dspark5_tps", metricUnit: "tok/s", bestDirection: "higher" };
    await writeFile(join(cwd, ".auto/log.jsonl"), [
      config,
      { run: 1, metric: 0, status: "crash" },
      { run: 2, metric: 22.239, status: "keep" },
      { ...config, name: "75% HBM / 25% UVA" },
      { run: 3, metric: 179.547, status: "keep" },
      { run: 4, metric: 261.593, status: "keep" },
    ].map(JSON.stringify).join("\n") + "\n");
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    const widget = harness.widgets.at(-1).widget({}, PLAIN_THEME);
    for (const width of [20, 40, 60, 80, 120, 200]) {
      const lines = widget.render(width);
      const text = lines.join(" ").replace(/\s+/g, " ");
      assert.match(text, /\(\+45.7%\)/, `current delta at width ${width}`);
      assert.match(text, /\(\+1076.3% from first baseline\)/, `first delta at width ${width}`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("same-cwd persisted logs still auto-activate autoresearch", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", true),
    true,
  );
});

test("missing persisted logs never auto-activate autoresearch", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", false),
    false,
  );
});

test("redirected workingDir logs require a pi-session activation", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true),
    false,
  );
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, true),
    true,
  );
});

test("a recorded manual off keeps same-cwd sessions inactive despite a persisted log", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", true, false),
    false,
  );
});

test("a recorded activation reactivates a redirected off decision on later start", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, false),
    false,
  );
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, true),
    true,
  );
});

test("session startup does not show a redirected workingDir dashboard without a session activation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-workdir-"));

  try {
    await writeRedirectedSession(cwd, workDir);

    const harness = createHarness({
      cwd,
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("session startup activates redirected workingDir dashboards when this pi session activated it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-workdir-"));

  try {
    await writeRedirectedSession(cwd, workDir);

    const harness = createHarness({
      cwd,
      branch: [activationEntry(workDir)],
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(typeof harness.widgets.at(-1)?.widget, "function");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("session startup keeps redirected workingDir inactive when deactivation is latest", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-workdir-"));

  try {
    await writeRedirectedSession(cwd, workDir);

    const harness = createHarness({
      cwd,
      branch: [activationEntry(workDir), activationEntry(workDir, false)],
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("starting autoresearch binds redirected workingDir activation to the pi session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
  const workDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-workdir-"));

  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "config.json"),
      JSON.stringify({ workingDir: workDir }) + "\n",
    );

    const harness = createHarness({ cwd });
    await harness.commands.get("autoresearch").handler("optimize runtime", harness.ctx);

    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());
    assert.equal(harness.appendedEntries.length, 1);
    assert.equal(harness.appendedEntries[0].customType, ACTIVATION_ENTRY);
    assert.equal(harness.appendedEntries[0].data.active, true);
    assert.equal(harness.appendedEntries[0].data.workDir, await realpath(workDir));
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test("starting autoresearch without prompt.md sends the create skill with expansion enabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    const harness = createHarness({ cwd });
    await harness.commands.get("autoresearch").handler("optimize runtime", harness.ctx);

    assert.equal(harness.sentMessages.length, 1);
    const [kickoff] = harness.sentMessages;
    assert.match(kickoff.content, /^\/skill:autoresearch-create optimize runtime/);
    assert.equal(kickoff.options.expandPromptTemplates, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("finalize stops an active loop and loads the finalize skill", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());

    await harness.commands.get("autoresearch").handler("finalize", harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.appendedEntries.at(-1).data.active, false);
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
    assert.deepEqual(harness.sentMessages, [FINALIZE_KICKOFF]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Esc and exhausted native retries persist a pause without any restart message", async () => {
  for (const stop of ["escape", "escape-during-boundary", "error"]) {
    const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cancel-"));
    try {
      await writeSameCwdLog(cwd);
      await writeFile(join(cwd, ".auto/prompt.md"), "Optimize latency\n");
      const harness = createHarness({ cwd });
      await harness.handlers.get("session_start")({}, harness.ctx);
      await harness.handlers.get("agent_start")({}, harness.ctx);
      await harness.tools.get("log_experiment").execute("log", { commit: "abcdef0", status: "keep", metric: 9, description: "measured", metrics: {}, asi: {} }, undefined, undefined, harness.ctx);
      await harness.handlers.get("agent_end")({}, harness.ctx);
      assert.equal(harness.customMessages.length, 0);
      assert.equal(harness.sentMessages.length, 0);
      if (stop !== "escape") {
        const result = await harness.handlers.get("agent_before_settle")({ outcome: stop === "error" ? "error" : "completed", entries: [], continue: false }, harness.ctx);
        assert.equal(result?.continue, stop === "error" ? undefined : true);
        if (result) assert.deepEqual(result.entries, []);
      }
      // Pi skips before_settle on abort; an abort during a handler suppresses
      // its proposed continuation and still emits this final notification.
      await harness.handlers.get("agent_settled")({ aborted: stop !== "error" }, harness.ctx);
      assert.match(harness.widgets.at(-1).widget.join("\n"), /autoresearch paused/);
      assert.deepEqual(harness.activeTools(), []);
      assert.equal(harness.aborted(), false, "settled notification must not recursively abort");
      await harness.handlers.get("turn_end")({ outcome: "completed", entries: [], continue: false }, harness.ctx);
      const sections = {};
      await harness.handlers.get("before_agent_start")({ prompt: "explain the result", systemPromptOptions: { sections } }, harness.ctx);
      assert.equal("autoresearch" in sections, false);
      assert.equal(harness.customMessages.length, 0);
      assert.equal(harness.sentMessages.length, 0);
      const reloaded = createHarness({ cwd, branch: harness.appendedEntries.map((entry) => ({ type: "custom", ...entry })) });
      await reloaded.handlers.get("session_start")({}, reloaded.ctx);
      assert.match(reloaded.widgets.at(-1).widget.join("\n"), /autoresearch paused/);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
});

test("manual session_compact pauses without launching another model request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.handlers.get("session_compact")({ reason: "manual", willRetry: false }, harness.ctx);

    assert.equal(harness.customMessages.length, 0);
    assert.equal(harness.sentMessages.length, 0);
    assert.match(harness.widgets.at(-1).widget.join("\n"), /autoresearch paused/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("overflow session_compact with willRetry does not double-resume", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, busy: true });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.handlers.get("session_compact")({ reason: "overflow", willRetry: true }, harness.ctx);
    const settle = await harness.handlers.get("agent_before_settle")(
      { outcome: "completed", entries: [], continue: false },
      harness.ctx,
    );

    assert.equal(harness.customMessages.length, 0);
    assert.equal(settle, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("threshold compaction during a run defers resume to agent_before_settle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, busy: true });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.handlers.get("session_compact")({ reason: "threshold", willRetry: false }, harness.ctx);
    assert.equal(harness.customMessages.length, 0);

    const settle = await harness.handlers.get("agent_before_settle")(
      { outcome: "completed", entries: [], continue: false },
      harness.ctx,
    );
    assert.equal(settle?.continue, true);
    assert.deepEqual(settle?.entries, []);
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("finalize clears pending compaction resume so agent_before_settle does not restart the loop", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, busy: true });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.handlers.get("session_compact")({ reason: "threshold", willRetry: false }, harness.ctx);
    await harness.commands.get("autoresearch").handler("finalize", harness.ctx);

    const settle = await harness.handlers.get("agent_before_settle")(
      { outcome: "completed", entries: [], continue: false },
      harness.ctx,
    );
    assert.equal(settle, undefined);
    assert.deepEqual(harness.sentMessages, [FINALIZE_KICKOFF]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("finalize aborts the in-flight iteration and starts the skill on a fresh turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, busy: true });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.commands.get("autoresearch").handler("finalize", harness.ctx);

    assert.equal(harness.aborted(), true);
    // No deliverAs: sent once the abort settled, not stranded in the aborted run's queue.
    assert.deepEqual(harness.sentMessages, [FINALIZE_KICKOFF]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("finalize after the loop is off loads the skill without aborting or recording another off", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, branch: [activationEntry(cwd, false)] });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.commands.get("autoresearch").handler("finalize", harness.ctx);

    assert.equal(harness.aborted(), false);
    assert.equal(harness.appendedEntries.length, 0);
    assert.deepEqual(harness.activeTools(), []);
    assert.deepEqual(harness.sentMessages, [FINALIZE_KICKOFF]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("finalize after the loop is off queues behind unrelated work instead of aborting it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, branch: [activationEntry(cwd, false)], busy: true });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.commands.get("autoresearch").handler("finalize", harness.ctx);

    assert.equal(harness.aborted(), false);
    assert.deepEqual(harness.sentMessages, [
      { ...FINALIZE_KICKOFF, options: { ...FINALIZE_KICKOFF.options, deliverAs: "followUp" } },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("finalize rejects a config-only log instead of starting a session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "log.jsonl"),
      JSON.stringify({ type: "config", name: "Not run yet" }) + "\n",
    );

    const harness = createHarness({ cwd });
    await harness.commands.get("autoresearch").handler("finalize", harness.ctx);

    assert.equal(harness.sentMessages.length, 0);
    assert.equal(harness.appendedEntries.length, 0);
    assert.deepEqual(harness.activeTools(), []);
    assert.match(harness.notifications.at(-1).message, /No logged experiments to finalize/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session startup keeps same-cwd sessions inactive when a manual off is recorded", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({
      cwd,
      branch: [activationEntry(cwd, false)],
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch off records a manual off decision for same-cwd sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, initialActiveTools: AUTORESEARCH_TOOLS });
    await harness.commands.get("autoresearch").handler("off", harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.appendedEntries.length, 1);
    assert.equal(harness.appendedEntries[0].customType, ACTIVATION_ENTRY);
    assert.equal(harness.appendedEntries[0].data.active, false);
    assert.equal(harness.appendedEntries[0].data.workDir, await realpath(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch dashboard explains that the overlay requires TUI mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    const harness = createHarness({ cwd });
    harness.ctx.mode = "rpc";

    await harness.commands.get("autoresearch").handler("dashboard", harness.ctx);

    assert.equal(harness.notifications.length, 1);
    assert.match(harness.notifications[0].message, /only available in TUI mode/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch offers completions for every subcommand", () => {
  const harness = createHarness({ cwd: "/tmp/pi-autoresearch-completions" });
  const complete = harness.commands.get("autoresearch").getArgumentCompletions;

  assert.ok(complete);
  assert.deepEqual(complete("")?.map((item) => item.value), ["off", "pause", "resume", "finalize", "clear", "export", "dashboard", "help"]);
  assert.deepEqual(complete("fin")?.map((item) => item.value), ["finalize"]);
  assert.deepEqual(complete("exp")?.map((item) => item.value), ["export"]);
  assert.deepEqual(complete("dash")?.map((item) => item.value), ["dashboard"]);
  assert.deepEqual(complete("CLE")?.map((item) => item.value), ["clear"]);
  assert.equal(complete("clear"), null);
  assert.equal(complete("unknown"), null);
  assert.equal(complete("optimize runtime"), null);
});

test("no offered subcommand is mistaken for a research goal", async () => {
  const complete = createHarness({ cwd: "/tmp/pi-autoresearch-completions" })
    .commands.get("autoresearch").getArgumentCompletions;

  for (const { value: subcommand } of complete("")) {
    const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
    try {
      const harness = createHarness({ cwd });
      harness.ctx.mode = "rpc";

      await harness.commands.get("autoresearch").handler(subcommand, harness.ctx);

      assert.equal(harness.sentMessages.length, 0, `${subcommand} started a research session`);
      assert.ok(
        !harness.appendedEntries.some((entry) => entry.data?.active === true),
        `${subcommand} activated autoresearch mode`,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

const PLAIN_THEME = new Proxy({}, { get: () => (...args) => args.at(-1) });

async function renderDashboardWidgetWithShortcuts(cwd, shortcuts) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "pi-autoresearch.json"), JSON.stringify({ shortcuts }));
    // Guards against reading the developer's own shortcut config.
    assert.equal(getAgentDir(), agentDir);

    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    return harness.widgets.at(-1).widget({}, PLAIN_THEME).render(120).join("\n");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("the dashboard hint names the dashboard subcommand when no shortcut is configured", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);
    const rendered = await renderDashboardWidgetWithShortcuts(cwd, {});

    assert.match(rendered, / \/autoresearch dashboard$/m);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the dashboard hint shows a configured fullscreen shortcut instead of the subcommand", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);
    const rendered = await renderDashboardWidgetWithShortcuts(cwd, { fullscreenDashboard: "ctrl+shift+u" });

    assert.match(rendered, / ctrl\+shift\+u fullscreen$/m);
    assert.doesNotMatch(rendered, /\/autoresearch dashboard/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch help and its aliases show usage instead of starting a session", async () => {
  for (const alias of ["", "help", "HELP", "--help", "-h"]) {
    const harness = createHarness({ cwd: "/tmp/pi-autoresearch-help" });

    await harness.commands.get("autoresearch").handler(alias, harness.ctx);

    assert.equal(harness.sentMessages.length, 0, `"${alias}" started a research session`);
    assert.equal(harness.appendedEntries.length, 0);
    assert.match(harness.notifications.at(-1).message, /^Usage: \/autoresearch \[off\|pause\|resume\|finalize\|/);
  }
});

test("/autoresearch clear turns off, deletes the log, and records a manual off decision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd, initialActiveTools: AUTORESEARCH_TOOLS });
    await harness.commands.get("autoresearch").handler("clear", harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(existsSync(join(cwd, ".auto", "log.jsonl")), false);
    assert.equal(harness.appendedEntries.length, 1);
    assert.equal(harness.appendedEntries[0].customType, ACTIVATION_ENTRY);
    assert.equal(harness.appendedEntries[0].data.active, false);
    assert.equal(harness.appendedEntries[0].data.workDir, await realpath(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const status of ["keep", "discard", "crash", "checks_failed"]) {
  for (const limitReached of [false, true]) {
    test(`log_experiment ${status} ${limitReached ? "stops without" : "includes"} the discard reminder`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-reminder-"));
      try {
        await writeSameCwdLog(cwd);
        if (limitReached) {
          await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ maxIterations: 2 }));
        }
        const harness = createHarness({ cwd });
        await harness.handlers.get("session_start")({}, harness.ctx);

        const result = await harness.tools.get("log_experiment").execute("test", {
          commit: "abcdef0",
          metric: 9,
          status,
          description: "test experiment",
          metrics: {},
          asi: { hypothesis: "test hypothesis", revisits_run: 1 },
        }, undefined, undefined, harness.ctx);
        const text = result.content[0].text;
        const rendered = harness.tools.get("log_experiment").renderResult(
          result, { expanded: false }, { fg: (_color, text) => text },
        ).render(100).join("\n");
        assert.match(rendered, /↻ Revisiting #1/);
        assert.equal(result.details.experiment.asi.revisits_run, 1);

        assert.equal(harness.aborted(), limitReached);
        if (limitReached) {
          assert.match(text, /STOP the experiment loop now/);
          assert.doesNotMatch(text, /previous discard/);
        } else {
          assert.match(text, /invalidates a previous discard's rollback reason/);
          assert.match(text, /weigh a targeted retry against other candidates/);
          assert.match(text, /Don't revive a discarded idea without a changed assumption/);
          assert.match(text, /Verification reruns to resolve measurement noise are separate/);
          assert.doesNotMatch(text, /don't retry unchanged hypotheses/);
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
}

test("log_experiment leaves ordinary results unchanged and ignores malformed revisit annotations", () => {
  const harness = createHarness({ cwd: "/unused" });
  const { details } = staleLogExperimentEntry().message;
  const render = (asi) => harness.tools.get("log_experiment").renderResult({
    content: [],
    details: { ...details, experiment: { ...details.state.results[0], asi } },
  }, { expanded: false }, { fg: (_color, text) => text }).render(100);
  const ordinaryResult = render(undefined);

  assert.doesNotMatch(ordinaryResult.join("\n"), /Revisiting/);
  for (const revisits_run of [undefined, null, "1", 0, -1, 1.5, true]) {
    assert.deepEqual(render({ revisits_run }), ordinaryResult);
  }
});

test("log_experiment revisit label wraps within narrow terminal widths", () => {
  const harness = createHarness({ cwd: "/unused" });
  const { details } = staleLogExperimentEntry().message;
  const component = harness.tools.get("log_experiment").renderResult({
    content: [],
    details: { ...details, experiment: { ...details.state.results[0], asi: { revisits_run: 5 } } },
  }, { expanded: false }, { fg: (_color, text) => text });

  for (const width of [20, 80]) {
    const lines = component.render(width);
    assert.match(lines.join("\n"), /↻ Revisiting #5/);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("deleted logs do not leave a stale autoresearch widget from session history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    const harness = createHarness({
      cwd,
      branch: [staleLogExperimentEntry()],
      initialActiveTools: AUTORESEARCH_TOOLS,
    });
    await harness.handlers.get("session_start")({}, harness.ctx);

    assert.deepEqual(harness.activeTools(), []);
    assert.equal(harness.widgets.at(-1)?.name, "autoresearch");
    assert.equal(harness.widgets.at(-1)?.widget, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gated tools register with defaultActive: false and MCP annotations", () => {
  const harness = createHarness({ cwd: "/unused" });

  for (const name of AUTORESEARCH_TOOLS) {
    const tool = harness.tools.get(name);
    assert.ok(tool, `expected ${name} to be registered`);
    assert.equal(tool.defaultActive, false);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean");
  }
});

test("before_agent_start mutates systemPromptOptions.sections without forcing systemPrompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);

    const sections = {};
    const activeRes = await harness.handlers.get("before_agent_start")(
      { messageType: "user", prompt: "go", systemPrompt: "BASE", systemPromptOptions: { sections } },
      harness.ctx,
    );
    assert.equal(activeRes, undefined);
    assert.match(sections.autoresearch, /Autoresearch Mode \(ACTIVE\)/);

    await harness.commands.get("autoresearch").handler("off", harness.ctx);
    const inactiveRes = await harness.handlers.get("before_agent_start")(
      { messageType: "user", prompt: "chat", systemPrompt: "BASE", systemPromptOptions: { sections } },
      harness.ctx,
    );
    assert.equal(inactiveRes, undefined);
    assert.equal("autoresearch" in sections, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("agent_before_settle resumes after logged experiments and skips chat-only or aborted runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.handlers.get("agent_start")({}, harness.ctx);

    // Chat-only turn: no experiment logged -> no auto-resume.
    const chatSettle = await harness.handlers.get("agent_before_settle")(
      { outcome: "completed", entries: [], continue: false },
      harness.ctx,
    );
    assert.equal(chatSettle, undefined);

    // Log an experiment during this run.
    await harness.tools.get("log_experiment").execute("t1", {
      commit: "abcdef0",
      metric: 9,
      status: "keep",
      description: "faster",
      metrics: {},
      asi: { hypothesis: "cache hot path" },
    }, undefined, undefined, harness.ctx);

    // Aborted outcome must not auto-resume and must reset the run window.
    const abortedSettle = await harness.handlers.get("agent_before_settle")(
      { outcome: "aborted", entries: [], continue: false },
      harness.ctx,
    );
    assert.equal(abortedSettle, undefined);
    await harness.handlers.get("agent_settled")({ aborted: true }, harness.ctx);

    assert.match(harness.widgets.at(-1).widget.join("\n"), /autoresearch paused/);
    // Only an explicit resume re-enables the loop after cancellation.
    await harness.commands.get("autoresearch").handler("resume", harness.ctx);
    await harness.handlers.get("agent_start")({}, harness.ctx);
    await harness.tools.get("log_experiment").execute("t2", {
      commit: "abcdef1",
      metric: 8,
      status: "keep",
      description: "even faster",
      metrics: {},
      asi: { hypothesis: "eliminate allocation" },
    }, undefined, undefined, harness.ctx);

    const completedSettle = await harness.handlers.get("agent_before_settle")(
      { outcome: "completed", entries: [], continue: false },
      harness.ctx,
    );
    assert.equal(completedSettle?.continue, true);
    assert.deepEqual(completedSettle?.entries, []);
    assert.equal(harness.customMessages.length, 0);

    // Old session history still renders even though new runs emit no messages.
    const oldResume = { content: "Run the next iteration now.", details: { turn: 1 } };
    const renderer = harness.messageRenderers.get("pi-autoresearch.resume");
    assert.ok(renderer);
    const compact = renderer(oldResume, { expanded: false }, PLAIN_THEME).render(100).join("\n");
    const expanded = renderer(oldResume, { expanded: true }, PLAIN_THEME).render(100).join("\n");
    assert.match(compact, /↻ Autoresearch continuing \(turn 1\)/);
    assert.match(expanded, /Run the next iteration now/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("compactEvery triggers deterministic compaction draft with firstKeptEntryId: null on turn_end", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));

  try {
    await writeSameCwdLog(cwd);
    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ compactEvery: 2 }) + "\n");

    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.handlers.get("agent_start")({}, harness.ctx);

    // 1st experiment: below cadence -> no compaction draft.
    await harness.tools.get("log_experiment").execute("t1", {
      commit: "1111111",
      metric: 9,
      status: "keep",
      description: "first",
      metrics: {},
      asi: { hypothesis: "h1" },
    }, undefined, undefined, harness.ctx);
    const turn1 = await harness.handlers.get("turn_end")(
      { outcome: "completed", entries: [], continue: false, toolResults: [] },
      harness.ctx,
    );
    assert.equal(turn1, undefined);

    // 2nd experiment: hits compactEvery=2 -> compaction + native continuation.
    await harness.tools.get("log_experiment").execute("t2", {
      commit: "2222222",
      metric: 8,
      status: "keep",
      description: "second",
      metrics: {},
      asi: { hypothesis: "h2" },
    }, undefined, undefined, harness.ctx);
    const turn2 = await harness.handlers.get("turn_end")(
      { outcome: "completed", entries: [], continue: false, toolResults: [] },
      harness.ctx,
    );
    assert.equal(turn2?.continue, true);
    assert.equal(turn2?.entries.length, 1);
    assert.equal(turn2?.entries[0].type, "compaction");
    assert.equal(turn2?.entries[0].firstKeptEntryId, null);
    assert.match(turn2?.entries[0].summary, /# Autoresearch Compaction Summary/);
    assert.equal(harness.customMessages.length, 0);
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
