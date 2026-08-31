import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  autoresearchShortcutsConfigPath,
  resolveAutoresearchShortcuts,
  SHORTCUT_ACTIONS,
} from "../extensions/pi-autoresearch/shortcuts.ts";
import autoresearchExtension from "../extensions/pi-autoresearch/index.ts";

const UNBOUND_DEFAULTS = {
  fullscreenDashboard: null,
  export: null,
  off: null,
};

test("no shortcuts are bound by default", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-test-"));
  try {
    const configPath = autoresearchShortcutsConfigPath(agentDir);
    const shortcuts = resolveAutoresearchShortcuts(configPath);

    assert.equal(configPath, join(agentDir, "extensions", "pi-autoresearch.json"));
    assert.deepEqual(shortcuts, UNBOUND_DEFAULTS);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("shortcut actions cover every configurable command", () => {
  assert.deepEqual([...SHORTCUT_ACTIONS], ["fullscreenDashboard", "export", "off"]);
});

test("shortcuts can be opted into via the config file", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-test-"));
  try {
    const configPath = autoresearchShortcutsConfigPath(agentDir);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        shortcuts: {
          fullscreenDashboard: "ctrl+shift+u",
          export: "alt+shift+e",
        },
      })
    );

    const shortcuts = resolveAutoresearchShortcuts(configPath);

    assert.deepEqual(shortcuts, {
      fullscreenDashboard: "ctrl+shift+u",
      export: "alt+shift+e",
      off: null,
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("explicit null in the config file keeps a shortcut unbound", async () => {
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

test("empty shortcut config leaves every action unbound", async () => {
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

    assert.deepEqual(shortcuts, UNBOUND_DEFAULTS);
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

    assert.deepEqual(shortcuts, UNBOUND_DEFAULTS);
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

    assert.deepEqual(shortcuts, UNBOUND_DEFAULTS);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /invalid pi-autoresearch config/i);
  } finally {
    console.warn = previousWarn;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("invalid shortcut chords warn instead of registering a dead binding", async () => {
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
          fullscreenDashboard: "ctrl+shift+",
        },
      })
    );

    assert.deepEqual(resolveAutoresearchShortcuts(configPath), UNBOUND_DEFAULTS);
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

test("extension registers no shortcuts without opt-in config", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-test-"));
  try {
    withAgentDir(agentDir, () => {
      assert.deepEqual(collectRegisteredShortcuts(), []);
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("extension registers each configured shortcut", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresearch-test-"));
  try {
    const configPath = autoresearchShortcutsConfigPath(agentDir);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        shortcuts: {
          fullscreenDashboard: "ctrl+shift+u",
          export: "alt+shift+e",
          off: "alt+shift+q",
        },
      })
    );

    withAgentDir(agentDir, () => {
      assert.deepEqual(
        collectRegisteredShortcuts().map((entry) => entry.shortcut),
        ["ctrl+shift+u", "alt+shift+e", "alt+shift+q"]
      );
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
