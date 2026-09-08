import {mkdirSync, writeFileSync} from 'node:fs';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const siteDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recordingsDirectory = resolve(siteDirectory, 'build/recordings');
const generatedCasts = {};

const ansi = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  blue: '\u001b[38;5;75m',
  green: '\u001b[38;5;78m',
  red: '\u001b[38;5;203m',
  yellow: '\u001b[38;5;214m',
  purple: '\u001b[38;2;178;148;187m',
  white: '\u001b[38;5;255m',
  clear: '\u001b[2J\u001b[H\u001b[?25l',
};

const theme = {
  fg: '#f1f1f4',
  bg: '#282c34',
  palette: '#1d1f21:#cc6666:#b5bd68:#f0c674:#81a2be:#b294bb:#8abeb7:#c5c8c6:#666666:#d54e53:#b9ca4a:#e7c547:#7aa6da:#c397d8:#70c0b1:#eaeaea',
};

const experimentRuns = [
  {commit: '6d1fe20', metric: '12.84s', status: 'keep', description: 'Establish test suite baseline', mobileDescription: 'Baseline'},
  {commit: 'a38fd71', metric: '9.62s', status: 'keep', description: 'Use isolated worker pool', mobileDescription: 'Isolate workers'},
  {commit: '—', metric: '10.19s', status: 'discard', description: 'Increase thread count to 12', mobileDescription: 'Try 12 threads'},
  {commit: 'c7a209e', metric: '8.47s', status: 'keep', description: 'Cache transformed setup files', mobileDescription: 'Cache transforms'},
];

const revisitRuns = {
  discard: {run: 7, wall: '33.9s', metric: '33.85s', best: '31.40s', description: 'Build pages in parallel with 8 workers.', short: 'Parallel pages ×8'},
  shift: {run: 12, wall: '22.1s', metric: '22.10s', best: '22.10s', description: 'Cache resized images between builds.', short: 'Cache resized images', commit: '9c1e4a2'},
  revisit: {run: 15, wall: '14.3s', metric: '14.30s', best: '14.30s', description: 'Retry parallel pages with cached images.', short: 'Retry parallel pages', commit: 'd47b0f3', revisits: 7},
};
const revisitBaselineSeconds = 48.2;
const editorRows = 5;
const testsBranch = {compact: 'autoresearch/tests', full: 'autoresearch/optimize-tests'};
const revisitBranch = {compact: 'autoresearch/build', full: 'autoresearch/optimize-build'};

mkdirSync(recordingsDirectory, {recursive: true});
writeExperimentCast('experiment.cast', 112, desktopExperimentScreen);
writeExperimentCast('experiment-compact.cast', 72, mobileExperimentScreen);
writeExperimentCast('experiment-mobile.cast', 42, narrowExperimentScreen);
writeFinalizeCast('finalize.cast', 72, 20);
writeFinalizeCast('finalize-mobile.cast', 44, 24);
writeRevisitCast('revisit.cast', 100, 39);
writeRevisitCast('revisit-mobile.cast', 44, 39);
writeEmbeddedCasts();

function writeEmbeddedCasts() {
  const source = `window.autoresearchCasts = ${JSON.stringify(generatedCasts)};\n`;
  writeFileSync(resolve(recordingsDirectory, 'casts.js'), source);
}

