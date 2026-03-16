import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import type { ExperimentResult, ExperimentState, MetricDef } from "./types";

/** Format a number with comma-separated thousands: 15586 → "15,586" */
function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

/** Format number with commas, preserving one decimal for fractional values */
function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

export function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  // Integers: no decimals
  if (value === Math.round(value)) return fmtNum(value) + u;
  // Fractional: 2 decimal places
  return fmtNum(value, 2) + u;
}

export function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher"
): boolean {
  return direction === "lower" ? current < best : current > best;
}

/** Get results in the current segment only */
export function currentResults(results: ExperimentResult[], segment: number): ExperimentResult[] {
  return results.filter((r) => r.segment === segment);
}

/** Baseline = first experiment in current segment */
export function findBaselineMetric(results: ExperimentResult[], segment: number): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

/**
 * Find secondary metric baselines from the first experiment in current segment.
 * For metrics that didn't exist at baseline time, falls back to the first
 * occurrence of that metric in the current segment.
 */
export function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[]
): Record<string, number> {
  const cur = currentResults(results, segment);
  const base: Record<string, number> = cur.length > 0
    ? { ...(cur[0].metrics ?? {}) }
    : {};

  // Fill in any known metrics missing from baseline with their first occurrence
  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] === undefined) {
        for (const r of cur) {
          const val = (r.metrics ?? {})[sm.name];
          if (val !== undefined) {
            base[sm.name] = val;
            break;
          }
        }
      }
    }
  }

  return base;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function getTuiSize(tui: unknown): { width: number; height: number } {
  const maybe = tui as { width?: number; height?: number } | undefined;
  return {
    width: maybe?.width ?? process.stdout.columns ?? 120,
    height: maybe?.height ?? process.stdout.rows ?? 40,
  };
}

export function truncateDisplayText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  let out = "";
  for (const ch of text) {
    if (visibleWidth(out + ch + "…") > maxWidth) break;
    out += ch;
  }
  return out + "…";
}

export function joinPartsToWidth(parts: string[], width: number): string {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    const next = out + part;
    if (visibleWidth(next) > width) break;
    out = next;
  }
  return truncateToWidth(out, width);
}

export function appendRightAlignedAdaptiveHint(
  baseLine: string,
  width: number,
  theme: Theme,
  hintCandidates: string[]
): string {
  const currentWidth = visibleWidth(baseLine);
  const available = width - currentWidth;
  if (available <= 0) return truncateToWidth(baseLine, width);

  let chosenHint: string | null = null;
  for (const candidate of hintCandidates) {
    if (visibleWidth(candidate) <= available) {
      chosenHint = candidate;
      break;
    }
  }

  if (!chosenHint) return truncateToWidth(baseLine, width);

  const hintStyled = theme.fg("dim", chosenHint);
  const hintWidth = visibleWidth(hintStyled);
  return truncateToWidth(
    baseLine + " ".repeat(Math.max(0, available - hintWidth)) + hintStyled,
    width
  );
}

