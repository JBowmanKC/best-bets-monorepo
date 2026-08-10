// ─────────────────────────────────────────────────────────────────────────
// Self-contained Vercel serverless function. No Anthropic dependency, no
// import from ../packages/algorithm — every helper the four-factor model
// needs lives in this one file so it can be deployed and read in isolation.
//
// Data sources (all free, no key required except OddsAPI):
//   MLB schedule   — https://statsapi.mlb.com/api/v1/schedule
//   MLB standings  — https://statsapi.mlb.com/api/v1/standings
//   NFL/NHL games  — https://site.api.espn.com/apis/site/v2/sports/...
//   Moneylines     — https://api.the-odds-api.com/v4/sports/.../odds
//
// Environment variables:
//   ODDS_API_KEY — OddsAPI key (live moneylines). Games still generate
//   without it, using record-gap-estimated odds as a fallback.
// ─────────────────────────────────────────────────────────────────────────

const ODDS_API_KEY = process.env.ODDS_API_KEY;

type Sport = "mlb" | "nfl" | "nhl";
type Tier = "elite" | "strong" | "value";

interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  setHeader(name: string, value: string): ApiResponse;
  status(code: number): ApiResponse;
  json(body: unknown): void;
  end(): void;
}

interface TeamRecord {
  wins: number;
  losses: number;
  winPct: number;
}

interface GameOdds {
  homeMoneyline: number | null;
  awayMoneyline: number | null;
}

/** A scheduled game with team context, before live odds are attached. */
interface ScheduledGame {
  id: string;
  sport: Sport;
  homeTeam: string;
  awayTeam: string;
  /** MLB team ids (0 for ESPN-sourced NFL/NHL games, which never need prop roster/stat lookups). */
  homeTeamId: number;
  awayTeamId: number;
  startTime: string;
  venue: string;
  homeRecord: TeamRecord;
  awayRecord: TeamRecord;
  homeRecentForm: ("W" | "L")[];
  awayRecentForm: ("W" | "L")[];
  homeSeriesWins: number;
  awaySeriesWins: number;
  notes: string;
}

/** A scheduled game with a moneyline (live or estimated) attached. */
type RawGame = ScheduledGame & { odds: GameOdds };

interface FactorScores {
  winProbability: number;
  expectedValue: number;
  momentum: number;
  context: number;
  composite: number;
}

interface BetPick {
  id: string;
  sport: Sport;
  matchup: string;
  betType: string;
  pickLabel: string;
  odds: number;
  estimatedWinPct: number;
  impliedWinPct: number;
  evEdge: number;
  tier: Tier;
  scores: FactorScores;
  startTime: string;
  rationale: string;
  stake: string;
  isPositiveEV: boolean;
  stakeAmount: number;
  potentialPayout: number;
}

/** Shape read back from the bankroll ledger (see apps/web/public/bankroll.json). */
interface CalibrationMultipliers {
  wpScoreMultiplier: number;
  evScoreMultiplier: number;
}

interface BankrollState {
  currentBankroll: number;
  calibration: CalibrationMultipliers;
}

const DEFAULT_BANKROLL_STATE: BankrollState = {
  currentBankroll: 500,
  calibration: { wpScoreMultiplier: 1, evScoreMultiplier: 1 },
};

interface ParlayLeg {
  pickId: string;
  matchup: string;
  pickLabel: string;
  sport: Sport;
  odds: number;
  startTime: string;
  /** Prop legs only — a prop leg can't be graded later without knowing what it's actually betting on. */
  propType?: PropType;
  playerName?: string;
  line?: number;
  recommendedSide?: PropSide;
}

interface Parlay {
  id: "safe" | "value" | "shot";
  label: string;
  emoji: string;
  legs: ParlayLeg[];
  estimatedPayout: number;
  combinedWinPct: number;
  recommendedStake: string;
  /** Dollar stake/payout for a committed daily parlay (safeParlay/highOddsParlay). Absent on the reference-only allParlays entries. */
  stakeAmount?: number;
  potentialPayout?: number;
}

interface SportStatus {
  sport: string;
  label: string;
  active: boolean;
  note: string;
}

interface DailySummary {
  totalBetsPlaced: number;
  totalStaked: number;
  totalPotentialPayout: number;
  bankrollAtRisk: number; // fraction, e.g. 0.14 = 14%
  highestConfidencePick: string;
}

interface BestBetsResponse {
  date: string;
  generatedAt: string;
  cached: boolean;
  sportStatuses: SportStatus[];

  // Top 10 by composite score alone, across picks + props — "Today's Analysis" in the UI.
  shortlist: (BetPick | PropPick)[];

  // The (up to) 5 committed bets for today, drawn from the shortlist above.
  bestBets: (BetPick | PropPick)[]; // up to 3 singles
  safeParlay: Parlay;
  highOddsParlay: Parlay;

  // Full analysis pool — scored in full, shown for transparency, not bet on.
  allPicks: BetPick[];
  allPropPicks: PropPick[];
  allParlays: Parlay[];

  summary: DailySummary;
}

// ─── Prop bets (MLB only — see fetchProbablePitchers/fetchPitcherGameLog/
// fetchBatterGameLog/fetchMLBRosterBatters below; NFL/NHL prop types exist
// in the union for future extension but have no fetcher/scorer yet) ────────
type PropType =
  | "pitcher_strikeouts"
  | "pitcher_outs"
  | "batter_hits"
  | "batter_total_bases"
  | "batter_home_runs"
  | "player_pass_yards"
  | "player_rush_yards"
  | "player_receiving_yards"
  | "player_shots_on_goal";

type PropSide = "over" | "under";
type VoidRisk = "low" | "medium" | "high";

interface PropFactorScores {
  hitRate: number;
  expectedValue: number;
  matchupQuality: number;
  context: number;
  composite: number;
}

interface PropPick {
  id: string;
  sport: Sport;
  playerName: string;
  team: string;
  matchup: string;
  gameId: string;
  propType: PropType;
  line: number;
  recommendedSide: PropSide;
  odds: number;
  overOdds: number | null;
  underOdds: number | null;
  hitRateLast10: number;
  hitRateLast20: number;
  recentAverage: number;
  estimatedHitPct: number;
  impliedHitPct: number;
  evEdge: number;
  tier: Tier;
  scores: PropFactorScores;
  startTime: string;
  rationale: string;
  stakeAmount: number;
  potentialPayout: number;
  voidRisk: VoidRisk;
  isPositiveEV: boolean;
}

const PROP_TYPE_LABELS: Record<PropType, string> = {
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

const TOP_GAMES_FOR_PROPS = 5;

// ─── Algorithm config (weights/thresholds must not change) ─────────────────
const FACTOR_WEIGHTS = {
  winProbability: 0.35,
  expectedValue: 0.35,
  momentum: 0.20,
  context: 0.10,
} as const;

const TIER_THRESHOLDS = { elite: 80, strong: 65, value: 50 } as const;

const STAKE_BY_TIER: Record<Tier, string> = {
  elite: "2–3 units",
  strong: "1–2 units",
  value: "0.5–1 unit",
};

const SPORT_LABELS: Record<Sport, string> = {
  mlb: "⚾ MLB",
  nfl: "🏈 NFL",
  nhl: "🏒 NHL",
};

const ODDS_SPORT_KEYS: Record<Sport, string> = {
  mlb: "baseball_mlb",
  nfl: "americanfootball_nfl",
  nhl: "icehockey_nhl",
};

// ─── Odds math ───────────────────────────────────────────────────────────────
function oddsToImpliedProb(americanOdds: number): number {
  if (americanOdds > 0) return 100 / (americanOdds + 100);
  return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
}

function probToAmericanOdds(prob: number): number {
  const p = Math.min(Math.max(prob, 0.01), 0.99);
  if (p >= 0.5) return Math.round((-100 * p) / (1 - p));
  return Math.round((100 * (1 - p)) / p);
}

/** Half Kelly stake sizing: min $2, max 15% of bankroll, rounded to the nearest $0.50. */
function kellyStake(
  bankroll: number,
  estimatedWinPct: number,
  odds: number,
  kellyFraction: number = 0.5
): number {
  const b = odds > 0 ? odds / 100 : 100 / Math.abs(odds); // decimal profit per $1
  const p = estimatedWinPct;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  const fraction = Math.max(0, kelly) * kellyFraction;
  const raw = bankroll * fraction;
  return Math.round(Math.min(Math.max(raw, 2), bankroll * 0.15) * 2) / 2;
}

function recordGapToWinProb(
  favRecord: TeamRecord,
  dogRecord: TeamRecord,
  isFavHome: boolean
): number {
  const pct = (r: TeamRecord) => (r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : 0.5);
  const gap = pct(favRecord) - pct(dogRecord);
  let prob = 0.5 + gap * 0.8;
  if (isFavHome) prob += 0.04;
  return Math.min(Math.max(prob, 0.3), 0.82);
}

// ─── Four-factor scorer (ported unchanged from the previous algorithm) ─────
function scoreWinProbability(game: RawGame, pickHome: boolean): number {
  const favRecord = pickHome ? game.homeRecord : game.awayRecord;
  const dogRecord = pickHome ? game.awayRecord : game.homeRecord;
  const prob = recordGapToWinProb(favRecord, dogRecord, pickHome);
  return Math.round(((prob - 0.3) / 0.52) * 100);
}

function scoreExpectedValue(estimatedWinPct: number, impliedWinPct: number) {
  const evEdge = estimatedWinPct - impliedWinPct;
  const score = Math.round(((evEdge + 0.10) / 0.25) * 100);
  return { score: Math.min(Math.max(score, 0), 100), evEdge };
}

function scoreMomentum(game: RawGame, pickHome: boolean): number {
  const recentForm = pickHome ? game.homeRecentForm : game.awayRecentForm;
  const seriesWins = pickHome ? game.homeSeriesWins : game.awaySeriesWins;
  const oppSeriesWins = pickHome ? game.awaySeriesWins : game.homeSeriesWins;

  const formWeights = [0.35, 0.25, 0.20, 0.12, 0.08];
  const formScore = recentForm.reduce(
    (acc, result, i) => acc + (result === "W" ? formWeights[i] : 0),
    0
  );

  const seriesScore = seriesWins > oppSeriesWins ? 1.0 : seriesWins === oppSeriesWins ? 0.5 : 0.1;
  return Math.round((formScore * 0.6 + seriesScore * 0.4) * 100);
}

function scoreContext(game: RawGame, pickHome: boolean): number {
  let score = 50;
  if (pickHome) score += 20;

  const notes = (game.notes || "").toLowerCase();
  if (notes.includes("playoff") || notes.includes("finals")) score += 15;
  if (notes.includes("revenge") || notes.includes("rivalry")) score += 10;
  if (notes.includes("rest")) score += 5;
  if (notes.includes("travel") || notes.includes("road trip")) score -= 5;
  if (notes.includes("doubleheader g2")) score -= 5;

  return Math.min(Math.max(score, 0), 100);
}

function composite(scores: Omit<FactorScores, "composite">): number {
  return Math.round(
    scores.winProbability * FACTOR_WEIGHTS.winProbability +
    scores.expectedValue * FACTOR_WEIGHTS.expectedValue +
    scores.momentum * FACTOR_WEIGHTS.momentum +
    scores.context * FACTOR_WEIGHTS.context
  );
}

function getTier(score: number): Tier | null {
  if (score >= TIER_THRESHOLDS.elite) return "elite";
  if (score >= TIER_THRESHOLDS.strong) return "strong";
  if (score >= TIER_THRESHOLDS.value) return "value";
  return null;
}

function buildRationale(game: RawGame, pickHome: boolean, winPct: number, evEdge: number): string {
  const team = pickHome ? game.homeTeam : game.awayTeam;
  const oppTeam = pickHome ? game.awayTeam : game.homeTeam;
  const teamRec = pickHome ? game.homeRecord : game.awayRecord;
  const oppRec = pickHome ? game.awayRecord : game.homeRecord;
  const recDiff = (teamRec.wins - teamRec.losses) - (oppRec.wins - oppRec.losses);
  const form = pickHome ? game.homeRecentForm : game.awayRecentForm;
  const winsLast5 = form.filter(r => r === "W").length;
  const homeStr = pickHome ? "at home" : "on the road";

  return [
    `${team} (${teamRec.wins}-${teamRec.losses}) vs ${oppTeam} (${oppRec.wins}-${oppRec.losses}).`,
    recDiff > 0
      ? `${team} is ${recDiff} games better on the season.`
      : `Slim record edge — value play.`,
    `Won ${winsLast5} of last 5 games ${homeStr}.`,
    `Algorithm win probability: ${Math.round(winPct * 100)}% vs implied ${Math.round((winPct - evEdge) * 100)}% — +${Math.round(evEdge * 100)}% positive EV edge.`,
  ].join(" ");
}

// ─── Narrative explanations (Claude Haiku, best-effort) ─────────────────────
//
// Replaces the template rationale with a short, model-written explanation.
// ANTHROPIC_API_KEY is optional: every call site below falls back to the
// existing template string (buildRationale's output, already attached to
// the pick) whenever the key is unset, the request fails, or the response
// is empty — a Haiku outage never blocks or degrades pick generation.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function callHaikuExplanation(prompt: string, fallback: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) return fallback;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 180,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) return fallback;
    const data: any = await res.json();
    const text = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
    return text.trim() || fallback;
  } catch {
    return fallback; // always fall back gracefully
  }
}

