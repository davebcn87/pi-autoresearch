#!/usr/bin/env node
/**
 * autoresearch.mjs — portable runtime for the autoresearch skill.
 *
 * Reimplements the pi extension tools (init_experiment, run_experiment,
 * log_experiment) as plain CLI subcommands so any agent with bash + node + git
 * can run the experiment loop — no pi installation required.
 *
 * Usage:
 *   autoresearch.mjs init --name "<goal>" --metric <name> [--unit <u>] [--direction lower|higher]
 *   autoresearch.mjs run [command] [--timeout <s>] [--checks-timeout <s>]
 *   autoresearch.mjs log --status keep|discard|crash|checks_failed --metric <n>
 *                        --commit <sha> --description "<text>"
 *                        [--metrics '<json>'] [--asi '<json>'] [--force]
 *   autoresearch.mjs status
 *
 * Produces the same .auto/log.jsonl schema as the pi extension, so
 * autoresearch-finalize works identically on both runtimes.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AUTO_DIR = ".auto";
const LOG_NAME = "log.jsonl";
const LEGACY_LOG_NAME = "autoresearch.jsonl";
const MEASURE_NAME = "measure.sh";
const LEGACY_MEASURE_NAME = "autoresearch.sh";
const CHECKS_NAME = "checks.sh";
const CONFIG_NAME = "config.json";
const HOOK_TIMEOUT_MS = 30_000;
const HOOK_STDOUT_MAX = 8 * 1024;
const TAIL_LINES = 10;
const TAIL_BYTES = 4 * 1024;
const CHECKS_TAIL_LINES = 80;
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const fmt = new Intl.NumberFormat("en-US");
const fmt2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const formatNum = (v, unit) =>
  v === null || v === undefined ? "—" : (v === Math.round(v) ? fmt.format(v) : fmt2.format(v)) + (unit || "");

function die(msg) {
  console.error(msg);
  process.exit(1);
}
function out(msg) {
  process.stdout.write(msg + "\n");
}
function truncateTail(text, maxLines, maxBytes) {
  let s = text;
  if (Buffer.byteLength(s, "utf8") > maxBytes) {
    s = Buffer.from(s, "utf8").subarray(Buffer.byteLength(s, "utf8") - maxBytes).toString("utf8");
  }
  const lines = s.split("\n");
  const truncated = lines.length > maxLines;
  return { content: truncated ? lines.slice(-maxLines).join("\n") : s, truncated };
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { args._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Session files / workdir
// ---------------------------------------------------------------------------
function sessionConfigPath(cwd) { return path.join(cwd, AUTO_DIR, CONFIG_NAME); }
function readSessionConfig(cwd) {
  try { return JSON.parse(fs.readFileSync(sessionConfigPath(cwd), "utf8")); }
  catch { return {}; }
}
function resolveWorkDir(cwd) {
  const cfg = readSessionConfig(cwd);
  if (cfg.workingDir) {
    const dir = path.resolve(cwd, cfg.workingDir);
    if (!fs.existsSync(dir)) die(`workingDir "${cfg.workingDir}" (from .auto/config.json) does not exist.`);
    return dir;
  }
  return cwd;
}
function autoPath(workDir, name, legacyName) {
  const cur = path.join(workDir, AUTO_DIR, name);
  const legacy = legacyName ? path.join(workDir, legacyName) : null;
  // If any current-layout artifact exists, stay in current layout.
  if (fs.existsSync(path.join(workDir, AUTO_DIR))) return cur;
  if (legacy && fs.existsSync(legacy)) return legacy;
  return cur;
}
const logPath = (w) => autoPath(w, LOG_NAME, LEGACY_LOG_NAME);
const measurePath = (w) => autoPath(w, MEASURE_NAME, LEGACY_MEASURE_NAME);
const checksPath = (w) => autoPath(w, CHECKS_NAME, "autoresearch.checks.sh");
const hookPath = (w, stage) => autoPath(w, path.join("hooks", `${stage}.sh`), null);

function stateFilePath(workDir) {
  try {
    const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: workDir, encoding: "utf8" })
      .stdout.trim();
    if (gitDir) return path.join(gitDir, "autoresearch-state.json");
  } catch { /* not a git repo */ }
  return path.join(workDir, AUTO_DIR, ".state.json");
}
function readState(workDir) {
  try { return JSON.parse(fs.readFileSync(stateFilePath(workDir), "utf8")); }
  catch { return {}; }
}
function writeState(workDir, patch) {
  const next = { ...readState(workDir), ...patch };
  const p = stateFilePath(workDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next));
}