function writeExperimentCast(filename, columns, renderScreen) {
  const rows = columns < 50 ? 19 : 20;
  const cast = createCast(columns, rows);
  const prompt = columns < 50
    ? '/autoresearch optimize test runtime'
    : columns < 80
      ? '/autoresearch optimize unit test runtime'
      : '/autoresearch optimize unit test runtime, monitor correctness';

  typePiPrompt(cast, prompt, columns, rows);
  cast.output(0.45, piApplicationScreen('', prompt, columns, rows));
  cast.output(0.35, piApplicationScreen(renderScreen([], true), '', columns, rows));
  cast.output(1.2, piApplicationScreen(renderScreen(experimentRuns.slice(0, 1), false), '', columns, rows));
  cast.output(1.0, piApplicationScreen(renderScreen(experimentRuns.slice(0, 1), true), '', columns, rows));
  cast.output(1.25, piApplicationScreen(renderScreen(experimentRuns.slice(0, 2), false), '', columns, rows));
  cast.output(1.0, piApplicationScreen(renderScreen(experimentRuns.slice(0, 2), true), '', columns, rows));
  cast.output(1.25, piApplicationScreen(renderScreen(experimentRuns.slice(0, 3), false), '', columns, rows));
  cast.output(1.0, piApplicationScreen(renderScreen(experimentRuns.slice(0, 3), true), '', columns, rows));
  cast.output(1.25, piApplicationScreen(renderScreen(experimentRuns, false), '', columns, rows));
  cast.output(2.3, '');
  cast.save(resolve(recordingsDirectory, filename));
}

function desktopExperimentScreen(runs, running) {
  const activity = running
    ? `${ansi.yellow}◆${ansi.reset} ${ansi.bold}run_experiment${ansi.reset} ${ansi.dim}pnpm test --run${ansi.reset}                                           ${ansi.dim}(timeout: 120s)${ansi.reset}\r\n${ansi.blue}⠋${ansi.reset} ${ansi.dim}Working…${ansi.reset}`
    : `${ansi.green}✓${ansi.reset} ${ansi.bold}run_experiment${ansi.reset} ${ansi.dim}pnpm test --run${ansi.reset}                                                    ${ansi.green}${latestMetric(runs)}${ansi.reset}\r\n${ansi.green}✅ wall: ${latestMetric(runs)}, test_runtime: ${latestMetric(runs)}${ansi.reset}`;

  if (runs.length === 0) {
    return `${activity}\r\n\r\n${ansi.blue}🔬${ansi.yellow} running…${ansi.reset}${ansi.dim} │ Vitest runtime │ waiting for first logged result${ansi.reset}`;
  }

  return `${activity}\r\n\r\n${dashboardTitle(108)}\r\n${summaryLines(runs)}\r\n\r\n${desktopTable(runs)}`;
}

function mobileExperimentScreen(runs, running) {
  const activity = running
    ? `${ansi.yellow}◆${ansi.reset} ${ansi.bold}run_experiment${ansi.reset} ${ansi.dim}pnpm test --run${ansi.reset}\r\n${ansi.blue}⠋${ansi.reset} ${ansi.dim}Working…${ansi.reset}`
    : `${ansi.green}✓${ansi.reset} ${ansi.bold}run_experiment${ansi.reset} ${ansi.dim}pnpm test --run${ansi.reset}\r\n${ansi.green}✅ test_runtime: ${latestMetric(runs)}${ansi.reset}`;

  if (runs.length === 0) {
    return `${activity}\r\n\r\n${ansi.blue}🔬${ansi.yellow} running…${ansi.reset}${ansi.dim} │ waiting for first result${ansi.reset}`;
  }

  return `${activity}\r\n\r\n${dashboardTitle(62)}\r\n${summaryLines(runs)}\r\n\r\n${mobileTable(runs)}`;
}

function narrowExperimentScreen(runs, running) {
  const activity = running
    ? `${ansi.yellow}◆${ansi.reset} ${ansi.bold}run_experiment${ansi.reset} ${ansi.dim}pnpm test${ansi.reset}\r\n${ansi.blue}⠋${ansi.reset} ${ansi.dim}Working…${ansi.reset}`
    : `${ansi.green}✓${ansi.reset} ${ansi.bold}run_experiment${ansi.reset} ${ansi.dim}pnpm test${ansi.reset}\r\n${ansi.green}✅ test_runtime: ${latestMetric(runs)}${ansi.reset}`;
  if (runs.length === 0) return `${activity}\r\n\r\n${ansi.blue}🔬 autoresearch${ansi.reset}${ansi.dim} · waiting for baseline${ansi.reset}`;
  return `${activity}\r\n\r\n${dashboardTitle(38)}\r\n${narrowSummary(runs)}\r\n\r\n${narrowTable(runs)}`;
}

