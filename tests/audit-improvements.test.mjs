import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import autoresearchExtension, {
  computeConfidence,
  DEFAULT_COMPACT_AT_PERCENT,
} from "../extensions/pi-autoresearch/index.ts";
import {
  autoresearchSummaryPathsFor,
  buildAutoresearchCompactionSummary,
} from "../extensions/pi-autoresearch/compaction.ts";

const execFileAsync = promisify(execFile);

function makeHarness({ cwd, contextTokens = 10_000, contextWindow = 1_000_000, onExec } = {}) {
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

test("run_experiment is the single experiment tool (no log_experiment) and defaults command to .auto/measure.sh", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-unified-"));
  try {
    const h = makeHarness({ cwd });
    assert.equal(h.tools.has("log_experiment"), false);
    await h.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", metric_unit: "tok/s", direction: "higher" }, undefined, undefined, h.ctx);
    const measurePath = join(cwd, ".auto/measure.sh");
    await writeFile(measurePath, "#!/usr/bin/env bash\nprintf 'METRIC tps=200\\nMETRIC p99_ms=12.5\\nMETRIC mem_mb=512\\n'\n");
    await chmod(measurePath, 0o755);

    // Omit command & optional learning fields -> defaults to ./.auto/measure.sh, logs baseline keep, and emits optional-feature hint.
    const r1 = await h.tools.get("run_experiment").execute("r1", {
      description: "baseline",
    }, undefined, undefined, h.ctx);
    assert.equal(r1.details.logged, true);
    assert.equal(r1.details.experiment.status, "keep");
    assert.equal(r1.details.experiment.metric, 200);
    assert.deepEqual(r1.details.experiment.metrics, { p99_ms: 12.5, mem_mb: 512 });
    assert.match(r1.content[0].text, /💡 Tip: optional run_experiment params hypothesis/);

    // Tie without keep_on_tie -> discard; providing hypothesis + prev_learning suppresses hint and updates run #1's ASI.
    const r2 = await h.tools.get("run_experiment").execute("r2", {
      description: "tie without flag",
      hypothesis: "same perf",
      prev_learning: "baseline established at 200 tok/s",
    }, undefined, undefined, h.ctx);
    assert.equal(r2.details.experiment.status, "discard");
    assert.doesNotMatch(r2.content[0].text, /💡 Tip:/);
    const logLines = (await readFile(join(cwd, ".auto/log.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(logLines.find((e) => e.run === 1).asi.learning, "baseline established at 200 tok/s");

    // Tie WITH keep_on_tie -> keep.
    const r3 = await h.tools.get("run_experiment").execute("r3", {
      description: "simpler code same perf",
      hypothesis: "remove dead branch",
      prev_learning: "tie was discarded as expected",
      keep_on_tie: true,
    }, undefined, undefined, h.ctx);
    assert.equal(r3.details.experiment.status, "keep");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("incompatible output on passing benchmark reports error without logging or modifying git, while crashes DO log", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-incompat-"));
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
    await writeFile(join(cwd, "app.txt"), "edited-unlogged\n");

    // Passing command with wrong METRIC key -> NOT logged, code NOT committed or reverted.
    const bad = await h.tools.get("run_experiment").execute("bad1", {
      command: "printf 'METRIC wrong_name=123\\n'",
      description: "wrong metric format",
    }, undefined, undefined, h.ctx);
    assert.equal(bad.details.logged, false);
    assert.equal(bad.details.incompatibleOutput, true);
    assert.match(bad.content[0].text, /Incompatible benchmark output/);
    assert.match(bad.content[0].text, /Found METRIC keys: wrong_name/);
    assert.match(bad.content[0].text, /Not logged yet/);
    assert.equal(await readFile(join(cwd, "app.txt"), "utf8"), "edited-unlogged\n");
    const logAfterBad = (await readFile(join(cwd, ".auto/log.jsonl"), "utf8")).trim().split("\n");
    assert.equal(logAfterBad.length, 1, "only config header should exist in log.jsonl");

    // Crash (exit 1) -> DOES log as crash, reverts app.txt, and commits .auto/.
    const crash = await h.tools.get("run_experiment").execute("crash1", {
      command: "exit 1",
      description: "compile failure",
      hypothesis: "try new kernel",
    }, undefined, undefined, h.ctx);
    assert.equal(crash.details.logged, true);
    assert.equal(crash.details.experiment.status, "crash");
    assert.equal(crash.details.experiment.metric, 0);
    assert.equal(await readFile(join(cwd, "app.txt"), "utf8"), "v0\n");
    assert.equal((await runRealExec("git", ["status", "--porcelain"], { cwd })).stdout.trim(), "");
    const logAfterCrash = (await readFile(join(cwd, ".auto/log.jsonl"), "utf8")).trim().split("\n");
    assert.equal(logAfterCrash.length, 2, "config + crash entry should be logged");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("computeConfidence measures marginal gain vs previous best, flagging tiny blips after big progress", () => {
  const mk = (metric, status = "keep") => ({
    commit: "a", metric, metrics: {}, status, description: "", timestamp: 0, segment: 0, confidence: null,
  });
  const runs = [
    mk(179.55), mk(200.56), mk(225.71), mk(171.88, "discard"), mk(233.91),
    mk(252.85), mk(253.35), mk(256.55), mk(261.59), mk(262.04), mk(264.62), mk(264.96),
  ];
  const conf = computeConfidence(runs, 0, "higher");
  assert.ok(conf !== null && conf < 1.0, `expected tiny +0.13% blip to be <1.0x noise, got ${conf}`);

  const clean = [mk(100), mk(100.1), mk(110)];
  const cleanConf = computeConfidence(clean, 0, "higher");
  assert.ok(cleanConf !== null && cleanConf >= 2.0, `expected big jump to be >=2.0x, got ${cleanConf}`);
});

test("run_experiment shows vs-best delta and omits 'likely real' confidence verdict on discards", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-vsbest-"));
  try {
    const h = makeHarness({ cwd });
    await h.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", metric_unit: "tok/s", direction: "higher" }, undefined, undefined, h.ctx);
    await h.tools.get("run_experiment").execute("r1", { command: "printf 'METRIC tps=100\\n'", description: "base" }, undefined, undefined, h.ctx);
    await h.tools.get("run_experiment").execute("r2", { command: "printf 'METRIC tps=200\\n'", description: "big win" }, undefined, undefined, h.ctx);
    const keepSmall = await h.tools.get("run_experiment").execute("r3", { command: "printf 'METRIC tps=202\\n'", description: "tiny bump" }, undefined, undefined, h.ctx);
    assert.match(keepSmall.content[0].text, /\+1\.0% vs best/);
    assert.match(keepSmall.content[0].text, /\+102\.0% vs baseline/);

    const disc = await h.tools.get("run_experiment").execute("r4", { command: "printf 'METRIC tps=150\\n'", description: "regression" }, undefined, undefined, h.ctx);
    assert.equal(disc.details.experiment.status, "discard");
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
    const below = makeHarness({ cwd, contextTokens: 130_000, contextWindow: 200_000 });
    await below.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", direction: "higher" }, undefined, undefined, below.ctx);
    await below.handlers.get("agent_start")({}, below.ctx);
    await below.tools.get("run_experiment").execute("r0", { command: "printf 'METRIC tps=90\\n'", description: "below" }, undefined, undefined, below.ctx);
    assert.equal(await below.handlers.get("turn_end")({ outcome: "completed", entries: [], continue: false, toolResults: [] }, below.ctx), undefined);

    const h = makeHarness({ cwd, contextTokens: 144_000, contextWindow: 200_000 });
    await h.tools.get("init_experiment").execute("init", { name: "TPS", metric_name: "tps", direction: "higher" }, undefined, undefined, h.ctx);
    await h.handlers.get("agent_start")({}, h.ctx);
    await h.tools.get("run_experiment").execute("r1", { command: "printf 'METRIC tps=100\\n'", description: "first" }, undefined, undefined, h.ctx);

    const turnEnd = await h.handlers.get("turn_end")({ outcome: "completed", entries: [], continue: false, toolResults: [] }, h.ctx);
    assert.equal(turnEnd?.continue, true);
    assert.equal(turnEnd?.entries[0]?.type, "compaction");
    assert.equal(turnEnd?.entries[0]?.firstKeptEntryId, null);

    await writeFile(join(cwd, ".auto/config.json"), JSON.stringify({ compactAtPercent: false }));
    await h.tools.get("run_experiment").execute("r2", { command: "printf 'METRIC tps=110\\n'", description: "second" }, undefined, undefined, h.ctx);
    assert.equal(await h.handlers.get("turn_end")({ outcome: "completed", entries: [], continue: false, toolResults: [] }, h.ctx), undefined);

    await writeFile(join(cwd, ".auto/config.json"), JSON.stringify({ compactAtTokens: 100_000 }));
    await h.tools.get("run_experiment").execute("r3", { command: "printf 'METRIC tps=120\\n'", description: "third" }, undefined, undefined, h.ctx);
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
    const keepRes = await h.tools.get("run_experiment").execute("k1", {
      command: "printf 'METRIC tps=100\\n'",
      description: "v1 improvement",
      hypothesis: "fast path",
    }, undefined, undefined, h.ctx);
    assert.equal(keepRes.details.experiment.status, "keep");
    const keepSha = keepRes.details.experiment.commit;
    const keepFiles = (await runRealExec("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", keepSha], { cwd })).stdout.trim().split("\n");
    assert.deepEqual(keepFiles, ["app.txt"]);
    const headMsgAfterKeep = (await runRealExec("git", ["log", "-1", "--format=%s"], { cwd })).stdout.trim();
    assert.match(headMsgAfterKeep, /^chore\(autoresearch\): #1 keep/);
    assert.equal((await runRealExec("git", ["status", "--porcelain"], { cwd })).stdout.trim(), "");

    // 2. Discard: revert code (including staged & untracked code), commit .auto/ learnings!
    await writeFile(join(cwd, "app.txt"), "bad-code\n");
    await writeFile(join(cwd, "scratch.tmp"), "untracked\n");
    await runRealExec("git", ["add", "app.txt"], { cwd });
    await writeFile(join(cwd, ".auto/ideas.md"), "- learned why bad-code failed\n");

    const discRes = await h.tools.get("run_experiment").execute("d1", {
      command: "printf 'METRIC tps=50\\n'",
      description: "regressed",
      hypothesis: "bad idea",
    }, undefined, undefined, h.ctx);
    assert.equal(discRes.details.experiment.status, "discard");
    assert.equal(await readFile(join(cwd, "app.txt"), "utf8"), "v1\n");
    const headMsgAfterDiscard = (await runRealExec("git", ["log", "-1", "--format=%s"], { cwd })).stdout.trim();
    assert.match(headMsgAfterDiscard, /^chore\(autoresearch\): #2 discard/);
    const discardFiles = (await runRealExec("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], { cwd })).stdout.trim().split("\n").sort();
    assert.deepEqual(discardFiles, [".auto/ideas.md", ".auto/log.jsonl"]);
    assert.equal((await runRealExec("git", ["status", "--porcelain"], { cwd })).stdout.trim(), "");
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

function interruptibleExec(cwd) {
  return async (cmd, args, opts) => {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, { cwd: opts?.cwd ?? cwd, signal: opts?.signal });
      return { code: 0, stdout, stderr, killed: false };
    } catch (e) {
      return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "", killed: e.name === "AbortError" };
    }
  };
}

async function commitRepoWithSlowableChecks(cwd, exec) {
  await exec("git", ["init", "-b", "main"]);
  await exec("git", ["config", "user.email", "test@example.com"]);
  await exec("git", ["config", "user.name", "Test"]);
  await writeFile(join(cwd, "app.txt"), "v0\n");
  await mkdir(join(cwd, ".auto"), { recursive: true });
  await writeFile(join(cwd, ".auto/checks.sh"), "#!/usr/bin/env bash\nif [ -f .auto/slow ]; then sleep 30; fi\n");
  await exec("git", ["add", "-A"]);
  await exec("git", ["commit", "-m", "initial"]);
}

function abortAfter(milliseconds) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), milliseconds);
  return controller.signal;
}

test("interrupting checks leaves the experiment's work and the log untouched", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-autoresearch-abort-checks-"));
  try {
    const exec = interruptibleExec(cwd);
    await commitRepoWithSlowableChecks(cwd, exec);
    const h = makeHarness({ cwd, onExec: exec });
    const run = (description, signal) => h.tools.get("run_experiment")
      .execute(description, { command: "printf 'METRIC ms=100\\n'", description }, signal, undefined, h.ctx);
    await h.tools.get("init_experiment").execute("init", { name: "Abort", metric_name: "ms", direction: "lower" }, undefined, undefined, h.ctx);
    await run("baseline");

    await writeFile(join(cwd, "app.txt"), "uncommitted experiment\n");
    await writeFile(join(cwd, "untracked.txt"), "new file\n");
    await writeFile(join(cwd, ".auto/slow"), "");
    await assert.rejects(run("interrupted", abortAfter(500)), /aborted/);

    assert.equal(await readFile(join(cwd, "app.txt"), "utf8"), "uncommitted experiment\n");
    assert.equal(await readFile(join(cwd, "untracked.txt"), "utf8"), "new file\n");
    const runs = (await readFile(join(cwd, ".auto/log.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter((e) => e.run);
    assert.deepEqual(runs.map((e) => e.status), ["keep"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