function buildExplanationPrompt(pick: BetPick, game: RawGame): string {
  const pickHome = pick.betType.includes("Home");
  const ourRec = pickHome ? game.homeRecord : game.awayRecord;
  const oppRec = pickHome ? game.awayRecord : game.homeRecord;
  const ourForm = pickHome ? game.homeRecentForm : game.awayRecentForm;
  const oppForm = pickHome ? game.awayRecentForm : game.homeRecentForm;
  const winsL5 = ourForm.filter(r => r === "W").length;
  const oppWinsL5 = oppForm.filter(r => r === "W").length;
  const seriesW = pickHome ? game.homeSeriesWins : game.awaySeriesWins;
  const oppSeriesW = pickHome ? game.awaySeriesWins : game.homeSeriesWins;
  const isPlus = pick.odds > 0;

  return `Write a 3-4 sentence sports betting explanation for this pick.
Be specific, analytical, and confident. Explain WHY this bet has edge.
No bullet points, no headers, plain paragraph text only.

Pick: ${pick.pickLabel} (${isPlus ? "+" : ""}${pick.odds})
Sport: ${pick.sport.toUpperCase()}
Our team record: ${ourRec.wins}-${ourRec.losses}
Opponent record: ${oppRec.wins}-${oppRec.losses}
Record gap: ${Math.abs((ourRec.wins - ourRec.losses) - (oppRec.wins - oppRec.losses))} games ${ourRec.winPct > oppRec.winPct ? "in our favour" : "against us — value play"}
Our recent form: ${winsL5} wins in last 5 games
Opponent recent form: ${oppWinsL5} wins in last 5 games
Series record: ${seriesW}-${oppSeriesW} in current series
Algorithm score: ${pick.scores.composite}/100 (${pick.tier.toUpperCase()} tier)
Win probability: ${Math.round(pick.estimatedWinPct * 100)}% vs implied ${Math.round(pick.impliedWinPct * 100)}%
EV edge: +${Math.round(pick.evEdge * 100)}%
Kelly stake: $${pick.stakeAmount} recommended
${isPlus ? "Note: Getting PLUS money on the better team — significant value." : ""}
${seriesW > oppSeriesW ? "Note: Carry series momentum." : ""}
Venue: ${game.venue}`;
}

async function generateExplanation(pick: BetPick, game: RawGame): Promise<string> {
  return callHaikuExplanation(buildExplanationPrompt(pick, game), pick.rationale);
}

function buildPropExplanationPrompt(prop: PropPick): string {
  const sideLabel = prop.recommendedSide === "over" ? "Over" : "Under";
  return `Write a 3-4 sentence explanation for this player prop bet.
Explain the hit rate trend, matchup angle, and EV edge.
Plain paragraph text only, no bullets.

Player: ${prop.playerName} (${prop.team})
Prop: ${sideLabel} ${prop.line} ${PROP_TYPE_LABELS[prop.propType]}
Odds: ${prop.odds > 0 ? "+" : ""}${prop.odds}
Hit rate last 10 games: ${Math.round(prop.hitRateLast10 * 10)}/10
Hit rate last 20 games: ${Math.round(prop.hitRateLast20 * 20)}/20
Recent average: ${prop.recentAverage}
Matchup context: ${prop.rationale}
EV edge: +${Math.round(prop.evEdge * 100)}%
Void risk: ${prop.voidRisk}`;
}

async function generatePropExplanation(prop: PropPick): Promise<string> {
  return callHaikuExplanation(buildPropExplanationPrompt(prop), prop.rationale);
}

function scoreGame(game: RawGame, bankrollState: BankrollState): BetPick[] {
  const picks: BetPick[] = [];

  for (const pickHome of [true, false]) {
    const odds = pickHome ? game.odds.homeMoneyline : game.odds.awayMoneyline;
    if (odds === null || odds === undefined) continue;

    const impliedWinPct = oddsToImpliedProb(odds);
    // Self-calibration: past results nudge these two factors before they feed
    // into the estimated win probability and composite score (see calibration
    // block in api/resolve-results.ts).
    const wpScore = Math.min(
      Math.max(Math.round(scoreWinProbability(game, pickHome) * bankrollState.calibration.wpScoreMultiplier), 0),
      100
    );
    const estimatedWinPct = 0.3 + (wpScore / 100) * 0.52;

    const rawEv = scoreExpectedValue(estimatedWinPct, impliedWinPct);
    const evEdge = rawEv.evEdge;
    if (evEdge <= 0) continue; // only positive EV picks survive
    const evScore = Math.min(Math.max(Math.round(rawEv.score * bankrollState.calibration.evScoreMultiplier), 0), 100);

    const momScore = scoreMomentum(game, pickHome);
    const ctxScore = scoreContext(game, pickHome);

    const factorScores: FactorScores = {
      winProbability: wpScore,
      expectedValue: evScore,
      momentum: momScore,
      context: ctxScore,
      composite: 0,
    };
    factorScores.composite = composite(factorScores);

    const tier = getTier(factorScores.composite);
    if (!tier) continue;

    const team = pickHome ? game.homeTeam : game.awayTeam;
    const direction = pickHome ? "Home Win" : "Away Win";

    const stakeAmount = kellyStake(bankrollState.currentBankroll, estimatedWinPct, odds);
    const potentialPayout = Math.round(
      (odds > 0 ? stakeAmount + (stakeAmount * odds) / 100 : stakeAmount + (stakeAmount * 100) / Math.abs(odds)) * 100
    ) / 100;

    picks.push({
      id: `${game.id}-${pickHome ? "home" : "away"}`,
      sport: game.sport,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      betType: `Moneyline — ${direction}`,
      pickLabel: `${team} ML`,
      odds,
      estimatedWinPct: Math.round(estimatedWinPct * 1000) / 1000,
      impliedWinPct: Math.round(impliedWinPct * 1000) / 1000,
      evEdge: Math.round(evEdge * 1000) / 1000,
      tier,
      scores: factorScores,
      startTime: game.startTime,
      rationale: buildRationale(game, pickHome, estimatedWinPct, evEdge),
      stake: STAKE_BY_TIER[tier],
      isPositiveEV: true,
      stakeAmount,
      potentialPayout,
    });
  }

  if (picks.length === 0) return [];
  picks.sort((a, b) => b.scores.composite - a.scores.composite);
  return [picks[0]]; // best side per game only
}

function scoreAllGames(games: RawGame[], bankrollState: BankrollState): BetPick[] {
  const allPicks = games.flatMap(game => scoreGame(game, bankrollState));
  const tierOrder: Record<Tier, number> = { elite: 3, strong: 2, value: 1 };
  allPicks.sort((a, b) => {
    const tierDiff = tierOrder[b.tier] - tierOrder[a.tier];
    if (tierDiff !== 0) return tierDiff;
    return b.scores.composite - a.scores.composite;
  });
  return allPicks;
}

