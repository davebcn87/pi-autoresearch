import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import autoresearch from "../extensions/pi-autoresearch/index.ts";

function exec(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ code: error?.code ?? 0, stdout, stderr, killed: error?.killed ?? false });
    });
  });
}

async function harness(t, maxIterations = 10) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-integration-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".auto"));
  const write = (name, value) => fs.writeFileSync(path.join(cwd, name), value);
  write(".gitignore", ".auto/\n");
  write("source.sh", "PRIMARY=100\nHOLDOUT=100\n");
  write(".auto/measure.sh", '. ./source.sh\nif test "${RECOGNITION:-pass}" = fail; then printf "VALIDATION_FAILED baseline code lost\\n"; exit 1; fi\nprintf "METRIC time=%s\\n" "$PRIMARY"\n');
  write(".auto/checks.sh", '. ./source.sh\ntest "$HOLDOUT" -le 100\n');
  write(".auto/config.json", JSON.stringify({ maxIterations }));
  write(".auto/research.json", JSON.stringify({ objective: "Improve generic execution time.", sourceFiles: ["source.sh"], failureInterval: 2 }));
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Research Test"], ["add", "."], ["commit", "-qm", "Baseline"]]) {
    assert.equal((await exec("git", args, { cwd })).code, 0);
  }
  const tools = new Map();
  const commands = new Map();
  const calls = [];
  let active = [];
  let decision = true;
  let abortCount = 0;
  const ctx = {
    cwd, hasUI: false, mode: "rpc", isIdle: () => true, hasPendingMessages: () => false,
    model: { provider: "fake", id: "experimenter" },
    modelRegistry: {
      find: (provider, id) => ({ provider, id, reasoning: true }),
      async complete(model, context) {
        calls.push({ model: `${model.provider}/${model.id}`, context });
        const response = !decision
          ? { verdict: "stop", reason: "No useful direction remains.", ideas: [] }
          : { verdict: "continue", reason: "Untried directions remain.", ideas: [{ approach: "stable-value-cache", hypothesis: "Remove work", change: "Cache stable values", mechanism: "Avoid repeated reads", validation: "Compare varied inputs" }] };
        return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(response) }] };
      },
    },
    abort() { abortCount++; }, sessionManager: { getSessionId: () => cwd, getBranch: () => [] },
    ui: { setWidget() {}, notify() {} },
  };
  autoresearch({
    on() {}, appendEntry() {}, registerShortcut() {},
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    getActiveTools: () => active, setActiveTools: (next) => { active = next; }, sendUserMessage() {},
    exec,
  });
  const run = (approach = "baseline") => tools.get("run_experiment").execute("run", { command: "bash .auto/measure.sh", approach }, undefined, undefined, ctx);
  const log = (metric, status = "keep", extra = {}) => tools.get("log_experiment").execute("log", { commit: "abcdef0", metric, status, description: "EXPERIMENTER_CLAIM_DO_NOT_SEND", asi: { hypothesis: "HISTORY_DO_NOT_SEND" }, ...extra }, undefined, undefined, ctx);
  await tools.get("init_experiment").execute("init", { name: "Optimize time", metric_name: "time", direction: "lower" }, undefined, undefined, ctx);
  return { cwd, ctx, calls, write, run, log, commands, tools, abortCount: () => abortCount, activeTools: () => active, reject: () => { decision = false; } };
}

test("existing keep behavior commits code and the manual advisor can stop the loop", async (t) => {
  const f = await harness(t);
  await f.run();
  const baseline = await f.log(100);
  assert.equal(baseline.details.experiment.status, "keep");
  assert.ok(f.calls.some((c) => c.context.systemPrompt.includes("research advisor")));
  assert.equal(f.calls.some((c) => c.context.systemPrompt.includes("evaluator")), false, "Acceptance needs no reviewer.");
  assert.ok(f.calls.every((c) => c.model === "openai-codex/gpt-6-astra"));
  f.write("source.sh", "PRIMARY=50\nHOLDOUT=50\n");
  await f.run();
  const result = await f.log(50);
  assert.equal(result.details.experiment.status, "keep");
  assert.equal((await exec("git", ["show", "HEAD:source.sh"], { cwd: f.cwd })).stdout, "PRIMARY=50\nHOLDOUT=50\n");
  for (const c of f.calls) {
    assert.equal(JSON.stringify(c.context).includes("EXPERIMENTER_CLAIM_DO_NOT_SEND"), false);
    assert.equal(JSON.stringify(c.context).includes("HISTORY_DO_NOT_SEND"), false);
    assert.equal(c.context.messages.length, 1);
  }
  assert.equal(f.calls.length, 1);
  f.reject();
  await f.commands.get("autoresearch").handler("ideas", f.ctx);
  assert.equal(f.activeTools().includes("run_experiment"), false);
  assert.equal(f.abortCount(), 0);
  assert.equal((await f.log(50)).isError, true);
});
