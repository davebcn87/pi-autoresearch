import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  autoresearchShortcutsConfigPath,
  DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT,
  resolveAutoresearchShortcuts,
} from "../extensions/pi-autoresearch/shortcuts.ts";
import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";

test("autoresearch shortcuts default to the documented bindings when config is absent", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-test-"));
  try {
    const configPath = autoresearchShortcutsConfigPath(agentDir);
    const shortcuts = resolveAutoresearchShortcuts(configPath);

    assert.equal(configPath, join(agentDir, "extensions", "pi-autoresearch.json"));
    assert.equal(shortcuts.fullscreenDashboard, DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("autoresearch shortcuts can be overridden by the config file", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-test-"));
  try {
    const configPath = autoresearchShortcutsConfigPath(agentDir);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        shortcuts: {
          fullscreenDashboard: "ctrl+shift+u",
        },
      })
    );

    const shortcuts = resolveAutoresearchShortcuts(configPath);

    assert.equal(shortcuts.fullscreenDashboard, "ctrl+shift+u");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("autoresearch shortcuts can be disabled with null in the config file", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-test-"));
  try {
    const configPath = autoresearchShortcutsConfigPath(agentDir);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        shortcuts: {
          fullscreenDashboard: null,
        },
      })
    );

    const shortcuts = resolveAutoresearchShortcuts(configPath);

    assert.equal(shortcuts.fullscreenDashboard, null);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("partial shortcut config defaults omitted fields independently", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-test-"));
  try {
    const configPath = autoresearchShortcutsConfigPath(agentDir);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        shortcuts: {},
      })
    );

    const shortcuts = resolveAutoresearchShortcuts(configPath);

    assert.equal(shortcuts.fullscreenDashboard, DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("malformed shortcut config warns and falls back to defaults", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-test-"));
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const configPath = autoresearchShortcutsConfigPath(agentDir);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(configPath, "{ not json");

    const shortcuts = resolveAutoresearchShortcuts(configPath);

    assert.deepEqual(shortcuts, {
      fullscreenDashboard: DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /pi-autoresearch.*config/i);
    assert.match(warnings[0], new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    console.warn = previousWarn;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("invalid known shortcut fields warn and fall back to defaults for the whole file", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-test-"));
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const configPath = autoresearchShortcutsConfigPath(agentDir);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        shortcuts: {
          fullscreenDashboard: 123,
        },
      })
    );

    const shortcuts = resolveAutoresearchShortcuts(configPath);

    assert.deepEqual(shortcuts, {
      fullscreenDashboard: DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /invalid pi-autoresearch config/i);
  } finally {
    console.warn = previousWarn;
    await rm(agentDir, { recursive: true, force: true });
  }
});

function withAgentDir(agentDir, fn) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    fn();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function collectRegisteredShortcuts() {
  const shortcuts = [];
  autoresearchExtension({
    on() {},
    registerTool() {},
    registerCommand() {},
    registerShortcut(shortcut, options) {
      shortcuts.push({ shortcut, description: options.description });
    },
  });
  return shortcuts;
}

test("extension registers shortcuts from the active profile config", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-test-"));
  try {
    const configPath = autoresearchShortcutsConfigPath(agentDir);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        shortcuts: {
          fullscreenDashboard: "ctrl+shift+u",
        },
      })
    );

    withAgentDir(agentDir, () => {
      assert.deepEqual(
        collectRegisteredShortcuts().map((entry) => entry.shortcut),
        ["ctrl+shift+u"]
      );
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