function calcParlayPayout(odds: number[]): number {
  const decimalProduct = odds.reduce((acc, o) => {
    const decimal = o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
    return acc * decimal;
  }, 1);
  return Math.round((decimalProduct - 1) * 100);
}

// ─── Custom parlay builder (moneylines + props) ─────────────────────────────
interface ParlayOptions {
  legs: number;
  riskLevel: "safe" | "standard" | "risky" | "custom";
  includeProps: boolean;
  sports?: Sport[];
}

const MAX_PROPS_PER_PARLAY = 2;

interface ParlayCandidate {
  isProp: boolean;
  tier: Tier;
  composite: number;
  winPct: number;
  odds: number;
  sport: Sport;
  voidRisk: VoidRisk | null;
  leg: ParlayLeg;
}

function propLegLabel(p: PropPick): string {
  const side = p.recommendedSide === "over" ? "Over" : "Under";
  return `${p.playerName} ${side} ${p.line} ${PROP_TYPE_LABELS[p.propType]}`;
}

function pickCandidates(picks: BetPick[]): ParlayCandidate[] {
  return picks.map(p => ({
    isProp: false,
    tier: p.tier,
    composite: p.scores.composite,
    winPct: p.estimatedWinPct,
    odds: p.odds,
    sport: p.sport,
    voidRisk: null,
    leg: { pickId: p.id, matchup: p.matchup, pickLabel: p.pickLabel, sport: p.sport, odds: p.odds, startTime: p.startTime },
  }));
}

function propCandidates(props: PropPick[]): ParlayCandidate[] {
  return props.map(p => ({
    isProp: true,
    tier: p.tier,
    composite: p.scores.composite,
    winPct: p.estimatedHitPct,
    odds: p.odds,
    sport: p.sport,
    voidRisk: p.voidRisk,
    leg: { pickId: p.id, matchup: p.matchup, pickLabel: propLegLabel(p), sport: p.sport, odds: p.odds, startTime: p.startTime },
  }));
}

/**
 * The reusable selection engine behind buildCustomParlay: filters candidates
 * by risk level and sport, then greedily fills legs — highest-composite
 * moneylines first, then highest-composite props up to the per-risk-level cap.
 * A high-voidRisk prop is never eligible, at any risk level.
 */
function selectParlayLegs(picks: BetPick[], propPicks: PropPick[], options: ParlayOptions): ParlayCandidate[] {
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

  const legs: ParlayCandidate[] = [];
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

  return legs.sort((a, b) => b.composite - a.composite);
}

function presentationFor(options: ParlayOptions): { id: Parlay["id"]; label: string; emoji: string; recommendedStake: string } {
  if (options.riskLevel === "safe") return { id: "safe", label: "Safety Parlay", emoji: "💚", recommendedStake: "1–2 units" };
  if (options.riskLevel === "risky") return { id: "shot", label: "Shot Parlay", emoji: "🚀", recommendedStake: "0.25 units" };
  return { id: "value", label: "Value Parlay", emoji: "💎", recommendedStake: "0.5 units" };
}

function buildCustomParlay(picks: BetPick[], propPicks: PropPick[], options: ParlayOptions): Parlay | null {
  const legs = selectParlayLegs(picks, propPicks, options);
  if (legs.length < 2) return null;

  const brand = presentationFor(options);
  return {
    id: brand.id,
    label: brand.label,
    emoji: brand.emoji,
    legs: legs.map(l => l.leg),
    estimatedPayout: calcParlayPayout(legs.map(l => l.odds)),
    combinedWinPct: Math.round(legs.reduce((acc, l) => acc * l.winPct, 1) * 100) / 100,
    recommendedStake: brand.recommendedStake,
  };
}

/** The three default parlays shown on the dashboard — safe/value/shot, now built through buildCustomParlay's risk-level rules. */
function buildDefaultParlays(picks: BetPick[], propPicks: PropPick[]): Parlay[] {
  const safe = buildCustomParlay(picks, propPicks, { legs: 3, riskLevel: "safe", includeProps: false });
  const value = buildCustomParlay(picks, propPicks, { legs: 4, riskLevel: "standard", includeProps: true });
  const shot = buildCustomParlay(picks, propPicks, { legs: 5, riskLevel: "risky", includeProps: true });
  return [safe, value, shot].filter((p): p is Parlay => p !== null);
}

// ─── Daily bet selection — 3 singles + 2 committed parlays ──────────────────
//
// The algorithm still scores every game and prop (scoreAllGames/buildPropPicks
// run unchanged, in full, before any of this). selectDailyBets() only decides
// which of those already-scored picks the bankroll actually gets committed to.

const MAX_DAILY_RISK_PCT = 0.20;
const MAX_SINGLE_BET_PCT = 0.08;

function isPropPick(x: BetPick | PropPick): x is PropPick {
  return "playerName" in x;
}

function toParlayLeg(item: BetPick | PropPick): ParlayLeg {
  return isPropPick(item)
    ? {
        pickId: item.id, matchup: item.matchup, pickLabel: propLegLabel(item), sport: item.sport,
        odds: item.odds, startTime: item.startTime,
        propType: item.propType, playerName: item.playerName, line: item.line, recommendedSide: item.recommendedSide,
      }
    : { pickId: item.id, matchup: item.matchup, pickLabel: item.pickLabel, sport: item.sport, odds: item.odds, startTime: item.startTime };
}

/** Top 10 across picks + props by composite score alone — no other filtering. Shown in the UI as "Today's Analysis". */
function buildShortlist(picks: BetPick[], propPicks: PropPick[]): (BetPick | PropPick)[] {
  const pool: (BetPick | PropPick)[] = [...picks, ...propPicks];
  pool.sort((a, b) => b.scores.composite - a.scores.composite);
  return pool.slice(0, 10);
}

/** Top 3 committed bets, chosen from the 10-item shortlist only: composite >= 68, positive EV, sane odds/prop-risk window, sorted by EV edge descending. */
function selectBestBets(shortlist: (BetPick | PropPick)[]): (BetPick | PropPick)[] {
  const qualified = shortlist.filter(item => {
    if (item.scores.composite < 68) return false;
    if (item.evEdge <= 0) return false;
    if (isPropPick(item)) {
      return (item.voidRisk === "low" || item.voidRisk === "medium") && item.hitRateLast10 >= 0.6;
    }
    return item.odds >= -250 && item.odds <= 300;
  });

  qualified.sort((a, b) => b.evEdge - a.evEdge);

  if (qualified.length === 0) console.warn("No qualifying picks today");
  return qualified.slice(0, 3);
}

/** 2-3 elite/strong moneyline legs, preferring picks not already used as a best bet. */
function selectSafeParlayLegs(picks: BetPick[], excludeIds: Set<string>): BetPick[] {
  const eligible = picks.filter(p => (p.tier === "elite" || p.tier === "strong") && p.odds >= -200 && p.odds <= 150);
  if (eligible.length === 0) return [];

  const targetLegs = eligible.length < 3 ? Math.min(2, eligible.length) : 3;
  const byComposite = (a: BetPick, b: BetPick) => b.scores.composite - a.scores.composite;

  const nonOverlap = eligible.filter(p => !excludeIds.has(p.id)).sort(byComposite);
  const pool = nonOverlap.length >= targetLegs ? nonOverlap : [...eligible].sort(byComposite);

  let legs = pool.slice(0, targetLegs);
  // Combined payout target +150 to +450 — if it runs past +500, drop the lowest-scoring leg.
  while (legs.length > 2 && calcParlayPayout(legs.map(l => l.odds)) > 500) {
    legs = legs.slice(0, -1);
  }
  return legs;
}

/** 4-5 legs (moneylines + up to 2 low-void-risk props), highest EV edge first, with payout adjustment. */
function selectHighOddsParlayLegs(picks: BetPick[], propPicks: PropPick[]): (BetPick | PropPick)[] {
  const pickPool = picks.filter(p => p.odds >= -300 && p.odds <= 250);
  const propPool = propPicks.filter(p => p.voidRisk === "low" && p.odds >= -300 && p.odds <= 250);
  const combined: (BetPick | PropPick)[] = [...pickPool, ...propPool].sort((a, b) => b.evEdge - a.evEdge);
  if (combined.length === 0) return [];

  const targetLegs = combined.length >= 5 ? 5 : Math.min(4, combined.length);

  const legs: (BetPick | PropPick)[] = [];
  const usedIds = new Set<string>();
  let propCount = 0;
  for (const c of combined) {
    if (legs.length >= targetLegs) break;
    if (isPropPick(c) && propCount >= 2) continue;
    legs.push(c);
    usedIds.add(c.id);
    if (isPropPick(c)) propCount += 1;
  }

  // Payout target +400 to +3000 — top up if short, trim the longest shot if it runs past +3000.
  let payout = calcParlayPayout(legs.map(l => l.odds));
  while (payout < 400 && legs.length < combined.length) {
    const next = combined.find(c => !usedIds.has(c.id) && (!isPropPick(c) || propCount < 2));
    if (!next) break;
    legs.push(next);
    usedIds.add(next.id);
    if (isPropPick(next)) propCount += 1;
    payout = calcParlayPayout(legs.map(l => l.odds));
  }

  while (payout > 3000 && legs.length > 0) {
    let longestShotIdx = 0;
    for (let i = 1; i < legs.length; i++) {
      if (legs[i].odds > legs[longestShotIdx].odds) longestShotIdx = i;
    }
    const removed = legs[longestShotIdx];
    const replacement = combined.find(c =>
      !usedIds.has(c.id) && c.id !== removed.id &&
      (!isPropPick(c) || propCount - (isPropPick(removed) ? 1 : 0) < 2)
    );

    legs.splice(longestShotIdx, 1);
    usedIds.delete(removed.id);
    if (isPropPick(removed)) propCount -= 1;
    if (!replacement) break; // nothing safer left — accept the payout as-is
    legs.push(replacement);
    usedIds.add(replacement.id);
    if (isPropPick(replacement)) propCount += 1;
    payout = calcParlayPayout(legs.map(l => l.odds));
  }

  return legs;
}

