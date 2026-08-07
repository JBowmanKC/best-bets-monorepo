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
}

interface Parlay {
  id: "safe" | "value" | "shot";
  label: string;
  emoji: string;
  legs: ParlayLeg[];
  estimatedPayout: number;
  combinedWinPct: number;
  recommendedStake: string;
}

interface SportStatus {
  sport: string;
  label: string;
  active: boolean;
  note: string;
}

interface BestBetsResponse {
  date: string;
  generatedAt: string;
  cached: boolean;
  sportStatuses: SportStatus[];
  picks: BetPick[];
  parlays: Parlay[];
}

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

// ─── Parlay builder (ported unchanged) ──────────────────────────────────────
function calcParlayPayout(odds: number[]): number {
  const decimalProduct = odds.reduce((acc, o) => {
    const decimal = o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
    return acc * decimal;
  }, 1);
  return Math.round((decimalProduct - 1) * 100);
}

function calcCombinedWinPct(picks: BetPick[]): number {
  return picks.reduce((acc, p) => acc * p.estimatedWinPct, 1);
}

function toLegs(picks: BetPick[]): ParlayLeg[] {
  return picks.map(p => ({
    pickId: p.id,
    matchup: p.matchup,
    pickLabel: p.pickLabel,
    sport: p.sport,
    odds: p.odds,
    startTime: p.startTime,
  }));
}

function buildParlays(picks: BetPick[]): Parlay[] {
  const elite = picks.filter(p => p.tier === "elite");
  const strong = picks.filter(p => p.tier === "strong");
  const all = picks;

  const safeLegs = [...elite, ...strong].slice(0, 3);
  if (safeLegs.length < 2) return [];

  const safe: Parlay = {
    id: "safe",
    label: "Safety Parlay",
    emoji: "💚",
    legs: toLegs(safeLegs),
    estimatedPayout: calcParlayPayout(safeLegs.map(p => p.odds)),
    combinedWinPct: Math.round(calcCombinedWinPct(safeLegs) * 100) / 100,
    recommendedStake: "1–2 units",
  };

  const valueLegs = all.slice(0, 4);
  const value: Parlay = {
    id: "value",
    label: "Value Parlay",
    emoji: "💎",
    legs: toLegs(valueLegs),
    estimatedPayout: calcParlayPayout(valueLegs.map(p => p.odds)),
    combinedWinPct: Math.round(calcCombinedWinPct(valueLegs) * 100) / 100,
    recommendedStake: "0.5 units",
  };

  const shotLegs = all.slice(0, 5);
  if (shotLegs.length < 5) return [safe, value];

  const shot: Parlay = {
    id: "shot",
    label: "Shot Parlay",
    emoji: "🚀",
    legs: toLegs(shotLegs),
    estimatedPayout: calcParlayPayout(shotLegs.map(p => p.odds)),
    combinedWinPct: Math.round(calcCombinedWinPct(shotLegs) * 100) / 100,
    recommendedStake: "0.25 units",
  };

  return [safe, value, shot];
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

interface OddsApiEntry {
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
      homeTeam: g.home_team,
      awayTeam: g.away_team,
      odds: averageBookmakerOdds(g),
    }));
  } catch (e) {
    console.warn(`OddsAPI ${sport} fetch threw:`, e);
    return [];
  }
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
    const parlays = buildParlays(picks);

    const response: BestBetsResponse = {
      date,
      generatedAt: new Date().toISOString(),
      cached: false,
      sportStatuses,
      picks,
      parlays,
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