function narrowSummary(runs) {
  const kept = runs.filter(({status}) => status === 'keep').length;
  const best = Math.min(...runs.filter(({status}) => status === 'keep').map(({metric}) => Number.parseFloat(metric)));
  const delta = ((best - 12.84) / 12.84 * 100).toFixed(1);
  return `${ansi.dim}Runs:${ansi.reset} ${runs.length}  ${ansi.green}${kept} kept${ansi.reset}\r\n${ansi.dim}Baseline:${ansi.reset} 12.84s\r\n${ansi.dim}Best:${ansi.reset} ${ansi.yellow}${ansi.bold}${best.toFixed(2)}s${ansi.reset} ${ansi.green}(${delta}%)${ansi.reset}`;
}

function narrowTable(runs) {
  const header = `${ansi.dim}#  runtime   status    experiment${ansi.reset}`;
  const rule = `${ansi.dim}${'─'.repeat(38)}${ansi.reset}`;
  const rows = runs.map((run, index) => {
    const statusColor = run.status === 'keep' ? ansi.green : ansi.yellow;
    return `${ansi.dim}${index + 1}  ${ansi.reset}${ansi.bold}${run.metric.padEnd(10)}${ansi.reset}${statusColor}${run.status.padEnd(10)}${ansi.reset}${ansi.dim}${run.mobileDescription}${ansi.reset}`;
  }).join('\r\n');
  return `${header}\r\n${rule}\r\n${rows}`;
}

function dashboardTitle(width) {
  const title = ' 🔬 autoresearch: Vitest runtime ';
  const remaining = Math.max(4, width - 3 - title.length);
  return `${ansi.dim}───${ansi.reset}${ansi.blue}${title}${ansi.reset}${ansi.dim}${'─'.repeat(remaining)}${ansi.reset}`;
}

function summaryLines(runs) {
  const kept = runs.filter(({status}) => status === 'keep').length;
  const discarded = runs.filter(({status}) => status === 'discard').length;
  const bestMetric = Math.min(...runs.filter(({status}) => status === 'keep').map(({metric}) => Number.parseFloat(metric)));
  const bestRun = experimentRuns.findIndex(({metric}) => Number.parseFloat(metric) === bestMetric) + 1;
  const confidence = runs.length >= 3 ? `${ansi.green}  (conf: 2.4×)${ansi.reset}` : '';
  const discardedText = discarded ? `${ansi.yellow}  ${discarded} discarded${ansi.reset}` : '';
  const improvement = ((bestMetric - 12.84) / 12.84 * 100).toFixed(1);
  const progress = bestMetric === 12.84 ? '' : `${ansi.green} (${improvement}%)${ansi.reset}`;

  return `  ${ansi.dim}Runs:${ansi.reset} ${runs.length}  ${ansi.green}${kept} kept${ansi.reset}${confidence}${discardedText}\r\n` +
    `  ${ansi.dim}Baseline: ★ test_runtime: 12.84s #1${ansi.reset}\r\n` +
    `  ${ansi.dim}Progress:${ansi.reset} ${ansi.yellow}${ansi.bold}★ test_runtime: ${bestMetric.toFixed(2)}s${ansi.reset}${ansi.dim} #${bestRun}${ansi.reset}${progress}`;
}

function desktopTable(runs) {
  const header = `  ${ansi.dim}#  commit    ${ansi.reset}${ansi.yellow}${ansi.bold}★ test_runtime  ${ansi.reset}${ansi.dim}status         description${ansi.reset}`;
  const rule = `  ${ansi.dim}${'─'.repeat(106)}${ansi.reset}`;
  const rows = runs.map((run, index) => formatDesktopRow(run, index)).join('\r\n');
  return `${header}\r\n${rule}\r\n${rows}`;
}