interface ParlayStakeInfo {
  stakeAmount: number;
  potentialPayout: number;
  combinedOdds: number;
  combinedWinPct: number;
}

function computeParlayStake(legs: (BetPick | PropPick)[], bankroll: number, kellyMultiplier: number = 1): ParlayStakeInfo {
  if (legs.length === 0) return { stakeAmount: 0, potentialPayout: 0, combinedOdds: 0, combinedWinPct: 0 };

  const combinedOdds = calcParlayPayout(legs.map(l => l.odds));
  const combinedWinPct = legs.reduce((acc, l) => acc * (isPropPick(l) ? l.estimatedHitPct : l.estimatedWinPct), 1);
  const rawStake = kellyStake(bankroll, combinedWinPct, combinedOdds);
  const stakeAmount = Math.round(rawStake * kellyMultiplier * 2) / 2;
  const potentialPayout = Math.round((stakeAmount + (stakeAmount * combinedOdds) / 100) * 100) / 100;

  return { stakeAmount, potentialPayout, combinedOdds, combinedWinPct };
}

function buildCommittedParlay(
  legs: (BetPick | PropPick)[], stakeInfo: ParlayStakeInfo,
  brand: { id: Parlay["id"]; label: string; emoji: string }
): Parlay {
  return {
    id: brand.id,
    label: brand.label,
    emoji: brand.emoji,
    legs: legs.map(toParlayLeg),
    estimatedPayout: stakeInfo.combinedOdds,
    combinedWinPct: Math.round(stakeInfo.combinedWinPct * 10000) / 10000,
    recommendedStake: `$${stakeInfo.stakeAmount.toFixed(2)}`,
    stakeAmount: stakeInfo.stakeAmount,
    potentialPayout: stakeInfo.potentialPayout,
  };
}

/** Recomputes potentialPayout for a single at a new stakeAmount, same formula used at scoring time. */
function payoutAt(odds: number, stakeAmount: number): number {
  return Math.round((odds > 0 ? stakeAmount + (stakeAmount * odds) / 100 : stakeAmount + (stakeAmount * 100) / Math.abs(odds)) * 100) / 100;
}

/**
 * Caps each bet at 8% of bankroll, then scales all five bets proportionally
 * down (never up) so the combined total never exceeds 20% of bankroll.
 */
function enforceDailyBudget(
  bestBets: (BetPick | PropPick)[], safeParlay: Parlay, highOddsParlay: Parlay, bankroll: number
): { bestBets: (BetPick | PropPick)[]; safeParlay: Parlay; highOddsParlay: Parlay; totalDailyStake: number } {
  const maxSingle = bankroll * MAX_SINGLE_BET_PCT;
  const cap = (n: number) => Math.min(n, maxSingle);

  const cappedBestBets = bestBets.map(b => cap(b.stakeAmount));
  const cappedSafe = cap(safeParlay.stakeAmount ?? 0);
  const cappedHigh = cap(highOddsParlay.stakeAmount ?? 0);

  const total = cappedBestBets.reduce((a, b) => a + b, 0) + cappedSafe + cappedHigh;
  const maxTotal = bankroll * MAX_DAILY_RISK_PCT;
  const scale = total > maxTotal && total > 0 ? maxTotal / total : 1;

  const round2 = (n: number) => Math.round(n * 2) / 2;

  const finalBestBets = bestBets.map((b, i) => {
    const stakeAmount = round2(cappedBestBets[i] * scale);
    return { ...b, stakeAmount, potentialPayout: payoutAt(b.odds, stakeAmount) };
  });

  const safeStake = round2(cappedSafe * scale);
  const finalSafeParlay: Parlay = {
    ...safeParlay,
    stakeAmount: safeStake,
    potentialPayout: payoutAt(safeParlay.estimatedPayout, safeStake),
    recommendedStake: `$${safeStake.toFixed(2)}`,
  };

  const highStake = round2(cappedHigh * scale);
  const finalHighOddsParlay: Parlay = {
    ...highOddsParlay,
    stakeAmount: highStake,
    potentialPayout: payoutAt(highOddsParlay.estimatedPayout, highStake),
    recommendedStake: `$${highStake.toFixed(2)}`,
  };

  const totalDailyStake = Math.round(
    (finalBestBets.reduce((a, b) => a + b.stakeAmount, 0) + safeStake + highStake) * 100
  ) / 100;

  return { bestBets: finalBestBets, safeParlay: finalSafeParlay, highOddsParlay: finalHighOddsParlay, totalDailyStake };
}

interface DailyBetsResult {
  shortlist: (BetPick | PropPick)[];
  bestBets: (BetPick | PropPick)[];
  safeParlay: Parlay;
  highOddsParlay: Parlay;
  totalDailyStake: number;
}

/** An empty stand-in Parlay for when too few legs qualify — keeps the response shape non-null. */
function emptyParlay(id: Parlay["id"], label: string, emoji: string): Parlay {
  return {
    id, label, emoji, legs: [], estimatedPayout: 0, combinedWinPct: 0,
    recommendedStake: "$0.00", stakeAmount: 0, potentialPayout: 0,
  };
}

function selectDailyBets(allPicks: BetPick[], allPropPicks: PropPick[], bankroll: number): DailyBetsResult {
  const shortlist = buildShortlist(allPicks, allPropPicks);
  const shortlistPicks = shortlist.filter((item): item is BetPick => !isPropPick(item));
  const shortlistProps = shortlist.filter(isPropPick);

  const bestBets = selectBestBets(shortlist);
  const bestBetIds = new Set(bestBets.map(b => b.id));

  const safeLegs = selectSafeParlayLegs(shortlistPicks, bestBetIds);
  const highLegs = selectHighOddsParlayLegs(shortlistPicks, shortlistProps);

  const safeParlay = safeLegs.length >= 2
    ? buildCommittedParlay(safeLegs, computeParlayStake(safeLegs, bankroll, 1), { id: "safe", label: "💚 Safe Parlay", emoji: "💚" })
    : emptyParlay("safe", "💚 Safe Parlay", "💚");

  // Higher variance (4-5 legs) — stake at 0.4x the full Kelly recommendation.
  const highOddsParlay = highLegs.length >= 2
    ? buildCommittedParlay(highLegs, computeParlayStake(highLegs, bankroll, 0.4), { id: "shot", label: "🚀 High Odds Parlay", emoji: "🚀" })
    : emptyParlay("shot", "🚀 High Odds Parlay", "🚀");

  return { shortlist, ...enforceDailyBudget(bestBets, safeParlay, highOddsParlay, bankroll) };
}

