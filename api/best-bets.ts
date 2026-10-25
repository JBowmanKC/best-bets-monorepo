// ─────────────────────────────────────────────────────────────────────────
// Self-contained Vercel serverless function. No Anthropic dependency, no
// import from ../packages/algorithm — every helper the four-factor model
// needs lives in this one file so it can be deployed and read in isolation.
//
// Data sources (all free, no key required except OddsAPI):
//   MLB schedule    — https://statsapi.mlb.com/api/v1/schedule
//   MLB standings   — https://statsapi.mlb.com/api/v1/standings
//   NFL/NHL games   — https://site.api.espn.com/apis/site/v2/sports/...
//   NCAAF games     — https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard (filtered to SEC/Big Ten/ACC via groups=)
//   NFL roster      — https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{id}/roster
//   NFL player logs — https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/{id}/gamelog
//   Moneylines      — https://api.the-odds-api.com/v4/sports/.../odds
//
// Sport selection: the `sports` query param decides what's fetched
// (default "nfl" — NFL-only for now; pass sports=mlb,nhl,ncaaf explicitly to
// still fetch those on demand). NCAAF is scoped to SEC/Big Ten/ACC only —
// see fetchNcaafGames.
//
// Environment variables:
//   ODDS_API_KEY — OddsAPI key (live moneylines). Games still generate
//   without it, using record-gap-estimated odds as a fallback.
// ─────────────────────────────────────────────────────────────────────────

const ODDS_API_KEY = process.env.ODDS_API_KEY;

/**
 * Every outbound fetch (ESPN, MLB Stats API, OddsAPI, Anthropic) is capped at
 * this long. Discovered the hard way on 2026-09-13: with no per-request
 * timeout, a single slow upstream response — ESPN's hidden APIs under real
 * NFL Sunday game-time load, in this case — can hang long enough to blow
 * past Vercel's 60s function limit and take the whole response (including
 * the moneyline picks that had nothing to do with the slow call) down with
 * it. Every call site already treats a thrown/rejected fetch as "this
 * sub-feature degrades gracefully" (try/catch → empty result), so turning a
 * hang into a fast timeout is a strict improvement, never a new failure mode.
 */
const FETCH_TIMEOUT_MS = 8_000;

type Sport = "mlb" | "nfl" | "nhl" | "ncaaf";
type Tier = "elite" | "strong" | "value";

interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * The base host to use for self-fetching this deployment's own static output
 * (e.g. bankroll.json). `process.env.VERCEL_URL` is Vercel's own per-deployment
 * URL — it commonly sits behind Vercel's deployment protection and isn't
 * reliably fetchable from inside the function itself, which silently degrades
 * every read to the empty-bankroll default. The incoming request's own Host
 * header is the domain whatever called this function just successfully used,
 * so it's used first; VERCEL_URL is kept only as a last-resort fallback.
 */
function selfBaseUrl(req: ApiRequest): string | null {
  const header = req.headers?.["x-forwarded-host"] ?? req.headers?.host;
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return fromHeader || process.env.VERCEL_URL || null;
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
  /** MLB or ESPN team id (0 for NHL games, which have no prop roster/stat lookups yet). */
  homeTeamId: number;
  awayTeamId: number;
  /** NFL-only: ESPN's team abbreviation, used to key into nflverse's defense-allowed-yards stats (see fetchNflDefenseStats). Empty for other sports. */
  homeTeamAbbr: string;
  awayTeamAbbr: string;
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
type RawGame = ScheduledGame & { odds: GameOdds; sportsbook: Sportsbook | "estimated" };

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
  /** Which book this price is from — a real book name, or "Estimated" (never bet on). */
  sportsbook: string;
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
  /** Same book as every other leg in the parlay — see the sportsbook-selection note above. */
  sportsbook: string;
}

interface Parlay {
  id: "safe" | "value" | "shot" | "double";
  label: string;
  emoji: string;
  legs: ParlayLeg[];
  estimatedPayout: number;
  combinedWinPct: number;
  recommendedStake: string;
  /** Dollar stake/payout for a committed daily parlay (safeParlay/highOddsParlay/doubleUpParlay). Absent on the reference-only allParlays entries. */
  stakeAmount?: number;
  potentialPayout?: number;
  /** The single book every leg is from. Absent when there are no legs. */
  sportsbook?: string;
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

  /** The book every bet/leg today is priced from, or null if none could be determined (e.g. no ODDS_API_KEY). */
  sportsbook: string | null;

  // The (up to) 6 committed bets for today.
  bestBets: (BetPick | PropPick)[]; // up to 3 singles
  safeParlay: Parlay;
  highOddsParlay: Parlay;
  doubleUpParlay: Parlay;

  // Full analysis pool — scored in full, shown for transparency, not bet on.
  allPicks: BetPick[];
  allPropPicks: PropPick[];
  allParlays: Parlay[];

  summary: DailySummary;
}

// ─── Prop bets (MLB, NFL and NHL — see buildMlbPropPicks, buildNflPropPicks
// and buildNhlPropPicks below) ────────────────────────────────────────────
type PropType =
  | "pitcher_strikeouts"
  | "pitcher_outs"
  | "batter_hits"
  | "batter_total_bases"
  | "batter_home_runs"
  | "player_pass_yards"
  | "player_rush_yards"
  | "player_receiving_yards"
  | "player_shots_on_goal"
  | "player_goals"
  | "player_assists"
  | "player_points";

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
  /** True when this line came from an "alternate" market (a different point total than the book's main line) — see pickPropPick for when this gets chosen over the main line. */
  isAlternateLine: boolean;
  /** Which book this price is from — a real book name, or "Estimated" (never bet on). */
  sportsbook: string;
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
  player_goals: "Goals",
  player_assists: "Assists",
  player_points: "Points",
};

const TOP_GAMES_FOR_PROPS = 5;
/**
 * NHL checks props for fewer games than NFL/MLB: it bets four nights a week
 * (Tue/Wed/Fri/Sat) on the same free 500-credit OddsAPI plan NFL uses, and
 * each game costs one credit per market. 4 markets × 3 games + 1 moneyline
 * call = 13 credits a run, ~220 a month — leaves room for NFL's ~210.
 */
const NHL_TOP_GAMES_FOR_PROPS = 3;
/** Hard cap on the prop pipeline so a slow upstream (ESPN under game-day load) can't blow past Vercel's 60s function limit and lose the moneyline picks too. */
const PROP_PIPELINE_TIMEOUT_MS = 35_000;

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
  ncaaf: "🏈 NCAAF",
};

const ODDS_SPORT_KEYS: Record<Sport, string> = {
  mlb: "baseball_mlb",
  nfl: "americanfootball_nfl",
  nhl: "icehockey_nhl",
  ncaaf: "americanfootball_ncaaf",
};

// ─── Sportsbook selection ────────────────────────────────────────────────────
//
// A parlay can only be placed at a single book, and even for singles, mixing
// books game-to-game makes the picks harder to actually go place. So rather
// than blending prices across books, one book is chosen for the whole run
// (whichever of the three covers the most of today's games — see
// chooseSportsbook) and every pick/leg is priced from that book alone. A game
// that book doesn't list falls back to the record-gap estimate and is tagged
// "Estimated" rather than misattributed to a book that didn't actually offer
// it — and estimated picks are never eligible to be bet on (see
// selectBestBets/selectSafeParlayLegs/selectHighOddsParlayLegs/selectParlayLegs).
const SPORTSBOOKS = ["draftkings", "fanduel", "betmgm"] as const;
type Sportsbook = typeof SPORTSBOOKS[number];

const SPORTSBOOK_LABELS: Record<Sportsbook, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betmgm: "BetMGM",
};

const ESTIMATED_SOURCE_LABEL = "Estimated";

function sportsbookLabel(book: Sportsbook | "estimated"): string {
  return book === "estimated" ? ESTIMATED_SOURCE_LABEL : SPORTSBOOK_LABELS[book];
}

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

const RECORD_PRIOR_GAMES = 6;

function recordGapToWinProb(
  favRecord: TeamRecord,
  dogRecord: TeamRecord,
  isFavHome: boolean
): number {
  // Regressed toward .500 as if every team had RECORD_PRIOR_GAMES extra games
  // split evenly — a 5-0 start reads as ~.73, not a perfect 1.000 that maxes
  // out the estimate after five games.
  const pct = (r: TeamRecord) => (r.wins + RECORD_PRIOR_GAMES / 2) / (r.wins + r.losses + RECORD_PRIOR_GAMES);
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

function buildRationale(
  game: RawGame, pickHome: boolean, winPct: number, impliedPct: number, evEdge: number,
  recordPct: number, marketPct: number
): string {
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
    // ESPN's NFL/NHL scoreboard carries no recent results, so form is empty
    // there — say nothing rather than "Won 0 of last 5".
    form.length > 0 ? `Won ${winsLast5} of last ${form.length} games ${homeStr}.` : `Playing ${homeStr}.`,
    `Record-based estimate ${Math.round(recordPct * 100)}% vs market ${Math.round(marketPct * 100)}% — blended ${Math.round(winPct * 100)}%`
      + ` vs implied ${Math.round(impliedPct * 100)}%, +${Math.round(evEdge * 100)}% EV edge.`,
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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

/**
 * How far a moneyline estimate moves from the market's own price toward the
 * record-based estimate. The record gap alone claimed 77% on average for NFL
 * moneyline singles that won 50% (e.g. a 5-0 team at 77% vs 45% implied, on
 * the road), so it can't replace the book's price outright. Set looser than
 * the 0.35 props/NHL use: at 0.35 almost no NFL moneyline cleared the
 * strong tier, which emptied the safe and double-up parlays most weeks.
 */
const MONEYLINE_MODEL_WEIGHT = 0.6;
/**
 * When the record-based estimate and the market disagree by more than this,
 * the market almost always knows something a W-L record can't see (a
 * starting QB out, a soft early schedule) — e.g. a 4-2 Giants side at +400
 * the record called a 71% team. Those games are skipped rather than bet.
 * 0.25 still screens out 10/25's 5-0 Chiefs at Seattle (~70% vs 43%);
 * 0.30 let them back in as a best bet.
 */
const MAX_RECORD_MARKET_GAP = 0.25;

function scoreGame(game: RawGame, bankrollState: BankrollState): BetPick[] {
  const picks: BetPick[] = [];

  // De-vig when both sides are priced, so the market's number is a fair probability.
  const rawHome = game.odds.homeMoneyline !== null && game.odds.homeMoneyline !== undefined ? oddsToImpliedProb(game.odds.homeMoneyline) : null;
  const rawAway = game.odds.awayMoneyline !== null && game.odds.awayMoneyline !== undefined ? oddsToImpliedProb(game.odds.awayMoneyline) : null;
  const fairHome = rawHome !== null && rawAway !== null ? rawHome / (rawHome + rawAway) : null;

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
    const recordWinPct = 0.3 + (wpScore / 100) * 0.52;
    const marketPct = fairHome === null ? impliedWinPct : pickHome ? fairHome : 1 - fairHome;
    if (Math.abs(recordWinPct - marketPct) > MAX_RECORD_MARKET_GAP) continue;
    const estimatedWinPct = marketPct + (recordWinPct - marketPct) * MONEYLINE_MODEL_WEIGHT;

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
      rationale: buildRationale(game, pickHome, estimatedWinPct, impliedWinPct, evEdge, recordWinPct, marketPct),
      stake: STAKE_BY_TIER[tier],
      isPositiveEV: true,
      stakeAmount,
      potentialPayout,
      sportsbook: sportsbookLabel(game.sportsbook),
    });
  }

  if (picks.length === 0) return [];
  picks.sort((a, b) => b.scores.composite - a.scores.composite);
  return [picks[0]]; // best side per game only
}

function scoreAllGames(
  games: RawGame[],
  bankrollState: BankrollState,
  /** NHL games are scored by their own model (scoreNhlGame); every other sport is unchanged. */
  nhlContexts: Map<string, NhlMatchupContext> = new Map()
): BetPick[] {
  const allPicks = games.flatMap(game => {
    if (game.sport !== "nhl") return scoreGame(game, bankrollState);
    const ctx = nhlContexts.get(game.id);
    return ctx ? scoreNhlGame(game, ctx, bankrollState) : [];
  });
  const tierOrder: Record<Tier, number> = { elite: 3, strong: 2, value: 1 };
  allPicks.sort((a, b) => {
    const tierDiff = tierOrder[b.tier] - tierOrder[a.tier];
    if (tierDiff !== 0) return tierDiff;
    return b.scores.composite - a.scores.composite;
  });
  return allPicks;
}

// ─── NHL moneyline model ─────────────────────────────────────────────────────
// The record-gap estimate scoreGame uses (0.5 + 0.8 × win% gap) produced
// 80%-vs-52% "edges" in October NHL — a 4-1 team vs a 1-4 team hits its 82%
// cap after five games, regardless of who those games were against. NHL
// moneylines went 1-5 on it. This model instead rates each team in goals per
// game and adds the situational factors that actually move NHL lines:
//
//   rating     goal differential per game, adjusted for strength of schedule
//              (who they've played), blended with last season's rating while
//              this season's sample is small
//   venue      league-wide home ice plus each team's own home/road split
//   rest       second night of a back-to-back, 3 games in 4 nights
//   road trip  each consecutive road game past the second wears a team down
//   goalie     tonight's probable starter vs the save % the team has had
//   injuries   points per game lost to stars listed out
//
// Every factor is in goals per game (for the home team), summed and turned
// into a win probability. That probability is then blended with the market's
// own (de-vigged) price rather than trusted outright — the same discipline
// scoreProp uses — so a bet needs the model to clearly disagree with the
// book, not just a good record.

/** One completed regular-season game from a team's point of view. */
interface NhlTeamGame {
  date: string; // YYYY-MM-DD, local game date
  opp: string; // NHL abbrev
  home: boolean;
  gf: number;
  ga: number;
}

interface NhlStandingsRow {
  abbrev: string;
  name: string;
  gamesPlayed: number;
  gdPerGame: number;
}

interface NhlGoalie {
  name: string;
  gamesPlayed: number;
  savePct: number;
  shotsAgainst: number;
}

interface NhlSkaterLine {
  name: string;
  gamesPlayed: number;
  points: number;
}

interface NhlInjury {
  name: string;
  status: string;
}

/** Everything the model knows about one team going into tonight. */
interface NhlTeamContext {
  abbrev: string;
  name: string;
  games: NhlTeamGame[];
  rating: number; // goals/game vs a league-average opponent
  homeSplit: number; // home GD/game minus overall GD/game, shrunk
  roadSplit: number;
  playedYesterday: boolean;
  threeInFour: boolean;
  roadTripGame: number; // tonight's place in a run of road games (0 if home)
  last10GdPerGame: number;
  last10Record: string;
  starter: NhlGoalie | null;
  teamSavePct: number | null;
  starsOut: { name: string; pointsPerGame: number; status: string }[];
}

interface NhlMatchupContext {
  home: NhlTeamContext;
  away: NhlTeamContext;
}

/** Goal-equivalent factor contributions, from the home team's side. */
interface NhlFactorBreakdown {
  rating: number;
  venue: number;
  rest: number;
  roadTrip: number;
  goalie: number;
  injuries: number;
  total: number;
}