// ---------------------------------------------------------------------------
// log.jsonl — same reconstruction logic as extensions/pi-autoresearch/jsonl.ts
// ---------------------------------------------------------------------------
function readEntries(workDir) {
  const p = logPath(workDir);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((line) => {
    try { const e = JSON.parse(line); return e && typeof e === "object" && !Array.isArray(e) ? e : null; }
    catch { return null; }
  }).filter(Boolean);
}
function appendEntry(workDir, entry) {
  const p = logPath(workDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + "\n");
}
function reconstruct(entries) {
  const st = { name: null, metricName: "metric", metricUnit: "", bestDirection: "lower", currentSegment: 0, results: [], secondaryMetrics: [] };
  let segment = 0;
  for (const e of entries) {
    if (e.type === "config") {
      if (typeof e.name === "string") st.name = e.name;
      if (typeof e.metricName === "string") st.metricName = e.metricName;
      if (typeof e.metricUnit === "string") st.metricUnit = e.metricUnit;
      st.bestDirection = e.bestDirection === "higher" ? "higher" : "lower";
      if (st.results.length > 0) { st.secondaryMetrics = []; segment++; }
      st.currentSegment = segment;
      continue;
    }
    if (typeof e.run !== "number") continue; // skips hook entries
    const run = {
      run: e.run,
      commit: typeof e.commit === "string" ? e.commit : "",
      metric: typeof e.metric === "number" ? e.metric : 0,
      metrics: e.metrics && typeof e.metrics === "object" ? e.metrics : {},
      status: ["discard", "crash", "checks_failed"].includes(e.status) ? e.status : "keep",
      description: typeof e.description === "string" ? e.description : "",
      segment,
      asi: e.asi && typeof e.asi === "object" ? e.asi : undefined,
      raw: e,
    };
    st.results.push(run);
    for (const n of Object.keys(run.metrics))
      if (!st.secondaryMetrics.includes(n)) st.secondaryMetrics.push(n);
  }
  return st;
}
const segmentResults = (st) => st.results.filter((r) => r.segment === st.currentSegment);
const isBetter = (c, b, dir) => (dir === "lower" ? c < b : c > b);
function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function baselineMetric(st) {
  const cur = segmentResults(st);
  return cur.length ? cur[0].metric : null;
}
function bestMetric(st) {
  const kept = segmentResults(st).filter((r) => r.status === "keep").map((r) => r.metric);
  if (!kept.length) return null;
  return st.bestDirection === "lower" ? Math.min(...kept) : Math.max(...kept);
}
function computeConfidence(st) {
  const cur = segmentResults(st).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;
  const med = median(cur.map((r) => r.metric));
  const mad = median(cur.map((r) => Math.abs(r.metric - med)));
  if (mad === 0) return null;
  const baseline = baselineMetric(st);
  if (baseline === null) return null;
  let best = null;
  for (const r of cur)
    if (r.status === "keep" && (best === null || isBetter(r.metric, best, st.bestDirection))) best = r.metric;
  if (best === null || best === baseline) return null;
  return Math.abs(best - baseline) / mad;
}
function sessionSnapshot(st) {
  return {
    metric_name: st.metricName,
    metric_unit: st.metricUnit,
    direction: st.bestDirection,
    baseline_metric: baselineMetric(st),
    best_metric: bestMetric(st),
    run_count: st.results.length,
    goal: st.name || "autoresearch",
  };
}