export function renderDashboardLines(
  st: ExperimentState,
  width: number,
  th: Theme,
  maxRows: number = 6,
  headerHint?: string
): string[] {
  const lines: string[] = [];

  if (st.results.length === 0) {
    lines.push(`  ${th.fg("dim", "No experiments yet.")}`);
    return lines;
  }

  const cur = currentResults(st.results, st.currentSegment);
  const kept = cur.filter((r) => r.status === "keep").length;
  const discarded = cur.filter((r) => r.status === "discard").length;
  const crashed = cur.filter((r) => r.status === "crash").length;
  const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

  const baseline = st.bestMetric;
  const baselineSec = findBaselineSecondary(st.results, st.currentSegment, st.secondaryMetrics);

  // Find best kept primary metric and its run number (current segment only)
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment) continue;
    if (r.status === "keep" && r.metric > 0) {
      if (bestPrimary === null || isBetter(r.metric, bestPrimary, st.bestDirection)) {
        bestPrimary = r.metric;
        bestSecondary = r.metrics ?? {};
        bestRunNum = i + 1;
      }
    }
  }

  // Runs summary
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Runs:")} ${th.fg("text", String(st.results.length))}` +
        `  ${th.fg("success", `${kept} kept`)}` +
        (discarded > 0 ? `  ${th.fg("warning", `${discarded} discarded`)}` : "") +
        (crashed > 0 ? `  ${th.fg("error", `${crashed} crashed`)}` : "") +
        (checksFailed > 0 ? `  ${th.fg("error", `${checksFailed} checks failed`)}` : ""),
      width
    )
  );

  // Baseline: first run's primary metric
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Baseline:")} ${th.fg("dim", `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)} #1`)}`,
      width
    )
  );


  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine = `  ${th.fg("muted", "Progress:")} ${th.fg("warning", th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg("dim", ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? "+" : "";
      const color = isBetter(bestPrimary, baseline, st.bestDirection) ? "success" : "error";
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    lines.push(truncateToWidth(progressLine, width));

    // Progress secondary metrics on next line with deltas
    if (st.secondaryMetrics.length > 0) {
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = bestSecondary[sm.name];
        const bv = baselineSec[sm.name];
        if (val !== undefined) {
          let part = `${sm.name}: ${formatNum(val, sm.unit)}`;
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? "+" : "";
            const c = val <= bv ? "success" : "error";
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }
      if (secParts.length > 0) {
        lines.push(
          truncateToWidth(
            `  ${th.fg("dim", "          ")}${th.fg("muted", secParts.join("  "))}`,
            width
          )
        );
      }
    }
  }

  lines.push("");

  // Determine visible rows for column pruning
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const visibleRows = st.results.slice(startIdx);

  // Only show secondary metric columns that have at least one value in visible rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    visibleRows.some((r) => (r.metrics ?? {})[sm.name] !== undefined)
  );

  // Column definitions
  const col = { idx: 3, commit: 8, primary: 11, status: 15 };
  const secColWidth = 11;
  const minDescWidth = 10;
  const leftPad = 2;
  const baseWithIdxAndDesc = leftPad + col.idx + col.commit + col.primary + col.status + minDescWidth;
  const baseWithoutIdx = leftPad + col.commit + col.primary + col.status + minDescWidth;

  // Resize behavior order: secondary metrics -> # column -> description
  let includeIndex = true;
  let includeDescription = true;
  if (width < baseWithIdxAndDesc) includeIndex = false;
  if (width < (includeIndex ? baseWithIdxAndDesc : baseWithoutIdx)) includeDescription = false;

  const spaceForSecondaries = Math.max(
    0,
    width -
      leftPad -
      (includeIndex ? col.idx : 0) -
      col.commit -
      col.primary -
      col.status -
      (includeDescription ? minDescWidth : 0)
  );
  const maxSecCols = Math.max(0, Math.floor(spaceForSecondaries / secColWidth));
  const shownSecMetrics = secMetrics.slice(0, maxSecCols);
  const hiddenSecMetrics = secMetrics.length - shownSecMetrics.length;
  const totalSecWidth = shownSecMetrics.length * secColWidth;
  const descW = includeDescription
    ? Math.max(
      minDescWidth,
      width -
        leftPad -
        (includeIndex ? col.idx : 0) -
        col.commit -
        col.primary -
        totalSecWidth -
        col.status
    )
    : 0;

  // Table header — primary metric name bolded with ★
  let headerLine = "  ";
  if (includeIndex) {
    headerLine += th.fg("muted", "#".padEnd(col.idx));
  }
  headerLine +=
    `${th.fg("muted", "commit".padEnd(col.commit))}` +
    `${th.fg("warning", th.bold(("★ " + st.metricName).slice(0, col.primary - 1).padEnd(col.primary)))}`;

  for (const sm of shownSecMetrics) {
    headerLine += th.fg(
      "muted",
      sm.name.slice(0, secColWidth - 1).padEnd(secColWidth)
    );
  }

  headerLine += th.fg("muted", "status".padEnd(col.status));
  if (includeDescription) {
    headerLine += th.fg("muted", "description");
  }
  if (headerHint) {
    headerLine = appendRightAlignedAdaptiveHint(headerLine, width, th, [
      headerHint,
      "ctrl+x collapse • full: c-s-x",
      "ctrl+x • c-s-x",
    ]);
  }

  lines.push(truncateToWidth(headerLine, width));
  lines.push(
    truncateToWidth(
      `  ${th.fg("borderMuted", "─".repeat(width - 4))}`,
      width
    )
  );

  if (hiddenSecMetrics > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `+${hiddenSecMetrics} metric column${hiddenSecMetrics === 1 ? "" : "s"} hidden at this width`)}`,
        width
      )
    );
  }

  // Baseline values for delta display (current segment only)
  const baselinePrimary = findBaselineMetric(st.results, st.currentSegment);
  const baselineSecondary = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics
  );

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `… ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)}`,
        width
      )
    );
  }

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    const isBaseline = !isOld && i === st.results.findIndex((x) => x.segment === st.currentSegment);

    const color = isOld
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning";

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = isOld ? "dim" : "text";
    if (!isOld) {
      if (isBaseline) {
        primaryColor = "muted"; // baseline row
      } else if (
        baselinePrimary !== null &&
        r.status === "keep" &&
        r.metric > 0
      ) {
        if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
          primaryColor = "success";
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error";
        }
      }
    }

    const idxStr = th.fg("dim", String(i + 1).padEnd(col.idx));
    const commitStr = isOld ? "(old)".padEnd(col.commit) : r.commit.padEnd(col.commit);

    let rowLine = "  ";
    if (includeIndex) {
      rowLine += idxStr;
    }
    rowLine +=
      `${th.fg(isOld ? "dim" : "accent", commitStr)}` +
      `${th.fg(primaryColor, isOld ? primaryStr.padEnd(col.primary) : th.bold(primaryStr.padEnd(col.primary)))}`;

    // Secondary metrics
    const rowMetrics = r.metrics ?? {};
    for (const sm of shownSecMetrics) {
      const val = rowMetrics[sm.name];
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = "dim";
        if (!isOld) {
          const bv = baselineSecondary[sm.name];
          if (isBaseline) {
            secColor = "muted"; // baseline row
          } else if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? "success" : "error";
          }
        }
        rowLine += th.fg(secColor, secStr.padEnd(secColWidth));
      } else {
        rowLine += th.fg("dim", "—".padEnd(secColWidth));
      }
    }

    rowLine += th.fg(color, r.status.padEnd(col.status));
    if (includeDescription) {
      rowLine += th.fg("muted", truncateToWidth(r.description, descW));
    }

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}
