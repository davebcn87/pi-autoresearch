import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DEFAULT_MAX_AUTORESUME_TURNS,
  readMaxAutoResumeTurns,
} from "../extensions/pi-autoresearch/index.ts";

test("maxAutoResumeTurns defaults to the built-in safety limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-autoresearch-config-"));
  try {
    assert.equal(readMaxAutoResumeTurns(dir), DEFAULT_MAX_AUTORESUME_TURNS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maxAutoResumeTurns can be overridden from autoresearch.config.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-autoresearch-config-"));
  try {
    await writeFile(
      join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxAutoResumeTurns: 3000 }),
    );

    assert.equal(readMaxAutoResumeTurns(dir), 3000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maxAutoResumeTurns ignores invalid values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-autoresearch-config-"));
  try {
    await writeFile(
      join(dir, "autoresearch.config.json"),
      JSON.stringify({ maxAutoResumeTurns: 0 }),
    );

    assert.equal(readMaxAutoResumeTurns(dir), DEFAULT_MAX_AUTORESUME_TURNS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
