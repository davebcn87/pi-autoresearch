import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateAutoresearchGitSafety } from "../extensions/pi-autoresearch/index.ts";

test("git safety preflight blocks autoresearch outside a git work tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-autoresearch-git-"));
  try {
    const result = validateAutoresearchGitSafety(dir);
    assert.equal(result.ok, false);
    assert.equal(result.allowNoGit, false);
    assert.match(result.error ?? "", /requires workingDir to be inside a git working tree/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git safety preflight allows explicit throwaway no-git sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-autoresearch-git-"));
  try {
    await mkdir(join(dir, ".auto"), { recursive: true });
    await writeFile(join(dir, ".auto", "config.json"), JSON.stringify({ allowNoGit: true }));

    const result = validateAutoresearchGitSafety(dir);
    assert.equal(result.ok, true);
    assert.equal(result.allowNoGit, true);
    assert.match(result.warning ?? "", /git keep\/discard protection is disabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git safety preflight accepts nested directories inside a git work tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-autoresearch-git-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    await mkdir(join(dir, "packages", "demo"), { recursive: true });
    await mkdir(join(dir, ".auto"), { recursive: true });
    await writeFile(join(dir, ".auto", "config.json"), JSON.stringify({ workingDir: "packages/demo" }));

    const result = validateAutoresearchGitSafety(dir);
    assert.equal(result.ok, true);
    assert.equal(result.allowNoGit, false);
    assert.equal(result.gitRoot, await realpath(dir));
    assert.equal(await realpath(result.workDir), await realpath(join(dir, "packages", "demo")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
