#!/usr/bin/env node
// Grades archived picks against final scores and writes
// `apps/web/public/results/results-<stamp>.json` next to each picks file.
//
//   node scripts/grade-picks.mjs              # grade whatever still needs it
//   node scripts/grade-picks.mjs --all        # re-grade every archived run
//   node scripts/grade-picks.mjs --stamp 20260728T192019Z
//   node scripts/grade-picks.mjs --dry-run    # print, write nothing
//
// Score sources are the same free feeds the picks came from, which is what
// makes the IDs line up: a pick id is `<gameId>-home|away`, where <gameId> is
// the MLB gamePk or the ESPN event id used to generate it. No key required.

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESULTS_DIR, listPicksFiles, readJson, summarize, unitProfit,
} from "./lib/history.mjs";

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_RETRIES = 3;

/** A game not found in any feed this long after tip-off is called unknown. */
const STALE_AFTER_MS = 8 * 60 * 60 * 1000;

/** How long to keep re-attempting runs that still hold unknown picks. */
const UNKNOWN_RETRY_MS = 14 * 24 * 60 * 60 * 1000;

const ESPN_PATHS = { nfl: "football/nfl", nhl: "hockey/nhl" };

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { all: false, dryRun: false, stamps: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--stamp") {
      const stamp = argv[++i];
      if (!stamp) throw new Error("--stamp needs a value, e.g. --stamp 20260728T192019Z");
      args.stamps.push(stamp);
    }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

// ─── Fetch helpers ──────────────────────────────────────────────────────────
async function fetchJson(url) {
  let lastErr;

  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_RETRIES) {
        await new Promise(r => setTimeout(r, 2 ** attempt * 500));
      }
    }
  }

  console.warn(`  ! fetch failed (${lastErr?.message}) — ${url}`);
  return null;
}

// ─── Date helpers ───────────────────────────────────────────────────────────
const toYmd = d => d.toISOString().slice(0, 10);
// Anchored at noon so a ±1 day shift can't be undone by a DST-free UTC edge.
const shiftDays = (ymd, days) =>
  toYmd(new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86_400_000));

/**
 * Dates whose schedule could contain these games.
 *
 * A slate's late games start after midnight UTC, and MLB files those under the
 * previous (local) day, so a pick's own start date is not always the date its
 * game is listed under. Checking the neighbours costs one extra request and
 * removes a whole class of silent misses.
 */
export function candidateDates(slateDate, picks) {
  const dates = new Set([slateDate]);
  for (const p of picks) {
    const t = Date.parse(p.startTime);
    if (Number.isNaN(t)) continue;
    const ymd = toYmd(new Date(t));
    dates.add(ymd);
    dates.add(shiftDays(ymd, -1));
  }
  return [...dates].sort();
}

// ─── Score feeds ────────────────────────────────────────────────────────────

/**
 * @returns {{ ok: boolean, byId: Map<string, object> }} where each value is
 *          { homeTeam, awayTeam, homeScore, awayScore, state, detail } and
 *          state is "final" | "live" | "scheduled" | "no-action".
 *
 * `ok: false` means the feed itself was unreachable, which is very different
 * from "the feed has no such game" — the caller must not grade on it.
 */
async function fetchMlbFinals(dates) {
  const byId = new Map();
  if (dates.length === 0) return { ok: true, byId };

  const url = "https://statsapi.mlb.com/api/v1/schedule"
    + `?sportId=1&startDate=${dates[0]}&endDate=${dates[dates.length - 1]}&hydrate=team,linescore`;
  const data = await fetchJson(url);
  if (!data) return { ok: false, byId };

  for (const day of data.dates ?? []) {
    for (const g of day.games ?? []) {
      const home = g.teams?.home;
      const away = g.teams?.away;
      const detailed = String(g.status?.detailedState ?? "");
      const abstract = String(g.status?.abstractGameState ?? "");

      let state = "scheduled";
      if (/postponed|cancelled|canceled|suspended/i.test(detailed)) state = "no-action";
      else if (abstract === "Final") state = "final";
      else if (abstract === "Live") state = "live";

      byId.set(String(g.gamePk), {
        homeTeam:  home?.team?.name ?? "Home",
        awayTeam:  away?.team?.name ?? "Away",
        homeScore: typeof home?.score === "number" ? home.score : null,
        awayScore: typeof away?.score === "number" ? away.score : null,
        state,
        detail: detailed,
      });
    }
  }

  return { ok: true, byId };
}

