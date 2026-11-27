import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";

import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_ENTRY = join(REPO_ROOT, "extensions", "pi-autoresearch", "index.ts");

test("Pi 1.7 resource loader loads pi-autoresearch cleanly with defaultActive: false tools and handlers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-sdk-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-agent-"));

  try {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        noExtensions: true,
        additionalExtensionPaths: [EXTENSION_ENTRY],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });

    const { extensions, errors } = services.resourceLoader.getExtensions();
    assert.deepEqual(errors, []);
    assert.equal(extensions.length, 1);

    const ext = extensions[0];
    assert.deepEqual(
      [...ext.tools.keys()].sort(),
      ["init_experiment", "log_experiment", "run_experiment"],
    );
    for (const tool of ext.tools.values()) {
      assert.equal(tool.definition.defaultActive, false);
      assert.ok(tool.definition.annotations, `missing annotations on ${tool.definition.name}`);
    }

    assert.equal(ext.commands.has("autoresearch"), true);
    assert.equal(ext.messageRenderers.has("pi-autoresearch.resume"), true);

    for (const requiredEvent of [
      "session_start",
      "session_tree",
      "session_before_switch",
      "session_shutdown",
      "session_before_compact",
      "session_compact",
      "session_compact_failed",
      "before_agent_start",
      "agent_start",
      "turn_end",
      "agent_end",
      "agent_before_settle",
      "agent_settled",
    ]) {
      assert.equal(ext.handlers.has(requiredEvent), true, `missing handler for ${requiredEvent}`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("live edits to .auto/config.json take effect immediately and checks gate blocks keep", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-live-"));

  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    await writeFile(
      join(cwd, ".auto", "measure.sh"),
      "#!/usr/bin/env bash\necho 'METRIC latency_ms=42'\n",
    );
    await chmod(join(cwd, ".auto", "measure.sh"), 0o755);
    await writeFile(
      join(cwd, ".auto", "checks.sh"),
      "#!/usr/bin/env bash\necho 'lint failed' >&2\nexit 1\n",
    );
    await chmod(join(cwd, ".auto", "checks.sh"), 0o755);

    const handlers = new Map();
    const tools = new Map();
    let activeTools = [];

    autoresearchExtension({
      on(name, handler) { handlers.set(name, handler); },
      appendEntry() {},
      registerTool(tool) { tools.set(tool.name, tool); },
      registerMessageRenderer() {},
      registerCommand() {},
      registerShortcut() {},
      getActiveTools() { return activeTools; },
      setActiveTools(next) { activeTools = [...next]; },
      sendUserMessage() {},
      sendMessage() {},
      async exec(cmd, args) {
        if (cmd === "bash" && args[0]?.endsWith("checks.sh")) {
          return { code: 1, stdout: "", stderr: "lint failed", killed: false };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    });

    const ctx = {
      cwd,
      mode: "tui",
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort() {},
      sessionManager: {
        getSessionId: () => `live:${cwd}`,
        getBranch: () => [],
      },
      ui: {
        setWidget() {},
        notify() {},
      },
    };

    await handlers.get("session_start")({}, ctx);
    await tools.get("init_experiment").execute("init", {
      name: "Live config test",
      metric_name: "latency_ms",
      metric_unit: "ms",
      direction: "lower",
    }, undefined, undefined, ctx);

    const runRes = await tools.get("run_experiment").execute("run1", {
      command: "./.auto/measure.sh",
    }, undefined, undefined, ctx);
    assert.equal(runRes.details.parsedPrimary, 42);
    assert.equal(runRes.details.checksPass, false);

    // Attempting to keep when checks failed must be rejected.
    const blockedKeep = await tools.get("log_experiment").execute("log1", {
      commit: "1111111",
      metric: 42,
      status: "keep",
      description: "should fail gate",
      metrics: {},
      asi: { hypothesis: "h1" },
    }, undefined, undefined, ctx);
    assert.match(blockedKeep.content[0].text, /Cannot keep — \.auto\/checks\.sh failed/);

    // Now log as checks_failed, then hot-enable compactEvery=1 via .auto/config.json.
    await tools.get("log_experiment").execute("log2", {
      commit: "1111111",
      metric: 42,
      status: "checks_failed",
      description: "checks failed",
      metrics: {},
      asi: { hypothesis: "h1", rollback_reason: "lint failed" },
    }, undefined, undefined, ctx);

    await writeFile(join(cwd, ".auto", "config.json"), JSON.stringify({ compactEvery: 1 }) + "\n");

    const turnEnd = await handlers.get("turn_end")(
      { outcome: "completed", entries: [], continue: false, toolResults: [] },
      ctx,
    );
    assert.equal(turnEnd?.continue, true);
    assert.equal(turnEnd?.entries[0]?.type, "compaction");
    assert.equal(turnEnd?.entries[0]?.firstKeptEntryId, null);

    // Clean shutdown leaves no lingering state.
    await handlers.get("session_shutdown")({}, ctx);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