function formatDesktopRow(run, index) {
  const statusColor = run.status === 'keep' ? ansi.green : ansi.yellow;
  const metricColor = index === 0 ? ansi.white : run.status === 'keep' ? ansi.green : ansi.white;
  return `  ${ansi.dim}${index + 1}  ${ansi.reset}${ansi.blue}${run.commit.padEnd(10)}${ansi.reset}${metricColor}${ansi.bold}${run.metric.padEnd(16)}${ansi.reset}${statusColor}${run.status.padEnd(15)}${ansi.reset}${ansi.dim}${run.description}${ansi.reset}`;
}

function mobileTable(runs) {
  const header = ` ${ansi.dim}# commit    ${ansi.reset}${ansi.yellow}${ansi.bold}★ runtime ${ansi.reset}${ansi.dim}status    description${ansi.reset}`;
  const rule = ` ${ansi.dim}${'─'.repeat(62)}${ansi.reset}`;
  const rows = runs.map((run, index) => formatMobileRow(run, index)).join('\r\n');
  return `${header}\r\n${rule}\r\n${rows}`;
}

function formatMobileRow(run, index) {
  const statusColor = run.status === 'keep' ? ansi.green : ansi.yellow;
  return ` ${ansi.dim}${index + 1} ${ansi.reset}${ansi.blue}${run.commit.padEnd(10)}${ansi.reset}${ansi.bold}${run.metric.padEnd(10)}${ansi.reset}${statusColor}${run.status.padEnd(10)}${ansi.reset}${ansi.dim}${run.mobileDescription}${ansi.reset}`;
}

function latestMetric(runs) {
  return runs.at(-1)?.metric ?? '—';
}

function writeFinalizeCast(filename, columns, rows) {
  const cast = createCast(columns, rows);
  const prompt = '/skill:autoresearch-finalize';
  cast.output(0.35, `${ansi.blue}› ${ansi.reset}`);
  typeText(cast, prompt);
  cast.output(0.35, '\r\n');
  cast.output(0.5, `${ansi.blue}◆${ansi.reset} ${ansi.bold}read${ansi.reset} ${ansi.dim}.auto/log.jsonl${ansi.reset}\r\n`);
  cast.output(0.9, `${ansi.green}✓${ansi.reset} ${ansi.dim}28 experiments · 9 kept · 19 discarded${ansi.reset}\r\n\r\n`);
  cast.output(0.8, `${ansi.white}${ansi.bold}Two independent changesets found.${ansi.reset}\r\n\r\n`);
  cast.output(0.8, `${ansi.blue}01${ansi.reset}  ${ansi.bold}Worker pool isolation${ansi.reset}\r\n    ${ansi.dim}Runs 12 + 18 · test configuration${ansi.reset}\r\n    ${ansi.green}−23.4% test runtime${ansi.reset}\r\n\r\n`);
  cast.output(0.9, `${ansi.blue}02${ansi.reset}  ${ansi.bold}Transform cache${ansi.reset}\r\n    ${ansi.dim}Run 27 · setup cache${ansi.reset}\r\n    ${ansi.green}−8.1% test runtime${ansi.reset}\r\n\r\n`);
  cast.output(0.8, `${ansi.blue}◆${ansi.reset} ${ansi.bold}bash${ansi.reset} ${ansi.dim}create independent branches from merge-base${ansi.reset}\r\n`);
  cast.output(1.1, `${ansi.green}✓ perf/test-pool${ansi.reset}      ${ansi.dim}2 commits${ansi.reset}\r\n${ansi.green}✓ perf/cache-config${ansi.reset}   ${ansi.dim}1 commit${ansi.reset}\r\n\r\n`);
  const readyMessage = columns < 60
    ? `${ansi.green}${ansi.bold}Ready for review.${ansi.reset}\r\n${ansi.dim}No shared files. Merge independently.${ansi.reset}`
    : `${ansi.green}${ansi.bold}Ready for review.${ansi.reset} ${ansi.dim}No shared files; safe to merge independently.${ansi.reset}`;
  cast.output(0.8, readyMessage);
  cast.output(2.0, '');
  cast.save(resolve(recordingsDirectory, filename));
}

