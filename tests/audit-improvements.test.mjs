import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import autoresearchExtension, {
  computeConfidence,
  DEFAULT_COMPACT_AT_PERCENT,
} from "../extensions/pi-autoresearch/index.ts";
import {
  autoresearchSummaryPathsFor,
  buildAutoresearchCompactionSummary,
} from "../extensions/pi-autoresearch/compaction.ts";

function makeHarness({ cwd, contextTokens = 10_000, contextWindow = 1_000_000, onExec }) {
  const handlers = new Map();
  const tools = new Map();
  const execCalls = [];
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
    async exec(cmd, args, opts) {
      execCalls.push({ cmd, args, opts });
      if (onExec) return onExec(cmd, args, opts);
      if (cmd === "git" && args[0] === "rev-parse") return { code: 0, stdout: "deadbee\n", stderr: "" };
      if (cmd === "git" && args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "[branch abc1234] commit\n", stderr: "" };
    },
  });

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    getContextUsage: () => ({ tokens: contextTokens, contextWindow, percent: (contextTokens / contextWindow) * 100 }),
    sessionManager: {
      getSessionId: () => `optb:${cwd}`,
      getBranch: () => [],
    },
    ui: {
      setWidget() {},
      setStatus() {},
      notify() {},
    },
  };

  return { handlers, tools, ctx, execCalls };
}