// ─── Data sources ────────────────────────────────────────────────────────────
function normalizeTeamName(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Reads the live bankroll ledger for stake sizing and calibration.
 *
 * Vercel functions have a read-only, ephemeral filesystem, so this can't just
 * `fs.readFileSync` the repo copy — instead it fetches the same file the
 * browser gets, from this deployment's own static output. Falls back to the
 * $500 starting bankroll and neutral (1.0) multipliers whenever the file
 * doesn't exist yet (first run) or the fetch fails for any reason.
 */
async function fetchBankrollState(): Promise<BankrollState> {
  const host = process.env.VERCEL_URL;
  if (!host) return DEFAULT_BANKROLL_STATE;

  try {
    const data = await fetchJson(`https://${host}/bankroll.json`);
    const currentBankroll = typeof data?.currentBankroll === "number" ? data.currentBankroll : 500;
    const wpScoreMultiplier = typeof data?.calibration?.wpScoreMultiplier === "number" ? data.calibration.wpScoreMultiplier : 1;
    const evScoreMultiplier = typeof data?.calibration?.evScoreMultiplier === "number" ? data.calibration.evScoreMultiplier : 1;
    return { currentBankroll, calibration: { wpScoreMultiplier, evScoreMultiplier } };
  } catch (e) {
    console.warn("bankroll.json fetch failed, using default $500 bankroll:", e);
    return DEFAULT_BANKROLL_STATE;
  }
}

function streakToForm(streakCode: string | undefined): ("W" | "L")[] {
  if (!streakCode || streakCode.length < 2) return [];
  const letter: "W" | "L" = streakCode[0] === "W" ? "W" : "L";
  const count = Math.min(parseInt(streakCode.slice(1), 10) || 0, 5);
  return Array(count).fill(letter);
}

interface SportResult {
  games: ScheduledGame[];
  status: SportStatus;
}

async function fetchMlbGames(date: string): Promise<SportResult> {
  const label = SPORT_LABELS.mlb;

  try {
    const scheduleUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=team,venue,linescore`;
    const schedule = await fetchJson(scheduleUrl);
    const rawGames: any[] = (schedule.dates ?? []).flatMap((d: any) => d.games ?? []);
    const upcoming = rawGames.filter(g => g.status?.abstractGameState === "Preview");

    if (upcoming.length === 0) {
      return {
        games: [],
        status: { sport: "mlb", label, active: false, note: "No upcoming MLB games today (off-season or slate complete)." },
      };
    }

    // Standings give current-season streaks for the momentum factor; best-effort.
    const year = date.slice(0, 4);
    const streakByTeamId = new Map<number, string | undefined>();
    try {
      const standingsUrl = `https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${year}&standingsTypes=regularSeason`;
      const standings = await fetchJson(standingsUrl);
      for (const record of standings.records ?? []) {
        for (const tr of record.teamRecords ?? []) {
          streakByTeamId.set(tr.team?.id, tr.streak?.streakCode);
        }
      }
    } catch (e) {
      console.warn("MLB standings fetch failed, continuing without streak data:", e);
    }

    const games: ScheduledGame[] = upcoming.map(g => {
      const home = g.teams?.home;
      const away = g.teams?.away;
      const homeWins = home?.leagueRecord?.wins ?? 0;
      const homeLosses = home?.leagueRecord?.losses ?? 0;
      const awayWins = away?.leagueRecord?.wins ?? 0;
      const awayLosses = away?.leagueRecord?.losses ?? 0;

      return {
        id: String(g.gamePk),
        sport: "mlb",
        homeTeam: home?.team?.name ?? "Home",
        awayTeam: away?.team?.name ?? "Away",
        homeTeamId: home?.team?.id ?? 0,
        awayTeamId: away?.team?.id ?? 0,
        startTime: g.gameDate,
        venue: g.venue?.name ?? "",
        homeRecord: {
          wins: homeWins, losses: homeLosses,
          winPct: homeWins + homeLosses > 0 ? homeWins / (homeWins + homeLosses) : 0.5,
        },
        awayRecord: {
          wins: awayWins, losses: awayLosses,
          winPct: awayWins + awayLosses > 0 ? awayWins / (awayWins + awayLosses) : 0.5,
        },
        homeRecentForm: streakToForm(streakByTeamId.get(home?.team?.id)),
        awayRecentForm: streakToForm(streakByTeamId.get(away?.team?.id)),
        homeSeriesWins: 0,
        awaySeriesWins: 0,
        notes: "",
      };
    });

    return {
      games,
      status: { sport: "mlb", label, active: true, note: `${games.length} game${games.length === 1 ? "" : "s"} scheduled today` },
    };
  } catch (e) {
    console.warn("MLB schedule fetch failed:", e);
    return { games: [], status: { sport: "mlb", label, active: false, note: "MLB schedule feed unreachable." } };
  }
}

async function fetchEspnGames(sport: "nfl" | "nhl", date: string): Promise<SportResult> {
  const label = SPORT_LABELS[sport];
  const path = sport === "nfl" ? "football/nfl" : "hockey/nhl";
  const dateParam = date.replace(/-/g, "");

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${dateParam}`;
    const data = await fetchJson(url);
    const events: any[] = (data.events ?? []).filter((e: any) => e.status?.type?.state === "pre");

    if (events.length === 0) {
      return {
        games: [],
        status: { sport, label, active: false, note: `No upcoming ${sport.toUpperCase()} games today (off-season or slate complete).` },
      };
    }

    const parseRecord = (c: any): TeamRecord => {
      const summary = c?.records?.find((r: any) => r.type === "total")?.summary ?? c?.records?.[0]?.summary ?? "";
      const match = /^(\d+)-(\d+)/.exec(summary);
      const wins = match ? parseInt(match[1], 10) : 0;
      const losses = match ? parseInt(match[2], 10) : 0;
      return { wins, losses, winPct: wins + losses > 0 ? wins / (wins + losses) : 0.5 };
    };

    const games: ScheduledGame[] = events.map(e => {
      const comp = e.competitions?.[0];
      const competitors: any[] = comp?.competitors ?? [];
      const home = competitors.find(c => c.homeAway === "home");
      const away = competitors.find(c => c.homeAway === "away");

      return {
        id: String(e.id),
        sport,
        homeTeam: home?.team?.displayName ?? "Home",
        awayTeam: away?.team?.displayName ?? "Away",
        homeTeamId: 0,
        awayTeamId: 0,
        startTime: e.date,
        venue: comp?.venue?.fullName ?? "",
        homeRecord: parseRecord(home),
        awayRecord: parseRecord(away),
        // ESPN's scoreboard endpoint doesn't expose per-team game logs, so
        // recent form is left empty here — the momentum factor falls back
        // to the series-advantage half of its formula.
        homeRecentForm: [],
        awayRecentForm: [],
        homeSeriesWins: 0,
        awaySeriesWins: 0,
        notes: "",
      };
    });

    return {
      games,
      status: { sport, label, active: true, note: `${games.length} game${games.length === 1 ? "" : "s"} scheduled today` },
    };
  } catch (e) {
    console.warn(`${sport.toUpperCase()} schedule fetch failed:`, e);
    return { games: [], status: { sport, label, active: false, note: `${sport.toUpperCase()} schedule feed unreachable.` } };
  }
}

// ─── MLB prop data (free MLB Stats API, no key required) ───────────────────
interface ProbablePitcher {
  id: number;
  name: string;
  teamId: number;
}

interface ProbablePitchersForGame {
  homePitcher: ProbablePitcher | null;
  awayPitcher: ProbablePitcher | null;
}

/**
 * Confirmed probable starters for every MLB game on `date`. A null side means
 * no starter has been announced yet — that side gets no pitcher props, since
 * there's no player to fetch a game log for.
 */
async function fetchProbablePitchers(date: string): Promise<Map<string, ProbablePitchersForGame>> {
  const map = new Map<string, ProbablePitchersForGame>();

  try {
    const data = await fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team`);
    const games: any[] = (data.dates ?? []).flatMap((d: any) => d.games ?? []);

    for (const g of games) {
      const homeProb = g.teams?.home?.probablePitcher;
      const awayProb = g.teams?.away?.probablePitcher;

      map.set(String(g.gamePk), {
        homePitcher: homeProb?.id
          ? { id: homeProb.id, name: homeProb.fullName ?? "Probable Pitcher", teamId: g.teams?.home?.team?.id }
          : null,
        awayPitcher: awayProb?.id
          ? { id: awayProb.id, name: awayProb.fullName ?? "Probable Pitcher", teamId: g.teams?.away?.team?.id }
          : null,
      });
    }
  } catch (e) {
    console.warn("fetchProbablePitchers failed:", e);
  }

  return map;
}

/** One game's worth of a stat category. Fields not relevant to the fetch (pitching vs hitting) are left undefined. */
interface GameLogEntry {
  date?: string; // YYYY-MM-DD, used for the fatigue signal in propContextScore
  strikeouts?: number;
  outs?: number;
  hits?: number;
  totalBases?: number;
  homeRuns?: number;
  atBats?: number;
}

/** True if 3+ of the player's last 5 days include a logged game (fatigue signal for propContextScore). */
function isFatigued(entries: GameLogEntry[], asOf: string): boolean {
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs)) return false;
  const fiveDaysAgoMs = asOfMs - 5 * 24 * 60 * 60 * 1000;
  const recentDates = new Set(
    entries
      .map(e => e.date)
      .filter((d): d is string => !!d && Date.parse(d) >= fiveDaysAgoMs && Date.parse(d) < asOfMs)
  );
  return recentDates.size >= 3;
}

interface PitcherGameLogResult {
  last10: GameLogEntry[];
  last20: GameLogEntry[];
  recentAvg: { strikeouts: number; outs: number };
}

async function fetchPitcherGameLog(playerId: number, season: string): Promise<PitcherGameLogResult> {
  const empty: PitcherGameLogResult = { last10: [], last20: [], recentAvg: { strikeouts: 0, outs: 0 } };

  try {
    const data = await fetchJson(
      `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&group=pitching&season=${season}&gameType=R`
    );
    const splits: any[] = data.stats?.[0]?.splits ?? [];

    // The API returns oldest-first; reverse so index 0 is the most recent start.
    const starts: GameLogEntry[] = splits
      .filter((s: any) => s.stat)
      .map((s: any) => ({
        date: s.date,
        strikeouts: Number(s.stat.strikeOuts ?? 0),
        outs: Number(s.stat.outs ?? (s.stat.inningsPitched ? Math.round(parseFloat(s.stat.inningsPitched) * 3) : 0)),
      }))
      .reverse();

    const last20 = starts.slice(0, 20);
    const last10 = starts.slice(0, 10);
    if (last10.length === 0) return empty;

    const avg = (entries: GameLogEntry[], key: "strikeouts" | "outs") =>
      entries.reduce((a, b) => a + (b[key] ?? 0), 0) / entries.length;

    return { last10, last20, recentAvg: { strikeouts: avg(last10, "strikeouts"), outs: avg(last10, "outs") } };
  } catch (e) {
    console.warn(`fetchPitcherGameLog(${playerId}) failed:`, e);
    return empty;
  }
}

interface BatterGameLogResult {
  last10: GameLogEntry[];
  last20: GameLogEntry[];
  recentAvg: { hits: number; totalBases: number; homeRuns: number };
}

async function fetchBatterGameLog(playerId: number, season: string): Promise<BatterGameLogResult> {
  const empty: BatterGameLogResult = { last10: [], last20: [], recentAvg: { hits: 0, totalBases: 0, homeRuns: 0 } };

  try {
    const data = await fetchJson(
      `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&group=hitting&season=${season}&gameType=R`
    );
    const splits: any[] = data.stats?.[0]?.splits ?? [];

    const games: GameLogEntry[] = splits
      .filter((s: any) => s.stat)
      .map((s: any) => ({
        date: s.date,
        hits: Number(s.stat.hits ?? 0),
        totalBases: Number(s.stat.totalBases ?? 0),
        homeRuns: Number(s.stat.homeRuns ?? 0),
        atBats: Number(s.stat.atBats ?? 0),
      }))
      .reverse();

    const last20 = games.slice(0, 20);
    const last10 = games.slice(0, 10);
    if (last10.length === 0) return empty;

    const avg = (entries: GameLogEntry[], key: "hits" | "totalBases" | "homeRuns") =>
      entries.reduce((a, b) => a + (b[key] ?? 0), 0) / entries.length;

    return {
      last10, last20,
      recentAvg: { hits: avg(last10, "hits"), totalBases: avg(last10, "totalBases"), homeRuns: avg(last10, "homeRuns") },
    };
  } catch (e) {
    console.warn(`fetchBatterGameLog(${playerId}) failed:`, e);
    return empty;
  }
}

interface RosterBatter {
  id: number;
  fullName: string;
  jerseyNumber: number;
}

/** Active-roster position players, top 9 by jersey number as a lineup-order proxy (no live lineup feed on the free tier). */
async function fetchMLBRosterBatters(teamId: number, season: string): Promise<RosterBatter[]> {
  try {
    const data = await fetchJson(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active&season=${season}`);
    const roster: any[] = data.roster ?? [];

    const batters: RosterBatter[] = roster
      .filter((p: any) => {
        const abbr = p.position?.abbreviation;
        return p.position?.type === "Hitter" || (abbr && abbr !== "P" && abbr !== "TWP");
      })
      .map((p: any) => ({
        id: p.person?.id,
        fullName: p.person?.fullName ?? "Unknown",
        jerseyNumber: parseInt(p.jerseyNumber, 10) || 99,
      }))
      .filter((p: RosterBatter) => Number.isFinite(p.id));

    return batters.sort((a, b) => a.jerseyNumber - b.jerseyNumber).slice(0, 9);
  } catch (e) {
    console.warn(`fetchMLBRosterBatters(${teamId}) failed:`, e);
    return [];
  }
}