// ---------------------------------------------------------------------------
// Revisiting discards: run #7 is discarded, #12 changes its assumption, #15 goes back.
// ---------------------------------------------------------------------------

function writeRevisitCast(filename, columns, rows) {
  const cast = createCast(columns, rows);
  const compact = columns < 60;
  const screen = (stage) => piApplicationScreen(revisitTranscript(stage, compact, columns), '', columns, rows, revisitBranch);

  cast.output(0.4, screen('discarded'));
  cast.output(2.2, screen('shifted'));
  cast.output(1.8, screen('reasoning'));
  cast.output(1.6, screen('running'));
  cast.output(0.6, screen('running-2'));
  cast.output(0.6, screen('running'));
  cast.output(0.6, screen('revisited'));
  holdFinalFrame(cast, 5);
  assertRevisitCastFits(columns, rows, compact);
  cast.save(resolve(recordingsDirectory, filename));
}

function revisitTranscript(stage, compact, columns) {
  const blocks = [loggedResult(revisitRuns.discard, 'discard', compact)];
  blocks.push(assistantNote(compact
    ? ['Image resizing already keeps every core', 'busy. Extra workers just add contention.']
    : ['Image resizing already keeps every core busy, so extra workers just add contention.', 'Staying sequential.']));
  if (stage === 'discarded') return joinBlocks(blocks, revisitWidget(['discard'], compact, columns));

  blocks.push(`${ansi.dim}… 4 experiments later${ansi.reset}`);
  blocks.push(loggedResult(revisitRuns.shift, 'keep', compact));
  if (stage === 'shifted') return joinBlocks(blocks, revisitWidget(['discard', 'shift'], compact, columns));

  blocks.push(assistantNote(compact
    ? ['Does #12 invalidate an earlier discard?', 'Yes — #7 failed because every core was', 'busy. Cached images leave the CPU idle,', 'so I\'m retrying parallel page builds.']
    : ['Does #12 invalidate an earlier discard? Yes: #7 was rejected because every core was busy.', 'Cached images leave the CPU mostly idle, so that rollback reason no longer holds.', 'Retrying parallel page builds.']));
  if (stage === 'reasoning') return joinBlocks(blocks, revisitWidget(['discard', 'shift'], compact, columns));

  if (stage.startsWith('running')) {
    const spinner = stage === 'running' ? '⠋' : '⠙';
    blocks.push(`${ansi.yellow}◆${ansi.reset} ${ansi.bold}run_experiment${ansi.reset} ${ansi.dim}pnpm build${ansi.reset}\r\n${ansi.blue}${spinner}${ansi.reset} ${ansi.dim}Working…${ansi.reset}`);
    return joinBlocks(blocks, revisitWidget(['discard', 'shift'], compact, columns));
  }

  blocks.push(`${ansi.green}✓${ansi.reset} ${ansi.bold}run_experiment${ansi.reset} ${ansi.dim}pnpm build${ansi.reset}\r\n${ansi.green}✅ wall: ${revisitRuns.revisit.wall}, build_time: ${revisitRuns.revisit.metric}${ansi.reset}`);
  blocks.push(loggedResult(revisitRuns.revisit, 'keep', compact));
  return joinBlocks(blocks, revisitWidget(['discard', 'shift', 'revisit'], compact, columns));
}

// The player clamps idle gaps to 1.5s, so a long hold needs several short no-op frames.
function holdFinalFrame(cast, seconds) {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1.25) cast.output(1.25, '');
}

function joinBlocks(blocks, widget) {
  return `${blocks.join('\r\n\r\n')}\r\n\r\n${widget}`;
}