test("log_experiment auto-fills metric, secondary metrics, and HEAD commit from last run_experiment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-autofill-"));
  try {
    const h = makeHarness({ cwd });
    await h.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", metric_unit: "tok/s", direction: "higher" }, undefined, undefined, h.ctx);
    await writeFile(join(cwd, ".auto/measure.sh"), "printf 'METRIC tps=200\\nMETRIC p99_ms=12.5\\nMETRIC mem_mb=512\\n'\n");
    await h.tools.get("run_experiment").execute("r1", { command: "bash .auto/measure.sh" }, undefined, undefined, h.ctx);

    // Omit commit, metric, and metrics — all should auto-fill.
    const logged = await h.tools.get("log_experiment").execute("l1", {
      status: "keep",
      description: "baseline with auto-filled metrics",
      asi: { hypothesis: "baseline" },
    }, undefined, undefined, h.ctx);

    assert.equal(logged.details.experiment.metric, 200);
    assert.deepEqual(logged.details.experiment.metrics, { p99_ms: 12.5, mem_mb: 512 });
    assert.equal(logged.details.experiment.commit, "deadbee");

    // Verify keep commit excludes .auto/ and legacy autoresearch.* files.
    const gitAdd = h.execCalls.find((c) => c.cmd === "git" && c.args[0] === "add");
    assert.ok(gitAdd);
    assert.ok(gitAdd.args.some((a) => a.includes(".auto")));

    // Crash log should not be rejected for missing secondary metrics.
    await h.tools.get("run_experiment").execute("r2", { command: "exit 1" }, undefined, undefined, h.ctx);
    const crashed = await h.tools.get("log_experiment").execute("l2", {
      status: "crash",
      description: "compile error",
      asi: { hypothesis: "bad change", rollback_reason: "exit 1" },
    }, undefined, undefined, h.ctx);
    assert.equal(crashed.details.experiment.status, "crash");
    assert.equal(crashed.details.experiment.metric, 0);
    // Discard/crash revert must unstage before checkout.
    const revertCall = h.execCalls.find((c) => c.cmd === "bash" && c.args[1]?.includes("git checkout"));
    assert.ok(revertCall);
    assert.match(revertCall.args[1], /git reset -q HEAD/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("computeConfidence measures marginal gain vs previous best, flagging tiny blips after big progress", () => {
  const mk = (metric, status = "keep") => ({
    commit: "a", metric, metrics: {}, status, description: "", timestamp: 0, segment: 0, confidence: null,
  });
  // Simulates live DeepSeek progression ending in a tiny +0.34 (+0.13%) blip.
  const runs = [
    mk(179.55), mk(200.56), mk(225.71), mk(171.88, "discard"), mk(233.91),
    mk(252.85), mk(253.35), mk(256.55), mk(261.59), mk(262.04), mk(264.62), mk(264.96),
  ];
  const conf = computeConfidence(runs, 0, "higher");
  assert.ok(conf !== null && conf < 1.0, `expected tiny +0.13% blip to be <1.0x noise, got ${conf}`);

  // Clean huge jump over small noise stays high confidence.
  const clean = [mk(100), mk(100.1), mk(110)];
  const cleanConf = computeConfidence(clean, 0, "higher");
  assert.ok(cleanConf !== null && cleanConf >= 2.0, `expected big jump to be >=2.0x, got ${cleanConf}`);
});

test("log_experiment shows vs-best delta and omits 'likely real' confidence verdict on discards", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-vsbest-"));
  try {
    const h = makeHarness({ cwd });
    await h.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", metric_unit: "tok/s", direction: "higher" }, undefined, undefined, h.ctx);
    await h.tools.get("log_experiment").execute("l1", { status: "keep", metric: 100, description: "base" }, undefined, undefined, h.ctx);
    await h.tools.get("log_experiment").execute("l2", { status: "keep", metric: 200, description: "big win" }, undefined, undefined, h.ctx);
    const keepSmall = await h.tools.get("log_experiment").execute("l3", { status: "keep", metric: 202, description: "tiny bump" }, undefined, undefined, h.ctx);
    assert.match(keepSmall.content[0].text, /\+1\.0% vs best/);
    assert.match(keepSmall.content[0].text, /\+102\.0% vs baseline/);

    const disc = await h.tools.get("log_experiment").execute("l4", { status: "discard", metric: 150, description: "regression" }, undefined, undefined, h.ctx);
    assert.match(disc.content[0].text, /-25\.7% vs best/);
    assert.doesNotMatch(disc.content[0].text, /likely real/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("context-window compaction triggers at default 70% and respects config overrides", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-pctcompact-"));
  try {
    assert.equal(DEFAULT_COMPACT_AT_PERCENT, 70);
    // Below 70% (65% of 200k) -> no compaction.
    const below = makeHarness({ cwd, contextTokens: 130_000, contextWindow: 200_000 });
    await below.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", direction: "higher" }, undefined, undefined, below.ctx);
    await below.handlers.get("agent_start")({}, below.ctx);
    await below.tools.get("log_experiment").execute("l0", { status: "keep", metric: 90, description: "below" }, undefined, undefined, below.ctx);
    assert.equal(await below.handlers.get("turn_end")({ outcome: "completed", entries: [], continue: false, toolResults: [] }, below.ctx), undefined);

    // At 72% of 200k -> triggers deterministic compaction.
    const h = makeHarness({ cwd, contextTokens: 144_000, contextWindow: 200_000 });
    await h.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", direction: "higher" }, undefined, undefined, h.ctx);
    await h.handlers.get("agent_start")({}, h.ctx);
    await h.tools.get("log_experiment").execute("l1", { status: "keep", metric: 100, description: "first" }, undefined, undefined, h.ctx);

    const turnEnd = await h.handlers.get("turn_end")({ outcome: "completed", entries: [], continue: false, toolResults: [] }, h.ctx);
    assert.equal(turnEnd?.continue, true);
    assert.equal(turnEnd?.entries[0]?.type, "compaction");
    assert.equal(turnEnd?.entries[0]?.firstKeptEntryId, null);

    // Disable via compactAtPercent: false.
    await writeFile(join(cwd, ".auto/config.json"), JSON.stringify({ compactAtPercent: false }));
    await h.tools.get("log_experiment").execute("l2", { status: "keep", metric: 110, description: "second" }, undefined, undefined, h.ctx);
    assert.equal(await h.handlers.get("turn_end")({ outcome: "completed", entries: [], continue: false, toolResults: [] }, h.ctx), undefined);

    // Explicit compactAtTokens override still works.
    await writeFile(join(cwd, ".auto/config.json"), JSON.stringify({ compactAtTokens: 100_000 }));
    await h.tools.get("log_experiment").execute("l3", { status: "keep", metric: 120, description: "third" }, undefined, undefined, h.ctx);
    const turnEnd3 = await h.handlers.get("turn_end")({ outcome: "completed", entries: [], continue: false, toolResults: [] }, h.ctx);
    assert.equal(turnEnd3?.entries[0]?.type, "compaction");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("real git repo commits .auto/ learnings on every run (keep and discard) while keeping code commits clean", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-realgit-"));
  const runRealExec = async (cmd, args, opts) => {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, { cwd: opts?.cwd ?? cwd });
      return { code: 0, stdout, stderr };
    } catch (e) {
      return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  };
  try {
    await runRealExec("git", ["init", "-b", "main"], { cwd });
    await runRealExec("git", ["config", "user.email", "test@example.com"], { cwd });
    await runRealExec("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "app.txt"), "v0\n");
    await runRealExec("git", ["add", "-A"], { cwd });
    await runRealExec("git", ["commit", "-m", "initial"], { cwd });

    const h = makeHarness({ cwd, onExec: runRealExec });
    await h.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", direction: "higher" }, undefined, undefined, h.ctx);
    await writeFile(join(cwd, ".auto/prompt.md"), "# Optimize app\n");
    await writeFile(join(cwd, "app.txt"), "v1\n");

    // 1. Keep: code commit has app.txt only; .auto commit checks in .auto/log.jsonl & prompt.md.
    const keepRes = await h.tools.get("log_experiment").execute("k1", {
      status: "keep", metric: 100, description: "v1 improvement", asi: { hypothesis: "fast path" },
    }, undefined, undefined, h.ctx);
    const keepSha = keepRes.details.experiment.commit;
    const keepFiles = (await runRealExec("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", keepSha], { cwd })).stdout.trim().split("\n");
    assert.deepEqual(keepFiles, ["app.txt"]);
    const headMsgAfterKeep = (await runRealExec("git", ["log", "-1", "--format=%s"], { cwd })).stdout.trim();
    assert.match(headMsgAfterKeep, /^chore\(autoresearch\): #1 keep/);
    const statusAfterKeep = (await runRealExec("git", ["status", "--porcelain"], { cwd })).stdout.trim();
    assert.equal(statusAfterKeep, "");

    // 2. Discard: revert code (including staged & untracked code), but commit .auto/ learnings!
    await writeFile(join(cwd, "app.txt"), "bad-code\n");
    await writeFile(join(cwd, "scratch.tmp"), "untracked\n");
    await runRealExec("git", ["add", "app.txt"], { cwd });
    await writeFile(join(cwd, ".auto/ideas.md"), "- learned why bad-code failed\n");

    await h.tools.get("log_experiment").execute("d1", {
      status: "discard", metric: 50, description: "regressed", asi: { hypothesis: "bad idea", rollback_reason: "2x slower" },
    }, undefined, undefined, h.ctx);

    assert.equal(await readFile(join(cwd, "app.txt"), "utf8"), "v1\n");
    const headMsgAfterDiscard = (await runRealExec("git", ["log", "-1", "--format=%s"], { cwd })).stdout.trim();
    assert.match(headMsgAfterDiscard, /^chore\(autoresearch\): #2 discard/);
    const discardFiles = (await runRealExec("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], { cwd })).stdout.trim().split("\n").sort();
    assert.deepEqual(discardFiles, [".auto/ideas.md", ".auto/log.jsonl"]);
    const statusAfterDiscard = (await runRealExec("git", ["status", "--porcelain"], { cwd })).stdout.trim();
    assert.equal(statusAfterDiscard, "");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("compaction summary synthesizes kept milestones and first-baseline lifetime delta", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-milestones-"));
  try {
    await mkdir(join(cwd, ".auto"), { recursive: true });
    const cfg = { type: "config", name: "TPS", metricName: "tps", metricUnit: "tok/s", bestDirection: "higher" };
    await writeFile(join(cwd, ".auto/log.jsonl"), [
      cfg,
      { run: 1, metric: 20, status: "keep", description: "orig base" },
      { ...cfg, name: "TPS v2" },
      { run: 2, metric: 100, status: "keep", description: "new base" },
      { run: 3, metric: 150, status: "keep", description: "fused kernel", asi: { finding: "saved 30us per layer" } },
    ].map(JSON.stringify).join("\n") + "\n");

    const summary = buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(cwd));
    assert.match(summary, /\(\+650\.0% from first baseline\)/);
    assert.match(summary, /## Kept Milestones \(current segment\)/);
    assert.match(summary, /#3 150tok\/s \(\+50\.0%\): fused kernel — saved 30us per layer/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