interface OddsApiEntry {
  id: string; // OddsAPI's own event id — needed for the per-event prop odds endpoint
  homeTeam: string;
  awayTeam: string;
  odds: GameOdds;
}

/**
 * Averaging raw American odds prices is invalid whenever books disagree on
 * who's favored — e.g. -150 and +130 straight-averaged is -10, which isn't a
 * legal American odds value at all (real lines never fall between -99 and
 * +99). Averaging implied probabilities instead, then converting back, always
 * lands back in a valid American odds range no matter how the books split.
 */
function averageBookmakerOdds(game: any): GameOdds {
  const home: number[] = [];
  const away: number[] = [];

  for (const bm of game.bookmakers ?? []) {
    const h2h = (bm.markets ?? []).find((m: any) => m.key === "h2h");
    if (!h2h) continue;
    for (const outcome of h2h.outcomes ?? []) {
      if (outcome.name === game.home_team) home.push(oddsToImpliedProb(outcome.price));
      else if (outcome.name === game.away_team) away.push(oddsToImpliedProb(outcome.price));
    }
  }

  const avg = (probs: number[]) => probs.reduce((a, b) => a + b, 0) / probs.length;

  return {
    homeMoneyline: home.length ? probToAmericanOdds(avg(home)) : null,
    awayMoneyline: away.length ? probToAmericanOdds(avg(away)) : null,
  };
}

async function fetchOddsForSport(sport: Sport): Promise<OddsApiEntry[]> {
  const sportKey = ODDS_SPORT_KEYS[sport];
  if (!ODDS_API_KEY || !sportKey) return [];

  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`OddsAPI ${sport} failed: ${res.status}`);
      return [];
    }
    const raw = (await res.json()) as any[];
    return raw.map(g => ({
      id: String(g.id),
      homeTeam: g.home_team,
      awayTeam: g.away_team,
      odds: averageBookmakerOdds(g),
    }));
  } catch (e) {
    console.warn(`OddsAPI ${sport} fetch threw:`, e);
    return [];
  }
}

// ─── Prop odds (selective — top 5 games only, to stay within OddsAPI's free tier) ──
interface PropOddsEntry {
  line: number;
  overOdds: number;
  underOdds: number;
}
type PropOddsMap = Map<string, PropOddsEntry>; // key: "playerName-propType"

const MLB_PROP_MARKETS = "pitcher_strikeouts,batter_hits,batter_home_runs,batter_total_bases";
const ODDS_API_MARKET_TO_PROP: Record<string, PropType> = {
  pitcher_strikeouts: "pitcher_strikeouts",
  batter_hits: "batter_hits",
  batter_home_runs: "batter_home_runs",
  batter_total_bases: "batter_total_bases",
};

async function fetchPropOddsForGame(eventId: string): Promise<PropOddsMap> {
  const map: PropOddsMap = new Map();
  if (!ODDS_API_KEY) return map;

  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${eventId}/odds`
      + `?apiKey=${ODDS_API_KEY}&regions=us&markets=${MLB_PROP_MARKETS}&oddsFormat=american&bookmakers=draftkings,fanduel`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`OddsAPI props ${eventId} failed: ${res.status}`);
      return map;
    }
    const data: any = await res.json();

    // Bucket every bookmaker's over/under quote by player+propType+line, then
    // average implied probability per side the same way moneylines are averaged.
    const buckets = new Map<string, { line: number; propType: PropType; player: string; overProbs: number[]; underProbs: number[] }>();

    for (const bm of data.bookmakers ?? []) {
      for (const market of bm.markets ?? []) {
        const propType = ODDS_API_MARKET_TO_PROP[market.key as string];
        if (!propType) continue;

        for (const outcome of market.outcomes ?? []) {
          const player = outcome.description ?? outcome.name;
          const side = String(outcome.name ?? "").toLowerCase();
          const line = Number(outcome.point);
          if (!player || (side !== "over" && side !== "under") || Number.isNaN(line)) continue;

          const key = `${player}-${propType}-${line}`;
          if (!buckets.has(key)) buckets.set(key, { line, propType, player, overProbs: [], underProbs: [] });
          const bucket = buckets.get(key)!;
          const prob = oddsToImpliedProb(outcome.price);
          if (side === "over") bucket.overProbs.push(prob);
          else bucket.underProbs.push(prob);
        }
      }
    }

    const avg = (probs: number[]) => probs.reduce((a, b) => a + b, 0) / probs.length;
    for (const bucket of buckets.values()) {
      if (bucket.overProbs.length === 0 && bucket.underProbs.length === 0) continue;
      const overOdds = bucket.overProbs.length ? probToAmericanOdds(avg(bucket.overProbs)) : -110;
      const underOdds = bucket.underProbs.length ? probToAmericanOdds(avg(bucket.underProbs)) : -110;
      map.set(`${bucket.player}-${bucket.propType}`, { line: bucket.line, overOdds, underOdds });
    }
  } catch (e) {
    console.warn(`OddsAPI props fetch threw for ${eventId}:`, e);
  }

  return map;
}

/** Fetches prop markets for up to TOP_GAMES_FOR_PROPS OddsAPI event ids in parallel and merges the results. */
async function fetchPropOdds(gameIds: string[], sport: Sport): Promise<PropOddsMap> {
  const merged: PropOddsMap = new Map();
  if (sport !== "mlb" || gameIds.length === 0) return merged;

  const perGame = await Promise.all(gameIds.slice(0, TOP_GAMES_FOR_PROPS).map(fetchPropOddsForGame));
  for (const m of perGame) for (const [k, v] of m) merged.set(k, v);
  return merged;
}

/** Record-gap fallback used whenever OddsAPI has no line for a game. */
function estimateOddsFromRecords(homeRecord: TeamRecord, awayRecord: TeamRecord): GameOdds {
  const homeProb = recordGapToWinProb(homeRecord, awayRecord, true);
  const awayProb = recordGapToWinProb(awayRecord, homeRecord, false);
  const total = homeProb + awayProb;

  return {
    homeMoneyline: probToAmericanOdds(homeProb / total),
    awayMoneyline: probToAmericanOdds(awayProb / total),
  };
}

function attachOdds(games: ScheduledGame[], oddsBySport: Record<string, OddsApiEntry[]>): RawGame[] {
  return games.map(g => {
    const pool = oddsBySport[g.sport] ?? [];
    const match = pool.find(
      o => normalizeTeamName(o.homeTeam) === normalizeTeamName(g.homeTeam) &&
           normalizeTeamName(o.awayTeam) === normalizeTeamName(g.awayTeam)
    );

    const odds = match && (match.odds.homeMoneyline !== null || match.odds.awayMoneyline !== null)
      ? match.odds
      : estimateOddsFromRecords(g.homeRecord, g.awayRecord);

    return { ...g, odds };
  });
}

// ─── Prop scorer (four-factor: hit rate 35% / EV 35% / matchup 20% / context 10%) ──
const PROP_FACTOR_WEIGHTS = { hitRate: 0.35, expectedValue: 0.35, matchupQuality: 0.20, context: 0.10 } as const;

function statValueForPropType(entry: GameLogEntry, propType: PropType): number {
  switch (propType) {
    case "pitcher_strikeouts": return entry.strikeouts ?? 0;
    case "pitcher_outs": return entry.outs ?? 0;
    case "batter_hits": return entry.hits ?? 0;
    case "batter_total_bases": return entry.totalBases ?? 0;
    case "batter_home_runs": return entry.homeRuns ?? 0;
    default: return 0; // NFL/NHL prop types have no game-log fetcher yet
  }
}

/** Fraction of games where the stat cleared (over) or stayed under the line. Exactly-on-the-line games count toward neither. */
function hitRateFor(entries: GameLogEntry[], propType: PropType, line: number, side: PropSide): number {
  if (entries.length === 0) return 0;
  const hits = entries.filter(e => {
    const v = statValueForPropType(e, propType);
    return side === "over" ? v > line : v < line;
  }).length;
  return hits / entries.length;
}

function recentAverageForPropType(recentAvg: { strikeouts?: number; outs?: number; hits?: number; totalBases?: number; homeRuns?: number }, propType: PropType): number {
  switch (propType) {
    case "pitcher_strikeouts": return recentAvg.strikeouts ?? 0;
    case "pitcher_outs": return recentAvg.outs ?? 0;
    case "batter_hits": return recentAvg.hits ?? 0;
    case "batter_total_bases": return recentAvg.totalBases ?? 0;
    case "batter_home_runs": return recentAvg.homeRuns ?? 0;
    default: return 0;
  }
}

/** League-average MLB strikeout rate (K/PA), used as the matchup-quality midpoint for pitcher strikeout props. */
const LEAGUE_AVG_K_RATE = 0.225;

async function fetchTeamKRate(teamId: number, season: string): Promise<number | null> {
  try {
    const data = await fetchJson(`https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=hitting&season=${season}`);
    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    const so = Number(stat?.strikeOuts ?? NaN);
    const pa = Number(stat?.plateAppearances ?? NaN);
    return Number.isFinite(so) && Number.isFinite(pa) && pa > 0 ? so / pa : null;
  } catch (e) {
    console.warn(`fetchTeamKRate(${teamId}) failed:`, e);
    return null;
  }
}

async function fetchPitcherWhip(playerId: number, season: string): Promise<number | null> {
  try {
    const data = await fetchJson(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=season&group=pitching&season=${season}`);
    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    const whip = Number(stat?.whip ?? NaN);
    return Number.isFinite(whip) ? whip : null;
  } catch (e) {
    console.warn(`fetchPitcherWhip(${playerId}) failed:`, e);
    return null;
  }
}

function matchupScoreForPitcherStrikeouts(oppKRate: number | null): number {
  if (oppKRate === null) return 50;
  if (oppKRate > 0.250) return Math.min(90, 75 + (oppKRate - 0.250) * 300);
  if (oppKRate >= 0.200) return 50 + ((oppKRate - 0.200) / 0.050) * 24;
  return Math.max(20, 49 - (0.200 - oppKRate) * 300);
}