const NHL_HOME_ICE_GOALS = 0.2; // ~54% home win rate league-wide
const NHL_GOALS_TO_LOGIT = 0.85; // a 1 goal/game edge ≈ a 70% favorite
const NHL_RATING_PRIOR_GAMES = 12; // games before this season's rating outweighs last season's
const NHL_PRIOR_REGRESSION = 0.5; // rosters turn over — keep half of last season's rating
const NHL_SPLIT_PRIOR_GAMES = 15;
const NHL_BACK_TO_BACK_GOALS = 0.25;
const NHL_THREE_IN_FOUR_GOALS = 0.1;
const NHL_SHOTS_PER_GAME = 28;
const NHL_STAR_MIN_PPG = 0.6;
const NHL_REPLACEMENT_PPG = 0.3;
const NHL_POINTS_PER_GOAL = 2.7; // a goal plus ~1.7 assists
/** How far the estimate moves from the market toward the model — same cap as scoreProp's MAX_SIGNAL_WEIGHT. */
const NHL_MODEL_WEIGHT = 0.35;

/** ESPN and the NHL disagree on five team abbreviations. */
const ESPN_TO_NHL_ABBREV: Record<string, string> = { LA: "LAK", NJ: "NJD", SJ: "SJS", TB: "TBL", UTAH: "UTA" };