// ---------------------------------------------------------------------------
// Hooks — same contract as extensions/pi-autoresearch/hooks.ts
// ---------------------------------------------------------------------------
function fireHook(workDir, stage, payload) {
  const script = hookPath(workDir, stage);
  let executable = false;
  try { fs.accessSync(script, fs.constants.X_OK); executable = fs.statSync(script).isFile(); } catch {}
  if (!executable) return null;

  const t0 = Date.now();
  const res = spawnSync("bash", [script], {
    cwd: workDir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: HOOK_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = res.error && res.error.code === "ETIMEDOUT";
  let stdout = res.stdout || "";
  const stderr = res.stderr || "";
  const exitCode = res.status;
  const stdoutBytes = Buffer.byteLength(stdout, "utf8");
  if (stdoutBytes > HOOK_STDOUT_MAX)
    stdout = Buffer.from(stdout, "utf8").subarray(0, HOOK_STDOUT_MAX).toString("utf8") +
      "\n…[truncated: hook stdout exceeded 8KB]";

  // Observability entry — skipped by run-entry reconstruction (no numeric `run`).
  const p = logPath(workDir);
  if (fs.existsSync(p) && readEntries(workDir).some((e) => e.type === "config")) {
    appendEntry(workDir, {
      type: "hook", stage, exit_code: exitCode,
      duration_ms: Date.now() - t0, stdout_bytes: stdoutBytes, timed_out: !!timedOut,
    });
  }

  if (timedOut) return `[${stage} hook timed out after ${HOOK_TIMEOUT_MS / 1000}s]`;
  if (exitCode !== 0) {
    const parts = [`[${stage} hook exited ${exitCode}]`];
    if (stderr.trim()) parts.push(stderr.trim());
    if (stdout.trim()) parts.push(stdout.trim());
    return parts.join("\n");
  }
  return stdout.trim() || null;
}

// ---------------------------------------------------------------------------
// METRIC line parsing — same regex as the extension
// ---------------------------------------------------------------------------
function parseMetricLines(output) {
  const map = new Map();
  const regex = /^METRIC\s+([\w.µ]+)=(\S+)\s*$/gm;
  let m;
  while ((m = regex.exec(output)) !== null) {
    const [, name, raw] = m;
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number.parseFloat(raw);
    if (!Number.isNaN(value)) map.set(name, value);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------
function git(workDir, argv, timeoutMs = 10_000) {
  const r = spawnSync("git", argv, { cwd: workDir, encoding: "utf8", timeout: timeoutMs });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}
function revertChanges(workDir) {
  // Same pathspec exclusions as the extension: .auto/** and legacy autoresearch.* preserved.
  const script = `
    git checkout -- . ':(exclude,glob)**/${AUTO_DIR}' ':(exclude,glob)**/${AUTO_DIR}/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'
    git clean -fd -e '${AUTO_DIR}' -e '**/${AUTO_DIR}/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' 2>/dev/null
  `;
  spawnSync("bash", ["-c", script], { cwd: workDir, timeout: 10_000 });
}
function isMeasureCommand(command) {
  let cmd = command.trim();
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");
  let prev;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.sh|\.auto\/measure\.sh)(?:\s|$)/.test(cmd);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function cmdInit(args) {
  const name = args.name;
  const metric = args.metric;
  if (!name || !metric) die("Usage: autoresearch.mjs init --name \"<goal>\" --metric <name> [--unit <u>] [--direction lower|higher]");
  const unit = typeof args.unit === "string" ? args.unit : "";
  const direction = args.direction === "higher" ? "higher" : "lower";
  const cwd = process.cwd();
  const workDir = resolveWorkDir(cwd);
  const cfg = readSessionConfig(cwd);
  const maxIter = typeof cfg.maxIterations === "number" ? cfg.maxIterations : null;

  const hadConfig = readEntries(workDir).some((e) => e.type === "config");
  appendEntry(workDir, { type: "config", name, metricName: metric, metricUnit: unit, bestDirection: direction });

  if (!hadConfig) {
    const st = reconstruct(readEntries(workDir));
    const steer = fireHook(workDir, "before", {
      event: "before", cwd: workDir, next_run: 1, last_run: null, session: sessionSnapshot(st),
    });
    if (steer) out(`\n${steer}\n`);
  }

  const reinit = hadConfig ? " (re-initialized — previous results archived, new baseline needed)" : "";
  const limitNote = maxIter !== null ? `\nMax iterations: ${maxIter} (from .auto/config.json)` : "";
  const workDirNote = workDir !== cwd ? `\nWorking directory: ${workDir}` : "";
  out(`✅ Experiment initialized: "${name}"${reinit}\nMetric: ${metric} (${unit || "unitless"}, ${direction} is better)${limitNote}${workDirNote}\nConfig written to .auto/log.jsonl. Now run the baseline with: autoresearch.mjs run`);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
function cmdRun(args) {
  const cwd = process.cwd();
  const workDir = resolveWorkDir(cwd);
  const st = reconstruct(readEntries(workDir));
  const cfg = readSessionConfig(cwd);
  const maxIter = typeof cfg.maxIterations === "number" ? cfg.maxIterations : null;
  if (maxIter !== null && segmentResults(st).length >= maxIter) {
    out(`🛑 Maximum experiments reached (${maxIter}). The experiment loop is done. To continue, run init again to start a new segment.`);
    return;
  }

  const measure = measurePath(workDir);
  let command = args._.join(" ").trim();
  if (!command) command = `bash ${path.relative(workDir, measure) || measure}`;
  if (fs.existsSync(measure) && !isMeasureCommand(command)) {
    const rel = path.relative(workDir, measure) || path.basename(measure);
    die(`❌ ${rel} exists — you must run it instead of a custom command.\n\nFound: ${measure}\nYour command: ${command}\n\nUse: autoresearch.mjs run "bash ${rel}" or autoresearch.mjs run "./${rel}"`);
  }

  const timeoutS = Number.parseFloat(args.timeout ?? "600");
  const t0 = Date.now();
  const res = spawnSync("bash", ["-c", command], {
    cwd: workDir,
    encoding: "utf8",
    timeout: timeoutS * 1000,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  const timedOut = !!(res.error && res.error.code === "ETIMEDOUT");
  const exitCode = res.status;
  const output = (res.stdout || "") + (res.stderr || "");
  const duration = (Date.now() - t0) / 1000;
  const benchmarkPassed = exitCode === 0 && !timedOut;

  let checksPass = null;
  let checksTimedOut = false;
  let checksOutput = "";
  let checksDuration = 0;
  const checks = checksPath(workDir);
  if (benchmarkPassed && fs.existsSync(checks)) {
    const checksTimeoutS = Number.parseFloat(args["checks-timeout"] ?? "300");
    const ct0 = Date.now();
    const cr = spawnSync("bash", [checks], {
      cwd: workDir, encoding: "utf8",
      timeout: checksTimeoutS * 1000, maxBuffer: 16 * 1024 * 1024,
    });
    checksDuration = (Date.now() - ct0) / 1000;
    checksTimedOut = !!(cr.error && cr.error.code === "ETIMEDOUT");
    checksPass = cr.status === 0 && !checksTimedOut;
    checksOutput = ((cr.stdout || "") + "\n" + (cr.stderr || "")).trim();
  }
  writeState(workDir, {
    checksPass,
    checksOutput: checksOutput.slice(-2000),
    checksDuration,
    lastDuration: duration,
  });

  const parsed = parseMetricLines(output);
  const parsedObj = parsed.size ? Object.fromEntries(parsed) : null;
  const parsedPrimary = parsed.get(st.metricName) ?? null;

  let text = "";
  if (timedOut) text += `⏰ TIMEOUT after ${duration.toFixed(1)}s\n`;
  else if (!benchmarkPassed) text += `💥 FAILED (exit code ${exitCode}) in ${duration.toFixed(1)}s\n`;
  else {
    text += `✅ Benchmark PASSED in ${duration.toFixed(1)}s\n`;
    if (checksTimedOut) text += `⏰ Checks TIMED OUT after ${checksDuration.toFixed(1)}s — log as 'checks_failed'.\n`;
    else if (checksPass === false) text += `💥 Checks FAILED in ${checksDuration.toFixed(1)}s — log as 'checks_failed' (keep is blocked).\n`;
    else if (checksPass === true) text += `✓ Checks passed (${checksDuration.toFixed(1)}s)\n`;
  }
  if (parsedObj) {
    text += `📈 Parsed metrics: ${JSON.stringify(parsedObj)}\n`;
    if (parsedPrimary !== null) text += `→ primary ${st.metricName}: ${formatNum(parsedPrimary, st.metricUnit)}\n`;
  }
  if (checksPass === false || checksTimedOut) {
    const tail = truncateTail(checksOutput, CHECKS_TAIL_LINES, 16 * 1024);
    text += `--- checks output ---\n${tail.content}\n`;
  }
  const tail = truncateTail(output, TAIL_LINES, TAIL_BYTES);
  if (tail.content.trim()) {
    text += `--- output tail ---\n${tail.content}\n`;
  }
  if (tail.truncated) {
    const tmp = path.join(os.tmpdir(), `autoresearch-run-${Date.now()}.log`);
    fs.writeFileSync(tmp, output);
    text += `[truncated — full output: ${tmp}]\n`;
  }
  out(text.replace(/\n$/, ""));
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------
function cmdLog(args) {
  const status = args.status;
  if (!["keep", "discard", "crash", "checks_failed"].includes(status))
    die("Usage: autoresearch.mjs log --status keep|discard|crash|checks_failed --metric <n> --commit <sha> --description \"<text>\" [--metrics '<json>'] [--asi '<json>'] [--force]");
  const metric = Number.parseFloat(args.metric);
  if (Number.isNaN(metric)) die("❌ --metric must be a number");
  const commit = typeof args.commit === "string" ? args.commit : "";
  const description = typeof args.description === "string" ? args.description : "";
  if (!description) die("❌ --description is required");

  let metrics = {};
  if (args.metrics && args.metrics !== true) {
    try { metrics = JSON.parse(args.metrics); } catch { die("❌ --metrics must be a JSON object"); }
    if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) die("❌ --metrics must be a JSON object");
    for (const [k, v] of Object.entries(metrics)) if (typeof v !== "number") delete metrics[k];
  }
  let asi;
  if (args.asi && args.asi !== true) {
    try { const p = JSON.parse(args.asi); if (p && typeof p === "object" && !Array.isArray(p)) asi = p; }
    catch { die("❌ --asi must be a JSON object"); }
  }
  const force = args.force === true || args.force === "true";

  const cwd = process.cwd();
  const workDir = resolveWorkDir(cwd);
  const state = readState(workDir);

  // Gate: cannot keep when last run's checks failed
  if (status === "keep" && state.checksPass === false) {
    die(`❌ Cannot keep — .auto/checks.sh failed.\n\n${(state.checksOutput || "").slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`);
  }

  const entries = readEntries(workDir);
  const st = reconstruct(entries);

  // Secondary metrics consistency (same rules as the extension)
  const known = new Set(st.secondaryMetrics);
  const provided = new Set(Object.keys(metrics));
  if (known.size > 0) {
    const missing = [...known].filter((n) => !provided.has(n));
    if (missing.length)
      die(`❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...known].join(", ")}\nGot: ${[...provided].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in --metrics.`);
    const fresh = [...provided].filter((n) => !known.has(n));
    if (fresh.length && !force)
      die(`❌ New secondary metric${fresh.length > 1 ? "s" : ""} not previously tracked: ${fresh.join(", ")}\n\nExisting metrics: ${[...known].join(", ")}\n\nIf this metric has proven very valuable to watch, run log again with --force to add it. Otherwise, remove it from --metrics.`);
  }

  const experiment = {
    commit: commit.slice(0, 7),
    metric,
    metrics,
    status,
    description,
    timestamp: Date.now(),
    segment: st.currentSegment,
    confidence: null,
  };
  if (asi) experiment.asi = asi;
  st.results.push({ ...experiment, run: st.results.length + 1 });
  st.bestMetric = baselineMetric(st);
  experiment.confidence = computeConfidence(st);

  const segCount = segmentResults(st).length;
  let text = `Logged #${st.results.length}: ${status} — ${description}`;
  if (st.bestMetric !== null) {
    text += `\nBaseline ${st.metricName}: ${formatNum(st.bestMetric, st.metricUnit)}`;
    if (segCount > 1 && status === "keep" && metric > 0) {
      const delta = metric - st.bestMetric;
      const pct = ((delta / st.bestMetric) * 100).toFixed(1);
      text += ` | this: ${formatNum(metric, st.metricUnit)} (${delta > 0 ? "+" : ""}${pct}%)`;
    }
  }
  if (Object.keys(metrics).length > 0) {
    const baseRun = segmentResults(st)[0];
    const parts = [];
    for (const [n, v] of Object.entries(metrics)) {
      let unit = "";
      if (n.endsWith("µs")) unit = "µs"; else if (n.endsWith("_ms")) unit = "ms";
      else if (n.endsWith("_s") || n.endsWith("_sec")) unit = "s";
      else if (n.endsWith("_kb")) unit = "kb"; else if (n.endsWith("_mb")) unit = "mb";
      let part = `${n}: ${formatNum(v, unit)}`;
      const bv = baseRun?.metrics?.[n];
      if (bv !== undefined && bv !== 0 && st.results.length > 1) {
        const d = v - bv;
        part += ` (${d > 0 ? "+" : ""}${((d / bv) * 100).toFixed(1)}%)`;
      }
      parts.push(part);
    }
    text += `\nSecondary: ${parts.join("  ")}`;
  }
  if (asi) {
    const parts = Object.entries(asi).map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`;
    });
    if (parts.length) text += `\n📋 ASI: ${parts.join(" | ")}`;
  }
  if (experiment.confidence !== null) {
    const c = experiment.confidence.toFixed(1);
    if (experiment.confidence >= 2.0) text += `\n📊 Confidence: ${c}× noise floor — improvement is likely real`;
    else if (experiment.confidence >= 1.0) text += `\n📊 Confidence: ${c}× noise floor — improvement is above noise but marginal`;
    else text += `\n⚠️ Confidence: ${c}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
  }
  const cfg = readSessionConfig(cwd);
  const maxIter = typeof cfg.maxIterations === "number" ? cfg.maxIterations : null;
  text += `\n(${segCount} experiments${maxIter !== null ? ` / ${maxIter} max` : ""})`;

  // Auto-commit only on keep — discards/crashes get reverted anyway
  if (status === "keep") {
    const resultData = { status, [st.metricName || "metric"]: metric, ...metrics };
    const commitMsg = `${description}\n\nResult: ${JSON.stringify(resultData)}`;
    const add = git(workDir, ["add", "-A"]);
    if (add.code !== 0) text += `\n⚠️ git add failed (exit ${add.code}): ${add.out.trim().slice(0, 200)}`;
    else if (git(workDir, ["diff", "--cached", "--quiet"]).code === 0) text += `\n📝 Git: nothing to commit (working tree clean)`;
    else {
      const c = git(workDir, ["commit", "-m", commitMsg]);
      if (c.code === 0) {
        text += `\n📝 Git: committed — ${(c.out.trim().split("\n")[0] || "")}`;
        const sha = git(workDir, ["rev-parse", "--short=7", "HEAD"], 5000).out.trim();
        if (sha.length >= 7) experiment.commit = sha;
      } else text += `\n⚠️ Git commit failed (exit ${c.code}): ${c.out.trim().slice(0, 200)}`;
    }
  }

  const entry = { run: st.results.length, ...experiment };
  if (!asi) delete entry.asi;
  try { appendEntry(workDir, entry); }
  catch (e) { text += `\n⚠️ Failed to write .auto/log.jsonl: ${e.message}`; }

  if (status !== "keep") {
    try { revertChanges(workDir); text += `\n📝 Git: reverted changes (${status}) — autoresearch files preserved`; }
    catch (e) { text += `\n⚠️ Git revert failed: ${e.message}`; }
  }

  writeState(workDir, { checksPass: null, checksOutput: "", lastDuration: null });

  // Hooks: after → then before for the next iteration (mirrors the extension).
  const session = sessionSnapshot(st);
  const afterSteer = fireHook(workDir, "after", { event: "after", cwd: workDir, run_entry: entry, session });
  if (afterSteer) text += `\n\n${afterSteer}`;

  const limitReached = maxIter !== null && segCount >= maxIter;
  if (limitReached) {
    text += `\n\n🛑 Maximum experiments reached (${maxIter}). STOP the experiment loop now.`;
  } else {
    text += "\n\nBefore choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.";
    const beforeSteer = fireHook(workDir, "before", {
      event: "before", cwd: workDir, next_run: st.results.length + 1, last_run: entry, session,
    });
    if (beforeSteer) text += `\n\n${beforeSteer}`;
  }
  out(text);
}

// ---------------------------------------------------------------------------
// status — session snapshot for resumes (replaces the pi widget/dashboard)
// ---------------------------------------------------------------------------
function cmdStatus() {
  const cwd = process.cwd();
  const workDir = resolveWorkDir(cwd);
  const st = reconstruct(readEntries(workDir));
  if (!readEntries(workDir).length) { out("No autoresearch session (.auto/log.jsonl not found)."); return; }
  const snap = sessionSnapshot(st);
  let text = `Session: ${snap.goal}\nMetric: ${snap.metric_name} (${snap.metric_unit || "unitless"}, ${snap.direction} is better)\nBaseline: ${formatNum(snap.baseline_metric, snap.metric_unit)}  Best kept: ${formatNum(snap.best_metric, snap.metric_unit)}  Runs: ${snap.run_count}`;
  const conf = computeConfidence(st);
  if (conf !== null) text += `\nConfidence: ${conf.toFixed(1)}× noise floor`;
  text += "\n\nRuns:";
  for (const r of st.results.slice(-20))
    text += `\n  #${r.run} [${r.status}] ${r.commit || "—"} ${formatNum(r.metric, snap.metric_unit)} — ${r.description}`;
  out(text);
}

// ---------------------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
switch (cmd) {
  case "init": cmdInit(args); break;
  case "run": cmdRun(args); break;
  case "log": cmdLog(args); break;
  case "status": cmdStatus(); break;
  default:
    out(`autoresearch.mjs — portable autoresearch runtime

Commands:
  init   --name "<goal>" --metric <name> [--unit <u>] [--direction lower|higher]
  run    [command] [--timeout <s>] [--checks-timeout <s>]
  log    --status keep|discard|crash|checks_failed --metric <n> --commit <sha>
         --description "<text>" [--metrics '<json>'] [--asi '<json>'] [--force]
  status`);
    process.exit(cmd ? 1 : 0);
}