function matchupScoreForBatterProps(oppWhip: number | null): number {
  if (oppWhip === null) return 50;
  if (oppWhip < 1.10) return Math.max(20, 40 - (1.10 - oppWhip) * 100);
  if (oppWhip <= 1.30) return 50 + ((oppWhip - 1.10) / 0.20) * 15;
  return Math.min(90, 70 + (oppWhip - 1.30) * 100);
}

/** Context score: home-batter/away-pitcher bumps, fatigue penalty, neutral base 50. */
function propContextScore(opts: { isHome: boolean; isPitcher: boolean; fatigued: boolean }): number {
  let score = 50;
  if (!opts.isPitcher && opts.isHome) score += 10;
  if (opts.isPitcher && !opts.isHome) score += 5;
  if (opts.fatigued) score -= 10;
  return Math.min(Math.max(score, 0), 100);
}

function buildPropRationale(
  playerName: string, propType: PropType, line: number, side: PropSide,
  hitRateLast10: number, recentAverage: number, opponent: string, matchupScore: number,
  estimatedHitPct: number, impliedHitPct: number, evEdge: number
): string {
  const label = PROP_TYPE_LABELS[propType];
  const matchupContext = matchupScore >= 65 ? "favorable" : matchupScore <= 35 ? "tough" : "neutral";

  return [
    `${playerName} has cleared ${line} ${label.toLowerCase()} in ${Math.round(hitRateLast10 * 10)} of their last 10 games (avg: ${recentAverage.toFixed(1)}).`,
    `Matchup vs ${opponent}: ${matchupContext}.`,
    `Estimated ${side} probability ${Math.round(estimatedHitPct * 100)}% vs implied ${Math.round(impliedHitPct * 100)}% — +${Math.round(evEdge * 100)}% EV edge.`,
  ].join(" ");
}

interface PropCandidateInput {
  playerId: number;
  playerName: string;
  team: string;
  opponent: string;
  isHome: boolean;
  isPitcher: boolean;
  propType: PropType;
  fatigued: boolean;
}

interface PropGameContext {
  gameId: string;
  sport: Sport;
  matchup: string;
  startTime: string;
}

function scoreProp(
  candidate: PropCandidateInput,
  log: { last10: GameLogEntry[]; last20: GameLogEntry[]; recentAvg: { strikeouts?: number; outs?: number; hits?: number; totalBases?: number; homeRuns?: number } },
  oddsEntry: PropOddsEntry,
  matchupScore: number,
  game: PropGameContext,
  bankrollState: BankrollState
): PropPick | null {
  const { propType, line } = { propType: candidate.propType, line: oddsEntry.line };
  if (log.last10.length === 0) return null; // no game-log history to score from

  const hitRateOver10 = hitRateFor(log.last10, propType, line, "over");
  const hitRateOver20 = hitRateFor(log.last20, propType, line, "over");
  const weightedOverRate = hitRateOver10 * 0.6 + hitRateOver20 * 0.4;

  const estimatedOverPct = Math.min(Math.max(weightedOverRate, 0.01), 0.99);
  const estimatedUnderPct = 1 - estimatedOverPct;
  const impliedOverPct = oddsToImpliedProb(oddsEntry.overOdds);
  const impliedUnderPct = oddsToImpliedProb(oddsEntry.underOdds);

  const evEdgeOver = estimatedOverPct - impliedOverPct;
  const evEdgeUnder = estimatedUnderPct - impliedUnderPct;

  const side: PropSide = evEdgeOver >= evEdgeUnder ? "over" : "under";
  const evEdge = side === "over" ? evEdgeOver : evEdgeUnder;
  if (evEdge <= 0) return null; // only positive EV props survive

  const estimatedHitPct = side === "over" ? estimatedOverPct : estimatedUnderPct;
  const impliedHitPct = side === "over" ? impliedOverPct : impliedUnderPct;
  const odds = side === "over" ? oddsEntry.overOdds : oddsEntry.underOdds;

  const hitRateScoreBasis = side === "over" ? weightedOverRate : 1 - weightedOverRate;
  const hitRateScore = Math.min(Math.max(((hitRateScoreBasis - 0.30) / 0.50) * 100, 0), 100);
  const { score: evScore } = scoreExpectedValue(estimatedHitPct, impliedHitPct);

  const factorScores: PropFactorScores = {
    hitRate: Math.round(hitRateScore),
    expectedValue: evScore,
    matchupQuality: Math.round(matchupScore),
    context: propContextScore({ isHome: candidate.isHome, isPitcher: candidate.isPitcher, fatigued: candidate.fatigued }),
    composite: 0,
  };
  factorScores.composite = Math.round(
    factorScores.hitRate * PROP_FACTOR_WEIGHTS.hitRate +
    factorScores.expectedValue * PROP_FACTOR_WEIGHTS.expectedValue +
    factorScores.matchupQuality * PROP_FACTOR_WEIGHTS.matchupQuality +
    factorScores.context * PROP_FACTOR_WEIGHTS.context
  );

  const tier = getTier(factorScores.composite);
  if (!tier) return null;

  // Void risk: pitcher props only reach here once a confirmed probable starter
  // exists, so they're "low"; batter lineups aren't official this far ahead of
  // game time, so batter props default to "medium". "high" is reserved for a
  // future signal (injury-report/lineup-confirmation feed) not available on
  // the free tier today — no prop currently resolves to it.
  const voidRisk: VoidRisk = candidate.isPitcher ? "low" : "medium";

  let stakeAmount = kellyStake(bankrollState.currentBankroll, estimatedHitPct, odds);
  if (voidRisk === "medium") stakeAmount = Math.round(stakeAmount * 0.6 * 2) / 2;
  // voidRisk is never "high" by construction above — the check is defensive,
  // matching the constraint that a high-void-risk prop is skipped entirely.
  if ((voidRisk as VoidRisk) === "high" || stakeAmount <= 0) return null;

  const potentialPayout = Math.round(
    (odds > 0 ? stakeAmount + (stakeAmount * odds) / 100 : stakeAmount + (stakeAmount * 100) / Math.abs(odds)) * 100
  ) / 100;

  const recentAverage = recentAverageForPropType(log.recentAvg, propType);

  return {
    id: `${game.gameId}-prop-${normalizeTeamName(candidate.playerName)}-${propType}`,
    sport: game.sport,
    playerName: candidate.playerName,
    team: candidate.team,
    matchup: game.matchup,
    gameId: game.gameId,
    propType,
    line,
    recommendedSide: side,
    odds,
    overOdds: oddsEntry.overOdds,
    underOdds: oddsEntry.underOdds,
    hitRateLast10: Math.round(hitRateOver10 * 100) / 100,
    hitRateLast20: Math.round(hitRateOver20 * 100) / 100,
    recentAverage: Math.round(recentAverage * 100) / 100,
    estimatedHitPct: Math.round(estimatedHitPct * 1000) / 1000,
    impliedHitPct: Math.round(impliedHitPct * 1000) / 1000,
    evEdge: Math.round(evEdge * 1000) / 1000,
    tier,
    scores: factorScores,
    startTime: game.startTime,
    rationale: buildPropRationale(
      candidate.playerName, propType, line, side,
      hitRateOver10, recentAverage, candidate.opponent, matchupScore,
      estimatedHitPct, impliedHitPct, evEdge
    ),
    stakeAmount,
    potentialPayout,
    voidRisk,
    isPositiveEV: true,
  };
}

// ─── Prop orchestration (top TOP_GAMES_FOR_PROPS MLB games only) ───────────
/** Real OddsAPI line/odds if available, else the recent-average estimate described in Step 3. */
function resolvePropOdds(
  map: PropOddsMap, playerName: string, propType: PropType,
  recentAvg: { strikeouts?: number; outs?: number; hits?: number; totalBases?: number; homeRuns?: number },
  statKey: "strikeouts" | "outs" | "hits" | "totalBases" | "homeRuns"
): PropOddsEntry {
  const real = map.get(`${playerName}-${propType}`);
  if (real) return real;

  const avg = recentAvg[statKey] ?? 0;
  if (propType === "pitcher_strikeouts") {
    return { line: Math.round(avg * 10) / 10 - 0.5, overOdds: -115, underOdds: -105 };
  }
  if (propType === "batter_hits") {
    return { line: avg >= 1.2 ? 1.5 : 0.5, overOdds: -115, underOdds: -105 };
  }
  // No explicit fallback formula given for total_bases/home_runs/outs — extrapolate
  // the same "recent average rounded to the nearest half, minus half" convention.
  return { line: Math.max(0.5, Math.round(avg * 2) / 2 - 0.5), overOdds: -115, underOdds: -105 };
}

