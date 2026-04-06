#!/usr/bin/env bash
set -euo pipefail

# Markdown exporter — reads session JSON from stdin, appends a report to autoresearch-report.md

INPUT=$(cat)
OUTPUT_FILE="autoresearch-report.md"

node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf-8'));
const s = d.session;
const keeps = d.keeps || [];

const lines = [];
lines.push('');
lines.push('---');
lines.push('');
lines.push('## ' + s.name);
lines.push('');
lines.push('| | |');
lines.push('|---|---|');
lines.push('| **Metric** | ' + s.metric_name + ' (' + s.metric_unit + ', ' + s.direction + ' is better) |');
lines.push('| **Baseline** | ' + s.baseline + ' |');
lines.push('| **Best** | ' + s.best + ' |');
lines.push('| **Improvement** | ' + s.improvement_pct + '% |');
lines.push('| **Runs** | ' + s.total_runs + ' total, ' + s.kept + ' kept, ' + s.discarded + ' discarded, ' + s.crashed + ' crashed |');
lines.push('| **Branch** | \`' + d.context.branch + '\` |');
lines.push('');

if (keeps.length > 0) {
  lines.push('### Kept experiments');
  lines.push('');
  for (const k of keeps) {
    const pct = s.baseline !== 0
      ? ((s.baseline - k.metric) / s.baseline * 100).toFixed(1)
      : '?';
    lines.push('- **' + k.description + '** — ' + s.metric_name + ': ' + k.metric + ' (' + pct + '% from baseline)');
  }
  lines.push('');
}

lines.push('*Exported on ' + new Date().toISOString().split('T')[0] + '*');
lines.push('');

process.stdout.write(lines.join('\n'));
" <<< "$INPUT" >> "$OUTPUT_FILE"

echo "wrote $OUTPUT_FILE"
