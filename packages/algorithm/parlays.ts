import { Pick, Parlay, ParlayLeg } from "./types";
import { oddsToImpliedProb } from "./scorer";

// Convert American odds list → combined parlay payout
function calcParlayPayout(odds: number[]): number {
  const decimalProduct = odds.reduce((acc, o) => {
    const decimal = o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
    return acc * decimal;
  }, 1);
  return Math.round((decimalProduct - 1) * 100);
}

// Combined win probability (product of individual probs)
function calcCombinedWinPct(picks: Pick[]): number {
  return picks.reduce((acc, p) => acc * p.estimatedWinPct, 1);
}

function toLegs(picks: Pick[]): ParlayLeg[] {
  return picks.map(p => ({
    pickId:    p.id,
    matchup:   p.matchup,
    pickLabel: p.pickLabel,
    sport:     p.sport,
    odds:      p.odds,
    startTime: p.startTime,
  }));
}

export function buildParlays(picks: Pick[]): Parlay[] {
  const elite  = picks.filter(p => p.tier === "elite");
  const strong = picks.filter(p => p.tier === "strong");
  const all    = picks; // already sorted by composite

  // ── Safe parlay: top 3 elite (fall back to strong if needed) ──────────────
  const safeLegs = [...elite, ...strong].slice(0, 3);
  if (safeLegs.length < 2) return []; // not enough picks

  const safePicks = safeLegs;
  const safe: Parlay = {
    id:                "safe",
    label:             "Safety Parlay",
    emoji:             "💚",
    legs:              toLegs(safePicks),
    estimatedPayout:   calcParlayPayout(safePicks.map(p => p.odds)),
    combinedWinPct:    Math.round(calcCombinedWinPct(safePicks) * 100) / 100,
    recommendedStake:  "1–2 units",
  };

  // ── Value parlay: top 4 picks (mix tiers, include any + odds) ─────────────
  const valueLegs = all.slice(0, 4);
  const value: Parlay = {
    id:                "value",
    label:             "Value Parlay",
    emoji:             "💎",
    legs:              toLegs(valueLegs),
    estimatedPayout:   calcParlayPayout(valueLegs.map(p => p.odds)),
    combinedWinPct:    Math.round(calcCombinedWinPct(valueLegs) * 100) / 100,
    recommendedStake:  "0.5 units",
  };

  // ── Shot parlay: top 5 picks ───────────────────────────────────────────────
  const shotLegs = all.slice(0, 5);
  if (shotLegs.length < 5) {
    return [safe, value];
  }
  const shot: Parlay = {
    id:                "shot",
    label:             "Shot Parlay",
    emoji:             "🚀",
    legs:              toLegs(shotLegs),
    estimatedPayout:   calcParlayPayout(shotLegs.map(p => p.odds)),
    combinedWinPct:    Math.round(calcCombinedWinPct(shotLegs) * 100) / 100,
    recommendedStake:  "0.25 units",
  };

  return [safe, value, shot];
}
