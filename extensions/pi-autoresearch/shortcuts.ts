import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT = "ctrl+shift+f";

const CONFIG_FILE_NAME = "pi-autoresearch.json";

export interface AutoresearchShortcuts {
  fullscreenDashboard: string | null;
}

interface AutoresearchShortcutConfig {
  fullscreenDashboard?: unknown;
}

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

  return {
    fullscreenDashboard: shortcutFromConfig(
      config.fullscreenDashboard,
      DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT
    ),
  };
}

function readShortcutConfig(configPath: string): AutoresearchShortcutConfig | null {
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
  return isValidShortcutConfigValue(shortcuts.fullscreenDashboard);
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

function shortcutFromConfig(configured: unknown, fallback: string): string | null {
  if (configured === null) return null;
  return typeof configured === "string" ? configured : fallback;
}

function defaultAutoresearchShortcuts(): AutoresearchShortcuts {
  return {
    fullscreenDashboard: DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT,
  };
}

function warnUsingDefaults(reason: "Could not read" | "Invalid", configPath: string): void {
  console.warn(
    `${reason} pi-autoresearch config at ${configPath}; using default shortcuts.`
  );
}
