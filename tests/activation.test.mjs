import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import autoresearchExtension, {
  shouldAutoActivateAutoresearch,
} from "../extensions/pi-autoresearch/index.ts";

const ACTIVATION_ENTRY = "pi-autoresearch.activation";
const AUTORESEARCH_TOOLS = ["init_experiment", "log_experiment", "run_experiment"];
const FINALIZE_KICKOFF = { content: "/skill:autoresearch-finalize", options: { expandPromptTemplates: true } };
const LONGER_THAN_AUTO_RESUME_DELAY_MS = 10_000;

function createHarness({ cwd, branch = [], initialActiveTools = [], busy = false }) {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const widgets = [];
  const notifications = [];
  const appendedEntries = [];
  const sentMessages = [];
  let activeTools = [...initialActiveTools];
  let aborted = false;
  let agentBusy = busy;

  autoresearchExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
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
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  return {
    appendedEntries,
    commands,
    handlers,
    ctx,
    notifications,
    sentMessages,
    tools,
    widgets,
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

test("a scheduled auto-resume restarts the loop when nothing stops it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
  mock.timers.enable({ apis: ["setTimeout"] });

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.handlers.get("session_compact")({}, harness.ctx);
    mock.timers.tick(LONGER_THAN_AUTO_RESUME_DELAY_MS);

    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0].content, /Run the next iteration now/);
  } finally {
    mock.timers.reset();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("finalize cancels a scheduled auto-resume so the loop does not restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-cwd-"));
  mock.timers.enable({ apis: ["setTimeout"] });

  try {
    await writeSameCwdLog(cwd);

    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.handlers.get("session_compact")({}, harness.ctx);
    await harness.commands.get("autoresearch").handler("finalize", harness.ctx);
    mock.timers.tick(LONGER_THAN_AUTO_RESUME_DELAY_MS);

    assert.deepEqual(harness.sentMessages, [FINALIZE_KICKOFF]);
  } finally {
    mock.timers.reset();
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
  assert.deepEqual(complete("")?.map((item) => item.value), ["off", "finalize", "clear", "export", "dashboard", "help"]);
  assert.deepEqual(complete("fin")?.map((item) => item.value), ["finalize"]);
  assert.deepEqual(complete("exp")?.map((item) => item.value), ["export"]);
  assert.deepEqual(complete("dash")?.map((item) => item.value), ["dashboard"]);
  assert.deepEqual(complete("CLEAR")?.map((item) => item.value), ["clear"]);
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

test("/autoresearch help and its aliases show usage instead of starting a session", async () => {
  for (const alias of ["", "help", "HELP", "--help", "-h"]) {
    const harness = createHarness({ cwd: "/tmp/pi-autoresearch-help" });

    await harness.commands.get("autoresearch").handler(alias, harness.ctx);

    assert.equal(harness.sentMessages.length, 0, `"${alias}" started a research session`);
    assert.equal(harness.appendedEntries.length, 0);
    assert.match(harness.notifications.at(-1).message, /^Usage: \/autoresearch \[off\|finalize\|/);
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
