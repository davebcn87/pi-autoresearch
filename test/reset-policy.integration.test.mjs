import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_INTEGRATION = process.env.PI_AUTORESEARCH_RUN_INTEGRATION === "1";
const QWEN_MODEL_ID = "qwen3.5-9b-local";
const TEST_CONTEXT_WINDOW = 1200;

test("on_exhaustion starts a fresh session after a qwen overflow", { timeout: 180_000 }, async (t) => {
  if (!RUN_INTEGRATION) {
    t.skip("Set PI_AUTORESEARCH_RUN_INTEGRATION=1 to run the local Pi/Qwen integration test.");
    return;
  }

  const qwenConfig = await loadQwenModelConfig();
  if (!qwenConfig) {
    t.skip(`Could not find ${QWEN_MODEL_ID} in ~/.pi/agent/models.json.`);
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-autoresearch-test-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  await writeFile(
    path.join(projectDir, "autoresearch.md"),
    "# Autoresearch smoke test\n\nResume from this file after a reset.\n",
    "utf8"
  );

  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify(
      {
        defaultProvider: qwenConfig.providerName,
        defaultModel: qwenConfig.modelId,
        compaction: { enabled: false },
        packages: [repoRoot],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify(
      {
        mode: "merge",
        providers: {
          [qwenConfig.providerName]: qwenConfig.providerConfig,
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const rpc = await RpcSession.start({
    cwd: projectDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    },
    provider: qwenConfig.providerName,
    modelId: qwenConfig.modelId,
  });

  t.after(async () => {
    await rpc.stop();
  });

  const initialState = (await rpc.command({ type: "get_state" })).data;
  assert.ok(initialState.sessionFile, "expected an initial session file");
  const initialSessionFile = initialState.sessionFile;

  const fromEventIndex = rpc.events.length;
  await rpc.command({
    type: "prompt",
    message: buildOverflowPrompt(),
  });

  await rpc.waitForEvent((event) => event.type === "agent_end", 120_000, fromEventIndex);

  const switchedState = await rpc.waitForState(
    (state) => typeof state.sessionFile === "string" && state.sessionFile !== initialSessionFile,
    120_000
  );

  assert.notEqual(
    switchedState.sessionFile,
    initialSessionFile,
    "expected a fresh session after the overflow"
  );

  try {
    await rpc.command({ type: "abort" });
  } catch {
    // The fresh session may already be idle.
  }

  await rpc.waitForState((state) => state.isStreaming === false, 30_000);

  const messageResponse = await rpc.command({ type: "get_messages" });
  const userTexts = (messageResponse.data.messages ?? [])
    .filter((message) => message.role === "user")
    .map(messageToText)
    .filter(Boolean);

  assert.ok(
    userTexts.some((text) => text.includes("Continue the autoresearch loop from here.")),
    `expected the fresh session to contain the autoresearch resume prompt, got:\n${userTexts.join("\n---\n")}`
  );

  const sessionFiles = await collectSessionFiles(path.join(agentDir, "sessions"));
  assert.ok(
    sessionFiles.length >= 2,
    `expected at least two session files after reset, found ${sessionFiles.length}`
  );
});

function buildOverflowPrompt() {
  const overflowCommand = `node -e "console.log('x'.repeat(200000))"`;

  return [
    "This is an integration smoke test. Follow these steps exactly and do not ask questions.",
    '1. Call init_experiment with name "overflow reset smoke", metric_name "score", direction "lower", and reset_policy "on_exhaustion".',
    `2. Call run_experiment with command ${JSON.stringify("printf 'baseline\\n'")}.`,
    '3. Call log_experiment with commit "deadbee", metric 1, status "discard", description "baseline smoke".',
    `4. Call run_experiment with command ${JSON.stringify(overflowCommand)}.`,
    "5. Do not call log_experiment after step 4.",
    "After step 4, continue the loop normally.",
  ].join("\n");
}

async function loadQwenModelConfig() {
  let parsed;
  try {
    const modelsPath = path.join(os.homedir(), ".pi/agent/models.json");
    const raw = await readFile(modelsPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const providers = parsed.providers ?? {};

  for (const [providerName, providerConfig] of Object.entries(providers)) {
    const model = (providerConfig.models ?? []).find((entry) => entry.id === QWEN_MODEL_ID);
    if (!model) continue;

    const clonedProvider = structuredClone(providerConfig);
    clonedProvider.models = [{ ...model, contextWindow: TEST_CONTEXT_WINDOW }];

    return {
      providerName,
      modelId: model.id,
      providerConfig: clonedProvider,
    };
  }

  return null;
}

function messageToText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function collectSessionFiles(rootDir) {
  const results = [];

  async function walk(currentDir) {
    let entries = [];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && fullPath.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return results;
}

class RpcSession {
  static async start({ cwd, env, provider, modelId }) {
    const proc = spawn("pi", ["--mode", "rpc", "--provider", provider, "--model", modelId], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session = new RpcSession(proc);
    await session.waitForReady();
    return session;
  }

  constructor(proc) {
    this.proc = proc;
    this.events = [];
    this.nextId = 1;
    this.stdoutBuffer = "";
    this.stderr = "";
    this.pendingResponses = new Map();
    this.eventWaiters = [];

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this.handleStdout(chunk));

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    proc.on("exit", (code, signal) => {
      const error = new Error(
        `pi RPC exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})\n${this.stderr}`
      );
      for (const pending of this.pendingResponses.values()) pending.reject(error);
      this.pendingResponses.clear();
      for (const waiter of this.eventWaiters) waiter.reject(error);
      this.eventWaiters = [];
    });
  }

  async waitForReady() {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await this.command({ type: "get_state" });
        return;
      } catch {
        await delay(250);
      }
    }

    throw new Error(`Timed out waiting for pi RPC startup.\n${this.stderr}`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;

      const parsed = JSON.parse(line);
      if (parsed.type === "response" && parsed.id && this.pendingResponses.has(parsed.id)) {
        const pending = this.pendingResponses.get(parsed.id);
        this.pendingResponses.delete(parsed.id);
        if (parsed.success === false) {
          pending.reject(new Error(parsed.error ?? parsed.message ?? JSON.stringify(parsed)));
        } else {
          pending.resolve(parsed);
        }
        continue;
      }

      this.events.push(parsed);
      this.resolveEventWaiters();
    }
  }

  resolveEventWaiters() {
    const remaining = [];
    for (const waiter of this.eventWaiters) {
      const match = this.findEvent(waiter.predicate, waiter.fromIndex);
      if (match) {
        waiter.resolve(match);
      } else {
        remaining.push(waiter);
      }
    }
    this.eventWaiters = remaining;
  }

  findEvent(predicate, fromIndex = 0) {
    for (let index = fromIndex; index < this.events.length; index++) {
      const event = this.events[index];
      if (predicate(event)) return event;
    }
    return null;
  }

  command(command) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pendingResponses.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }

  waitForEvent(predicate, timeoutMs, fromIndex = 0) {
    const existing = this.findEvent(predicate, fromIndex);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((waiter) => waiter !== record);
        reject(new Error(`Timed out waiting for RPC event after ${timeoutMs}ms.\n${this.stderr}`));
      }, timeoutMs);

      const record = {
        predicate,
        fromIndex,
        resolve: (event) => {
          clearTimeout(timeout);
          resolve(event);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };

      this.eventWaiters.push(record);
    });
  }

  async waitForState(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const response = await this.command({ type: "get_state" });
      if (predicate(response.data)) return response.data;
      await delay(500);
    }

    throw new Error(`Timed out waiting for state after ${timeoutMs}ms.\n${this.stderr}`);
  }

  async stop() {
    if (this.proc.killed) return;

    this.proc.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => this.proc.once("exit", resolve)),
      delay(5_000).then(() => {
        this.proc.kill("SIGKILL");
      }),
    ]);
  }
}
