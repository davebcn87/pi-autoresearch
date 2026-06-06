import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyInferredAutoresearchConfig,
  DEFAULT_MAX_AUTORESUME_TURNS,
  inferAutoresearchConfigFromPrompt,
  readMaxAutoResumeTurns,
  readMaxExperiments,
} from "../extensions/pi-autoresearch/index.ts";

test("auto-resume defaults to the conservative built-in safety valve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-autoresearch-config-"));
  try {
    assert.equal(readMaxAutoResumeTurns(dir), DEFAULT_MAX_AUTORESUME_TURNS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto-resume config supports finite and unlimited values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-autoresearch-config-"));
  try {
    await writeFile(join(dir, "autoresearch.config.json"), JSON.stringify({ maxAutoResumeTurns: 75 }));
    assert.equal(readMaxAutoResumeTurns(dir), 75);

    await writeFile(join(dir, "autoresearch.config.json"), JSON.stringify({ maxAutoResumeTurns: null }));
    assert.equal(readMaxAutoResumeTurns(dir), null);

    await writeFile(join(dir, "autoresearch.config.json"), JSON.stringify({ maxAutoResumeTurns: 0 }));
    assert.equal(readMaxAutoResumeTurns(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("natural-language run counts configure experiment and auto-resume budgets", () => {
  assert.deepEqual(inferAutoresearchConfigFromPrompt("optimize bundle size for 50 runs"), {
    maxIterations: 50,
    maxAutoResumeTurns: 50,
  });

  assert.deepEqual(inferAutoresearchConfigFromPrompt("continue for 1,000 experiments"), {
    maxIterations: 1000,
    maxAutoResumeTurns: 1000,
  });
});

test("natural-language resume counts configure only the auto-resume budget", () => {
  assert.deepEqual(inferAutoresearchConfigFromPrompt("continue for 80 auto-resume turns"), {
    maxAutoResumeTurns: 80,
  });
});

test("natural-language unlimited phrases remove caps and allow indefinite auto-resume", () => {
  assert.deepEqual(inferAutoresearchConfigFromPrompt("continue indefinitely and never stop"), {
    clearMaxIterations: true,
    maxAutoResumeTurns: null,
  });

  assert.deepEqual(inferAutoresearchConfigFromPrompt("run forever for 25 runs"), {
    maxIterations: 25,
    maxAutoResumeTurns: null,
  });
});

test("natural-language parser avoids unrelated durations and product words", () => {
  assert.equal(
    inferAutoresearchConfigFromPrompt("model training, run 5 minutes of train.py"),
    null,
  );
  assert.equal(
    inferAutoresearchConfigFromPrompt("optimize infinite scroll performance"),
    null,
  );
});

test("applying inferred config preserves unrelated fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-autoresearch-config-"));
  try {
    await writeFile(
      join(dir, "autoresearch.config.json"),
      JSON.stringify({ workingDir: "../project", maxIterations: 10 }),
    );

    const notes = applyInferredAutoresearchConfig(dir, {
      clearMaxIterations: true,
      maxAutoResumeTurns: null,
    });

    assert.deepEqual(notes, ["maxIterations=unlimited", "maxAutoResumeTurns=unlimited"]);
    assert.equal(readMaxExperiments(dir), null);
    assert.equal(readMaxAutoResumeTurns(dir), null);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "autoresearch.config.json"), "utf-8")), {
      workingDir: "../project",
      maxAutoResumeTurns: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