function assistantNote(lines) {
  return lines.map((line) => `${ansi.white}${line}${ansi.reset}`).join('\r\n');
}

/** Mirrors log_experiment's renderCall + renderResult output, including the revisit line. */
function loggedResult(run, status, compact) {
  const statusColor = status === 'keep' ? ansi.green : ansi.yellow;
  const icon = status === 'keep' ? '✓' : '–';
  const call = `${ansi.bold}log_experiment${ansi.reset} ${statusColor}${status}${ansi.reset} ${ansi.dim}${compact ? run.short : run.description}${ansi.reset}`;
  const result = compact
    ? `${statusColor}${icon}${ansi.reset} ${ansi.blue}#${run.run}${ansi.reset} ${ansi.dim}(${ansi.reset}${ansi.yellow}${run.metric}${ansi.reset}${ansi.dim})${ansi.reset} ${run.short}`
    : `${statusColor}${icon}${ansi.reset} ${ansi.blue}#${run.run}${ansi.reset} ${ansi.dim}(${ansi.reset}${ansi.yellow}wall: ${run.wall}${ansi.dim}, ${ansi.reset}${ansi.yellow}build_time: ${run.metric}${ansi.reset}${ansi.dim})${ansi.reset} ${run.description} ${ansi.dim}│${ansi.reset} ${ansi.yellow}★ best: ${run.best}${ansi.reset}`;
  const badge = run.revisits ? `\r\n${ansi.blue}↻ Revisiting #${run.revisits}${ansi.reset}` : '';
  return `${call}\r\n${result}${badge}`;
}

function revisitWidget(visible, compact, columns) {
  const runs = visible.map((key) => revisitRuns[key]);
  const latest = runs.at(-1);
  const kept = runs.filter((run) => run.commit).length + 4;
  const total = latest.run;
  const improvement = ((Number.parseFloat(latest.best) - revisitBaselineSeconds) / revisitBaselineSeconds * 100).toFixed(1);
  const title = revisitTitle(columns);
  const summary = compact
    ? `${ansi.dim}Runs:${ansi.reset} ${total}  ${ansi.green}${kept} kept${ansi.reset}  ${ansi.yellow}${total - kept} discarded${ansi.reset}\r\n${ansi.dim}Best:${ansi.reset} ${ansi.yellow}${ansi.bold}${latest.best}${ansi.reset} ${ansi.green}(${improvement}%)${ansi.reset}`
    : `  ${ansi.dim}Runs:${ansi.reset} ${total}  ${ansi.green}${kept} kept${ansi.reset}  ${ansi.yellow}${total - kept} discarded${ansi.reset}\r\n  ${ansi.dim}Baseline: ★ build_time: ${revisitBaselineSeconds.toFixed(2)}s #1${ansi.reset}\r\n  ${ansi.dim}Progress:${ansi.reset} ${ansi.yellow}${ansi.bold}★ build_time: ${latest.best}${ansi.reset}${ansi.dim} #${runs.findLast((run) => run.commit)?.run ?? 6}${ansi.reset}${ansi.green} (${improvement}%)${ansi.reset}`;
  return `${title}\r\n${summary}\r\n\r\n${revisitTable(runs, compact, columns)}`;
}

function revisitTitle(columns) {
  const title = columns < 60 ? ' 🔬 autoresearch: site build ' : ' 🔬 autoresearch: website build time ';
  const remaining = Math.max(4, columns - 4 - title.length);
  return `${ansi.dim}───${ansi.reset}${ansi.blue}${title}${ansi.reset}${ansi.dim}${'─'.repeat(remaining)}${ansi.reset}`;
}

