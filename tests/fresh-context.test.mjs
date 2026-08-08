import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension, {
  readFreshContextPerIteration,
} from "../extensions/pi-autoresearch/index.ts";

const AUTORESEARCH_TOOLS = ["init_experiment", "log_experiment", "run_experiment"];

async function writeConfig(cwd, config) {
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify(config) + "\n");
}

// A same-cwd persisted log makes session_start auto-activate autoresearch mode.
async function writeSameCwdLog(cwd, config = {}) {
  await writeConfig(cwd, config);
  await writeFile(
    join(cwd, ".auto", "log.jsonl"),
    [
      JSON.stringify({
        type: "config",
        name: "Fresh-context research",
        metricName: "runtime_ms",
        metricUnit: "ms",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "abcdef0",
        metric: 10,
        metrics: {},
        status: "keep",
        description: "baseline",
        timestamp: Date.now(),
      }),
    ].join("\n") + "\n",
  );
}

// Minimal harness: enough of the pi extension + session ctx surface to drive
// session_start and the /autoresearch-next command handler, capturing the
// newSession() handoff and any messages sent into the replacement session.
function createHarness({ cwd, initialActiveTools = [] }) {
  const commands = new Map();
  const handlers = new Map();
  const newSessionCalls = [];
  const freshMessages = [];
  let activeTools = [...initialActiveTools];

  autoresearchExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    appendEntry() {},
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
    sendUserMessage() {},
  });

  const ctx = {
    cwd,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    waitForIdle: async () => {},
    sessionManager: {
      getSessionId: () => `test:${cwd}`,
      getBranch: () => [],
      getSessionFile: () => `${cwd}/.auto/session.jsonl`,
    },
    async newSession(options) {
      newSessionCalls.push(options);
      if (options?.withSession) {
        await options.withSession({
          sendUserMessage: (content) => freshMessages.push(content),
        });
      }
      return { cancelled: false };
    },
    ui: {
      setWidget() {},
      notify() {},
    },
  };

  return {
    commands,
    handlers,
    ctx,
    newSessionCalls,
    freshMessages,
    activeTools: () => activeTools,
  };
}

test("readFreshContextPerIteration defaults to false when unset", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-fresh-"));
  try {
    assert.equal(readFreshContextPerIteration(cwd), false);
    await writeConfig(cwd, { maxIterations: 50 });
    assert.equal(readFreshContextPerIteration(cwd), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("readFreshContextPerIteration reads the boolean flag from config", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-fresh-"));
  try {
    await writeConfig(cwd, { freshContextPerIteration: true });
    assert.equal(readFreshContextPerIteration(cwd), true);

    await writeConfig(cwd, { freshContextPerIteration: false });
    assert.equal(readFreshContextPerIteration(cwd), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("readFreshContextPerIteration only treats a real boolean true as enabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-fresh-"));
  try {
    // Truthy-but-not-true values must not silently enable the feature.
    await writeConfig(cwd, { freshContextPerIteration: "true" });
    assert.equal(readFreshContextPerIteration(cwd), false);

    await writeConfig(cwd, { freshContextPerIteration: 1 });
    assert.equal(readFreshContextPerIteration(cwd), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch-next starts a fresh session and kicks off a rehydrating experiment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-fresh-"));
  try {
    await writeSameCwdLog(cwd, { freshContextPerIteration: true });

    const harness = createHarness({ cwd });
    // session_start auto-activates autoresearch mode from the same-cwd log.
    await harness.handlers.get("session_start")({}, harness.ctx);
    assert.deepEqual(harness.activeTools().sort(), AUTORESEARCH_TOOLS.sort());

    await harness.commands.get("autoresearch-next").handler("", harness.ctx);

    assert.equal(harness.newSessionCalls.length, 1);
    assert.equal(
      harness.newSessionCalls[0].parentSession,
      `${cwd}/.auto/session.jsonl`,
    );
    assert.equal(harness.freshMessages.length, 1);
    // The kickoff must instruct the history-less session to rehydrate from disk.
    assert.match(harness.freshMessages[0], /fresh session/i);
    assert.match(harness.freshMessages[0], /rehydrate/i);
    assert.match(harness.freshMessages[0], /log\.jsonl/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/autoresearch-next is a no-op when autoresearch mode is inactive", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-fresh-"));
  try {
    // No persisted log => session_start leaves autoresearch mode off.
    const harness = createHarness({ cwd });
    await harness.handlers.get("session_start")({}, harness.ctx);

    await harness.commands.get("autoresearch-next").handler("", harness.ctx);

    assert.equal(harness.newSessionCalls.length, 0);
    assert.equal(harness.freshMessages.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
