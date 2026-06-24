import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension, {
  shouldAutoActivateAutoresearch,
} from "../extensions/pi-autoresearch/index.ts";

const ACTIVATION_ENTRY = "pi-autoresearch.activation";
const AUTORESEARCH_TOOLS = ["init_experiment", "log_experiment", "run_experiment"];

function createHarness({ cwd, branch = [], initialActiveTools = [] }) {
  const commands = new Map();
  const handlers = new Map();
  const widgets = [];
  const notifications = [];
  const appendedEntries = [];
  const sentMessages = [];
  let activeTools = [...initialActiveTools];
  let aborted = false;

  autoresearchExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    registerTool() {},
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
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {
      aborted = true;
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
