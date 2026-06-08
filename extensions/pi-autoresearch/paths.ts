/**
 * Session file path resolution.
 *
 * All autoresearch session files live under a single `.auto/` subfolder
 * (one folder to preserve across reverts, gitignore, and clean up). New
 * sessions always write the `.auto/` layout. For backwards compatibility we
 * still read the legacy flat `autoresearch.*` files when only those exist.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const AUTO_DIR = ".auto";

export type SessionFileKind = "log" | "prompt" | "ideas" | "checks" | "measure" | "config";
export type HookStage = "before" | "after";

const CURRENT_HOOKS_DIR = "hooks";
const LEGACY_HOOKS_DIR = "autoresearch.hooks";

const SESSION_FILE_NAMES: Record<SessionFileKind, { current: string; legacy: string }> = {
  log:    { current: "log.jsonl",   legacy: "autoresearch.jsonl" },
  prompt: { current: "prompt.md",  legacy: "autoresearch.md" },
  ideas:  { current: "ideas.md",    legacy: "autoresearch.ideas.md" },
  checks: { current: "checks.sh",   legacy: "autoresearch.checks.sh" },
  measure:{ current: "measure.sh",  legacy: "autoresearch.sh" },
  config: { current: "config.json", legacy: "autoresearch.config.json" },
};

export interface SessionFileCandidates {
  current: string;
  legacy: string;
}

function currentSessionPath(dir: string, kind: SessionFileKind): string {
  return path.join(dir, AUTO_DIR, SESSION_FILE_NAMES[kind].current);
}

function legacySessionPath(dir: string, kind: SessionFileKind): string {
  return path.join(dir, SESSION_FILE_NAMES[kind].legacy);
}

function currentHookPath(workDir: string, stage: HookStage): string {
  return path.join(workDir, AUTO_DIR, CURRENT_HOOKS_DIR, `${stage}.sh`);
}

function legacyHookPath(workDir: string, stage: HookStage): string {
  return path.join(workDir, LEGACY_HOOKS_DIR, `${stage}.sh`);
}

function currentLayoutExists(dir: string): boolean {
  for (const kind of Object.keys(SESSION_FILE_NAMES) as SessionFileKind[]) {
    if (fs.existsSync(currentSessionPath(dir, kind))) return true;
  }
  return fs.existsSync(path.join(dir, AUTO_DIR, CURRENT_HOOKS_DIR));
}

/** Return both physical paths for destructive or migration operations. */
export function sessionFileCandidates(dir: string, kind: SessionFileKind): SessionFileCandidates {
  return {
    current: currentSessionPath(dir, kind),
    legacy: legacySessionPath(dir, kind),
  };
}

/**
 * Effective path for a session file. If any current `.auto/` session artifact
 * exists, stay in the current layout for every file and ignore stale legacy
 * peers. Fall back to a legacy flat file only when no current layout exists.
 */
export function sessionFilePath(dir: string, kind: SessionFileKind): string {
  const candidates = sessionFileCandidates(dir, kind);
  if (currentLayoutExists(dir)) return candidates.current;
  return fs.existsSync(candidates.legacy) ? candidates.legacy : candidates.current;
}

/** Effective path for a hook script, with the same layout choice as session files. */
export function hookScriptPath(workDir: string, stage: HookStage): string {
  const current = currentHookPath(workDir, stage);
  const legacy = legacyHookPath(workDir, stage);
  if (currentLayoutExists(workDir)) return current;
  return fs.existsSync(legacy) ? legacy : current;
}

/** Ensure the parent directory for a session file exists before writing. */
export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
