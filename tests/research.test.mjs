import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ResearchSession } from '../extensions/pi-autoresearch/research.ts';

const primary = { name: 'time', direction: 'lower' };
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-research-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const write = (name, content) => fs.writeFileSync(path.join(cwd, name), content);
  fs.mkdirSync(path.join(cwd, '.auto'));
  write('source.sh', 'PRIMARY=100\nHOLDOUT=100\n');
  write('.auto/research.json', JSON.stringify({ objective: 'Reduce execution time while preserving generalization.', constraints: ['Preserve correctness.'], sourceFiles: ['source.sh'], failureInterval: 3 }));
  return { cwd, write, session: new ResearchSession(cwd) };
}
test('the outside advisor sees measured outcomes, allows useful variants, and can stop the loop', async (t) => {
  const f = fixture(t);
  const marker = 'HISTORY_CONTAMINATION_SENTINEL';
  f.write('.auto/ideas.md', marker);
  f.write('.auto/log.jsonl', JSON.stringify({ description: marker, asi: { next_action_hint: marker } }));
  f.write('.auto/prompt.md', marker);
  const results = [
    { approach: 'value-cache', status: 'keep', metric: 100, checksPassed: true },
    { approach: 'value-cache', status: 'discard', metric: 110, checksPassed: true },
    { approach: 'value-cache', status: 'checks_failed', metric: 90, checksPassed: false },
    { approach: 'constructor', status: 'discard', metric: 120, checksPassed: true },
  ];
  const payloads = [];
  const result = await f.session.ideate(async (model, system, data) => {
    payloads.push({ model, system, data });
    return JSON.stringify({ verdict: 'continue', reason: 'A useful variant remains.', ideas: [
      { approach: 'Value Cache', hypothesis: 'Reduce misses.', change: 'Cache immutable computation.', mechanism: 'Compute once.', validation: 'Compare unseen workloads.' },
    ] });
  }, results, primary);
  assert.equal(payloads.length, 1);
  assert.equal(JSON.stringify(payloads[0]).includes(marker), false);
  assert.deepEqual(payloads[0].data.primary, { ...primary, baseline: 100, best: 100 });
  assert.deepEqual(payloads[0].data.approaches[0], { name: 'value-cache', attempts: 3, kept: 1, bestKeptMetric: 100, lastResult: results[2] });
  assert.equal(result.stop, false);
  assert.match(result.text, /1 suggestions/);
  const journal = JSON.parse(fs.readFileSync(path.join(f.cwd, '.auto/ideation.jsonl'), 'utf8').trim());
  assert.deepEqual(journal.ideas.map((i) => i.approach), ['value-cache']);
  assert.match(fs.readFileSync(path.join(f.cwd, '.auto/ideas.md'), 'utf8'), /- \[ \] Approach: value-cache \|/);
  const stop = await f.session.ideate(async () => JSON.stringify({ verdict: 'stop', reason: 'The remaining work is noise.', ideas: [] }), results, primary);
  assert.equal(stop.stop, true);
  assert.match(stop.text, /recommends stopping: The remaining work is noise/);
  await assert.rejects(f.session.ideate(async () => { throw new Error('Unavailable'); }, results, primary), /Unavailable/);
});

function resetConfig(f, updates) {
  const config = JSON.parse(fs.readFileSync(path.join(f.cwd, '.auto/research.json'), 'utf8'));
  f.write('.auto/research.json', JSON.stringify({ ...config, ...updates }));
  return new ResearchSession(f.cwd);
}

test('model requests time out even when the provider ignores cancellation', async (t) => {
  const f = fixture(t);
  const session = resetConfig(f, { timeoutSeconds: 1 });
  const started = Date.now();
  // Keep Node alive because AbortSignal.timeout uses an unreferenced timer.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(session.ideate(async () => new Promise(() => {}), [], primary), /cancelled or timed out/);
    assert.ok(Date.now() - started < 5000, 'Provider must not block beyond the configured deadline.');
  } finally {
    clearInterval(keepAlive);
  }
});

test('stopping a session during an advisor request cancels the request', async (t) => {
  const f = fixture(t);
  let entered;
  const requestStarted = new Promise(resolve => { entered = resolve; });
  let modelSignal;
  const pending = f.session.ideate(async (_model, _system, _data, signal) => {
    modelSignal = signal;
    entered();
    return new Promise(() => {});
  }, [], primary);
  await requestStarted;
  f.session.cancel();
  await assert.rejects(pending, /cancelled or timed out/);
  assert.equal(modelSignal.aborted, true);
  assert.equal(fs.existsSync(path.join(f.cwd, '.auto/ideation.jsonl')), false);
});

test('oversized advisor output is rejected before use', async (t) => {
  const f = fixture(t);
  const response = JSON.stringify({ verdict: 'stop', reason: 'Done.', ideas: [], padding: 'x'.repeat(33 * 1024) });
  await assert.rejects(f.session.ideate(async () => response, [], primary), /Model response exceeds 32 KiB/);
});
