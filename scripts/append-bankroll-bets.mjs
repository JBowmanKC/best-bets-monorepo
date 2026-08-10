#!/usr/bin/env node
// Appends a pending bankroll bet for each of today's *committed* daily bets
// — the 3 bestBets singles plus the safeParlay and highOddsParlay — without
// touching any bet that's already recorded. The much larger allPicks/
// allPropPicks analysis pool is deliberately NOT tracked here: the whole
// point of the daily-selection system is that the bankroll only ever commits
// to the 5 bets selectDailyBets() actually chose.
//
//   node scripts/append-bankroll-bets.mjs [picksJsonPath]
//
// Run by the Daily Picks workflow right after picks.json is fetched.
// Idempotent: re-running against the same picks file is a no-op because bets
// are keyed by betId.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { PUBLIC_DIR } from "./lib/history.mjs";

const BANKROLL_FILE = join(PUBLIC_DIR, "bankroll.json");

const defaultBankroll = () => ({
  initialBankroll: 500,
  currentBankroll: 500,
  totalBets: 0,
  wins: 0,
  losses: 0,
  pushes: 0,
  voids: 0,
  totalStaked: 0,
  totalProfit: 0,
  roi: 0,
  peakBankroll: 500,
  lowestBankroll: 500,
  calibration: {
    eliteWinRate: null,
    strongWinRate: null,
    valueWinRate: null,
    mlbRoi: null,
    nflRoi: null,
    nhlRoi: null,
    wpScoreMultiplier: 1.0,
    evScoreMultiplier: 1.0,
    lastCalibrated: null,
    totalResultsTracked: 0,
  },
  bets: [],
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function moneylineBetEntry(pick, date) {
  return {
    betId: `${pick.sport}-${pick.id}-${date}`,
    date,
    sport: pick.sport,
    matchup: pick.matchup,
    pickLabel: pick.pickLabel,
    odds: pick.odds,
    stakeAmount: pick.stakeAmount,
    potentialPayout: pick.potentialPayout,
    estimatedWinPct: pick.estimatedWinPct,
    impliedWinPct: pick.impliedWinPct,
    evEdge: pick.evEdge,
    tier: pick.tier,
    scores: { composite: pick.scores.composite },
    result: "pending",
    profitLoss: null,
    bankrollAfter: null,
    resolvedAt: null,
  };
}

/**
 * Same shape as a moneyline bet, plus propType/playerName/line/recommendedSide
 * — the resolver needs the line and side to grade a prop (see the file header
 * comment in api/resolve-results.ts for why those two aren't optional).
 */
function propBetEntry(prop, date) {
  return {
    ...moneylineBetEntry(prop, date),
    pickLabel: `${prop.playerName} ${prop.recommendedSide === "over" ? "Over" : "Under"} ${prop.line}`,
    estimatedWinPct: prop.estimatedHitPct,
    impliedWinPct: prop.impliedHitPct,
    propType: prop.propType,
    playerName: prop.playerName,
    line: prop.line,
    recommendedSide: prop.recommendedSide,
  };
}

const isProp = item => "playerName" in item;

/**
 * A parlay leg only carries `matchup`/`sport`/`startTime` (see api/best-bets.ts's
 * ParlayLeg) — `date` for grading is derived from the leg's own startTime
 * rather than reused from the slate date, since a late game can start after
 * midnight UTC and land on a different calendar date than the slate.
 */
function parlayLegRecord(leg) {
  return {
    pickLabel: leg.pickLabel,
    odds: leg.odds,
    sport: leg.sport,
    matchup: leg.matchup,
    date: String(leg.startTime).slice(0, 10),
    ...(leg.propType ? { propType: leg.propType, playerName: leg.playerName, line: leg.line, recommendedSide: leg.recommendedSide } : {}),
  };
}

function parlayBetEntry(parlay, kind, date) {
  return {
    betId: `parlay-${kind}-${date}`,
    date,
    betType: "parlay",
    parlayLegs: (parlay.legs ?? []).map(parlayLegRecord),
    combinedOdds: parlay.estimatedPayout,
    stakeAmount: parlay.stakeAmount ?? 0,
    potentialPayout: parlay.potentialPayout ?? 0,
    result: "pending",
    profitLoss: null,
    bankrollAfter: null,
    resolvedAt: null,
  };
}

async function main() {
  const picksPath = process.argv[2] ?? join(PUBLIC_DIR, "picks.json");
  if (!existsSync(picksPath)) throw new Error(`No picks file at ${picksPath}`);

  const payload = await readJson(picksPath);
  const bestBets = payload.bestBets ?? [];
  const safeParlay = payload.safeParlay;
  const highOddsParlay = payload.highOddsParlay;

  const bankroll = existsSync(BANKROLL_FILE) ? await readJson(BANKROLL_FILE) : defaultBankroll();
  const seen = new Set(bankroll.bets.map(b => b.betId));

  const candidates = bestBets.map(item =>
    isProp(item) ? propBetEntry(item, payload.date) : moneylineBetEntry(item, payload.date)
  );
  if (safeParlay?.legs?.length > 0) candidates.push(parlayBetEntry(safeParlay, "safe", payload.date));
  if (highOddsParlay?.legs?.length > 0) candidates.push(parlayBetEntry(highOddsParlay, "high", payload.date));

  let added = 0;
  for (const bet of candidates) {
    if (seen.has(bet.betId)) continue;

    bankroll.bets.push(bet);
    bankroll.totalBets += 1;
    bankroll.totalStaked = Math.round((bankroll.totalStaked + bet.stakeAmount) * 100) / 100;
    seen.add(bet.betId);
    added += 1;
  }

  if (added === 0) {
    console.log(`No new bets to add (${candidates.length} committed bet(s) already tracked for ${payload.date}).`);
    return;
  }

  await writeFile(BANKROLL_FILE, `${JSON.stringify(bankroll, null, 2)}\n`, "utf8");
  console.log(`Added ${added} new bet(s) to bankroll.json for ${payload.date} (${bestBets.length} single(s), ${candidates.length - bestBets.length} parlay(s)).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
