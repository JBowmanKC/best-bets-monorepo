#!/usr/bin/env node
// Appends one pending bankroll bet per pick in a freshly-fetched picks
// payload, without touching any bet that's already recorded.
//
//   node scripts/append-bankroll-bets.mjs [picksJsonPath]
//
// Run by the Daily Picks workflow right after picks.json is fetched, so every
// pick that goes out gets its Kelly stake tracked in
// apps/web/public/bankroll.json from day one. Idempotent: re-running against
// the same picks file is a no-op because bets are keyed by betId.

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

async function main() {
  const picksPath = process.argv[2] ?? join(PUBLIC_DIR, "picks.json");
  if (!existsSync(picksPath)) throw new Error(`No picks file at ${picksPath}`);

  const payload = await readJson(picksPath);
  const picks = payload.picks ?? [];

  const bankroll = existsSync(BANKROLL_FILE) ? await readJson(BANKROLL_FILE) : defaultBankroll();
  const seen = new Set(bankroll.bets.map(b => b.betId));

  let added = 0;
  for (const pick of picks) {
    const betId = `${pick.sport}-${pick.id}-${payload.date}`;
    if (seen.has(betId)) continue;

    bankroll.bets.push({
      betId,
      date: payload.date,
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
    });

    bankroll.totalBets += 1;
    bankroll.totalStaked = Math.round((bankroll.totalStaked + pick.stakeAmount) * 100) / 100;
    seen.add(betId);
    added += 1;
  }

  if (added === 0) {
    console.log(`No new bets to add (${picks.length} pick(s) already tracked for ${payload.date}).`);
    return;
  }

  await writeFile(BANKROLL_FILE, `${JSON.stringify(bankroll, null, 2)}\n`, "utf8");
  console.log(`Added ${added} new bet(s) to bankroll.json for ${payload.date}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
