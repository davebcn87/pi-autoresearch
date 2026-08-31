import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// No shortcut is bound by default: pi's built-in keymap grows over time and
// any hardcoded chord eventually collides with it (see issue #86). Every
// action is reachable through /autoresearch subcommands; chords are opt-in.
export const SHORTCUT_ACTIONS = ["fullscreenDashboard", "export", "off"] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export type AutoresearchShortcuts = Record<ShortcutAction, string | null>;

const CONFIG_FILE_NAME = "pi-autoresearch.json";

export function autoresearchShortcutsConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "extensions", CONFIG_FILE_NAME);
}

export function resolveAutoresearchShortcuts(
  configPath: string = autoresearchShortcutsConfigPath()
): AutoresearchShortcuts {
  if (!existsSync(configPath)) {
    return defaultAutoresearchShortcuts();
  }

  const config = readShortcutConfig(configPath);
  if (!config) {
    return defaultAutoresearchShortcuts();
  }

  return shortcutsFromConfig(config);
}

function readShortcutConfig(configPath: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    warnUsingDefaults("Could not read", configPath);
    return null;
  }

  const shortcuts = isRecord(parsed) ? parsed.shortcuts : undefined;
  if (shortcuts === undefined) {
    return {};
  }

  if (!isRecord(shortcuts) || !hasValidShortcutValues(shortcuts)) {
    warnUsingDefaults("Invalid", configPath);
    return null;
  }

  return shortcuts;
}

function hasValidShortcutValues(shortcuts: Record<string, unknown>): boolean {
  return SHORTCUT_ACTIONS.every((action) => isValidShortcutConfigValue(shortcuts[action]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidShortcutConfigValue(value: unknown): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value !== "")
  );
}

function shortcutsFromConfig(config: Record<string, unknown>): AutoresearchShortcuts {
  const shortcuts = defaultAutoresearchShortcuts();
  for (const action of SHORTCUT_ACTIONS) {
    const configured = config[action];
    if (typeof configured === "string") {
      shortcuts[action] = configured;
    }
  }
  return shortcuts;
}

function defaultAutoresearchShortcuts(): AutoresearchShortcuts {
  return {
    fullscreenDashboard: null,
    export: null,
    off: null,
  };
}

function warnUsingDefaults(reason: "Could not read" | "Invalid", configPath: string): void {
  console.warn(
    `${reason} pi-autoresearch config at ${configPath}; using default shortcuts.`
  );
}
