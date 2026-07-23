// ─── Core data types ───────────────────────────────────────────────────────

export type Sport = "mlb" | "nfl" | "nhl" | "soccer";
export type Tier = "elite" | "strong" | "value";

export interface TeamRecord {
  wins: number;
  losses: number;
  winPct: number;
}

export interface GameOdds {
  homeMoneyline: number | null; // e.g. -145, +130
  awayMoneyline: number | null;
  drawMoneyline?: number | null; // soccer only
}

export interface RawGame {
  id: string;
  sport: Sport;
  homeTeam: string;
  awayTeam: string;
  startTime: string; // ISO 8601
  homeRecord: TeamRecord;
  awayRecord: TeamRecord;
  odds: GameOdds;
  // Recent form: last 5 results W/L
  homeRecentForm: ("W" | "L")[];
  awayRecentForm: ("W" | "L")[];
  // Series context (wins in current series)
  homeSeriesWins: number;
  awaySeriesWins: number;
  venue: string;
  notes?: string; // e.g. "Doubleheader G2", "Playoff Game 7"
}

// ─── Algorithm scoring ──────────────────────────────────────────────────────

export interface FactorScores {
  winProbability: number;    // 0-100
  expectedValue: number;     // 0-100 (maps EV% to score)
  momentum: number;          // 0-100
  context: number;           // 0-100
  composite: number;         // weighted composite 0-100
}

export interface Pick {
  id: string;
  sport: Sport;
  matchup: string;           // "LA Dodgers @ New York Yankees"
  betType: string;           // "Moneyline — Away Win"
  pickLabel: string;         // "Los Angeles Dodgers ML"
  odds: number;              // -145
  estimatedWinPct: number;   // 0.65
  impliedWinPct: number;     // 0.592 (from odds)
  evEdge: number;            // +0.058 (5.8%)
  tier: Tier;
  scores: FactorScores;
  startTime: string;
  rationale: string;
  stake: string;             // "2–3 units"
  isPositiveEV: boolean;
}

export interface ParlayLeg {
  pickId: string;
  matchup: string;
  pickLabel: string;
  sport: Sport;
  odds: number;
  startTime: string;
}

export interface Parlay {
  id: "safe" | "value" | "shot";
  label: string;
  emoji: string;
  legs: ParlayLeg[];
  estimatedPayout: number;   // e.g. 480 means +480
  combinedWinPct: number;    // 0.27
  recommendedStake: string;  // "1–2 units"
}

export interface BestBetsResponse {
  date: string;              // "2026-07-19"
  generatedAt: string;       // ISO timestamp
  picks: Pick[];
  parlays: Parlay[];
  sportStatus: SportStatus[];
  cached: boolean;
}

export interface SportStatus {
  sport: Sport;
  label: string;
  active: boolean;
  note: string;
}

// ─── Algorithm config ───────────────────────────────────────────────────────

export const FACTOR_WEIGHTS = {
  winProbability: 0.35,
  expectedValue:  0.35,
  momentum:       0.20,
  context:        0.10,
} as const;

export const TIER_THRESHOLDS = {
  elite:  80,
  strong: 65,
  value:  50,
} as const;

export const STAKE_BY_TIER: Record<Tier, string> = {
  elite:  "2–3 units",
  strong: "1–2 units",
  value:  "0.5–1 unit",
};