async function fetchEspnFinals(sport, dates) {
  const byId = new Map();
  const path = ESPN_PATHS[sport];
  if (!path) return { ok: true, byId };

  let ok = true;

  for (const date of dates) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${date.replace(/-/g, "")}`;
    const data = await fetchJson(url);
    if (!data) { ok = false; continue; }

    for (const e of data.events ?? []) {
      const comp = e.competitions?.[0];
      const competitors = comp?.competitors ?? [];
      const home = competitors.find(c => c.homeAway === "home");
      const away = competitors.find(c => c.homeAway === "away");
      const type = e.status?.type ?? {};
      const name = String(type.name ?? "");

      let state = "scheduled";
      if (/POSTPONED|CANCELED|CANCELLED|SUSPENDED/i.test(name)) state = "no-action";
      else if (type.completed) state = "final";
      else if (type.state === "in") state = "live";

      const num = v => (v === null || v === undefined || v === "" ? null : Number(v));

      byId.set(String(e.id), {
        homeTeam:  home?.team?.displayName ?? "Home",
        awayTeam:  away?.team?.displayName ?? "Away",
        homeScore: num(home?.score),
        awayScore: num(away?.score),
        state,
        detail: String(type.description ?? type.shortDetail ?? name),
      });
    }
  }

  return { ok, byId };
}

// ─── Grading ────────────────────────────────────────────────────────────────

/**
 * @param pick a `Pick` from an archived payload
 * @param game the matching entry from a score feed, or undefined if absent
 */
export function gradePick(pick, game) {
  const base = {
    pickId:      pick.id,
    sport:       pick.sport,
    matchup:     pick.matchup,
    pickLabel:   pick.pickLabel,
    tier:        pick.tier,
    odds:        pick.odds,
    startTime:   pick.startTime,
    unitsRisked: 1,
    unitsNet:    0,
  };

  const started = Date.parse(pick.startTime);
  const stale = !Number.isNaN(started) && Date.now() - started > STALE_AFTER_MS;

  if (!game) {
    return {
      ...base,
      outcome: stale ? "unknown" : "pending",
      unitsRisked: 0,
      note: stale
        ? "Game not found in the score feed for any candidate date."
        : "Game not yet listed as final.",
    };
  }

  if (game.state === "no-action") {
    return { ...base, outcome: "push", note: game.detail || "No action (postponed or cancelled)." };
  }

  if (game.state !== "final" || game.homeScore === null || game.awayScore === null) {
    return {
      ...base,
      outcome: stale && game.state !== "live" ? "unknown" : "pending",
      unitsRisked: 0,
      note: game.detail ? `Game state: ${game.detail}.` : "Game not final yet.",
    };
  }

  const pickedHome = pick.id.endsWith("-home");
  const picked = pickedHome ? game.homeScore : game.awayScore;
  const opponent = pickedHome ? game.awayScore : game.homeScore;

  const outcome = picked > opponent ? "win" : picked < opponent ? "loss" : "push";
  const unitsNet = outcome === "win" ? Math.round(unitProfit(pick.odds) * 10_000) / 10_000
    : outcome === "loss" ? -1
    : 0;

  return {
    ...base,
    outcome,
    unitsNet,
    finalScore: {
      homeTeam:  game.homeTeam,
      awayTeam:  game.awayTeam,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
    },
  };
}

async function gradeRun({ stamp, path }) {
  const payload = await readJson(path);
  const picks = payload.picks ?? [];

  if (picks.length === 0) {
    console.log(`  ${stamp}: no picks in this run — nothing to grade`);
    return { status: "empty" };
  }

  const dates = candidateDates(payload.date, picks);
  const sports = new Set(picks.map(p => p.sport));

  const finals = new Map();
  let feedsOk = true;

  if (sports.has("mlb")) {
    const { ok, byId } = await fetchMlbFinals(dates);
    feedsOk &&= ok;
    for (const [id, g] of byId) finals.set(`mlb:${id}`, g);
  }
  for (const sport of ["nfl", "nhl"]) {
    if (!sports.has(sport)) continue;
    const { ok, byId } = await fetchEspnFinals(sport, dates);
    feedsOk &&= ok;
    for (const [id, g] of byId) finals.set(`${sport}:${id}`, g);
  }

  if (!feedsOk) {
    console.warn(`  ${stamp}: score feed unreachable — leaving this run for the next attempt`);
    return { status: "feed-error" };
  }

  const results = picks.map(pick => {
    const gameId = pick.id.replace(/-(home|away)$/, "");
    return gradePick(pick, finals.get(`${pick.sport}:${gameId}`));
  });

  return {
    status: "ok",
    file: {
      picksFile:        `picks-${stamp}.json`,
      date:             payload.date,
      picksGeneratedAt: payload.generatedAt,
      gradedAt:         new Date().toISOString(),
      summary:          summarize(results),
      results,
    },
  };
}

/**
 * A run needs grading when it has no results file, or when its results file
 * still has picks that could yet resolve.
 *
 * Pending picks are always retried. Unknowns are retried too — a game missing
 * from the feed is usually a transient gap — but only while the run is recent,
 * so a permanently unmatchable game doesn't get re-fetched forever.
 */
async function needsGrading(stamp) {
  const path = join(RESULTS_DIR, `results-${stamp}.json`);
  if (!existsSync(path)) return true;

  let existing;
  try {
    existing = await readJson(path);
  } catch {
    return true; // unreadable/corrupt — rewrite it
  }

  if ((existing.summary?.pending ?? 0) > 0) return true;

  if ((existing.summary?.unknown ?? 0) > 0) {
    const age = Date.now() - Date.parse(existing.picksGeneratedAt ?? "");
    return !Number.isNaN(age) && age < UNKNOWN_RETRY_MS;
  }

  return false;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = await listPicksFiles();

  if (all.length === 0) {
    console.log("No archived picks found in apps/web/public/picks — nothing to grade.");
    return;
  }

  let targets = all;
  if (args.stamps.length > 0) {
    targets = all.filter(f => args.stamps.includes(f.stamp));
    const missing = args.stamps.filter(s => !all.some(f => f.stamp === s));
    if (missing.length) throw new Error(`No archived picks for stamp(s): ${missing.join(", ")}`);
  } else if (!args.all) {
    const checks = await Promise.all(all.map(f => needsGrading(f.stamp)));
    targets = all.filter((_, i) => checks[i]);
  }

  if (targets.length === 0) {
    console.log(`All ${all.length} archived run(s) are fully graded — nothing to do.`);
    return;
  }

  console.log(`Grading ${targets.length} of ${all.length} archived run(s)…`);
  let written = 0;
  let failed = 0;

  for (const target of targets) {
    const { status, file } = await gradeRun(target);
    if (status === "feed-error") { failed += 1; continue; }
    if (status !== "ok") continue;

    const s = file.summary;
    console.log(
      `  ${target.stamp} (${file.date}): ${s.wins}W-${s.losses}L-${s.pushes}P`
      + `, ${s.pending} pending, ${s.unknown} unknown, ${s.unitsNet >= 0 ? "+" : ""}${s.unitsNet}u`
    );

    const outPath = join(RESULTS_DIR, `results-${target.stamp}.json`);

    // Nothing has finished yet: writing a file of all-pending rows would just
    // churn the repo, and the next run will pick this stamp up again anyway.
    if (s.graded === 0 && s.unknown === 0 && !existsSync(outPath)) {
      console.log("    → no games final yet, not writing a results file");
      continue;
    }

    if (args.dryRun) {
      console.log("    → dry run, not writing");
      continue;
    }

    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(outPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    written += 1;
  }

  console.log(`Wrote ${written} results file(s).`);

  // Every run failing on the feed means the score sources are down or their
  // shape changed — fail loudly rather than logging a green no-op.
  if (failed > 0 && written === 0) {
    console.error(`All ${failed} run(s) failed on an unreachable score feed.`);
    process.exit(1);
  }
}

// Guarded so the test suite can import the pure helpers above without the
// script fetching anything or writing files.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