/** Lowercase, accents stripped, letters/digits only — "Montréal" and "Montreal" match. */
function nhlFold(name: string): string {
  return (name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function shiftIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const clampGoals = (v: number, cap: number) => Math.min(Math.max(v, -cap), cap);

/**
 * Strength-of-schedule-adjusted rating: each game's margin plus how good the
 * opponent has been (their own GD/game), averaged — beating good teams counts
 * for more than beating bad ones. Blended with last season's regressed
 * rating while the current sample is small.
 */
function nhlTeamRating(games: NhlTeamGame[], oppGdPerGame: Map<string, number>, priorGdPerGame: number | null): number {
  const prior = (priorGdPerGame ?? 0) * NHL_PRIOR_REGRESSION;
  if (games.length === 0) return prior;
  const adjusted = games.reduce((acc, g) => acc + (g.gf - g.ga) + (oppGdPerGame.get(g.opp) ?? 0), 0) / games.length;
  return (adjusted * games.length + prior * NHL_RATING_PRIOR_GAMES) / (games.length + NHL_RATING_PRIOR_GAMES);
}

/** Home (or road) GD/game relative to the team's overall GD/game, shrunk toward zero on small samples. */
function nhlVenueSplit(games: NhlTeamGame[], home: boolean): number {
  const venueGames = games.filter(g => g.home === home);
  if (games.length === 0 || venueGames.length === 0) return 0;
  const overall = games.reduce((a, g) => a + g.gf - g.ga, 0) / games.length;
  const venue = venueGames.reduce((a, g) => a + g.gf - g.ga, 0) / venueGames.length;
  return (venue - overall) * (venueGames.length / (venueGames.length + NHL_SPLIT_PRIOR_GAMES));
}

/** Rest and travel going into tonight. `games` must be sorted oldest → newest and only include games before `date`. */
function nhlSchedulePressure(games: NhlTeamGame[], date: string, homeTonight: boolean) {
  const yesterday = shiftIsoDate(date, -1);
  const threeDaysAgo = shiftIsoDate(date, -3);
  const playedYesterday = games.some(g => g.date === yesterday);
  const threeInFour = games.filter(g => g.date >= threeDaysAgo && g.date < date).length >= 2;
  let roadTripGame = 0;
  if (!homeTonight) {
    roadTripGame = 1;
    for (let i = games.length - 1; i >= 0 && !games[i].home; i--) roadTripGame += 1;
  }
  return { playedYesterday, threeInFour, roadTripGame };
}

function nhlLast10(games: NhlTeamGame[]): { gdPerGame: number; record: string } {
  const last = games.slice(-10);
  if (last.length === 0) return { gdPerGame: 0, record: "0-0" };
  const w = last.filter(g => g.gf > g.ga).length;
  return { gdPerGame: last.reduce((a, g) => a + g.gf - g.ga, 0) / last.length, record: `${w}-${last.length - w}` };
}

/** Goals/game the team loses to its listed-out stars. Only players who've been in the lineup most of the season count — a player out for weeks is already reflected in the rating. */
function nhlInjuryGoals(starsOut: NhlTeamContext["starsOut"]): number {
  const lost = starsOut.reduce((acc, s) => {
    const weight = s.status === "Day-To-Day" ? 0.5 : 1;
    return acc + weight * Math.max(s.pointsPerGame - NHL_REPLACEMENT_PPG, 0) / NHL_POINTS_PER_GOAL;
  }, 0);
  return Math.min(lost, 0.6);
}

/**
 * Tonight's starter vs the save % the team has actually been getting, in
 * goals/game — the team rating already reflects its usual goaltending, so only
 * a change of goalie should move the line. The starter's own % is shrunk
 * toward the team's on a small sample (so the regular starter nets out to
 * ~zero, and a backup with two starts can't swing it much). A starter with
 * no NHL games this season — a call-up — is treated as replacement level.
 */
const NHL_REPLACEMENT_SAVE_PCT = 0.89;

function nhlGoalieGoals(team: NhlTeamContext): number {
  if (!team.starter || team.teamSavePct === null) return 0;
  const gp = team.starter.gamesPlayed;
  const starterSv = gp === 0
    ? NHL_REPLACEMENT_SAVE_PCT
    : (team.starter.savePct * gp + team.teamSavePct * 4) / (gp + 4);
  return clampGoals((starterSv - team.teamSavePct) * NHL_SHOTS_PER_GAME, 0.4);
}

function nhlFactors(ctx: NhlMatchupContext): NhlFactorBreakdown {
  const { home, away } = ctx;
  const rating = home.rating - away.rating;
  const venue = NHL_HOME_ICE_GOALS + clampGoals(0.5 * home.homeSplit + 0.5 * -away.roadSplit, 0.3);
  const fatigue = (t: NhlTeamContext) =>
    (t.playedYesterday ? NHL_BACK_TO_BACK_GOALS : 0) + (t.threeInFour ? NHL_THREE_IN_FOUR_GOALS : 0);
  const rest = fatigue(away) - fatigue(home);
  const roadTrip = Math.min(0.05 * Math.max(away.roadTripGame - 2, 0), 0.2);
  const goalie = nhlGoalieGoals(home) - nhlGoalieGoals(away);
  const injuries = nhlInjuryGoals(away.starsOut) - nhlInjuryGoals(home.starsOut);
  const total = rating + venue + rest + roadTrip + goalie + injuries;
  return { rating, venue, rest, roadTrip, goalie, injuries, total };
}

function nhlHomeWinProb(totalGoals: number): number {
  return 1 / (1 + Math.exp(-NHL_GOALS_TO_LOGIT * totalGoals));
}

const fmtGoals = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

function buildNhlRationale(
  game: RawGame, ctx: NhlMatchupContext, f: NhlFactorBreakdown, pickHome: boolean,
  modelPct: number, marketPct: number, estimatedPct: number, evEdge: number
): string {
  const me = pickHome ? ctx.home : ctx.away;
  const opp = pickHome ? ctx.away : ctx.home;
  const sign = pickHome ? 1 : -1;
  const notes: string[] = [];

  notes.push(
    `${me.name} rate ${fmtGoals(me.rating)} goals/game after strength of schedule vs ${fmtGoals(opp.rating)} for ${opp.name}`
    + ` (last 10: ${me.last10Record} vs ${opp.last10Record}).`
  );
  notes.push(pickHome ? "Home ice." : "On the road.");
  if (me.playedYesterday) notes.push(`${me.name} are on the second night of a back-to-back.`);
  if (opp.playedYesterday) notes.push(`${opp.name} are on the second night of a back-to-back.`);
  if (me.roadTripGame >= 3) notes.push(`Game ${me.roadTripGame} of a road trip for ${me.name}.`);
  if (opp.roadTripGame >= 3) notes.push(`Game ${opp.roadTripGame} of a road trip for ${opp.name}.`);
  const goalieLine = (t: NhlTeamContext) => t.starter ? `${t.starter.name} (${t.starter.savePct.toFixed(3)})` : "starter unconfirmed";
  notes.push(`In net: ${goalieLine(me)} vs ${goalieLine(opp)}.`);
  const starsLine = (t: NhlTeamContext) => t.starsOut.map(s => `${s.name} (${s.pointsPerGame.toFixed(2)} pts/gm, ${s.status})`).join(", ");
  if (me.starsOut.length) notes.push(`${me.name} without ${starsLine(me)}.`);
  if (opp.starsOut.length) notes.push(`${opp.name} without ${starsLine(opp)}.`);

  const situational = sign * (f.venue + f.rest + f.roadTrip + f.goalie + f.injuries);
  notes.push(
    `Model ${Math.round(modelPct * 100)}% vs market ${Math.round(marketPct * 100)}%`
    + ` (situational factors ${fmtGoals(situational)} goals) — blended estimate ${Math.round(estimatedPct * 100)}%, +${Math.round(evEdge * 100)}% EV edge.`
  );
  return notes.join(" ");
}

/** Best side of one NHL game, or nothing when the model doesn't clear the market by enough. */
function scoreNhlGame(game: RawGame, ctx: NhlMatchupContext, bankrollState: BankrollState): BetPick[] {
  const f = nhlFactors(ctx);
  const modelHome = nhlHomeWinProb(f.total);

  const homeOdds = game.odds.homeMoneyline;
  const awayOdds = game.odds.awayMoneyline;
  // De-vig when both sides are priced, so the market's "fair" number is comparable to the model's.
  const rawHome = homeOdds !== null && homeOdds !== undefined ? oddsToImpliedProb(homeOdds) : null;
  const rawAway = awayOdds !== null && awayOdds !== undefined ? oddsToImpliedProb(awayOdds) : null;
  const fairHome = rawHome !== null && rawAway !== null ? rawHome / (rawHome + rawAway) : rawHome ?? (rawAway !== null ? 1 - rawAway : 0.5);

  const picks: BetPick[] = [];
  for (const pickHome of [true, false]) {
    const odds = pickHome ? homeOdds : awayOdds;
    if (odds === null || odds === undefined) continue;

    const impliedWinPct = oddsToImpliedProb(odds);
    const marketPct = pickHome ? fairHome : 1 - fairHome;
    const modelPct = pickHome ? modelHome : 1 - modelHome;
    const estimatedWinPct = Math.min(Math.max(marketPct + (modelPct - marketPct) * NHL_MODEL_WEIGHT, 0.05), 0.95);

    const rawEv = scoreExpectedValue(estimatedWinPct, impliedWinPct);
    const evEdge = rawEv.evEdge;
    if (evEdge <= 0) continue;

    const sign = pickHome ? 1 : -1;
    const me = pickHome ? ctx.home : ctx.away;
    const opp = pickHome ? ctx.away : ctx.home;
    const wpScore = Math.min(Math.max(Math.round(((estimatedWinPct - 0.3) / 0.52) * 100 * bankrollState.calibration.wpScoreMultiplier), 0), 100);
    const evScore = Math.min(Math.max(Math.round(rawEv.score * bankrollState.calibration.evScoreMultiplier), 0), 100);
    // Momentum: last-10 goal differential, this team vs the opponent.
    const momScore = Math.min(Math.max(Math.round(50 + (me.last10GdPerGame - opp.last10GdPerGame) * 15), 0), 100);
    // Context: the situational factors (venue/rest/travel/goalie/injuries) in this side's favor.
    const situational = sign * (f.venue + f.rest + f.roadTrip + f.goalie + f.injuries);
    const ctxScore = Math.min(Math.max(Math.round(50 + situational * 60), 0), 100);

    const factorScores: FactorScores = { winProbability: wpScore, expectedValue: evScore, momentum: momScore, context: ctxScore, composite: 0 };
    factorScores.composite = composite(factorScores);
    const tier = getTier(factorScores.composite);
    if (!tier) continue;

    const team = pickHome ? game.homeTeam : game.awayTeam;
    const stakeAmount = kellyStake(bankrollState.currentBankroll, estimatedWinPct, odds);
    const potentialPayout = Math.round(
      (odds > 0 ? stakeAmount + (stakeAmount * odds) / 100 : stakeAmount + (stakeAmount * 100) / Math.abs(odds)) * 100
    ) / 100;

    picks.push({
      id: `${game.id}-${pickHome ? "home" : "away"}`,
      sport: game.sport,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      betType: `Moneyline — ${pickHome ? "Home Win" : "Away Win"}`,
      pickLabel: `${team} ML`,
      odds,
      estimatedWinPct: Math.round(estimatedWinPct * 1000) / 1000,
      impliedWinPct: Math.round(impliedWinPct * 1000) / 1000,
      evEdge: Math.round(evEdge * 1000) / 1000,
      tier,
      scores: factorScores,
      startTime: game.startTime,
      rationale: buildNhlRationale(game, ctx, f, pickHome, modelPct, marketPct, estimatedWinPct, evEdge),
      stake: STAKE_BY_TIER[tier],
      isPositiveEV: true,
      stakeAmount,
      potentialPayout,
      sportsbook: sportsbookLabel(game.sportsbook),
    });
  }

  if (picks.length === 0) return [];
  picks.sort((a, b) => b.scores.composite - a.scores.composite);
  return [picks[0]];
}

// ─── NHL model data (NHL's own API + ESPN; free, no key) ────────────────────
async function fetchNhlStandingsTable(date: string | "now"): Promise<NhlStandingsRow[]> {
  try {
    const data = await fetchJson(`https://api-web.nhle.com/v1/standings/${date}`);
    return (data.standings ?? [])
      .map((t: any): NhlStandingsRow => ({
        abbrev: t.teamAbbrev?.default ?? "",
        name: t.teamName?.default ?? "",
        gamesPlayed: Number(t.gamesPlayed) || 0,
        gdPerGame: Number(t.gamesPlayed) > 0 ? Number(t.goalDifferential) / Number(t.gamesPlayed) : 0,
      }))
      .filter((r: NhlStandingsRow) => r.abbrev);
  } catch (e) {
    console.warn(`fetchNhlStandingsTable(${date}) failed:`, e);
    return [];
  }
}

/** Completed regular-season games, oldest first, before `beforeDate`. */
async function fetchNhlTeamGames(abbrev: string, seasonId: string, beforeDate: string): Promise<NhlTeamGame[]> {
  try {
    const data = await fetchJson(`https://api-web.nhle.com/v1/club-schedule-season/${abbrev}/${seasonId}`);
    return (data.games ?? [])
      .filter((g: any) => g.gameType === 2 && (g.gameState === "FINAL" || g.gameState === "OFF") && g.gameDate < beforeDate)
      .map((g: any): NhlTeamGame => {
        const home = g.homeTeam?.abbrev === abbrev;
        const me = home ? g.homeTeam : g.awayTeam;
        const them = home ? g.awayTeam : g.homeTeam;
        return { date: g.gameDate, opp: them?.abbrev ?? "", home, gf: Number(me?.score) || 0, ga: Number(them?.score) || 0 };
      })
      .sort((a: NhlTeamGame, b: NhlTeamGame) => a.date.localeCompare(b.date));
  } catch (e) {
    console.warn(`fetchNhlTeamGames(${abbrev}) failed:`, e);
    return [];
  }
}

async function fetchNhlClubStats(abbrev: string): Promise<{ skaters: NhlSkaterLine[]; goalies: NhlGoalie[] }> {
  try {
    const data = await fetchJson(`https://api-web.nhle.com/v1/club-stats/${abbrev}/now`);
    const full = (p: any) => `${p.firstName?.default ?? ""} ${p.lastName?.default ?? ""}`.trim();
    return {
      skaters: (data.skaters ?? []).map((s: any) => ({ name: full(s), gamesPlayed: Number(s.gamesPlayed) || 0, points: Number(s.points) || 0 })),
      goalies: (data.goalies ?? []).map((g: any) => ({
        name: full(g), gamesPlayed: Number(g.gamesPlayed) || 0, savePct: Number(g.savePercentage) || 0, shotsAgainst: Number(g.shotsAgainst) || 0,
      })),
    };
  } catch (e) {
    console.warn(`fetchNhlClubStats(${abbrev}) failed:`, e);
    return { skaters: [], goalies: [] };
  }
}

/** ESPN injury report, keyed by folded team display name. */
async function fetchNhlInjuries(): Promise<Map<string, NhlInjury[]>> {
  const map = new Map<string, NhlInjury[]>();
  try {
    const data = await fetchJson("https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries");
    for (const team of data.injuries ?? []) {
      map.set(nhlFold(team.displayName ?? ""), (team.injuries ?? []).map((i: any) => ({
        name: i.athlete?.displayName ?? "", status: String(i.status ?? ""),
      })));
    }
  } catch (e) {
    console.warn("fetchNhlInjuries failed:", e);
  }
  return map;
}

/** ESPN's probable starting goalie for each side of an event, keyed by ESPN team id. */
async function fetchNhlProbableGoalies(date: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${date.replace(/-/g, "")}`);
    for (const e of data.events ?? []) {
      for (const c of e.competitions?.[0]?.competitors ?? []) {
        const goalie = (c.probables ?? []).find((p: any) => p.name === "probableStartingGoalie")?.athlete?.fullName;
        if (goalie) map.set(`${e.id}:${c.team?.id}`, goalie);
      }
    }
  } catch (e) {
    console.warn("fetchNhlProbableGoalies failed:", e);
  }
  return map;
}

/**
 * Builds the model inputs for every NHL game on tonight's slate. Only the
 * teams playing tonight get their schedule/stats fetched (2 calls each);
 * standings (this season + last), injuries and probable goalies are one
 * call apiece. A team the NHL API can't be matched to is left out, and its
 * game simply gets no moneyline pick.
 */
async function fetchNhlMatchupContexts(games: RawGame[], date: string): Promise<Map<string, NhlMatchupContext>> {
  const result = new Map<string, NhlMatchupContext>();
  const nhlGames = games.filter(g => g.sport === "nhl");
  if (nhlGames.length === 0) return result;

  const seasonEnd = nhlSeasonFor(date);
  const seasonId = `${seasonEnd - 1}${seasonEnd}`;
  const [standings, priorStandings, injuries, probables] = await Promise.all([
    fetchNhlStandingsTable("now"),
    fetchNhlStandingsTable(`${seasonEnd - 1}-04-15`),
    fetchNhlInjuries(),
    fetchNhlProbableGoalies(date),
  ]);
  const oppGdPerGame = new Map(standings.map(r => [r.abbrev, r.gdPerGame]));
  const priorGd = new Map(priorStandings.map(r => [r.abbrev, r.gdPerGame]));
  const abbrevByName = new Map(standings.map(r => [nhlFold(r.name), r.abbrev]));
  const nameByAbbrev = new Map(standings.map(r => [r.abbrev, r.name]));
  const toAbbrev = (espnName: string, espnAbbr: string) =>
    abbrevByName.get(nhlFold(espnName)) ?? ESPN_TO_NHL_ABBREV[espnAbbr] ?? espnAbbr;

  const teamAbbrevs = new Set<string>();
  for (const g of nhlGames) {
    teamAbbrevs.add(toAbbrev(g.homeTeam, g.homeTeamAbbr));
    teamAbbrevs.add(toAbbrev(g.awayTeam, g.awayTeamAbbr));
  }
  const perTeam = new Map<string, { games: NhlTeamGame[]; stats: { skaters: NhlSkaterLine[]; goalies: NhlGoalie[] } }>();
  await Promise.all([...teamAbbrevs].map(async abbrev => {
    const [teamGames, stats] = await Promise.all([fetchNhlTeamGames(abbrev, seasonId, date), fetchNhlClubStats(abbrev)]);
    perTeam.set(abbrev, { games: teamGames, stats });
  }));

  const buildTeam = (game: RawGame, home: boolean): NhlTeamContext | null => {
    const espnName = home ? game.homeTeam : game.awayTeam;
    const abbrev = toAbbrev(espnName, home ? game.homeTeamAbbr : game.awayTeamAbbr);
    const data = perTeam.get(abbrev);
    if (!data || !nameByAbbrev.has(abbrev)) return null;

    const pressure = nhlSchedulePressure(data.games, date, home);
    const last10 = nhlLast10(data.games);
    const goalies = data.stats.goalies.filter(g => g.gamesPlayed > 0);
    const totalShots = goalies.reduce((a, g) => a + g.shotsAgainst, 0);
    const teamSavePct = totalShots > 0 ? goalies.reduce((a, g) => a + g.savePct * g.shotsAgainst, 0) / totalShots : null;
    const espnTeamId = home ? game.homeTeamId : game.awayTeamId;
    const starterName = probables.get(`${game.id}:${espnTeamId}`);
    const starter = starterName
      ? data.stats.goalies.find(g => nhlFold(g.name) === nhlFold(starterName)) ?? { name: starterName, gamesPlayed: 0, savePct: NHL_REPLACEMENT_SAVE_PCT, shotsAgainst: 0 }
      : null;

    const teamGp = data.games.length;
    const injured = injuries.get(nhlFold(espnName)) ?? [];
    const starsOut = injured.flatMap(inj => {
      const line = data.stats.skaters.find(s => nhlFold(s.name) === nhlFold(inj.name));
      if (!line || line.gamesPlayed < Math.max(3, teamGp * 0.5)) return [];
      const ppg = line.points / line.gamesPlayed;
      return ppg >= NHL_STAR_MIN_PPG ? [{ name: line.name, pointsPerGame: ppg, status: inj.status }] : [];
    });

    return {
      abbrev,
      name: espnName,
      games: data.games,
      rating: nhlTeamRating(data.games, oppGdPerGame, priorGd.get(abbrev) ?? null),
      homeSplit: nhlVenueSplit(data.games, true),
      roadSplit: nhlVenueSplit(data.games, false),
      ...pressure,
      last10GdPerGame: last10.gdPerGame,
      last10Record: last10.record,
      starter,
      teamSavePct,
      starsOut,
    };
  };

  for (const g of nhlGames) {
    const home = buildTeam(g, true);
    const away = buildTeam(g, false);
    if (home && away) result.set(g.id, { home, away });
  }
  return result;
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
  const line = p.isAlternateLine ? `Alt ${p.line}` : `${p.line}`;
  return `${p.playerName} ${side} ${line} ${PROP_TYPE_LABELS[p.propType]}`;
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
    leg: { pickId: p.id, matchup: p.matchup, pickLabel: p.pickLabel, sport: p.sport, odds: p.odds, startTime: p.startTime, sportsbook: p.sportsbook },
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
    leg: { pickId: p.id, matchup: p.matchup, pickLabel: propLegLabel(p), sport: p.sport, odds: p.odds, startTime: p.startTime, sportsbook: p.sportsbook },
  }));
}

/**
 * The reusable selection engine behind buildCustomParlay: filters candidates
 * by risk level and sport, then greedily fills legs — highest-composite
 * moneylines first, then highest-composite props up to the per-risk-level cap.
 * A high-voidRisk prop is never eligible, at any risk level. An "Estimated"
 * pick (no real book listed it) is never eligible either — a parlay has to be
 * placeable at one real book, and a synthetic price isn't placeable anywhere.
 */
function selectParlayLegs(picks: BetPick[], propPicks: PropPick[], options: ParlayOptions): ParlayCandidate[] {
  let pickPool = picks.filter(p => p.sportsbook !== ESTIMATED_SOURCE_LABEL);
  let propPool = options.includeProps ? propPicks.filter(p => p.voidRisk !== "high" && p.sportsbook !== ESTIMATED_SOURCE_LABEL) : [];

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
    sportsbook: legs[0].leg.sportsbook,
  };
}

/** The three default parlays shown on the dashboard — safe/value/shot, now built through buildCustomParlay's risk-level rules. */
function buildDefaultParlays(picks: BetPick[], propPicks: PropPick[]): Parlay[] {
  const safe = buildCustomParlay(picks, propPicks, { legs: 3, riskLevel: "safe", includeProps: false });
  const value = buildCustomParlay(picks, propPicks, { legs: 4, riskLevel: "standard", includeProps: true });
  const shot = buildCustomParlay(picks, propPicks, { legs: 5, riskLevel: "risky", includeProps: true });
  return [safe, value, shot].filter((p): p is Parlay => p !== null);
}

// ─── Daily bet selection — 3 singles + 3 committed parlays ──────────────────
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
        sportsbook: item.sportsbook,
      }
    : { pickId: item.id, matchup: item.matchup, pickLabel: item.pickLabel, sport: item.sport, odds: item.odds, startTime: item.startTime, sportsbook: item.sportsbook };
}

/**
 * Top 3 best-bet singles: composite >= 68, sane odds window, sorted tier > EV
 * edge > composite. "Estimated" picks are excluded — nothing gets committed
 * to a synthetic price that no real book actually offered.
 */
function selectBestBets(picks: BetPick[], propPicks: PropPick[]): (BetPick | PropPick)[] {
  const pickPool = picks.filter(p => p.scores.composite >= 68 && p.odds >= -250 && p.odds <= 300 && p.sportsbook !== ESTIMATED_SOURCE_LABEL);
  const propPool = propPicks.filter(p => {
    // hitRateLast10 is always the *over* rate (see scoreProp) — for an
    // "under" pick, a low over-rate is exactly what makes it a good under,
    // so the quality bar has to read the rate in whichever direction was
    // actually recommended, not always the over side.
    const hitRateInDirection = p.recommendedSide === "over" ? p.hitRateLast10 : 1 - p.hitRateLast10;
    return (
      p.scores.composite >= 68 &&
      (p.voidRisk === "low" || p.voidRisk === "medium") &&
      hitRateInDirection >= 0.6 &&
      p.sportsbook !== ESTIMATED_SOURCE_LABEL
    );
  });

  const tierOrder: Record<Tier, number> = { elite: 3, strong: 2, value: 1 };
  const pool: (BetPick | PropPick)[] = [...pickPool, ...propPool];

  pool.sort((a, b) => {
    const tierDiff = tierOrder[b.tier] - tierOrder[a.tier];
    if (tierDiff !== 0) return tierDiff;
    const evDiff = b.evEdge - a.evEdge;
    if (evDiff !== 0) return evDiff;
    return b.scores.composite - a.scores.composite;
  });

  if (pool.length === 0) console.warn("No qualifying picks today");
  return pool.slice(0, 3);
}

/** 2-3 elite/strong moneyline legs, preferring picks not already used as a best bet. */
function selectSafeParlayLegs(picks: BetPick[], excludeIds: Set<string>): BetPick[] {
  const eligible = picks.filter(p =>
    (p.tier === "elite" || p.tier === "strong") && p.odds >= -200 && p.odds <= 150 && p.sportsbook !== ESTIMATED_SOURCE_LABEL
  );
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
  const pickPool = picks.filter(p => p.odds >= -300 && p.odds <= 250 && p.sportsbook !== ESTIMATED_SOURCE_LABEL);
  // voidRisk is "low" only for a QB prop (see scoreProp) — a holdover from
  // MLB's pitcher/batter split, where a batter's lineup spot genuinely isn't
  // locked until close to game time. A starting NFL skill player is just as
  // reliably known pre-game as the QB, and bestBets itself already accepts
  // "medium" risk — excluding it here meant this parlay had nothing to work
  // with on any slate without a qualifying QB prop (e.g. a 1-game Thursday
  // night with no QB prop clearing the bar, even with plenty of good RB/WR
  // props available).
  const propPool = propPicks.filter(p =>
    (p.voidRisk === "low" || p.voidRisk === "medium") && p.odds >= -300 && p.odds <= 250 && p.sportsbook !== ESTIMATED_SOURCE_LABEL
  );
  const combined: (BetPick | PropPick)[] = [...pickPool, ...propPool].sort((a, b) => b.evEdge - a.evEdge);
  if (combined.length === 0) return [];

  const targetLegs = combined.length >= 5 ? 5 : Math.min(4, combined.length);

  // Picks the best legs by edge regardless of type — a moneyline isn't
  // entitled to a slot just because it's a moneyline. A thin slate (e.g. one
  // game) can easily have its best 3-4 edges all be props and nothing worth
  // including on the moneyline side at all, and forcing one in anyway
  // previously meant swapping out a better prop for a worse moneyline purely
  // to satisfy an arbitrary "max 2 props" rule.
  const legs: (BetPick | PropPick)[] = combined.slice(0, targetLegs);
  const usedIds = new Set<string>(legs.map(l => l.id));

  // Payout target +400 to +3000 — top up if short, trim the longest shot if it runs past +3000.
  let payout = calcParlayPayout(legs.map(l => l.odds));
  while (payout < 400 && legs.length < combined.length) {
    const next = combined.find(c => !usedIds.has(c.id));
    if (!next) break;
    legs.push(next);
    usedIds.add(next.id);
    payout = calcParlayPayout(legs.map(l => l.odds));
  }

  // Ids removed for pushing the payout too high this pass never get
  // reconsidered as a "replacement" — without this, a removed leg goes back
  // into usedIds.delete()'s pool immediately, and if the next-best
  // replacement is itself long enough to blow the ceiling right back open,
  // the loop can swap the same two legs back and forth forever (found live
  // on 2026-09-13's first full NFL Sunday slate, where the eligible pool
  // finally had enough long shots to hit this). Tracking `rejected`
  // separately from `usedIds` makes the candidate pool strictly shrink each
  // iteration, which guarantees this terminates.
  const rejected = new Set<string>();
  while (payout > 3000 && legs.length > 0) {
    let longestShotIdx = 0;
    for (let i = 1; i < legs.length; i++) {
      if (legs[i].odds > legs[longestShotIdx].odds) longestShotIdx = i;
    }
    const removed = legs[longestShotIdx];
    rejected.add(removed.id);
    const replacement = combined.find(c => !usedIds.has(c.id) && !rejected.has(c.id));

    legs.splice(longestShotIdx, 1);
    usedIds.delete(removed.id);
    if (!replacement) break; // nothing safer left — accept the payout as-is
    legs.push(replacement);
    usedIds.add(replacement.id);
    payout = calcParlayPayout(legs.map(l => l.odds));
  }

  return legs;
}

/**
 * 2+ heavy-favorite moneyline legs targeting a combined payout near +100 —
 * "double up": stake $10, walk away with $20. Needs legs negative enough
 * that even multiplied together the parlay stays close to even money;
 * lighter favorites (as used by selectSafeParlayLegs) would blow well past
 * +100 the moment a second leg is added.
 */
function selectDoubleUpParlayLegs(picks: BetPick[]): BetPick[] {
  const eligible = picks.filter(p => p.odds <= -110 && p.odds >= -450 && p.sportsbook !== ESTIMATED_SOURCE_LABEL);
  if (eligible.length < 2) return [];

  const byComposite = (a: BetPick, b: BetPick) => b.scores.composite - a.scores.composite;
  const pool = [...eligible].sort(byComposite);

  let legs = pool.slice(0, 2);
  let payout = calcParlayPayout(legs.map(l => l.odds));

  // Target band +70 to +150 (as close to doubling the stake as the board
  // allows) — keep adding the next-best favorite while running too hot.
  for (let i = 2; payout > 150 && i < pool.length; i++) {
    legs.push(pool[i]);
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
    sportsbook: legs[0].sportsbook,
  };
}

/**
 * Recomputes potentialPayout for a single at a new stakeAmount, same formula
 * used at scoring time.
 *
 * `odds: 0` and `stakeAmount: 0` are both real inputs here — emptyParlay()
 * uses exactly that pair as its zeroed-out sentinel when a parlay doesn't
 * have enough qualifying legs, and enforceDailyBudget() runs every bet
 * (including those sentinels) through this function unconditionally. The
 * unguarded formula divides by Math.abs(odds), so odds=0 produces Infinity
 * (or NaN, if stakeAmount is also 0 — 0 * Infinity is NaN) instead of 0.
 * Both serialize to `null` in JSON, which is what broke the summary.
 */
function payoutAt(odds: number, stakeAmount: number): number {
  if (odds === 0 || stakeAmount <= 0) return 0;
  return Math.round((odds > 0 ? stakeAmount + (stakeAmount * odds) / 100 : stakeAmount + (stakeAmount * 100) / Math.abs(odds)) * 100) / 100;
}

/**
 * Caps each bet at 8% of bankroll, then scales all six bets proportionally
 * down (never up) so the combined total never exceeds 20% of bankroll.
 */
function enforceDailyBudget(
  bestBets: (BetPick | PropPick)[], safeParlay: Parlay, highOddsParlay: Parlay, doubleUpParlay: Parlay, bankroll: number
): { bestBets: (BetPick | PropPick)[]; safeParlay: Parlay; highOddsParlay: Parlay; doubleUpParlay: Parlay; totalDailyStake: number } {
  const maxSingle = bankroll * MAX_SINGLE_BET_PCT;
  const cap = (n: number) => Math.min(n, maxSingle);

  const cappedBestBets = bestBets.map(b => cap(b.stakeAmount));
  const cappedSafe = cap(safeParlay.stakeAmount ?? 0);
  const cappedHigh = cap(highOddsParlay.stakeAmount ?? 0);
  const cappedDouble = cap(doubleUpParlay.stakeAmount ?? 0);

  const total = cappedBestBets.reduce((a, b) => a + b, 0) + cappedSafe + cappedHigh + cappedDouble;
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

  const doubleStake = round2(cappedDouble * scale);
  const finalDoubleUpParlay: Parlay = {
    ...doubleUpParlay,
    stakeAmount: doubleStake,
    potentialPayout: payoutAt(doubleUpParlay.estimatedPayout, doubleStake),
    recommendedStake: `$${doubleStake.toFixed(2)}`,
  };

  const totalDailyStake = Math.round(
    (finalBestBets.reduce((a, b) => a + b.stakeAmount, 0) + safeStake + highStake + doubleStake) * 100
  ) / 100;

  return {
    bestBets: finalBestBets, safeParlay: finalSafeParlay, highOddsParlay: finalHighOddsParlay,
    doubleUpParlay: finalDoubleUpParlay, totalDailyStake,
  };
}

interface DailyBetsResult {
  bestBets: (BetPick | PropPick)[];
  safeParlay: Parlay;
  highOddsParlay: Parlay;
  doubleUpParlay: Parlay;
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
  const bestBets = selectBestBets(allPicks, allPropPicks);
  const bestBetIds = new Set(bestBets.map(b => b.id));

  const safeLegs = selectSafeParlayLegs(allPicks, bestBetIds);
  const highLegs = selectHighOddsParlayLegs(allPicks, allPropPicks);
  const doubleLegs = selectDoubleUpParlayLegs(allPicks);

  const safeParlay = safeLegs.length >= 2
    ? buildCommittedParlay(safeLegs, computeParlayStake(safeLegs, bankroll, 1), { id: "safe", label: "💚 Safe Parlay", emoji: "💚" })
    : emptyParlay("safe", "💚 Safe Parlay", "💚");

  // Higher variance (4-5 legs) — stake at 0.4x the full Kelly recommendation.
  const highOddsParlay = highLegs.length >= 2
    ? buildCommittedParlay(highLegs, computeParlayStake(highLegs, bankroll, 0.4), { id: "shot", label: "🚀 High Odds Parlay", emoji: "🚀" })
    : emptyParlay("shot", "🚀 High Odds Parlay", "🚀");

  // Heavy favorites, near-even payout — stake at 0.7x Kelly (lower variance than the other two).
  const doubleUpParlay = doubleLegs.length >= 2
    ? buildCommittedParlay(doubleLegs, computeParlayStake(doubleLegs, bankroll, 0.7), { id: "double", label: "2️⃣ Double Up Parlay", emoji: "2️⃣" })
    : emptyParlay("double", "2️⃣ Double Up Parlay", "2️⃣");

  return enforceDailyBudget(bestBets, safeParlay, highOddsParlay, doubleUpParlay, bankroll);
}

// ─── Data sources ────────────────────────────────────────────────────────────
function normalizeTeamName(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
 *
 * NFL and NHL run against completely separate bankrolls: `?ledger=nhl` reads
 * the NHL ledger at /nhl-data/bankroll.json; anything else keeps the original
 * NFL ledger at /bankroll.json, so existing callers are unchanged.
 */
async function fetchBankrollState(req: ApiRequest): Promise<BankrollState> {
  const host = selfBaseUrl(req);
  if (!host) return DEFAULT_BANKROLL_STATE;

  const ledgerPath = req.query.ledger === "nhl" ? "/nhl-data/bankroll.json" : "/bankroll.json";
  try {
    const data = await fetchJson(`https://${host}${ledgerPath}`);
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
        homeTeamAbbr: "",
        awayTeamAbbr: "",
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
        // ESPN's own numeric team id — used for NFL prop roster/game-log lookups (see fetchNflRosterOffense).
        homeTeamId: parseInt(home?.team?.id, 10) || 0,
        awayTeamId: parseInt(away?.team?.id, 10) || 0,
        homeTeamAbbr: home?.team?.abbreviation ?? "",
        awayTeamAbbr: away?.team?.abbreviation ?? "",
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

// ─── College football (ESPN, filtered to SEC/Big Ten/ACC) ──────────────────
//
// ESPN's college football scoreboard covers every FBS game — hundreds of
// teams across dozens of conferences — so a plain date fetch (like NFL/NHL
// use) would flood the pool with games nobody asked for. Its `groups=`
// param filters server-side to one conference's games (any game with at
// least one participant from that conference — a marquee team's game
// against a smaller program still counts), so this fetches SEC/Big Ten/ACC
// separately and merges, deduping by event id for cross-conference games
// that show up in two of the three fetches (e.g. an SEC-vs-ACC matchup).
const NCAAF_CONFERENCE_GROUPS: Record<string, string> = { SEC: "8", "Big Ten": "5", ACC: "1" };

async function fetchNcaafGames(date: string): Promise<SportResult> {
  const label = SPORT_LABELS.ncaaf;
  const dateParam = date.replace(/-/g, "");

  try {
    const perConference = await Promise.all(
      Object.values(NCAAF_CONFERENCE_GROUPS).map(groupId =>
        fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${dateParam}&groups=${groupId}`)
      )
    );

    const eventsById = new Map<string, any>();
    for (const data of perConference) {
      for (const e of (data.events ?? []) as any[]) eventsById.set(String(e.id), e);
    }

    const upcoming = [...eventsById.values()].filter((e: any) => e.status?.type?.state === "pre");

    if (upcoming.length === 0) {
      return {
        games: [],
        status: { sport: "ncaaf", label, active: false, note: "No upcoming SEC/Big Ten/ACC games today (usually a non-Saturday)." },
      };
    }

    const parseRecord = (c: any): TeamRecord => {
      const summary = c?.records?.find((r: any) => r.type === "total")?.summary ?? c?.records?.[0]?.summary ?? "";
      const match = /^(\d+)-(\d+)/.exec(summary);
      const wins = match ? parseInt(match[1], 10) : 0;
      const losses = match ? parseInt(match[2], 10) : 0;
      return { wins, losses, winPct: wins + losses > 0 ? wins / (wins + losses) : 0.5 };
    };

    const games: ScheduledGame[] = upcoming.map((e: any) => {
      const comp = e.competitions?.[0];
      const competitors: any[] = comp?.competitors ?? [];
      const home = competitors.find(c => c.homeAway === "home");
      const away = competitors.find(c => c.homeAway === "away");

      return {
        id: String(e.id),
        sport: "ncaaf",
        homeTeam: home?.team?.displayName ?? "Home",
        awayTeam: away?.team?.displayName ?? "Away",
        homeTeamId: parseInt(home?.team?.id, 10) || 0,
        awayTeamId: parseInt(away?.team?.id, 10) || 0,
        homeTeamAbbr: "",
        awayTeamAbbr: "",
        startTime: e.date,
        venue: comp?.venue?.fullName ?? "",
        homeRecord: parseRecord(home),
        awayRecord: parseRecord(away),
        // Same as NFL/NHL: ESPN's scoreboard doesn't expose per-team game
        // logs, so recent form is left empty and momentum falls back to the
        // series-advantage half of its formula.
        homeRecentForm: [],
        awayRecentForm: [],
        homeSeriesWins: 0,
        awaySeriesWins: 0,
        notes: "",
      };
    });

    return {
      games,
      status: { sport: "ncaaf", label, active: true, note: `${games.length} game${games.length === 1 ? "" : "s"} scheduled today (SEC/Big Ten/ACC)` },
    };
  } catch (e) {
    console.warn("NCAAF schedule fetch failed:", e);
    return { games: [], status: { sport: "ncaaf", label, active: false, note: "NCAAF schedule feed unreachable." } };
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

/** One game's worth of a stat category. Fields not relevant to the fetch (pitching/hitting vs NFL) are left undefined. */
interface GameLogEntry {
  date?: string; // YYYY-MM-DD, used for the fatigue signal in propContextScore
  strikeouts?: number;
  outs?: number;
  hits?: number;
  totalBases?: number;
  homeRuns?: number;
  atBats?: number;
  passingYards?: number;
  rushingYards?: number;
  receivingYards?: number;
  goals?: number;
  assists?: number;
  points?: number;
  shotsOnGoal?: number;
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
  /** Each candidate book's own price — nothing blended. Absent key = that book didn't list this game. */
  byBook: Partial<Record<Sportsbook, GameOdds>>;
}

/** Pulls each candidate book's own home/away price out of one OddsAPI game entry — no cross-book blending. */
function extractBookOdds(game: any): Partial<Record<Sportsbook, GameOdds>> {
  const byBook: Partial<Record<Sportsbook, GameOdds>> = {};

  for (const bm of game.bookmakers ?? []) {
    const book = bm.key as Sportsbook;
    if (!SPORTSBOOKS.includes(book)) continue;

    const h2h = (bm.markets ?? []).find((m: any) => m.key === "h2h");
    if (!h2h) continue;

    let homeMoneyline: number | null = null;
    let awayMoneyline: number | null = null;
    for (const outcome of h2h.outcomes ?? []) {
      if (outcome.name === game.home_team) homeMoneyline = outcome.price;
      else if (outcome.name === game.away_team) awayMoneyline = outcome.price;
    }

    if (homeMoneyline !== null || awayMoneyline !== null) byBook[book] = { homeMoneyline, awayMoneyline };
  }

  return byBook;
}

async function fetchOddsForSport(sport: Sport): Promise<OddsApiEntry[]> {
  const sportKey = ODDS_SPORT_KEYS[sport];
  if (!ODDS_API_KEY || !sportKey) return [];

  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american&bookmakers=${SPORTSBOOKS.join(",")}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`OddsAPI ${sport} failed: ${res.status}`);
      return [];
    }
    const raw = (await res.json()) as any[];
    return raw.map(g => ({
      id: String(g.id),
      homeTeam: g.home_team,
      awayTeam: g.away_team,
      byBook: extractBookOdds(g),
    }));
  } catch (e) {
    console.warn(`OddsAPI ${sport} fetch threw:`, e);
    return [];
  }
}

/**
 * Picks the one book every pick/leg today will be priced from — whichever of
 * the candidates lists a price for the most games across every sport in this
 * run, tie-broken by SPORTSBOOKS order. Returns null only when none of them
 * listed anything at all (no ODDS_API_KEY, or every fetch failed).
 */
function chooseSportsbook(oddsBySport: Record<string, OddsApiEntry[]>): Sportsbook | null {
  const counts: Record<Sportsbook, number> = { draftkings: 0, fanduel: 0, betmgm: 0 };

  for (const entries of Object.values(oddsBySport)) {
    for (const entry of entries) {
      for (const book of SPORTSBOOKS) {
        if (entry.byBook[book]) counts[book] += 1;
      }
    }
  }

  let best: Sportsbook | null = null;
  for (const book of SPORTSBOOKS) {
    if (best === null || counts[book] > counts[best]) best = book;
  }
  return best && counts[best] > 0 ? best : null;
}

// ─── Prop odds (selective — top 5 games only, to stay within OddsAPI's free tier) ──
interface PropOddsEntry {
  line: number;
  overOdds: number;
  underOdds: number;
  /** The chosen book for a real quote, or "estimated" — see resolvePropOddsCandidates's fallback branch. */
  sportsbook: Sportsbook | "estimated";
  /** From an OddsAPI "_alternate" market — a different point total than the book's main line. See pickPropPick. */
  isAlternate: boolean;
}
/** key: "playerName-propType" → every line OddsAPI quoted for that player/prop, main line and alternates together. */
type PropOddsMap = Map<string, PropOddsEntry[]>;

const MLB_PROP_MARKETS = "pitcher_strikeouts,batter_hits,batter_home_runs,batter_total_bases,"
  + "pitcher_strikeouts_alternate,batter_hits_alternate,batter_home_runs_alternate,batter_total_bases_alternate";
const NFL_PROP_MARKETS = "player_pass_yds,player_rush_yds,player_reception_yds,"
  + "player_pass_yds_alternate,player_rush_yds_alternate,player_reception_yds_alternate";
// Main lines only, no alternates — each market costs a credit per game, and
// NHL has to fit beside NFL in the 500-credit plan (see NHL_TOP_GAMES_FOR_PROPS).
const NHL_PROP_MARKETS = "player_goals,player_assists,player_points,player_shots_on_goal";
const PROP_MARKETS_BY_SPORT: Partial<Record<Sport, string>> = {
  mlb: MLB_PROP_MARKETS,
  nfl: NFL_PROP_MARKETS,
  nhl: NHL_PROP_MARKETS,
};
const ODDS_API_MARKET_TO_PROP: Record<string, PropType> = {
  pitcher_strikeouts: "pitcher_strikeouts",
  batter_hits: "batter_hits",
  batter_home_runs: "batter_home_runs",
  batter_total_bases: "batter_total_bases",
  player_pass_yds: "player_pass_yards",
  player_rush_yds: "player_rush_yards",
  player_reception_yds: "player_receiving_yards",
  pitcher_strikeouts_alternate: "pitcher_strikeouts",
  batter_hits_alternate: "batter_hits",
  batter_home_runs_alternate: "batter_home_runs",
  batter_total_bases_alternate: "batter_total_bases",
  player_pass_yds_alternate: "player_pass_yards",
  player_rush_yds_alternate: "player_rush_yards",
  player_reception_yds_alternate: "player_receiving_yards",
  player_goals: "player_goals",
  player_assists: "player_assists",
  player_points: "player_points",
  player_shots_on_goal: "player_shots_on_goal",
};

/** Same book chosen for moneylines — a parlay leg can't come from a different book than the rest of the slip. */
async function fetchPropOddsForGame(eventId: string, book: Sportsbook, sport: Sport): Promise<PropOddsMap> {
  const map: PropOddsMap = new Map();
  const markets = PROP_MARKETS_BY_SPORT[sport];
  const sportKey = ODDS_SPORT_KEYS[sport];
  if (!ODDS_API_KEY || !markets || !sportKey) return map;

  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds`
      + `?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=american&bookmakers=${book}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`OddsAPI props ${eventId} failed: ${res.status}`);
      return map;
    }
    const data: any = await res.json();

    // Pair each player+propType+line's over and under quote from this one book.
    // Bucketing by line (not just player+propType) is what lets the main line
    // and every alternate line coexist instead of overwriting each other.
    const buckets = new Map<string, { line: number; propType: PropType; player: string; isAlternate: boolean; overOdds?: number; underOdds?: number }>();

    for (const bm of data.bookmakers ?? []) {
      if (bm.key !== book) continue; // the query already scopes to one book — defensive only
      for (const market of bm.markets ?? []) {
        const propType = ODDS_API_MARKET_TO_PROP[market.key as string];
        if (!propType) continue;
        const isAlternate = String(market.key).endsWith("_alternate");

        for (const outcome of market.outcomes ?? []) {
          const player = outcome.description ?? outcome.name;
          const side = String(outcome.name ?? "").toLowerCase();
          const line = Number(outcome.point);
          if (!player || (side !== "over" && side !== "under") || Number.isNaN(line)) continue;

          const key = `${player}-${propType}-${line}`;
          if (!buckets.has(key)) buckets.set(key, { line, propType, player, isAlternate });
          const bucket = buckets.get(key)!;
          if (side === "over") bucket.overOdds = outcome.price;
          else bucket.underOdds = outcome.price;
        }
      }
    }

    for (const bucket of buckets.values()) {
      // Only lines the book actually priced on BOTH sides are usable. Alternate
      // ladders usually quote just the over at long odds (e.g. Over 199.5
      // rushing at +3200); this used to fill the missing side with a made-up
      // -110, which turned "Under 199.5" into a fictional near-free bet with a
      // 40-point phantom edge. A one-sided quote has no real opposing price to
      // anchor against, so it's skipped rather than guessed at.
      if (bucket.overOdds === undefined || bucket.underOdds === undefined) continue;
      const key = `${bucket.player}-${bucket.propType}`;
      const entry: PropOddsEntry = {
        line: bucket.line,
        overOdds: bucket.overOdds,
        underOdds: bucket.underOdds,
        sportsbook: book,
        isAlternate: bucket.isAlternate,
      };
      const list = map.get(key);
      if (list) list.push(entry);
      else map.set(key, [entry]);
    }
  } catch (e) {
    console.warn(`OddsAPI props fetch threw for ${eventId}:`, e);
  }

  return map;
}

/** Fetches prop markets for up to TOP_GAMES_FOR_PROPS OddsAPI event ids in parallel and merges the results. */
async function fetchPropOdds(gameIds: string[], sport: Sport, book: Sportsbook | null): Promise<PropOddsMap> {
  const merged: PropOddsMap = new Map();
  if (!PROP_MARKETS_BY_SPORT[sport] || gameIds.length === 0 || !book) return merged;

  const perGame = await Promise.all(gameIds.slice(0, TOP_GAMES_FOR_PROPS).map(id => fetchPropOddsForGame(id, book, sport)));
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

function attachOdds(games: ScheduledGame[], oddsBySport: Record<string, OddsApiEntry[]>, chosenBook: Sportsbook | null): RawGame[] {
  return games.map(g => {
    const pool = oddsBySport[g.sport] ?? [];
    const match = pool.find(
      o => normalizeTeamName(o.homeTeam) === normalizeTeamName(g.homeTeam) &&
           normalizeTeamName(o.awayTeam) === normalizeTeamName(g.awayTeam)
    );

    const bookOdds = chosenBook ? match?.byBook[chosenBook] : undefined;

    if (bookOdds && (bookOdds.homeMoneyline !== null || bookOdds.awayMoneyline !== null)) {
      return { ...g, odds: bookOdds, sportsbook: chosenBook! };
    }
    return { ...g, odds: estimateOddsFromRecords(g.homeRecord, g.awayRecord), sportsbook: "estimated" as const };
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
    case "player_pass_yards": return entry.passingYards ?? 0;
    case "player_rush_yards": return entry.rushingYards ?? 0;
    case "player_receiving_yards": return entry.receivingYards ?? 0;
    case "player_goals": return entry.goals ?? 0;
    case "player_assists": return entry.assists ?? 0;
    case "player_points": return entry.points ?? 0;
    case "player_shots_on_goal": return entry.shotsOnGoal ?? 0;
    default: return 0;
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

function recentAverageForPropType(recentAvg: { strikeouts?: number; outs?: number; hits?: number; totalBases?: number; homeRuns?: number; passingYards?: number; rushingYards?: number; receivingYards?: number; goals?: number; assists?: number; points?: number; shotsOnGoal?: number }, propType: PropType): number {
  switch (propType) {
    case "pitcher_strikeouts": return recentAvg.strikeouts ?? 0;
    case "pitcher_outs": return recentAvg.outs ?? 0;
    case "batter_hits": return recentAvg.hits ?? 0;
    case "batter_total_bases": return recentAvg.totalBases ?? 0;
    case "batter_home_runs": return recentAvg.homeRuns ?? 0;
    case "player_pass_yards": return recentAvg.passingYards ?? 0;
    case "player_rush_yards": return recentAvg.rushingYards ?? 0;
    case "player_receiving_yards": return recentAvg.receivingYards ?? 0;
    case "player_goals": return recentAvg.goals ?? 0;
    case "player_assists": return recentAvg.assists ?? 0;
    case "player_points": return recentAvg.points ?? 0;
    case "player_shots_on_goal": return recentAvg.shotsOnGoal ?? 0;
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

/**
 * `opponentRankContext` is a pre-built phrase like "has the 5th best run
 * defense in the league" (see nflDefenseRank) — callers with real league-wide
 * rank data pass it in; others (MLB, or an NFL team not yet in this season's
 * table) pass null and get the older generic favorable/tough/neutral read of
 * matchupScore instead.
 */
function buildPropRationale(
  playerName: string, propType: PropType, line: number, side: PropSide,
  hitRateLast10: number, sampleSize: number, recentAverage: number, opponent: string, matchupScore: number,
  estimatedHitPct: number, impliedHitPct: number, evEdge: number, opponentRankContext: string | null
): string {
  const label = PROP_TYPE_LABELS[propType];
  const matchupSentence = opponentRankContext
    ? `They're up against ${opponent}, who ${opponentRankContext}.`
    : `Matchup vs ${opponent}: ${matchupScore >= 65 ? "favorable" : matchupScore <= 35 ? "tough" : "neutral"}.`;

  return [
    `${playerName} has cleared ${line} ${label.toLowerCase()} in ${Math.round(hitRateLast10 * sampleSize)} of their last ${sampleSize} game${sampleSize === 1 ? "" : "s"} (avg: ${recentAverage.toFixed(1)}).`,
    matchupSentence,
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
  /** True if this week's injury report lists the player Out/Doubtful/IR/suspended — see fetchNflGameInjuries. Always false for MLB (no feed wired up for it yet). */
  injuryConcern: boolean;
}

interface PropGameContext {
  gameId: string;
  sport: Sport;
  matchup: string;
  startTime: string;
}

function scoreProp(
  candidate: PropCandidateInput,
  log: { last10: GameLogEntry[]; last20: GameLogEntry[]; recentAvg: { strikeouts?: number; outs?: number; hits?: number; totalBases?: number; homeRuns?: number; passingYards?: number; rushingYards?: number; receivingYards?: number; goals?: number; assists?: number; points?: number; shotsOnGoal?: number } },
  oddsEntry: PropOddsEntry,
  matchupScore: number,
  game: PropGameContext,
  bankrollState: BankrollState,
  /** See buildPropRationale — a pre-built "has the Nth best X defense in the league" phrase, NFL-only for now. */
  opponentRankContext: string | null = null
): PropPick | null {
  const { propType, line } = { propType: candidate.propType, line: oddsEntry.line };
  if (log.last10.length === 0) return null; // no game-log history to score from

  const hitRateOver10 = hitRateFor(log.last10, propType, line, "over");
  const hitRateOver20 = hitRateFor(log.last20, propType, line, "over");
  // A flat 10/20-game blend dilutes a genuine recent role change (a bigger
  // workload from an injury elsewhere on the offense, a new starting job,
  // etc.) by averaging it against games from before the change happened —
  // exactly what happened with a Browns RB who'd clearly taken on a bigger
  // role the last few weeks while his 10-game average still looked modest.
  // Giving the most recent games extra say (they're already included in
  // hitRateOver10 too, so this just up-weights them further) surfaces that
  // kind of shift without needing to trace it to a specific cause.
  const RECENT_FORM_GAMES = 3;
  const hitRateRecent = hitRateFor(log.last10.slice(0, RECENT_FORM_GAMES), propType, line, "over");
  const weightedOverRate = hitRateRecent * 0.35 + hitRateOver10 * 0.4 + hitRateOver20 * 0.25;

  // The trailing hit-rate is an average against whichever opponents the
  // player already faced — it says nothing about *this* week's specific
  // matchup. matchupScore (0-100, 50 = neutral) already measures how this
  // week's opponent compares to a league-average defense in this exact stat
  // category (see matchupScoreForNflProp/matchupScoreForPitcherStrikeouts/
  // matchupScoreForBatterProps); nudge the trailing rate toward what that
  // matchup alone would suggest before blending with the market below, so a
  // strong recent stretch against a bottom-ranked defense is discounted
  // against a legitimately tough one this week, and vice versa. Kept modest
  // (±15 points at the scoring functions' own 20-90 clamp) since matchup
  // quality is a real but secondary signal, not a substitute for market
  // pricing.
  const matchupAdjustment = (matchupScore - 50) / 200;
  const matchupAdjustedRate = Math.min(Math.max(weightedOverRate + matchupAdjustment, 0), 1);

  const impliedOverPct = oddsToImpliedProb(oddsEntry.overOdds);
  const impliedUnderPct = oddsToImpliedProb(oddsEntry.underOdds);

  // The (matchup-adjusted) trailing hit-rate is still a weak, noisy signal
  // on its own — a 1-2 game sample is either a 100% or 0% "hit rate" by
  // construction, and even a full 10-game sample is just one player's
  // game-to-game variance, not a market-grade estimate. The book's own price
  // already reflects the same recent form (that's how lines get set), so it
  // is a far better starting point than a naive coin flip. The trailing rate
  // is only allowed to pull the estimate part-way from that market price —
  // capped at MAX_SIGNAL_WEIGHT even with a full sample — so a real edge
  // shows up as a few points over the market, not a 30-50 point mismatch
  // (a 3-week audit found every prior pick claiming exactly that kind of
  // implausible edge, and the ones with the *most* claimed edge performed
  // worst — a sign the raw hit-rate signal was swamping the market price
  // instead of merely nudging it).
  const MAX_SIGNAL_WEIGHT = 0.35;
  const sampleConfidence = Math.min(log.last10.length, 10) / 10;
  const signalWeight = MAX_SIGNAL_WEIGHT * sampleConfidence;

  const estimatedOverPct = Math.min(Math.max(
    impliedOverPct + (matchupAdjustedRate - impliedOverPct) * signalWeight, 0.01
  ), 0.99);
  const estimatedUnderPct = 1 - estimatedOverPct;

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

  // Void risk: an injury-report hit overrides everything else — a player
  // listed Out/Doubtful/IR/suspended this week is liable to not play at all,
  // which wastes one of the day's limited best-bet slots on a prop likely to
  // just void rather than win or lose. Otherwise, pitcher props only reach
  // here once a confirmed probable starter exists, so they're "low"; batter
  // lineups aren't official this far ahead of game time, so batter props
  // default to "medium".
  const voidRisk: VoidRisk = candidate.injuryConcern ? "high" : candidate.isPitcher ? "low" : "medium";

  let stakeAmount = kellyStake(bankrollState.currentBankroll, estimatedHitPct, odds);
  if (voidRisk === "medium") stakeAmount = Math.round(stakeAmount * 0.6 * 2) / 2;
  // An injury-flagged player is dropped entirely rather than surfaced as a
  // visible-but-ineligible prop — there's no betting value in showing a line
  // for someone who may not take the field.
  if (voidRisk === "high" || stakeAmount <= 0) return null;

  const potentialPayout = Math.round(
    (odds > 0 ? stakeAmount + (stakeAmount * odds) / 100 : stakeAmount + (stakeAmount * 100) / Math.abs(odds)) * 100
  ) / 100;

  const recentAverage = recentAverageForPropType(log.recentAvg, propType);

  return {
    id: `${game.gameId}-prop-${normalizeTeamName(candidate.playerName)}-${propType}${oddsEntry.isAlternate ? `-alt${line}` : ""}`,
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
      hitRateOver10, log.last10.length, recentAverage, candidate.opponent, matchupScore,
      estimatedHitPct, impliedHitPct, evEdge, opponentRankContext
    ),
    stakeAmount,
    potentialPayout,
    voidRisk,
    isPositiveEV: true,
    isAlternateLine: oddsEntry.isAlternate,
    sportsbook: sportsbookLabel(oddsEntry.sportsbook),
  };
}

/**
 * Odds worse (more negative) than this are "too risky" for a single prop
 * bet — laying a lot of money to win a little. -200 means risking $200 to
 * win $100, i.e. needing to be right more than 2 times in 3 just to break
 * even on the juice alone.
 */
const PROP_RISK_ODDS_THRESHOLD = -200;

/**
 * Picks one PropPick to actually bet from every (main line + alternate
 * lines) candidate scored for a player+propType. The main line wins by
 * default; it only gets passed over when its own odds are too risky, in
 * which case the safest positive-EV alternate line takes its place instead
 * of skipping the player entirely. If every alternate is just as risky, the
 * main line is kept rather than betting nothing.
 */
function pickPropPick(candidates: PropPick[]): PropPick | null {
  if (candidates.length === 0) return null;

  const main = candidates.find(c => !c.isAlternateLine);
  if (!main || main.odds >= PROP_RISK_ODDS_THRESHOLD) {
    return main ?? [...candidates].sort((a, b) => b.scores.composite - a.scores.composite)[0];
  }

  const saferAlts = candidates
    .filter(c => c.isAlternateLine && c.odds >= PROP_RISK_ODDS_THRESHOLD)
    .sort((a, b) => b.scores.composite - a.scores.composite);

  return saferAlts[0] ?? main;
}

// ─── Prop orchestration (top TOP_GAMES_FOR_PROPS MLB games only) ───────────
/** Real OddsAPI line(s) (main + any alternates) if available, else a single recent-average estimate described in Step 3. */
function resolvePropOddsCandidates(
  map: PropOddsMap, playerName: string, propType: PropType,
  recentAvg: { strikeouts?: number; outs?: number; hits?: number; totalBases?: number; homeRuns?: number },
  statKey: "strikeouts" | "outs" | "hits" | "totalBases" | "homeRuns"
): PropOddsEntry[] {
  const real = map.get(`${playerName}-${propType}`);
  if (real && real.length > 0) return real;

  const avg = recentAvg[statKey] ?? 0;
  if (propType === "pitcher_strikeouts") {
    return [{ line: Math.round(avg * 10) / 10 - 0.5, overOdds: -115, underOdds: -105, sportsbook: "estimated", isAlternate: false }];
  }
  if (propType === "batter_hits") {
    return [{ line: avg >= 1.2 ? 1.5 : 0.5, overOdds: -115, underOdds: -105, sportsbook: "estimated", isAlternate: false }];
  }
  // No explicit fallback formula given for total_bases/home_runs/outs — extrapolate
  // the same "recent average rounded to the nearest half, minus half" convention.
  return [{ line: Math.max(0.5, Math.round(avg * 2) / 2 - 0.5), overOdds: -115, underOdds: -105, sportsbook: "estimated", isAlternate: false }];
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
      const candidates = resolvePropOddsCandidates(propOddsMap, pitcher.name, propType, log.recentAvg, statKey)
        .map(oddsEntry => scoreProp(
          { playerId: pitcher.id, playerName: pitcher.name, team, opponent, isHome, isPitcher: true, propType, fatigued, injuryConcern: false },
          log, oddsEntry, matchupScore, gameCtx, bankrollState
        ))
        .filter((p): p is PropPick => p !== null);
      const pick = pickPropPick(candidates);
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
      const candidates = resolvePropOddsCandidates(propOddsMap, batter.fullName, propType, log.recentAvg, statKey)
        .map(oddsEntry => scoreProp(
          { playerId: batter.id, playerName: batter.fullName, team, opponent, isHome, isPitcher: false, propType, fatigued, injuryConcern: false },
          log, oddsEntry, matchupScore, gameCtx, bankrollState
        ))
        .filter((p): p is PropPick => p !== null);
      const pick = pickPropPick(candidates);
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
async function buildMlbPropPicks(
  moneylinePicks: BetPick[],
  rawGames: RawGame[],
  mlbOddsEntries: OddsApiEntry[],
  bankrollState: BankrollState,
  date: string,
  book: Sportsbook | null
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

  const propOddsMap = await fetchPropOdds([...eventIdByGameId.values()], "mlb", book);
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

// ─── NFL prop data (ESPN's free hidden APIs — roster + per-athlete game log, no key required) ──
//
// NFL has no "probable starter" feed like MLB's, and no reliable free depth-
// chart endpoint either (see research notes in the PR — roster order is
// alphabetical, not depth order). So this pipeline is odds-first instead of
// roster-first: it only ever scores a player OddsAPI is actually offering a
// line for (books already imply who the plausible starters are), then
// resolves that player's name to an ESPN athlete id via the team roster
// purely to pull their game log.
interface NflRosterPlayer {
  id: number;
  fullName: string;
  position: string;
}

/** Active offense-group skill players (QB/RB/WR/TE) — the only positions the three wired-up prop markets cover. */
async function fetchNflRosterOffense(teamId: number): Promise<NflRosterPlayer[]> {
  try {
    const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/roster`);
    const offense = (data.athletes ?? []).find((g: any) => g.position === "offense");
    const items: any[] = offense?.items ?? [];

    return items
      .filter((p: any) => ["QB", "RB", "WR", "TE"].includes(p.position?.abbreviation) && p.status?.type === "active")
      .map((p: any) => ({ id: parseInt(p.id, 10), fullName: p.fullName ?? "Unknown", position: p.position.abbreviation }))
      .filter((p: NflRosterPlayer) => Number.isFinite(p.id));
  } catch (e) {
    console.warn(`fetchNflRosterOffense(${teamId}) failed:`, e);
    return [];
  }
}

/**
 * One season's regular-season game log for an NFL athlete, most-recent-game
 * first (ESPN already returns it in that order). `names` maps each `stats`
 * array by index to a stat key — only the three this pipeline scores
 * (passing/rushing/receiving yards) are pulled out; everything else in the
 * row is ignored.
 */
async function fetchNflSeasonGameLog(playerId: number, season: number): Promise<GameLogEntry[]> {
  try {
    const data = await fetchJson(
      `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${playerId}/gamelog?season=${season}`
    );
    const names: string[] = data.names ?? [];
    const regularSeason = (data.seasonTypes ?? []).find((st: any) => /Regular Season/i.test(st.displayName ?? ""));
    const events: any[] = (regularSeason?.categories ?? []).flatMap((c: any) => c.events ?? []);

    return events.map((ev: any) => {
      const meta = data.events?.[ev.eventId];
      const entry: GameLogEntry = { date: meta?.gameDate ? String(meta.gameDate).slice(0, 10) : undefined };
      names.forEach((name: string, i: number) => {
        if (name !== "passingYards" && name !== "rushingYards" && name !== "receivingYards") return;
        const val = Number(ev.stats?.[i]);
        (entry as any)[name] = Number.isFinite(val) ? val : 0;
      });
      return entry;
    });
  } catch (e) {
    console.warn(`fetchNflSeasonGameLog(${playerId}, ${season}) failed:`, e);
    return [];
  }
}

interface NflGameLogResult {
  last10: GameLogEntry[];
  last20: GameLogEntry[];
  recentAvg: { passingYards: number; rushingYards: number; receivingYards: number };
}

/**
 * Early in a new season there are only 1-2 current-season games to score
 * from — nowhere near enough to trust a hit rate (a single game is either a
 * 100% or 0% "hit rate", which scoreProp's clamp then reads as near-certain).
 * Pad the current season's games out with the tail of the prior season
 * (already most-recent-first, so concatenating keeps recency order) until
 * there's a real sample to work with, rather than only falling back when
 * the current season is completely empty.
 */
const NFL_MIN_GAMELOG_SAMPLE = 10;

async function fetchNflPlayerGameLog(playerId: number, season: number): Promise<NflGameLogResult> {
  let events = await fetchNflSeasonGameLog(playerId, season);
  if (events.length < NFL_MIN_GAMELOG_SAMPLE) {
    const prior = await fetchNflSeasonGameLog(playerId, season - 1);
    events = events.concat(prior.slice(0, NFL_MIN_GAMELOG_SAMPLE - events.length));
  }

  const last20 = events.slice(0, 20);
  const last10 = events.slice(0, 10);
  const avg = (key: "passingYards" | "rushingYards" | "receivingYards") =>
    last10.length > 0 ? last10.reduce((a, b) => a + (b[key] ?? 0), 0) / last10.length : 0;

  return {
    last10, last20,
    recentAvg: { passingYards: avg("passingYards"), rushingYards: avg("rushingYards"), receivingYards: avg("receivingYards") },
  };
}

/** ESPN's team abbreviation, translated to nflverse's team code — the two disagree only on the Rams and Commanders. */
function toNflverseAbbr(espnAbbr: string): string {
  if (espnAbbr === "LAR") return "LA";
  if (espnAbbr === "WSH") return "WAS";
  return espnAbbr;
}

interface NflDefenseAllowed {
  passYardsAllowed: number;
  rushYardsAllowed: number;
  recYardsAllowed: number;
  gamesPlayed: number;
}

/**
 * Per-team yards allowed so far this season, averaged per game, from
 * nflverse's weekly team-stats release — an open, freely-licensed dataset
 * built from play-by-play data (https://github.com/nflverse/nflverse-data,
 * no auth or ToS restriction on programmatic access, unlike consumer sites
 * such as Linemate). Each row is one team's own offensive output in one
 * game; "yards allowed by team X's defense" is every other team's output in
 * games where X was the opponent, which is why this keys off the
 * `opponent_team` column rather than `team`. Small file (a few hundred KB
 * at most), so no local caching beyond one fetch per request.
 */
async function fetchNflDefenseStats(season: number): Promise<Map<string, NflDefenseAllowed>> {
  const map = new Map<string, NflDefenseAllowed>();
  try {
    const res = await fetch(
      `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (!res.ok) return map;
    const text = await res.text();
    const [headerLine, ...rows] = text.trim().split("\n");
    const headers = headerLine.split(",");
    const oppIdx = headers.indexOf("opponent_team");
    const passIdx = headers.indexOf("passing_yards");
    const rushIdx = headers.indexOf("rushing_yards");
    const recIdx = headers.indexOf("receiving_yards");
    if (oppIdx === -1 || passIdx === -1 || rushIdx === -1 || recIdx === -1) return map;

    for (const row of rows) {
      if (!row) continue;
      const cols = row.split(",");
      const opp = cols[oppIdx];
      if (!opp) continue;
      const entry = map.get(opp) ?? { passYardsAllowed: 0, rushYardsAllowed: 0, recYardsAllowed: 0, gamesPlayed: 0 };
      entry.passYardsAllowed += Number(cols[passIdx]) || 0;
      entry.rushYardsAllowed += Number(cols[rushIdx]) || 0;
      entry.recYardsAllowed += Number(cols[recIdx]) || 0;
      entry.gamesPlayed += 1;
      map.set(opp, entry);
    }
    for (const entry of map.values()) {
      entry.passYardsAllowed /= entry.gamesPlayed;
      entry.rushYardsAllowed /= entry.gamesPlayed;
      entry.recYardsAllowed /= entry.gamesPlayed;
    }
  } catch (e) {
    console.warn(`fetchNflDefenseStats(${season}) failed:`, e);
  }
  return map;
}

/** League-wide average of each per-game allowed-yards category, for normalizing one team's number against the field. */
function leagueAvgAllowed(defenseStats: Map<string, NflDefenseAllowed>): NflDefenseAllowed | null {
  const teams = [...defenseStats.values()];
  if (teams.length === 0) return null;
  const avg = (key: "passYardsAllowed" | "rushYardsAllowed" | "recYardsAllowed") =>
    teams.reduce((a, b) => a + b[key], 0) / teams.length;
  return {
    passYardsAllowed: avg("passYardsAllowed"),
    rushYardsAllowed: avg("rushYardsAllowed"),
    recYardsAllowed: avg("recYardsAllowed"),
    gamesPlayed: teams.reduce((a, b) => a + b.gamesPlayed, 0) / teams.length,
  };
}

/**
 * Matchup quality from real per-game yards-allowed data for the prop's own
 * category (pass/rush/receiving) rather than a single blended proxy — a
 * defense can be stout against the run and soft against the pass, and the
 * old opponent-win% heuristic couldn't tell the difference. A defense
 * allowing more than the league average in this category is an easier
 * matchup (higher score); less is tougher. Falls back to a neutral 50 when
 * there's no data yet (Week 1, an unmapped team, or the fetch failed) rather
 * than guessing.
 */
function nflDefenseAllowedKey(propType: PropType): keyof NflDefenseAllowed | null {
  if (propType === "player_pass_yards") return "passYardsAllowed";
  if (propType === "player_rush_yards") return "rushYardsAllowed";
  if (propType === "player_receiving_yards") return "recYardsAllowed";
  return null;
}

/**
 * Each qualifying defensive starter out in the relevant position group (see
 * PASS_DEFENSE_POSITIONS/RUN_DEFENSE_POSITIONS) nudges the matchup score —
 * season-long allowed-yards stats won't reflect an injury from this week
 * yet, so this is the only way an in-week change registers at all. Capped
 * low relative to the real allowed-yards signal, since there's no
 * starter/snap-share data behind these counts (see fetchNflGameInjuries).
 */
function nflDefenseInjuryBump(propType: PropType, oppInjuries: NflDefensiveInjuryCounts | undefined): number {
  if (!oppInjuries) return 0;
  const hits = propType === "player_rush_yards" ? oppInjuries.runDefenseHits : oppInjuries.passDefenseHits;
  return Math.min(hits * 4, 12);
}

function matchupScoreForNflProp(
  propType: PropType, oppAllowed: NflDefenseAllowed | undefined, leagueAvg: NflDefenseAllowed | null,
  oppInjuries: NflDefensiveInjuryCounts | undefined
): number {
  const key = nflDefenseAllowedKey(propType);
  const injuryBump = key ? nflDefenseInjuryBump(propType, oppInjuries) : 0;

  if (!key || !oppAllowed || !leagueAvg || oppAllowed.gamesPlayed === 0) {
    return Math.min(90, Math.max(20, 50 + injuryBump));
  }

  const allowed = oppAllowed[key];
  const avg = leagueAvg[key];
  if (avg <= 0) return Math.min(90, Math.max(20, 50 + injuryBump));

  return Math.min(90, Math.max(20, Math.round(50 + (allowed / avg - 1) * 100) + injuryBump));
}

const NFL_DEFENSE_CATEGORY_LABEL: Partial<Record<PropType, string>> = {
  player_rush_yards: "run defense",
  player_pass_yards: "pass defense",
  player_receiving_yards: "pass defense",
};

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * "has the 5th best run defense in the league" — a team's rank (1 = fewest
 * yards allowed, i.e. the stingiest) among every team with at least one game
 * of data so far this season. Null once there's no rank to report (no
 * category mapping for this propType, no league data yet, or the team isn't
 * in the table), in which case buildPropRationale falls back to the older
 * generic favorable/tough/neutral phrasing.
 */
function nflDefenseRankContext(
  propType: PropType, teamAbbr: string, defenseStats: Map<string, NflDefenseAllowed>
): string | null {
  const key = nflDefenseAllowedKey(propType);
  const categoryLabel = NFL_DEFENSE_CATEGORY_LABEL[propType];
  if (!key || !categoryLabel) return null;

  const ranked = [...defenseStats.entries()]
    .filter(([, allowed]) => allowed.gamesPlayed > 0)
    .sort((a, b) => a[1][key] - b[1][key]);
  const rank = ranked.findIndex(([abbr]) => abbr === teamAbbr);
  if (rank === -1) return null;

  const perGame = Math.round(ranked[rank][1][key]);
  return `has the ${ordinal(rank + 1)} best ${categoryLabel} in the league. `
    + `On average they allow ${perGame} ${NFL_YARDS_ALLOWED_LABEL[key] ?? "yards"} per game`;
}

const NFL_YARDS_ALLOWED_LABEL: Partial<Record<keyof NflDefenseAllowed, string>> = {
  passYardsAllowed: "passing yards",
  rushYardsAllowed: "rushing yards",
  recYardsAllowed: "receiving yards",
};

const NFL_DISQUALIFYING_INJURY_STATUSES = new Set(["out", "doubtful", "injured reserve", "ir", "suspended", "pup", "physically unable to perform"]);

/** Secondary vs. front-seven positions — a rough but workable split for which allowed-yards category an injured defender affects. */
const PASS_DEFENSE_POSITIONS = new Set(["CB", "S", "FS", "SS", "DB"]);
const RUN_DEFENSE_POSITIONS = new Set(["DT", "DE", "NT", "LB", "ILB", "OLB", "MLB", "EDGE"]);

interface NflDefensiveInjuryCounts {
  passDefenseHits: number;
  runDefenseHits: number;
}

interface NflGameInjuries {
  /** Normalized names of players listed Out/Doubtful/IR/suspended — liable to not play at all. */
  concerningByName: Set<string>;
  /** Counts of those same disqualifying-status players by position group, keyed by team display name (matches game.homeTeam/awayTeam). */
  byTeam: Map<string, NflDefensiveInjuryCounts>;
}

/**
 * This week's official injury report for both teams in a game, from the
 * same ESPN game-summary endpoint resolve-results.ts uses for box scores —
 * already scoped to the current week's designations, not full-season
 * history, so no date filtering is needed.
 *
 * `concerningByName`: players liable to not play at all — scoreProp uses
 * this to drop their own prop rather than waste a best-bet slot on one
 * likely to just void. "Questionable" is deliberately left out of this set:
 * those players suit up the large majority of the time in the NFL, and
 * excluding them outright would cut real volume for little benefit.
 *
 * `byTeam`: the same disqualifying-status players, grouped by team and
 * position group — matchupScoreForNflProp uses this to nudge a defense's
 * matchup score beyond what its season-long allowed-yards average shows,
 * since that average won't reflect an injury from this week yet. There's no
 * "starter" flag in this feed, so a backup getting dinged counts the same as
 * a starter — an approximation, not a precise snap-share model.
 */
async function fetchNflGameInjuries(eventId: string): Promise<NflGameInjuries> {
  const concerningByName = new Set<string>();
  const byTeam = new Map<string, NflDefensiveInjuryCounts>();
  try {
    const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${eventId}`);
    for (const teamEntry of data.injuries ?? []) {
      const teamName: string | undefined = teamEntry.team?.displayName;
      for (const inj of teamEntry.injuries ?? []) {
        const status = String(inj.status ?? "").toLowerCase().trim();
        const name = inj.athlete?.displayName;
        if (!name || !NFL_DISQUALIFYING_INJURY_STATUSES.has(status)) continue;
        concerningByName.add(normalizeTeamName(name));

        const position = inj.athlete?.position?.abbreviation;
        if (!teamName || !position) continue;
        const counts = byTeam.get(teamName) ?? { passDefenseHits: 0, runDefenseHits: 0 };
        if (PASS_DEFENSE_POSITIONS.has(position)) counts.passDefenseHits += 1;
        if (RUN_DEFENSE_POSITIONS.has(position)) counts.runDefenseHits += 1;
        byTeam.set(teamName, counts);
      }
    }
  } catch (e) {
    console.warn(`fetchNflGameInjuries(${eventId}) failed:`, e);
  }
  return { concerningByName, byTeam };
}

/** All (player, propType) candidates OddsAPI actually offered a line for in one NFL game, scored against that player's game log. */
async function buildNflPropsForGame(
  game: RawGame,
  propOddsMap: PropOddsMap,
  bankrollState: BankrollState,
  season: number,
  defenseStats: Map<string, NflDefenseAllowed>,
  leagueAvg: NflDefenseAllowed | null
): Promise<PropPick[]> {
  const gameCtx: PropGameContext = {
    gameId: game.id, sport: game.sport,
    matchup: `${game.awayTeam} @ ${game.homeTeam}`, startTime: game.startTime,
  };

  // Group the odds map's flat "player-propType" keys back by player, so each
  // player's game log is only fetched once even if books offered them
  // multiple prop markets (e.g. a receiving-back with both rush and rec yards).
  const propTypesByPlayer = new Map<string, PropType[]>();
  for (const key of propOddsMap.keys()) {
    const propType = (["player_pass_yards", "player_rush_yards", "player_receiving_yards"] as const)
      .find(t => key.endsWith(`-${t}`));
    if (!propType) continue;
    const playerName = key.slice(0, key.length - propType.length - 1);
    const list = propTypesByPlayer.get(playerName) ?? [];
    list.push(propType);
    propTypesByPlayer.set(playerName, list);
  }
  if (propTypesByPlayer.size === 0) return [];

  const [homeRoster, awayRoster, injuries] = await Promise.all([
    fetchNflRosterOffense(game.homeTeamId),
    fetchNflRosterOffense(game.awayTeamId),
    fetchNflGameInjuries(game.id),
  ]);
  const rosterByName = new Map<string, { player: NflRosterPlayer; isHome: boolean }>();
  for (const player of homeRoster) rosterByName.set(normalizeTeamName(player.fullName), { player, isHome: true });
  for (const player of awayRoster) rosterByName.set(normalizeTeamName(player.fullName), { player, isHome: false });

  const props: PropPick[] = [];
  await Promise.all([...propTypesByPlayer.entries()].map(async ([playerName, propTypes]) => {
    const match = rosterByName.get(normalizeTeamName(playerName));
    if (!match) return; // OddsAPI's player name didn't resolve to either roster — skip rather than guess

    const { player, isHome } = match;
    const log = await fetchNflPlayerGameLog(player.id, season);
    if (log.last10.length === 0) return;

    const team = isHome ? game.homeTeam : game.awayTeam;
    const opponent = isHome ? game.awayTeam : game.homeTeam;
    const oppAbbr = toNflverseAbbr(isHome ? game.awayTeamAbbr : game.homeTeamAbbr);
    const oppAllowed = defenseStats.get(oppAbbr);

    for (const propType of propTypes) {
      const oddsEntries = propOddsMap.get(`${playerName}-${propType}`);
      if (!oddsEntries || oddsEntries.length === 0) continue;
      const matchupScore = matchupScoreForNflProp(propType, oppAllowed, leagueAvg, injuries.byTeam.get(opponent));
      const opponentRankContext = nflDefenseRankContext(propType, oppAbbr, defenseStats);
      const candidates = oddsEntries
        .map(oddsEntry => scoreProp(
          {
            playerId: player.id, playerName: player.fullName, team, opponent, isHome,
            // Reuses the pitcher/batter void-risk split: a starting QB is about
            // as reliably announced in advance as a probable starter is.
            isPitcher: player.position === "QB",
            propType, fatigued: false,
            injuryConcern: injuries.concerningByName.has(normalizeTeamName(player.fullName)),
          },
          log, oddsEntry, matchupScore, gameCtx, bankrollState, opponentRankContext
        ))
        .filter((p): p is PropPick => p !== null);
      const pick = pickPropPick(candidates);
      if (pick) props.push(pick);
    }
  }));

  return props;
}

/**
 * Scores props for the top TOP_GAMES_FOR_PROPS NFL games by moneyline
 * composite score. Every prop-fetch failure is caught per-game, same
 * guarantee as buildMlbPropPicks.
 */
async function buildNflPropPicks(
  moneylinePicks: BetPick[],
  rawGames: RawGame[],
  nflOddsEntries: OddsApiEntry[],
  bankrollState: BankrollState,
  date: string,
  book: Sportsbook | null
): Promise<PropPick[]> {
  const rankedGameIds = moneylinePicks
    .filter(p => p.sport === "nfl")
    .slice()
    .sort((a, b) => b.scores.composite - a.scores.composite)
    .map(p => p.id.replace(/-(home|away)$/, ""));

  // A game only gets a moneyline pick if its moneyline score clears the
  // minimum tier — a close, unremarkable game often doesn't, and on a
  // one-game slate that meant no game was eligible for props at all (a
  // Monday night with nothing actionable on the moneyline got zero picks of
  // any kind). Props are a separate market with their own edge test, so a
  // game with no moneyline pick still gets scored, just after the ones that
  // do, within the same cap on games checked (OddsAPI cost doesn't grow).
  const nflGames = rawGames.filter(g => g.sport === "nfl");
  const ranked = rankedGameIds.map(id => nflGames.find(g => g.id === id)).filter((g): g is RawGame => !!g);
  const unranked = nflGames.filter(g => !rankedGameIds.includes(g.id));
  const topGames = [...ranked, ...unranked].slice(0, TOP_GAMES_FOR_PROPS);
  if (topGames.length === 0) return [];

  const eventIdByGameId = new Map<string, string>();
  for (const game of topGames) {
    const match = nflOddsEntries.find(
      o => normalizeTeamName(o.homeTeam) === normalizeTeamName(game.homeTeam) &&
           normalizeTeamName(o.awayTeam) === normalizeTeamName(game.awayTeam)
    );
    if (match) eventIdByGameId.set(game.id, match.id);
  }

  const season = parseInt(date.slice(0, 4), 10);
  const defenseStats = await fetchNflDefenseStats(season);
  const leagueAvg = leagueAvgAllowed(defenseStats);

  const perGame = await Promise.all(topGames.map(async game => {
    const eventId = eventIdByGameId.get(game.id);
    if (!eventId || !book) return [];
    try {
      const propOddsMap = await fetchPropOddsForGame(eventId, book, "nfl");
      return await buildNflPropsForGame(game, propOddsMap, bankrollState, season, defenseStats, leagueAvg);
    } catch (e) {
      console.warn(`NFL prop scoring failed for game ${game.id}:`, e);
      return [];
    }
  }));

  return perGame.flat().sort((a, b) => b.scores.composite - a.scores.composite);
}

// ─── NHL props (goals / assists / points / shots on goal) ──────────────────
// Same odds-first design as NFL: only players OddsAPI actually prices are
// scored, resolved to an ESPN athlete id via the team roster to pull their
// game log. Goalies are never looked up — no saves market is requested.
interface NhlRosterPlayer {
  id: number;
  fullName: string;
  position: string;
}

/**
 * Active skaters only. A player ESPN lists as injured/day-to-day isn't in
 * this list, so their props are skipped rather than risk a scratch voiding
 * one of the day's best-bet slots (the NHL stand-in for NFL's injury report).
 */
async function fetchNhlRosterSkaters(teamId: number): Promise<NhlRosterPlayer[]> {
  try {
    const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/${teamId}/roster`);
    return (data.athletes ?? [])
      .flatMap((g: any) => g.items ?? [])
      .filter((p: any) => p.position?.abbreviation !== "G" && p.status?.type === "active")
      .map((p: any) => ({ id: parseInt(p.id, 10), fullName: p.fullName ?? "Unknown", position: p.position?.abbreviation ?? "" }))
      .filter((p: NhlRosterPlayer) => Number.isFinite(p.id));
  } catch (e) {
    console.warn(`fetchNhlRosterSkaters(${teamId}) failed:`, e);
    return [];
  }
}

/**
 * One season's regular-season game log for an NHL skater, most recent first.
 * ESPN groups the events by month and the month order isn't guaranteed, so
 * they're sorted by game date explicitly. ESPN's "shotsTotal" is shots on
 * goal (it matches the boxscore's "S" column), which is what the
 * player_shots_on_goal market settles on.
 */
async function fetchNhlSeasonGameLog(playerId: number, season: number): Promise<GameLogEntry[]> {
  try {
    const data = await fetchJson(
      `https://site.web.api.espn.com/apis/common/v3/sports/hockey/nhl/athletes/${playerId}/gamelog?season=${season}`
    );
    const names: string[] = data.names ?? [];
    const col = (name: string) => names.indexOf(name);
    const [gi, ai, pi, si] = [col("goals"), col("assists"), col("points"), col("shotsTotal")];
    const regularSeason = (data.seasonTypes ?? []).find((st: any) => /Regular Season/i.test(st.displayName ?? ""));
    const events: any[] = (regularSeason?.categories ?? []).flatMap((c: any) => c.events ?? []);
    const stat = (ev: any, i: number) => {
      const v = i === -1 ? NaN : Number(ev.stats?.[i]);
      return Number.isFinite(v) ? v : 0;
    };

    return events
      .map((ev: any): GameLogEntry => {
        const meta = data.events?.[ev.eventId];
        return {
          date: meta?.gameDate ? String(meta.gameDate).slice(0, 10) : undefined,
          goals: stat(ev, gi),
          assists: stat(ev, ai),
          points: stat(ev, pi),
          shotsOnGoal: stat(ev, si),
        };
      })
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  } catch (e) {
    console.warn(`fetchNhlSeasonGameLog(${playerId}, ${season}) failed:`, e);
    return [];
  }
}

interface NhlGameLogResult {
  last10: GameLogEntry[];
  last20: GameLogEntry[];
  recentAvg: { goals: number; assists: number; points: number; shotsOnGoal: number };
}

/** Same early-season padding as NFL_MIN_GAMELOG_SAMPLE — a handful of October games isn't a sample. */
const NHL_MIN_GAMELOG_SAMPLE = 10;

async function fetchNhlPlayerGameLog(playerId: number, season: number): Promise<NhlGameLogResult> {
  let events = await fetchNhlSeasonGameLog(playerId, season);
  if (events.length < NHL_MIN_GAMELOG_SAMPLE) {
    const prior = await fetchNhlSeasonGameLog(playerId, season - 1);
    events = events.concat(prior.slice(0, NHL_MIN_GAMELOG_SAMPLE - events.length));
  }

  const last20 = events.slice(0, 20);
  const last10 = events.slice(0, 10);
  const avg = (key: "goals" | "assists" | "points" | "shotsOnGoal") =>
    last10.length > 0 ? last10.reduce((a, b) => a + (b[key] ?? 0), 0) / last10.length : 0;

  return {
    last10, last20,
    recentAvg: { goals: avg("goals"), assists: avg("assists"), points: avg("points"), shotsOnGoal: avg("shotsOnGoal") },
  };
}

/** ESPN names NHL seasons by the year they end: October 2026 is the 2027 season. */
function nhlSeasonFor(date: string): number {
  const year = parseInt(date.slice(0, 4), 10);
  const month = parseInt(date.slice(5, 7), 10);
  return month >= 8 ? year + 1 : year;
}

interface NhlTeamDefense {
  goalsAgainstPerGame: number;
  gamesPlayed: number;
}

/** Goals allowed per game for every team, keyed by normalized team display name — one standings call. */
async function fetchNhlGoalsAgainst(): Promise<Map<string, NhlTeamDefense>> {
  const map = new Map<string, NhlTeamDefense>();
  try {
    const data = await fetchJson("https://site.api.espn.com/apis/v2/sports/hockey/nhl/standings");
    const entries: any[] = (data.children ?? []).flatMap((c: any) => c.standings?.entries ?? []);
    for (const e of entries) {
      const stat = (name: string) => Number((e.stats ?? []).find((s: any) => s.name === name)?.value);
      const gp = stat("gamesPlayed");
      const ga = stat("pointsAgainst"); // ESPN's generic name — for hockey it's goals against
      if (!e.team?.displayName || !Number.isFinite(gp) || !Number.isFinite(ga) || gp <= 0) continue;
      map.set(normalizeTeamName(e.team.displayName), { goalsAgainstPerGame: ga / gp, gamesPlayed: gp });
    }
  } catch (e) {
    console.warn("fetchNhlGoalsAgainst failed:", e);
  }
  return map;
}

/** Shots on goal allowed per game for one team (ESPN team statistics), or null if unavailable. */
async function fetchNhlShotsAgainstPerGame(teamId: number): Promise<{ perGame: number; gamesPlayed: number } | null> {
  try {
    const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/${teamId}/statistics`);
    const cats: any[] = data.results?.stats?.categories ?? [];
    const find = (cat: string, name: string) =>
      Number(cats.find(c => c.name === cat)?.stats?.find((s: any) => s.name === name)?.value);
    const shotsAgainst = find("defensive", "shotsAgainst");
    const games = find("general", "games");
    if (!Number.isFinite(shotsAgainst) || !Number.isFinite(games) || games <= 0) return null;
    return { perGame: shotsAgainst / games, gamesPlayed: games };
  } catch (e) {
    console.warn(`fetchNhlShotsAgainstPerGame(${teamId}) failed:`, e);
    return null;
  }
}

/**
 * League-average shots on goal allowed per team per game. Only the handful
 * of teams in tonight's prop games get a shots-against lookup (one ESPN call
 * each), which is too few to average reliably, so this uses the recent-season
 * NHL norm instead.
 */
const NHL_LEAGUE_AVG_SHOTS_AGAINST = 28;

/**
 * Same 20-90 scale as matchupScoreForNflProp: an opponent allowing more than
 * league average in the prop's category is an easier matchup. Goals, assists
 * and points all read goals-against; shots reads shots-against. Early in the
 * season a team's per-game rate is pulled toward the league average until it
 * has ~20 games behind it, so a hot or cold first week can't swing the score.
 */
function matchupScoreForNhlProp(
  propType: PropType,
  oppGoals: NhlTeamDefense | undefined,
  leagueAvgGoalsAgainst: number | null,
  oppShots: { perGame: number; gamesPlayed: number } | null
): number {
  const ratio = (allowed: number, gp: number, avg: number) => {
    const weight = Math.min(gp, 20) / 20;
    const shrunk = avg + (allowed - avg) * weight;
    return shrunk / avg;
  };

  if (propType === "player_shots_on_goal") {
    if (!oppShots) return 50;
    const r = ratio(oppShots.perGame, oppShots.gamesPlayed, NHL_LEAGUE_AVG_SHOTS_AGAINST);
    return Math.min(90, Math.max(20, Math.round(50 + (r - 1) * 100)));
  }

  if (!oppGoals || !leagueAvgGoalsAgainst || leagueAvgGoalsAgainst <= 0) return 50;
  const r = ratio(oppGoals.goalsAgainstPerGame, oppGoals.gamesPlayed, leagueAvgGoalsAgainst);
  return Math.min(90, Math.max(20, Math.round(50 + (r - 1) * 100)));
}

/**
 * The opponent phrase for buildPropRationale. Goals/assists/points: "has the
 * 5th best goals-against average in the league. On average they allow 2.6
 * goals per game". Shots: only tonight's teams have shots-against data (see
 * NHL_LEAGUE_AVG_SHOTS_AGAINST), so there's no league rank — just the
 * per-game number against the league norm.
 */
function nhlOpponentContext(
  propType: PropType, teamName: string, goalsAgainst: Map<string, NhlTeamDefense>,
  oppShots: { perGame: number; gamesPlayed: number } | null
): string | null {
  if (propType === "player_shots_on_goal") {
    if (!oppShots) return null;
    return `allows ${oppShots.perGame.toFixed(1)} shots on goal per game (league average is about ${NHL_LEAGUE_AVG_SHOTS_AGAINST})`;
  }
  const ranked = [...goalsAgainst.entries()].sort((a, b) => a[1].goalsAgainstPerGame - b[1].goalsAgainstPerGame);
  const rank = ranked.findIndex(([name]) => name === normalizeTeamName(teamName));
  if (rank === -1) return null;
  return `has the ${ordinal(rank + 1)} best goals-against average in the league. `
    + `On average they allow ${ranked[rank][1].goalsAgainstPerGame.toFixed(1)} goals per game`;
}

const NHL_PROP_TYPES = ["player_goals", "player_assists", "player_points", "player_shots_on_goal"] as const;

async function buildNhlPropsForGame(
  game: RawGame,
  propOddsMap: PropOddsMap,
  bankrollState: BankrollState,
  season: number,
  goalsAgainst: Map<string, NhlTeamDefense>,
  leagueAvgGoalsAgainst: number | null
): Promise<PropPick[]> {
  const gameCtx: PropGameContext = {
    gameId: game.id, sport: game.sport,
    matchup: `${game.awayTeam} @ ${game.homeTeam}`, startTime: game.startTime,
  };

  const propTypesByPlayer = new Map<string, PropType[]>();
  for (const key of propOddsMap.keys()) {
    const propType = NHL_PROP_TYPES.find(t => key.endsWith(`-${t}`));
    if (!propType) continue;
    const playerName = key.slice(0, key.length - propType.length - 1);
    const list = propTypesByPlayer.get(playerName) ?? [];
    list.push(propType);
    propTypesByPlayer.set(playerName, list);
  }
  if (propTypesByPlayer.size === 0) return [];

  const [homeRoster, awayRoster, homeShots, awayShots] = await Promise.all([
    fetchNhlRosterSkaters(game.homeTeamId),
    fetchNhlRosterSkaters(game.awayTeamId),
    fetchNhlShotsAgainstPerGame(game.homeTeamId),
    fetchNhlShotsAgainstPerGame(game.awayTeamId),
  ]);
  const rosterByName = new Map<string, { player: NhlRosterPlayer; isHome: boolean }>();
  for (const player of homeRoster) rosterByName.set(normalizeTeamName(player.fullName), { player, isHome: true });
  for (const player of awayRoster) rosterByName.set(normalizeTeamName(player.fullName), { player, isHome: false });

  const props: PropPick[] = [];
  await Promise.all([...propTypesByPlayer.entries()].map(async ([playerName, propTypes]) => {
    const match = rosterByName.get(normalizeTeamName(playerName));
    if (!match) return; // not an active skater on either roster — skip rather than guess

    const { player, isHome } = match;
    const log = await fetchNhlPlayerGameLog(player.id, season);
    if (log.last10.length === 0) return;

    const team = isHome ? game.homeTeam : game.awayTeam;
    const opponent = isHome ? game.awayTeam : game.homeTeam;
    const oppGoals = goalsAgainst.get(normalizeTeamName(opponent));
    const oppShots = isHome ? awayShots : homeShots;
    // Back-to-backs are routine in the NHL and do dent skater output.
    const fatigued = isFatigued(log.last10, game.startTime);

    for (const propType of propTypes) {
      const oddsEntries = propOddsMap.get(`${playerName}-${propType}`);
      if (!oddsEntries || oddsEntries.length === 0) continue;
      const matchupScore = matchupScoreForNhlProp(propType, oppGoals, leagueAvgGoalsAgainst, oppShots);
      const candidates = oddsEntries
        .map(oddsEntry => scoreProp(
          {
            playerId: player.id, playerName: player.fullName, team, opponent, isHome,
            // NHL lines aren't confirmed until warmups, so every skater prop is
            // "Probable" (medium void risk) — same treatment as an MLB batter.
            isPitcher: false,
            propType, fatigued, injuryConcern: false,
          },
          log, oddsEntry, matchupScore, gameCtx, bankrollState,
          nhlOpponentContext(propType, opponent, goalsAgainst, oppShots)
        ))
        .filter((p): p is PropPick => p !== null);
      const pick = pickPropPick(candidates);
      if (pick) props.push(pick);
    }
  }));

  return props;
}

/**
 * Scores props for the top NHL_TOP_GAMES_FOR_PROPS games, ranked the same way
 * as NFL (games with the strongest moneyline pick first, then the rest).
 * Every failure is caught per-game so props can never take down moneylines.
 */
async function buildNhlPropPicks(
  moneylinePicks: BetPick[],
  rawGames: RawGame[],
  nhlOddsEntries: OddsApiEntry[],
  bankrollState: BankrollState,
  date: string,
  book: Sportsbook | null
): Promise<PropPick[]> {
  const rankedGameIds = moneylinePicks
    .filter(p => p.sport === "nhl")
    .slice()
    .sort((a, b) => b.scores.composite - a.scores.composite)
    .map(p => p.id.replace(/-(home|away)$/, ""));

  const nhlGames = rawGames.filter(g => g.sport === "nhl");
  const ranked = [...new Set(rankedGameIds)].map(id => nhlGames.find(g => g.id === id)).filter((g): g is RawGame => !!g);
  const unranked = nhlGames.filter(g => !rankedGameIds.includes(g.id));
  const topGames = [...ranked, ...unranked].slice(0, NHL_TOP_GAMES_FOR_PROPS);
  if (topGames.length === 0 || !book) return [];

  const eventIdByGameId = new Map<string, string>();
  for (const game of topGames) {
    const match = nhlOddsEntries.find(
      o => normalizeTeamName(o.homeTeam) === normalizeTeamName(game.homeTeam) &&
           normalizeTeamName(o.awayTeam) === normalizeTeamName(game.awayTeam)
    );
    if (match) eventIdByGameId.set(game.id, match.id);
  }

  const season = nhlSeasonFor(date);
  const goalsAgainst = await fetchNhlGoalsAgainst();
  const teams = [...goalsAgainst.values()];
  const leagueAvgGoalsAgainst = teams.length > 0
    ? teams.reduce((a, b) => a + b.goalsAgainstPerGame, 0) / teams.length
    : null;

  const perGame = await Promise.all(topGames.map(async game => {
    const eventId = eventIdByGameId.get(game.id);
    if (!eventId) return [];
    try {
      const propOddsMap = await fetchPropOddsForGame(eventId, book, "nhl");
      return await buildNhlPropsForGame(game, propOddsMap, bankrollState, season, goalsAgainst, leagueAvgGoalsAgainst);
    } catch (e) {
      console.warn(`NHL prop scoring failed for game ${game.id}:`, e);
      return [];
    }
  }));

  return perGame.flat().sort((a, b) => b.scores.composite - a.scores.composite);
}

const MAX_PROP_PICKS = 10;

/** Merges the per-sport prop pipelines and caps the combined pool — Full Analysis only needs the top 10 overall. */
async function buildPropPicks(
  moneylinePicks: BetPick[],
  rawGames: RawGame[],
  oddsBySport: Record<string, OddsApiEntry[]>,
  bankrollState: BankrollState,
  date: string,
  book: Sportsbook | null
): Promise<PropPick[]> {
  const [mlbProps, nflProps, nhlProps] = await Promise.all([
    buildMlbPropPicks(moneylinePicks, rawGames, oddsBySport.mlb ?? [], bankrollState, date, book),
    buildNflPropPicks(moneylinePicks, rawGames, oddsBySport.nfl ?? [], bankrollState, date, book),
    buildNhlPropPicks(moneylinePicks, rawGames, oddsBySport.nhl ?? [], bankrollState, date, book),
  ]);

  return [...mlbProps, ...nflProps, ...nhlProps]
    .sort((a, b) => b.scores.composite - a.scores.composite)
    .slice(0, MAX_PROP_PICKS);
}

// ─── Main handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }

  try {
    const date = (req.query.date as string) || new Date().toISOString().split("T")[0];
    const sportsParam = (req.query.sports as string) || "nfl";
    const sports = sportsParam.split(",").map(s => s.trim()).filter(Boolean) as Sport[];

    const results: SportResult[] = await Promise.all(
      sports.map(sport => {
        if (sport === "mlb") return fetchMlbGames(date);
        if (sport === "nfl" || sport === "nhl") return fetchEspnGames(sport, date);
        if (sport === "ncaaf") return fetchNcaafGames(date);
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
    const chosenBook = chooseSportsbook(oddsBySport);

    const bankrollState = await fetchBankrollState(req);
    const rawGames = attachOdds(games, oddsBySport, chosenBook);
    // NHL moneylines need the model's schedule/goalie/injury inputs; returns
    // an empty map (no fetches) when there are no NHL games, e.g. NFL runs.
    const nhlContexts = await fetchNhlMatchupContexts(rawGames, date);
    const picks = scoreAllGames(rawGames, bankrollState, nhlContexts);

    // Prop bets are best-effort: any failure here must never take down the
    // moneyline picks that already succeeded above. They're also time-boxed —
    // on a full game-day slate the NFL prop fan-out (roster + game-log calls
    // per player across TOP_GAMES_FOR_PROPS games) can occasionally run long
    // if ESPN's hidden API is slow under real game-day traffic, and this
    // whole function gets hard-killed at Vercel's 60s limit with nothing
    // returned at all. Capping props at PROP_PIPELINE_TIMEOUT_MS guarantees
    // moneyline picks still ship even when props can't finish in time.
    let propPicks: PropPick[] = [];
    try {
      propPicks = await Promise.race([
        buildPropPicks(picks, rawGames, oddsBySport, bankrollState, date, chosenBook),
        new Promise<PropPick[]>(resolve => setTimeout(() => resolve([]), PROP_PIPELINE_TIMEOUT_MS)),
      ]);
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

    // Reference-only trio (safe/value/shot) — unrelated to the 6 bets actually
    // committed below, kept purely so the "Full Analysis" view has something
    // to show under allParlays.
    const allParlays = buildDefaultParlays(picksWithExplanations, propPicksWithExplanations);

    let dailyBets: DailyBetsResult;
    try {
      dailyBets = selectDailyBets(picksWithExplanations, propPicksWithExplanations, bankrollState.currentBankroll);
    } catch (e) {
      // Never let a selection bug take down pick generation — fall back to a
      // simple top-3-by-composite single plus the reference safe/shot parlays.
      // (No "double up" equivalent exists in the reference trio, so that one
      // just falls back to empty.)
      console.warn("selectDailyBets failed, falling back to top picks:", e);
      const fallbackBestBets = [...picksWithExplanations].sort((a, b) => b.scores.composite - a.scores.composite).slice(0, 3);
      const fallbackSafe = allParlays.find(p => p.id === "safe") ?? emptyParlay("safe", "💚 Safe Parlay", "💚");
      const fallbackShot = allParlays.find(p => p.id === "shot") ?? emptyParlay("shot", "🚀 High Odds Parlay", "🚀");
      dailyBets = {
        bestBets: fallbackBestBets,
        safeParlay: fallbackSafe,
        highOddsParlay: fallbackShot,
        doubleUpParlay: emptyParlay("double", "2️⃣ Double Up Parlay", "2️⃣"),
        totalDailyStake: fallbackBestBets.reduce((a, b) => a + b.stakeAmount, 0),
      };
    }

    const itemLabel = (item: BetPick | PropPick) => (isPropPick(item) ? propLegLabel(item) : item.pickLabel);
    const totalPotentialPayout = Math.round(
      (dailyBets.bestBets.reduce((a, b) => a + b.potentialPayout, 0) +
        (dailyBets.safeParlay.potentialPayout ?? 0) +
        (dailyBets.highOddsParlay.potentialPayout ?? 0) +
        (dailyBets.doubleUpParlay.potentialPayout ?? 0)) * 100
    ) / 100;
    const totalBetsPlaced =
      dailyBets.bestBets.length +
      (dailyBets.safeParlay.legs.length > 0 ? 1 : 0) +
      (dailyBets.highOddsParlay.legs.length > 0 ? 1 : 0) +
      (dailyBets.doubleUpParlay.legs.length > 0 ? 1 : 0);

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
      sportsbook: chosenBook ? SPORTSBOOK_LABELS[chosenBook] : null,
      bestBets: dailyBets.bestBets,
      safeParlay: dailyBets.safeParlay,
      highOddsParlay: dailyBets.highOddsParlay,
      doubleUpParlay: dailyBets.doubleUpParlay,
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
