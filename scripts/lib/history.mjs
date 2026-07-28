// Shared helpers for the pick-archive scripts (`grade-picks.mjs`,
// `build-history-index.mjs`).
//
// Plain ESM JavaScript on purpose: both scripts run in GitHub Actions with
// nothing installed but Node itself, so there is no build step and no
// dependency on the workspace being installed first.

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT   = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PUBLIC_DIR  = join(REPO_ROOT, "apps", "web", "public");
export const PICKS_DIR   = join(PUBLIC_DIR, "picks");
export const RESULTS_DIR = join(PUBLIC_DIR, "results");
export const INDEX_FILE  = join(PUBLIC_DIR, "history-index.json");

export const TIERS = ["elite", "strong", "value"];

const PICKS_RE   = /^picks-(\d{8}T\d{6}Z)\.json$/;
const RESULTS_RE = /^results-(\d{8}T\d{6}Z)\.json$/;

/** `2026-07-28T19:20:19.251Z` → `20260728T192019Z` (filename-safe, sortable). */
export function toStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Inverse of `toStamp`, for turning a filename back into a real Date. */
export function fromStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

async function listStamped(dir, pattern) {
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  return names
    .map(name => {
      const m = pattern.exec(name);
      return m ? { stamp: m[1], name, path: join(dir, name) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.stamp.localeCompare(b.stamp));
}

/** Archived picks payloads, oldest first. */
export function listPicksFiles() {
  return listStamped(PICKS_DIR, PICKS_RE);
}

/** Graded results files, oldest first. */
export function listResultsFiles() {
  return listStamped(RESULTS_DIR, RESULTS_RE);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// ─── Odds math ──────────────────────────────────────────────────────────────

/** Profit on a 1-unit win at American odds: +150 → 1.5, −200 → 0.5. */
export function unitProfit(americanOdds) {
  return americanOdds > 0 ? americanOdds / 100 : 100 / Math.abs(americanOdds);
}

// ─── Summaries ──────────────────────────────────────────────────────────────

export function emptySummary() {
  return {
    total: 0, graded: 0, wins: 0, losses: 0, pushes: 0, pending: 0, unknown: 0,
    winRate: null, unitsRisked: 0, unitsNet: 0, roi: null,
  };
}

const round = (n, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * Aggregate `PickResult`s into a `ResultsSummary`.
 *
 * Only decided picks (win/loss/push) count toward risked units and ROI —
 * counting a pending game as a 1-unit loss would make every fresh slate look
 * catastrophic until its games finish.
 */
export function summarize(results) {
  const s = emptySummary();

  for (const r of results) {
    s.total += 1;
    switch (r.outcome) {
      case "win":     s.wins += 1;    break;
      case "loss":    s.losses += 1;  break;
      case "push":    s.pushes += 1;  break;
      case "pending": s.pending += 1; break;
      default:        s.unknown += 1; break;
    }
    if (r.outcome === "win" || r.outcome === "loss" || r.outcome === "push") {
      s.graded      += 1;
      s.unitsRisked += r.unitsRisked;
      s.unitsNet    += r.unitsNet;
    }
  }

  const decided = s.wins + s.losses;
  s.winRate     = decided > 0 ? round(s.wins / decided) : null;
  s.unitsRisked = round(s.unitsRisked, 2);
  s.unitsNet    = round(s.unitsNet, 2);
  s.roi         = s.unitsRisked > 0 ? round(s.unitsNet / s.unitsRisked) : null;

  return s;
}

/** Merge already-computed summaries (e.g. per-run → all-time totals). */
export function mergeSummaries(summaries) {
  const all = emptySummary();

  for (const s of summaries) {
    all.total       += s.total;
    all.graded      += s.graded;
    all.wins        += s.wins;
    all.losses      += s.losses;
    all.pushes      += s.pushes;
    all.pending     += s.pending;
    all.unknown     += s.unknown;
    all.unitsRisked += s.unitsRisked;
    all.unitsNet    += s.unitsNet;
  }

  const decided = all.wins + all.losses;
  all.winRate     = decided > 0 ? round(all.wins / decided) : null;
  all.unitsRisked = round(all.unitsRisked, 2);
  all.unitsNet    = round(all.unitsNet, 2);
  all.roi         = all.unitsRisked > 0 ? round(all.unitsNet / all.unitsRisked) : null;

  return all;
}
