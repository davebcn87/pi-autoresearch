#!/usr/bin/env bash
set -euo pipefail

# SQLite exporter — appends curated wins to ~/.pi/agent/autoresearch.db
#
# Reads session JSON from stdin. Upserts a session row, then appends
# each curated_win as a separate row linked to the session.
# FTS is kept in sync automatically via triggers.

DB_PATH="${AUTORESEARCH_DB:-${HOME}/.pi/agent/autoresearch.db}"

if ! command -v sqlite3 &>/dev/null; then
  echo "sqlite3 not found, skipping" >&2
  exit 1
fi

mkdir -p "$(dirname "$DB_PATH")"

sqlite3 "$DB_PATH" <<'SQL'
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  goal TEXT,
  metric_name TEXT,
  metric_unit TEXT,
  direction TEXT,
  baseline REAL,
  best REAL,
  improvement_pct REAL,
  total_runs INTEGER,
  kept INTEGER,
  repo TEXT,
  branch TEXT,
  autoresearch_md TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  technique TEXT NOT NULL,
  description TEXT NOT NULL,
  metric_before REAL,
  metric_after REAL,
  commits TEXT,
  files TEXT,
  dead_ends TEXT,
  session_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS wins_fts USING fts5(
  technique,
  description,
  files,
  dead_ends,
  session_name,
  content=wins,
  content_rowid=id,
  tokenize='porter'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS wins_ai AFTER INSERT ON wins BEGIN
  INSERT INTO wins_fts(rowid, technique, description, files, dead_ends, session_name)
  VALUES(NEW.id, NEW.technique, NEW.description, NEW.files, NEW.dead_ends, NEW.session_name);
END;

CREATE TRIGGER IF NOT EXISTS wins_ad AFTER DELETE ON wins BEGIN
  INSERT INTO wins_fts(wins_fts, rowid, technique, description, files, dead_ends, session_name)
  VALUES('delete', OLD.id, OLD.technique, OLD.description, OLD.files, OLD.dead_ends, OLD.session_name);
END;
SQL

INPUT=$(cat)

# Check if there are any curated wins
COUNT=$(echo "$INPUT" | node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).curated_wins || []).length))")

if [ "$COUNT" = "0" ]; then
  echo "no curated wins to export"
  exit 0
fi

echo "$INPUT" | node -e '
const d = JSON.parse(require("fs").readFileSync("/dev/stdin", "utf-8"));
const wins = d.curated_wins || [];
const s = d.session;
const ctx = d.context;

const esc = (v) => v == null ? "NULL" : "\x27" + String(v).replace(/\x27/g, "\x27\x27") + "\x27";
const sessionId = `${ctx.repo}:${ctx.branch}`;

const sql = [];

// Upsert session
sql.push(`INSERT INTO sessions (id, goal, metric_name, metric_unit, direction, baseline, best, improvement_pct, total_runs, kept, repo, branch, autoresearch_md)
VALUES (
  ${esc(sessionId)}, ${esc(s.name)}, ${esc(s.metric_name)}, ${esc(s.metric_unit)},
  ${esc(s.direction)}, ${s.baseline}, ${s.best}, ${s.improvement_pct},
  ${s.total_runs}, ${s.kept}, ${esc(ctx.repo)}, ${esc(ctx.branch)}, ${esc(ctx.autoresearch_md)}
)
ON CONFLICT(id) DO UPDATE SET
  goal=excluded.goal, metric_name=excluded.metric_name, metric_unit=excluded.metric_unit,
  direction=excluded.direction, baseline=excluded.baseline, best=excluded.best,
  improvement_pct=excluded.improvement_pct, total_runs=excluded.total_runs, kept=excluded.kept,
  autoresearch_md=excluded.autoresearch_md, updated_at=datetime(\x27now\x27);`);

// Insert wins — FTS is updated automatically via trigger
for (const w of wins) {
  sql.push(`INSERT INTO wins (session_id, technique, description, metric_before, metric_after, commits, files, dead_ends, session_name)
VALUES (
  ${esc(sessionId)}, ${esc(w.technique)}, ${esc(w.description)},
  ${w.metric_before ?? "NULL"}, ${w.metric_after ?? "NULL"},
  ${esc(JSON.stringify(w.commits || []))}, ${esc(JSON.stringify(w.files || []))},
  ${esc(JSON.stringify(w.dead_ends || []))}, ${esc(s.name)}
);`);
}

process.stdout.write(sql.join("\n"));
' | sqlite3 "$DB_PATH"

echo "wrote $COUNT win(s) to $DB_PATH"