async function buildPropsForGame(
  game: RawGame,
  probable: ProbablePitchersForGame | undefined,
  propOddsMap: PropOddsMap,
  bankrollState: BankrollState,
  season: string
): Promise<PropPick[]> {
  const props: PropPick[] = [];
  const gameCtx: PropGameContext = {
    gameId: game.id, sport: game.sport,
    matchup: `${game.awayTeam} @ ${game.homeTeam}`, startTime: game.startTime,
  };

  // ── Pitcher props: strikeouts + outs, confirmed probable starters only ──
  const pitcherJobs: { pitcher: ProbablePitcher; isHome: boolean }[] = [];
  if (probable?.homePitcher) pitcherJobs.push({ pitcher: probable.homePitcher, isHome: true });
  if (probable?.awayPitcher) pitcherJobs.push({ pitcher: probable.awayPitcher, isHome: false });

  await Promise.all(pitcherJobs.map(async ({ pitcher, isHome }) => {
    const [log, oppKRate] = await Promise.all([
      fetchPitcherGameLog(pitcher.id, season),
      fetchTeamKRate(isHome ? game.awayTeamId : game.homeTeamId, season), // opponent's hitting K rate
    ]);
    if (log.last10.length === 0) return;

    const matchupScore = matchupScoreForPitcherStrikeouts(oppKRate);
    const fatigued = isFatigued(log.last10, game.startTime);
    const team = isHome ? game.homeTeam : game.awayTeam;
    const opponent = isHome ? game.awayTeam : game.homeTeam;

    for (const propType of ["pitcher_strikeouts", "pitcher_outs"] as const) {
      const statKey = propType === "pitcher_strikeouts" ? "strikeouts" : "outs";
      const oddsEntry = resolvePropOdds(propOddsMap, pitcher.name, propType, log.recentAvg, statKey);
      const pick = scoreProp(
        { playerId: pitcher.id, playerName: pitcher.name, team, opponent, isHome, isPitcher: true, propType, fatigued },
        log, oddsEntry, matchupScore, gameCtx, bankrollState
      );
      if (pick) props.push(pick);
    }
  }));

  // ── Batter props: hits, total bases, home runs — top 9 by jersey number per team ──
  const [homeBatters, awayBatters] = await Promise.all([
    fetchMLBRosterBatters(game.homeTeamId, season),
    fetchMLBRosterBatters(game.awayTeamId, season),
  ]);
  const [homeOppWhip, awayOppWhip] = await Promise.all([
    probable?.awayPitcher ? fetchPitcherWhip(probable.awayPitcher.id, season) : Promise.resolve(null), // home batters face the away pitcher
    probable?.homePitcher ? fetchPitcherWhip(probable.homePitcher.id, season) : Promise.resolve(null),
  ]);

  const batterJobs = [
    ...homeBatters.map(b => ({ batter: b, isHome: true, oppWhip: homeOppWhip })),
    ...awayBatters.map(b => ({ batter: b, isHome: false, oppWhip: awayOppWhip })),
  ];

  await Promise.all(batterJobs.map(async ({ batter, isHome, oppWhip }) => {
    const log = await fetchBatterGameLog(batter.id, season);
    if (log.last10.length === 0) return;

    const matchupScore = matchupScoreForBatterProps(oppWhip);
    const fatigued = isFatigued(log.last10, game.startTime);
    const team = isHome ? game.homeTeam : game.awayTeam;
    const opponent = isHome ? game.awayTeam : game.homeTeam;

    for (const propType of ["batter_hits", "batter_total_bases", "batter_home_runs"] as const) {
      const statKey = propType === "batter_hits" ? "hits" : propType === "batter_total_bases" ? "totalBases" : "homeRuns";
      const oddsEntry = resolvePropOdds(propOddsMap, batter.fullName, propType, log.recentAvg, statKey);
      const pick = scoreProp(
        { playerId: batter.id, playerName: batter.fullName, team, opponent, isHome, isPitcher: false, propType, fatigued },
        log, oddsEntry, matchupScore, gameCtx, bankrollState
      );
      if (pick) props.push(pick);
    }
  }));

  return props;
}

/**
 * Scores props for the top TOP_GAMES_FOR_PROPS MLB games by moneyline
 * composite score. Every prop-fetch failure is caught per-game so a bad
 * player/team lookup never takes down the moneyline picks (or the rest of
 * the prop slate) — see the try/catch in the main handler for the same
 * guarantee at the top level.
 */
async function buildPropPicks(
  moneylinePicks: BetPick[],
  rawGames: RawGame[],
  mlbOddsEntries: OddsApiEntry[],
  bankrollState: BankrollState,
  date: string
): Promise<PropPick[]> {
  const topGameIds = moneylinePicks
    .filter(p => p.sport === "mlb")
    .slice()
    .sort((a, b) => b.scores.composite - a.scores.composite)
    .slice(0, TOP_GAMES_FOR_PROPS)
    .map(p => p.id.replace(/-(home|away)$/, ""));

  const topGames = rawGames.filter(g => g.sport === "mlb" && topGameIds.includes(g.id));
  if (topGames.length === 0) return [];

  const probablePitchers = await fetchProbablePitchers(date);

  const eventIdByGameId = new Map<string, string>();
  for (const game of topGames) {
    const match = mlbOddsEntries.find(
      o => normalizeTeamName(o.homeTeam) === normalizeTeamName(game.homeTeam) &&
           normalizeTeamName(o.awayTeam) === normalizeTeamName(game.awayTeam)
    );
    if (match) eventIdByGameId.set(game.id, match.id);
  }

  const propOddsMap = await fetchPropOdds([...eventIdByGameId.values()], "mlb");
  const season = date.slice(0, 4);

  const perGame = await Promise.all(topGames.map(async game => {
    try {
      return await buildPropsForGame(game, probablePitchers.get(game.id), propOddsMap, bankrollState, season);
    } catch (e) {
      console.warn(`Prop scoring failed for game ${game.id}:`, e);
      return [];
    }
  }));

  return perGame.flat().sort((a, b) => b.scores.composite - a.scores.composite);
}

// ─── Main handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }

  try {
    const date = (req.query.date as string) || new Date().toISOString().split("T")[0];
    const sportsParam = (req.query.sports as string) || "mlb,nfl,nhl";
    const sports = sportsParam.split(",").map(s => s.trim()).filter(Boolean) as Sport[];

    const results: SportResult[] = await Promise.all(
      sports.map(sport => {
        if (sport === "mlb") return fetchMlbGames(date);
        if (sport === "nfl" || sport === "nhl") return fetchEspnGames(sport, date);
        return Promise.resolve<SportResult>({
          games: [],
          status: { sport, label: String(sport).toUpperCase(), active: false, note: "Sport not supported by this endpoint." },
        });
      })
    );

    const games = results.flatMap(r => r.games);
    const sportStatuses = results.map(r => r.status);

    const oddsEntries = await Promise.all(
      sports.map(async (sport): Promise<[Sport, OddsApiEntry[]]> => [sport, await fetchOddsForSport(sport)])
    );
    const oddsBySport = Object.fromEntries(oddsEntries);

    const bankrollState = await fetchBankrollState();
    const rawGames = attachOdds(games, oddsBySport);
    const picks = scoreAllGames(rawGames, bankrollState);

    // Prop bets are best-effort: any failure here must never take down the
    // moneyline picks that already succeeded above.
    let propPicks: PropPick[] = [];
    try {
      propPicks = await buildPropPicks(picks, rawGames, oddsBySport.mlb ?? [], bankrollState, date);
    } catch (e) {
      console.warn("Prop pipeline failed entirely, continuing with moneyline picks only:", e);
    }

    // Narrative explanations are best-effort too: generateExplanation/
    // generatePropExplanation always resolve (never throw) and fall back to
    // the template rationale already on the pick, so a Haiku outage can only
    // ever degrade prose quality, never drop a pick.
    const picksWithExplanations = await Promise.all(
      picks.map(async (pick) => {
        const gameId = pick.id.replace(/-(home|away)$/, "");
        const game = rawGames.find(g => g.id === gameId);
        if (!game) return pick;
        const rationale = await generateExplanation(pick, game);
        return { ...pick, rationale };
      })
    );

    const propPicksWithExplanations = await Promise.all(
      propPicks.map(async (prop) => ({ ...prop, rationale: await generatePropExplanation(prop) }))
    );

    // Reference-only trio (safe/value/shot) — unrelated to the 5 bets actually
    // committed below, kept purely so the "Full Analysis" view has something
    // to show under allParlays.
    const allParlays = buildDefaultParlays(picksWithExplanations, propPicksWithExplanations);

    let dailyBets: DailyBetsResult;
    try {
      dailyBets = selectDailyBets(picksWithExplanations, propPicksWithExplanations, bankrollState.currentBankroll);
    } catch (e) {
      // Never let a selection bug take down pick generation — fall back to a
      // simple top-3-by-composite single plus the reference safe/shot parlays.
      console.warn("selectDailyBets failed, falling back to top picks:", e);
      const fallbackShortlist = buildShortlist(picksWithExplanations, propPicksWithExplanations);
      const fallbackBestBets = fallbackShortlist.slice(0, 3);
      const fallbackSafe = allParlays.find(p => p.id === "safe") ?? emptyParlay("safe", "💚 Safe Parlay", "💚");
      const fallbackShot = allParlays.find(p => p.id === "shot") ?? emptyParlay("shot", "🚀 High Odds Parlay", "🚀");
      dailyBets = {
        shortlist: fallbackShortlist,
        bestBets: fallbackBestBets,
        safeParlay: fallbackSafe,
        highOddsParlay: fallbackShot,
        totalDailyStake: fallbackBestBets.reduce((a, b) => a + b.stakeAmount, 0),
      };
    }

    const itemLabel = (item: BetPick | PropPick) => (isPropPick(item) ? propLegLabel(item) : item.pickLabel);
    const totalPotentialPayout = Math.round(
      (dailyBets.bestBets.reduce((a, b) => a + b.potentialPayout, 0) +
        (dailyBets.safeParlay.potentialPayout ?? 0) +
        (dailyBets.highOddsParlay.potentialPayout ?? 0)) * 100
    ) / 100;
    const totalBetsPlaced =
      dailyBets.bestBets.length +
      (dailyBets.safeParlay.legs.length > 0 ? 1 : 0) +
      (dailyBets.highOddsParlay.legs.length > 0 ? 1 : 0);

    const summary: DailySummary = {
      totalBetsPlaced,
      totalStaked: dailyBets.totalDailyStake,
      totalPotentialPayout,
      bankrollAtRisk: bankrollState.currentBankroll > 0
        ? Math.round((dailyBets.totalDailyStake / bankrollState.currentBankroll) * 10000) / 10000
        : 0,
      highestConfidencePick: dailyBets.bestBets.length > 0 ? itemLabel(dailyBets.bestBets[0]) : "",
    };

    const response: BestBetsResponse = {
      date,
      generatedAt: new Date().toISOString(),
      cached: false,
      sportStatuses,
      shortlist: dailyBets.shortlist,
      bestBets: dailyBets.bestBets,
      safeParlay: dailyBets.safeParlay,
      highOddsParlay: dailyBets.highOddsParlay,
      allPicks: picksWithExplanations,
      allPropPicks: propPicksWithExplanations,
      allParlays,
      summary,
    };

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).json(response);
  } catch (err) {
    console.error("best-bets handler error:", err);
    res.status(500).json({
      error: "Failed to generate picks",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