function revisitTable(runs, compact, columns) {
  const indent = compact ? '' : '  ';
  const header = compact
    ? `${ansi.dim}#   build_time status  description${ansi.reset}`
    : `${indent}${ansi.dim}#   commit   ${ansi.reset}${ansi.yellow}${ansi.bold}★ build_time ${ansi.reset}${ansi.dim}status    description${ansi.reset}`;
  const rule = `${indent}${ansi.dim}${'─'.repeat(columns - 4)}${ansi.reset}`;
  const earlier = `${indent}${ansi.dim}… 6 earlier runs${ansi.reset}`;
  const rows = runs.map((run) => revisitRow(run, compact, indent));
  return [header, rule, earlier, ...rows].join('\r\n');
}

function revisitRow(run, compact, indent) {
  const status = run.commit ? 'keep' : 'discard';
  const statusColor = run.commit ? ansi.green : ansi.yellow;
  const number = String(run.run).padEnd(4);
  if (compact) {
    return `${ansi.dim}${number}${ansi.reset}${ansi.bold}${run.metric.padEnd(11)}${ansi.reset}${statusColor}${status.padEnd(8)}${ansi.reset}${ansi.dim}${run.short}${ansi.reset}`;
  }
  const commit = (run.commit ?? '—').padEnd(9);
  return `${indent}${ansi.dim}${number}${ansi.reset}${ansi.blue}${commit}${ansi.reset}${ansi.bold}${run.metric.padEnd(13)}${ansi.reset}${statusColor}${status.padEnd(10)}${ansi.reset}${ansi.dim}${run.description}${ansi.reset}`;
}

function assertRevisitCastFits(columns, rows, compact) {
  const lines = revisitTranscript('revisited', compact, columns).split('\r\n');
  const overflowing = lines.find((line) => visibleLength(line) > columns);
  if (overflowing) throw new Error(`revisit cast line overflows ${columns} columns: ${JSON.stringify(stripAnsi(overflowing))}`);
  const available = rows - editorRows;
  if (lines.length > available) throw new Error(`revisit cast needs ${lines.length} rows but only ${available} are available above the editor`);
}

function visibleLength(line) {
  return [...stripAnsi(line)].length;
}

function stripAnsi(line) {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

function createCast(columns, rows) {
  const events = [];
  const header = {
    version: 3,
    term: {cols: columns, rows, type: 'xterm-256color', theme},
    env: {SHELL: '/bin/zsh'},
  };

  return {
    output(delay, text) {
      events.push([delay, 'o', text]);
    },
    save(path) {
      const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))];
      generatedCasts[`recordings/${basename(path)}`] = `${lines.join('\n')}\n`;
    },
  };
}

function typeText(cast, text) {
  for (const character of text) {
    cast.output(character === ' ' ? 0.025 : 0.035, character);
  }
}

function typePiPrompt(cast, text, columns, rows) {
  for (let length = 0; length <= text.length; length += 1) {
    const character = text[length - 1] ?? '';
    cast.output(character === ' ' ? 0.025 : 0.035, piApplicationScreen('', text.slice(0, length), columns, rows));
  }
}

function piApplicationScreen(content, input, columns, rows, branch = testsBranch) {
  const contentLines = content ? content.split('\r\n').length : 0;
  const paddingRows = Math.max(0, rows - editorRows - contentLines);
  const padding = '\r\n'.repeat(paddingRows);
  const separator = `${ansi.purple}${'─'.repeat(columns)}${ansi.reset}`;
  const compact = columns < 60;
  const project = `~/project (${compact ? branch.compact : branch.full})`;
  const status = compact
    ? '0.0%/200k (auto)        opus-4-8 • high'
    : '0.0%/200k (auto)                  (anthropic) claude-opus-4-8 • high';
  const cursor = `${ansi.white}\u001b[7m \u001b[27m${ansi.reset}`;
  const editor = `${separator}\r\n ${ansi.white}${input}${ansi.reset}${cursor}\r\n${separator}\r\n${ansi.dim}${project}${ansi.reset}\r\n${ansi.dim}${status}${ansi.reset}`;
  return `${ansi.clear}${padding}${content}${content ? '\r\n' : ''}${editor}`;
}
