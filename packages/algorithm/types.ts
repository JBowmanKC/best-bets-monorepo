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
  sportStatuses: SportStatus[];
  cached: boolean;
  /**
   * Non-fatal problems that degrade pick quality (e.g. team context could not
   * be fetched). Present so the UI can avoid showing picks as authoritative.
   */
  warnings?: string[];
}

export interface SportStatus {
  sport: Sport;
  label: string;
  active: boolean;
  note: string;
}

// ─── Pick history + results grading ─────────────────────────────────────────
//
// Every worker run archives its payload as `/picks/picks-<stamp>.json`, where
// <stamp> is a compact UTC timestamp (`20260728T192019Z`). A later grading run
// writes `/results/results-<stamp>.json` using the *same* stamp, so a pick file
// and its graded outcome are paired by filename alone. `/history-index.json`
// is generated at build time from whatever files are present — static hosting
// can't list a directory, so the index is how the browser discovers runs.

export type Outcome =
  | "win"
  | "loss"
  | "push"      // tie — moneyline stake returned
  | "pending"   // game hasn't finished yet
  | "unknown";  // game finished but no score could be matched to the pick

export interface FinalScore {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
}

export interface PickResult {
  pickId: string;
  sport: Sport;
  matchup: string;
  pickLabel: string;
  tier: Tier;
  odds: number;
  startTime: string;
  outcome: Outcome;
  /** Present once the game is final and matched. */
  finalScore?: FinalScore;
  /** Flat 1 unit per pick, so runs are comparable regardless of tier staking. */
  unitsRisked: number;
  /** Profit in units: +payout on a win, −1 on a loss, 0 on push/pending. */
  unitsNet: number;
  /** Why a pick is pending/unknown, when it is. */
  note?: string;
}

export interface ResultsSummary {
  total: number;
  graded: number;   // win + loss + push
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  unknown: number;
  /** wins / (wins + losses) — null until at least one decided pick. */
  winRate: number | null;
  unitsRisked: number;
  unitsNet: number;
  /** unitsNet / unitsRisked — null until at least one decided pick. */
  roi: number | null;
}

export interface ResultsFile {
  /** Filename of the picks payload this graded, e.g. `picks-20260728T192019Z.json`. */
  picksFile: string;
  /** Slate date of those picks. */
  date: string;
  /** `generatedAt` copied from the picks payload. */
  picksGeneratedAt: string;
  gradedAt: string;
  summary: ResultsSummary;
  results: PickResult[];
}

/** Per-tier slice of the record, for spotting which tiers actually hit. */
export type TierBreakdown = Record<Tier, ResultsSummary>;

export interface HistoryRun {
  /** Compact UTC stamp shared by the picks and results filenames. */
  stamp: string;
  date: string;
  generatedAt: string;
  picksPath: string;              // "/picks/picks-<stamp>.json"
  resultsPath: string | null;     // "/results/results-<stamp>.json" once graded
  pickCount: number;
  tierCounts: Record<Tier, number>;
  summary: ResultsSummary | null;
}

export interface HistoryIndex {
  generatedAt: string;
  /** Newest run first. */
  runs: HistoryRun[];
  totals: ResultsSummary;
  byTier: TierBreakdown;
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

// ─── Bankroll simulation (Kelly staking, P&L ledger) ────────────────────────
//
// apps/web/public/bankroll.json is a persistent $500 virtual bankroll: every
// pick gets staked via Half Kelly (api/best-bets.ts), tracked here as a
// pending bet, then settled against real scores each morning
// (api/resolve-results.ts). See PickHistory.tsx for the ledger UI.

export type BetResult = "pending" | "win" | "loss" | "push" | "void";

export interface BankrollBet {
  betId: string;
  date: string;
  sport: Sport;
  matchup: string;
  pickLabel: string;
  odds: number;
  stakeAmount: number;
  potentialPayout: number;
  estimatedWinPct: number;
  impliedWinPct: number;
  evEdge: number;
  tier: Tier;
  scores: { composite: number };
  result: BetResult;
  /** Present once the bet is decided (null while pending). */
  profitLoss: number | null;
  /** Running bankroll balance right after this bet settled (null while pending). */
  bankrollAfter: number | null;
  resolvedAt: string | null;
}

export interface BankrollCalibration {
  /** Actual win rate per tier, from resolved bets. Null until calibration first runs. */
  eliteWinRate: number | null;
  strongWinRate: number | null;
  valueWinRate: number | null;
  /** Actual ROI per sport, from resolved bets. */
  mlbRoi: number | null;
  nflRoi: number | null;
  nhlRoi: number | null;
  /** Applied to the raw win-probability score before the composite is computed. */
  wpScoreMultiplier: number;
  /** Applied to the raw expected-value score before the composite is computed. */
  evScoreMultiplier: number;
  lastCalibrated: string | null;
  /** Count of resolved (non-pending) bets. Calibration only adjusts multipliers at 20+. */
  totalResultsTracked: number;
}

export interface BankrollFile {
  initialBankroll: number;
  currentBankroll: number;
  totalBets: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  totalStaked: number;
  totalProfit: number;
  roi: number;
  peakBankroll: number;
  lowestBankroll: number;
  calibration: BankrollCalibration;
  /** Chronological, oldest first — the order picks were placed in. */
  bets: BankrollBet[];
}
