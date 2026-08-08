import type { Pick, PropPick, ParlayOptions, Tier } from "@best-bets/algorithm";

/**
 * Client-side mirror of buildCustomParlay/selectParlayLegs in api/best-bets.ts.
 *
 * Builds the parlay configurator's live preview entirely from data already on
 * the page (picks + propPicks from picks.json) — no API call. Keep this in
 * sync with the server's selection rules if either one changes.
 */

const PROP_TYPE_LABELS: Record<string, string> = {
  pitcher_strikeouts: "Strikeouts",
  pitcher_outs: "Outs Recorded",
  batter_hits: "Hits",
  batter_total_bases: "Total Bases",
  batter_home_runs: "Home Runs",
  player_pass_yards: "Passing Yards",
  player_rush_yards: "Rushing Yards",
  player_receiving_yards: "Receiving Yards",
  player_shots_on_goal: "Shots on Goal",
};

const MAX_PROPS_PER_PARLAY = 2;

export interface ClientParlayLeg {
  id: string;
  label: string;
  odds: number;
  isProp: boolean;
}

export interface ClientParlayResult {
  legs: ClientParlayLeg[];
  estimatedPayout: number; // e.g. 720 means +720
  combinedWinPct: number;  // 0-1
}

interface Candidate {
  isProp: boolean;
  tier: Tier;
  composite: number;
  winPct: number;
  voidRisk: "low" | "medium" | "high" | null;
  leg: ClientParlayLeg;
}

function propLegLabel(p: PropPick): string {
  const side = p.recommendedSide === "over" ? "Over" : "Under";
  return `${p.playerName} ${side} ${p.line} ${PROP_TYPE_LABELS[p.propType] ?? p.propType}`;
}

function pickCandidates(picks: Pick[]): Candidate[] {
  return picks.map(p => ({
    isProp: false,
    tier: p.tier,
    composite: p.scores.composite,
    winPct: p.estimatedWinPct,
    voidRisk: null,
    leg: { id: p.id, label: p.pickLabel, odds: p.odds, isProp: false },
  }));
}

function propCandidates(props: PropPick[]): Candidate[] {
  return props.map(p => ({
    isProp: true,
    tier: p.tier,
    composite: p.scores.composite,
    winPct: p.estimatedHitPct,
    voidRisk: p.voidRisk,
    leg: { id: p.id, label: propLegLabel(p), odds: p.odds, isProp: true },
  }));
}

function calcParlayPayout(odds: number[]): number {
  const decimalProduct = odds.reduce((acc, o) => {
    const decimal = o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
    return acc * decimal;
  }, 1);
  return Math.round((decimalProduct - 1) * 100);
}

export function buildClientParlay(picks: Pick[], propPicks: PropPick[], options: ParlayOptions): ClientParlayResult {
  let pickPool = picks;
  let propPool = options.includeProps ? propPicks.filter(p => p.voidRisk !== "high") : [];

  if (options.sports?.length) {
    pickPool = pickPool.filter(p => options.sports!.includes(p.sport));
    propPool = propPool.filter(p => options.sports!.includes(p.sport));
  }

  let maxProps = MAX_PROPS_PER_PARLAY;
  if (options.riskLevel === "safe") {
    pickPool = pickPool.filter(p => p.tier === "elite");
    propPool = [];
    maxProps = 0;
  } else if (options.riskLevel === "standard") {
    pickPool = pickPool.filter(p => p.tier === "elite" || p.tier === "strong");
    propPool = propPool.filter(p => p.voidRisk === "low" && (p.tier === "elite" || p.tier === "strong"));
    maxProps = Math.min(1, MAX_PROPS_PER_PARLAY);
  } else if (options.riskLevel === "risky") {
    propPool = propPool.filter(p => p.voidRisk === "low" || p.voidRisk === "medium");
  }
  // "custom": every tier, every void risk short of "high", up to the global prop cap.

  const pickPoolSorted = pickCandidates(pickPool).sort((a, b) => b.composite - a.composite);
  const propPoolSorted = propCandidates(propPool).sort((a, b) => b.composite - a.composite);

  const legs: Candidate[] = [];
  for (const c of pickPoolSorted) {
    if (legs.length >= options.legs) break;
    legs.push(c);
  }

  let propCount = 0;
  for (const c of propPoolSorted) {
    if (legs.length >= options.legs || propCount >= maxProps) break;
    legs.push(c);
    propCount += 1;
  }

  legs.sort((a, b) => b.composite - a.composite);

  return {
    legs: legs.map(l => l.leg),
    estimatedPayout: legs.length >= 2 ? calcParlayPayout(legs.map(l => l.leg.odds)) : 0,
    combinedWinPct: legs.length >= 2 ? legs.reduce((acc, l) => acc * l.winPct, 1) : 0,
  };
}
