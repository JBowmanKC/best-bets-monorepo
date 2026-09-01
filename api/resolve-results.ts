// ─────────────────────────────────────────────────────────────────────────
// Self-contained Vercel serverless function. Resolves every "pending" bet in
// the bankroll ledger against real game scores, recomputes the running
// bankroll, and self-calibrates the algorithm's confidence multipliers once
// enough results have been tracked.
//
// IMPORTANT — this function does NOT write to disk. Vercel functions run on
// a read-only, ephemeral filesystem: anything written to
// apps/web/public/bankroll.json here would vanish the moment the instance is
// recycled and would never reach the git repo or the next deploy. Instead
// this handler fetches the ledger the same way the browser does (from this
// deployment's own static output), resolves it entirely in memory, and
// returns the full updated object in the response under `bankroll`. The
// caller — the "Resolve Results" GitHub Actions workflow — is what actually
// persists it, by writing that field to apps/web/public/bankroll.json and
// committing it. See .github/workflows/resolve-results.yml.
//
// Data sources (same free feeds api/best-bets.ts uses, no key required):
//   MLB schedule/scores — https://statsapi.mlb.com/api/v1/schedule
//   NFL/NHL scoreboard  — https://site.api.espn.com/apis/site/v2/sports/...
// ─────────────────────────────────────────────────────────────────────────

// Note: this file has no top-level import/export (module.exports is a plain
// CommonJS assignment), so — same as api/best-bets.ts — it's compiled by
// tsc as a global script, not a module. Both files sit in the same
// `npm run typecheck` program, so any identifier declared at the top level
// of both would collide as a duplicate; the couple of names this file
// happens to share with best-bets.ts (team-name/JSON-fetch helpers) are
// prefixed accordingly to avoid that.
type RrSport = "mlb" | "nfl" | "nhl";
type RrTier = "elite" | "strong" | "value";
type BetResult = "pending" | "win" | "loss" | "push" | "void";

interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  setHeader(name: string, value: string): ApiResponse;
  status(code: number): ApiResponse;
  json(body: unknown): void;
  end(): void;
}

/**
 * The base host to use for self-fetching this deployment's own static output
 * (bankroll.json). `process.env.VERCEL_URL` is Vercel's own per-deployment
 * URL — it commonly sits behind Vercel's deployment protection and isn't
 * reliably fetchable from inside the function itself, which is why every
 * "Resolve Results" run was silently falling back to an empty ledger and
 * wiping out that day's bets instead of updating them. The incoming
 * request's own Host header is the domain whatever called this function just
 * successfully used, so it's used first; VERCEL_URL is kept only as a
 * last-resort fallback.
 */
function rrSelfBaseUrl(req: ApiRequest): string | null {
  const header = req.headers?.["x-forwarded-host"] ?? req.headers?.host;
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return fromHeader || process.env.VERCEL_URL || null;
}

/**
 * One parlay leg. `pickLabel` + `odds` are what the original bankroll.json
 * spec asked for; everything else here is added because a leg can't actually
 * be graded without knowing which game it's from and (for a prop leg) which
 * stat/line/side — same reasoning as the single-bet `line`/`recommendedSide`
 * addition above.
 */
interface ParlayLegRecord {
  pickLabel: string;
  odds: number;
  sport: RrSport;
  matchup: string;
  date: string;
  propType?: string;
  playerName?: string;
  line?: number;
  recommendedSide?: "over" | "under";
  /** Set once the whole parlay is graded (see resolveParlayBet) — undefined while pending. */
  result?: "win" | "loss" | "void";
}

interface BankrollBet {
  betId: string;
  date: string;
  result: BetResult;
  profitLoss: number | null;
  bankrollAfter: number | null;
  resolvedAt: string | null;
  stakeAmount: number;
  potentialPayout: number;
  // Single bets only (moneyline or prop) — a parlay entry (betType: "parlay")
  // carries parlayLegs instead and leaves these undefined, since none of them
  // has a single well-defined value across multiple legs.
  sport?: RrSport;
  matchup?: string;
  pickLabel?: string;
  odds?: number;
  estimatedWinPct?: number;
  impliedWinPct?: number;
  evEdge?: number;
  tier?: RrTier;
  scores?: { composite: number };
  // Prop bets only (absent/undefined on moneyline bets). `line` and
  // `recommendedSide` aren't in the original bankroll.json spec, which only
  // called for propType/playerName — but a prop can't be graded without
  // knowing what line it was placed against and which side was bet, so both
  // are added here too. See the resolve-results.ts file header for why.
  propType?: string;
  playerName?: string;
  line?: number | null;
  recommendedSide?: "over" | "under" | null;
  // Parlay bets only.
  betType?: "single" | "parlay";
  parlayLegs?: ParlayLegRecord[];
  combinedOdds?: number;
}

interface Calibration {
  eliteWinRate: number | null;
  strongWinRate: number | null;
  valueWinRate: number | null;
  mlbRoi: number | null;
  nflRoi: number | null;
  nhlRoi: number | null;
  wpScoreMultiplier: number;
  evScoreMultiplier: number;
  lastCalibrated: string | null;
  totalResultsTracked: number;
}

interface Bankroll {
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
  calibration: Calibration;
  bets: BankrollBet[];
}

interface FinalGame {
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  state: "scheduled" | "final" | "no-action";
  /** MLB gamePk — set only by fetchMlbFinals, needed to fetch the boxscore for prop resolution. */
  gamePk?: string;
}

const CALIBRATION_THRESHOLD = 20;
const EV_CALIBRATION_THRESHOLD = 30;
const WIN_RATE_TOLERANCE = 0.08;

function defaultBankroll(): Bankroll {
  return {
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
  };
}

// ─── Fetch helpers ───────────────────────────────────────────────────────────
async function rrFetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function rrNormalizeTeamName(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Reads the live ledger from this deployment's own static output (see
 * api/best-bets.ts for why this is a self-fetch rather than fs.readFileSync).
 *
 * Only a clean 404 (the file has genuinely never been written — the very
 * first run) is treated as "start from an empty ledger." Any other failure
 * (network error, non-404 status, malformed JSON) throws instead of silently
 * defaulting — this handler's whole response gets persisted as the new
 * bankroll.json by the calling workflow, so quietly returning an empty
 * ledger on a transient failure would overwrite every real bet ever tracked.
 * Better to fail the workflow loudly and retry next run.
 */
async function fetchBankrollFile(req: ApiRequest): Promise<Bankroll> {
  const host = rrSelfBaseUrl(req);
  if (!host) {
    throw new Error("Could not determine this deployment's own host (no Host header and no VERCEL_URL).");
  }

  const url = `https://${host}/bankroll.json`;
  const res = await fetch(url);

  if (res.status === 404) {
    console.warn(`bankroll.json not found at ${url} — starting from an empty ledger (first run).`);
    return defaultBankroll();
  }
  if (!res.ok) {
    throw new Error(`Fetching the live ledger failed: HTTP ${res.status} for ${url}.`);
  }

  const data = (await res.json()) as any;
  if (!data || !Array.isArray(data.bets)) {
    throw new Error(`bankroll.json at ${url} was malformed (missing/invalid "bets" array).`);
  }

  return data as Bankroll;
}

async function fetchMlbFinals(date: string): Promise<FinalGame[]> {
  const data = await rrFetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`);
  const games: any[] = (data.dates ?? []).flatMap((d: any) => d.games ?? []);

  return games.map(g => {
    const home = g.teams?.home;
    const away = g.teams?.away;
    const detailed = String(g.status?.detailedState ?? "");
    const abstract = String(g.status?.abstractGameState ?? "");

    let state: FinalGame["state"] = "scheduled";
    if (/postponed|cancelled|canceled|suspended/i.test(detailed)) state = "no-action";
    else if (abstract === "Final") state = "final";

    const homeScore = typeof home?.score === "number" ? home.score
      : typeof g.linescore?.teams?.home?.runs === "number" ? g.linescore.teams.home.runs : null;
    const awayScore = typeof away?.score === "number" ? away.score
      : typeof g.linescore?.teams?.away?.runs === "number" ? g.linescore.teams.away.runs : null;

    return {
      homeTeam: home?.team?.name ?? "", awayTeam: away?.team?.name ?? "",
      homeScore, awayScore, state, gamePk: String(g.gamePk),
    };
  });
}

async function fetchEspnFinals(sport: "nfl" | "nhl", date: string): Promise<FinalGame[]> {
  const path = sport === "nfl" ? "football/nfl" : "hockey/nhl";
  const dateParam = date.replace(/-/g, "");
  const data = await rrFetchJson(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${dateParam}`);
  const events: any[] = data.events ?? [];

  return events.map(e => {
    const comp = e.competitions?.[0];
    const competitors: any[] = comp?.competitors ?? [];
    const home = competitors.find(c => c.homeAway === "home");
    const away = competitors.find(c => c.homeAway === "away");
    const type = e.status?.type ?? {};
    const name = String(type.name ?? "");

    let state: FinalGame["state"] = "scheduled";
    if (/POSTPONED|CANCELED|CANCELLED|SUSPENDED/i.test(name)) state = "no-action";
    else if (type.completed) state = "final";

    const num = (v: any) => (v === null || v === undefined || v === "" ? null : Number(v));

    return {
      homeTeam: home?.team?.displayName ?? "",
      awayTeam: away?.team?.displayName ?? "",
      homeScore: num(home?.score),
      awayScore: num(away?.score),
      state,
    };
  });
}

// ─── Resolution ──────────────────────────────────────────────────────────────
function findGame(finals: FinalGame[], awayTeam: string, homeTeam: string): FinalGame | undefined {
  return finals.find(
    g => rrNormalizeTeamName(g.homeTeam) === rrNormalizeTeamName(homeTeam) &&
         rrNormalizeTeamName(g.awayTeam) === rrNormalizeTeamName(awayTeam)
  );
}

interface Outcome {
  result: BetResult;
  profitLoss: number;
}

/** MLB boxscore for prop grading — pitchers/batters stat lines per team. */
async function fetchMlbBoxscore(gamePk: string): Promise<any | null> {
  try {
    return await rrFetchJson(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);
  } catch (e) {
    console.warn(`fetchMlbBoxscore(${gamePk}) failed:`, e);
    return null;
  }
}

/**
 * Finds `playerName` in either team's boxscore. Null means they never appear
 * at all — not on the active roster for this game (healthy scratch, demoted,
 * etc.) — the caller should void the bet rather than wait forever, since a
 * final game's roster list is never going to grow a missing player.
 */
function findBoxscorePlayer(boxscore: any, playerName: string): any | null {
  const sides = [boxscore?.teams?.home, boxscore?.teams?.away];

  for (const side of sides) {
    const players = side?.players ?? {};
    for (const key of Object.keys(players)) {
      const p = players[key];
      if (rrNormalizeTeamName(p?.person?.fullName ?? "") === rrNormalizeTeamName(playerName)) return p;
    }
  }

  return null;
}

/**
 * Reads the stat `propType` bets against for a player already confirmed
 * present in a final game's boxscore. A missing counting-stat field (e.g. a
 * bench bat with zero plate appearances, or a reliever who warmed up but
 * never entered) means they recorded zero of it — the game is final, so
 * that's a real result, not data still waiting to post — hence `?? 0` rather
 * than treating it as unresolvable.
 */
function readBoxscoreStatValue(player: any, propType: string): number {
  const isPitcherProp = propType === "pitcher_strikeouts" || propType === "pitcher_outs";
  const stat = isPitcherProp ? player?.stats?.pitching : player?.stats?.batting;
  const num = (v: any) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

  switch (propType) {
    case "pitcher_strikeouts": return num(stat?.strikeOuts) ?? 0;
    case "pitcher_outs": {
      const outs = num(stat?.outs);
      if (outs !== null) return outs;
      const ip = parseFloat(stat?.inningsPitched ?? "");
      return Number.isNaN(ip) ? 0 : Math.round(ip * 3);
    }
    case "batter_hits": return num(stat?.hits) ?? 0;
    case "batter_total_bases": return num(stat?.totalBases) ?? 0;
    case "batter_home_runs": return num(stat?.homeRuns) ?? 0;
    default: return 0;
  }
}

/** Returns null when the bet should stay pending (game not final / boxscore not posted). */
async function resolvePropBet(bet: BankrollBet, game: FinalGame): Promise<Outcome | null> {
  if (game.state === "no-action") return { result: "void", profitLoss: 0 };
  if (game.state !== "final" || !game.gamePk) return null;
  if (bet.line === undefined || bet.line === null || !bet.recommendedSide || !bet.propType) return null;

  const boxscore = await fetchMlbBoxscore(game.gamePk);
  if (!boxscore) return null; // couldn't fetch — stays pending, retried next run

  const player = findBoxscorePlayer(boxscore, bet.playerName ?? "");
  if (!player) return { result: "void", profitLoss: 0 }; // scratched/not on the active roster — no action

  const statValue = readBoxscoreStatValue(player, bet.propType);
  if (statValue === bet.line) return { result: "push", profitLoss: 0 };

  const won = bet.recommendedSide === "over" ? statValue > bet.line : statValue < bet.line;
  return won
    ? { result: "win", profitLoss: Math.round((bet.potentialPayout - bet.stakeAmount) * 100) / 100 }
    : { result: "loss", profitLoss: -bet.stakeAmount };
}

function rrCalcParlayPayout(odds: number[]): number {
  const decimalProduct = odds.reduce((acc, o) => {
    const decimal = o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
    return acc * decimal;
  }, 1);
  return Math.round((decimalProduct - 1) * 100);
}

/**
 * Resolves one parlay leg to a plain win/loss/void — never a dollar amount,
 * since a leg's own stake isn't meaningful (only the parlay as a whole is
 * staked). Returns null when the leg's game isn't final yet, so the whole
 * parlay stays pending until every leg has an answer.
 */
async function resolveParlayLeg(
  leg: ParlayLegRecord,
  getFinals: (sport: RrSport, date: string) => Promise<FinalGame[]>
): Promise<"win" | "loss" | "void" | null> {
  const parts = leg.matchup.split(" @ ");
  if (parts.length !== 2) return null;
  const [awayTeam, homeTeam] = parts;

  const finals = await getFinals(leg.sport, leg.date);
  const game = findGame(finals, awayTeam, homeTeam);
  if (!game) return null;

  if (leg.propType) {
    if (game.state === "no-action") return "void";
    if (game.state !== "final" || !game.gamePk) return null;
    if (leg.line === undefined || leg.line === null || !leg.recommendedSide) return null;

    const boxscore = await fetchMlbBoxscore(game.gamePk);
    if (!boxscore) return null;

    const player = findBoxscorePlayer(boxscore, leg.playerName ?? "");
    if (!player) return "void"; // scratched/not on the active roster — no action, same as a voided leg

    const statValue = readBoxscoreStatValue(player, leg.propType);
    if (statValue === leg.line) return "void"; // a push leg is dropped, same as a voided one

    return (leg.recommendedSide === "over" ? statValue > leg.line : statValue < leg.line) ? "win" : "loss";
  }

  if (game.state === "no-action") return "void";
  if (game.state !== "final" || game.homeScore === null || game.awayScore === null) return null;

  const pickedTeam = leg.pickLabel.replace(/\s+ML$/, "").trim();
  const pickedHome = rrNormalizeTeamName(pickedTeam) === rrNormalizeTeamName(homeTeam);
  const pickedAway = rrNormalizeTeamName(pickedTeam) === rrNormalizeTeamName(awayTeam);
  if (!pickedHome && !pickedAway) return null;

  const pickedScore = pickedHome ? game.homeScore : game.awayScore;
  const oppScore = pickedHome ? game.awayScore : game.homeScore;
  if (pickedScore > oppScore) return "win";
  if (pickedScore < oppScore) return "loss";
  return "void"; // a push leg is dropped, same as a voided one
}

/**
 * A parlay wins only if every leg wins. Any leg losing sinks the whole
 * parlay. A voided (or pushed) leg is dropped and the payout is recalculated
 * from the remaining winning legs' odds; if every leg voids, so does the
 * parlay.
 */
async function resolveParlayBet(
  bet: BankrollBet,
  getFinals: (sport: RrSport, date: string) => Promise<FinalGame[]>
): Promise<Outcome | null> {
  const legs = bet.parlayLegs ?? [];
  if (legs.length === 0) return null;

  const results: ("win" | "loss" | "void")[] = [];
  for (const leg of legs) {
    const outcome = await resolveParlayLeg(leg, getFinals);
    if (outcome === null) return null; // any leg still undecided — whole parlay stays pending
    results.push(outcome);
  }

  // Every leg is decided at this point — record each leg's own outcome so
  // the ledger UI can show which legs won/lost, not just the parlay overall.
  legs.forEach((leg, i) => { leg.result = results[i]; });

  if (results.every(r => r === "void")) return { result: "void", profitLoss: 0 };
  if (results.some(r => r === "loss")) return { result: "loss", profitLoss: -bet.stakeAmount };

  const survivingOdds = legs.filter((_, i) => results[i] === "win").map(l => l.odds);
  const recalculatedOdds = survivingOdds.length > 0 ? rrCalcParlayPayout(survivingOdds) : 0;
  const potentialPayout = Math.round((bet.stakeAmount + (bet.stakeAmount * recalculatedOdds) / 100) * 100) / 100;
  return { result: "win", profitLoss: Math.round((potentialPayout - bet.stakeAmount) * 100) / 100 };
}

/** Returns null when the bet should stay pending (game not final / not found / side unclear). */
async function resolveBet(
  bet: BankrollBet,
  getFinals: (sport: RrSport, date: string) => Promise<FinalGame[]>
): Promise<Outcome | null> {
  if (bet.betType === "parlay") return resolveParlayBet(bet, getFinals);
  if (!bet.sport || !bet.matchup || !bet.pickLabel) return null; // malformed single — nothing to resolve against

  const finals = await getFinals(bet.sport, bet.date);
  const parts = bet.matchup.split(" @ ");
  if (parts.length !== 2) return null;
  const [awayTeam, homeTeam] = parts;

  const game = findGame(finals, awayTeam, homeTeam);
  if (!game) return null;

  if (bet.propType) return resolvePropBet(bet, game);

  if (game.state === "no-action") return { result: "void", profitLoss: 0 };
  if (game.state !== "final" || game.homeScore === null || game.awayScore === null) return null;

  const pickedTeam = bet.pickLabel.replace(/\s+ML$/, "").trim();
  const pickedHome = rrNormalizeTeamName(pickedTeam) === rrNormalizeTeamName(homeTeam);
  const pickedAway = rrNormalizeTeamName(pickedTeam) === rrNormalizeTeamName(awayTeam);
  if (!pickedHome && !pickedAway) return null; // can't tell which side this pick was on

  const pickedScore = pickedHome ? game.homeScore : game.awayScore;
  const oppScore = pickedHome ? game.awayScore : game.homeScore;

  if (pickedScore > oppScore) {
    return { result: "win", profitLoss: Math.round((bet.potentialPayout - bet.stakeAmount) * 100) / 100 };
  }
  if (pickedScore < oppScore) return { result: "loss", profitLoss: -bet.stakeAmount };
  return { result: "push", profitLoss: 0 };
}

// ─── Bankroll ledger math ────────────────────────────────────────────────────

/** Walks every bet in order and rebuilds bankrollAfter + all aggregate stats from scratch. */
function recomputeBankroll(bankroll: Bankroll): void {
  let running = bankroll.initialBankroll;
  let peak = bankroll.initialBankroll;
  let low = bankroll.initialBankroll;
  let wins = 0, losses = 0, pushes = 0, voids = 0;
  let totalStaked = 0, totalProfit = 0, stakedForRoi = 0;

  for (const bet of bankroll.bets) {
    totalStaked += bet.stakeAmount;
    if (bet.result === "pending") continue;

    if (bet.result === "win") wins += 1;
    else if (bet.result === "loss") losses += 1;
    else if (bet.result === "push") pushes += 1;
    else if (bet.result === "void") voids += 1;

    running += bet.profitLoss ?? 0;
    bet.bankrollAfter = Math.round(running * 100) / 100;
    peak = Math.max(peak, bet.bankrollAfter);
    low = Math.min(low, bet.bankrollAfter);
    totalProfit += bet.profitLoss ?? 0;
    if (bet.result !== "void") stakedForRoi += bet.stakeAmount;
  }

  bankroll.totalBets = bankroll.bets.length;
  bankroll.wins = wins;
  bankroll.losses = losses;
  bankroll.pushes = pushes;
  bankroll.voids = voids;
  bankroll.totalStaked = Math.round(totalStaked * 100) / 100;
  bankroll.totalProfit = Math.round(totalProfit * 100) / 100;
  bankroll.currentBankroll = Math.round(running * 100) / 100;
  bankroll.peakBankroll = Math.round(peak * 100) / 100;
  bankroll.lowestBankroll = Math.round(low * 100) / 100;
  bankroll.roi = stakedForRoi > 0 ? Math.round((totalProfit / stakedForRoi) * 10000) / 10000 : 0;
}

function tierActualWinRate(bets: BankrollBet[], tier: RrTier): number | null {
  const decided = bets.filter(b => b.tier === tier && (b.result === "win" || b.result === "loss"));
  if (decided.length === 0) return null;
  return Math.round((decided.filter(b => b.result === "win").length / decided.length) * 10000) / 10000;
}

function tierPredictedWinRate(bets: BankrollBet[], tier: RrTier): number | null {
  const decided = bets.filter(b => b.tier === tier && (b.result === "win" || b.result === "loss"));
  if (decided.length === 0) return null;
  return decided.reduce((acc, b) => acc + (b.estimatedWinPct ?? 0), 0) / decided.length;
}

function sportRoi(bets: BankrollBet[], sport: RrSport): number | null {
  const decided = bets.filter(b => b.sport === sport && (b.result === "win" || b.result === "loss" || b.result === "push"));
  if (decided.length === 0) return null;
  const staked = decided.reduce((acc, b) => acc + b.stakeAmount, 0);
  const profit = decided.reduce((acc, b) => acc + (b.profitLoss ?? 0), 0);
  return staked > 0 ? Math.round((profit / staked) * 10000) / 10000 : null;
}

/**
 * Self-calibration: nudges the two composite-score multipliers based on how
 * the algorithm's predictions have actually panned out. Requires
 * CALIBRATION_THRESHOLD tracked results before touching anything, so early
 * noise can't swing the multipliers.
 */
function runCalibration(bankroll: Bankroll): void {
  const resolvedCount = bankroll.wins + bankroll.losses + bankroll.pushes + bankroll.voids;
  bankroll.calibration.totalResultsTracked = resolvedCount;
  if (resolvedCount < CALIBRATION_THRESHOLD) return;

  const bets = bankroll.bets;
  const eliteActual = tierActualWinRate(bets, "elite");

  bankroll.calibration.eliteWinRate = eliteActual;
  bankroll.calibration.strongWinRate = tierActualWinRate(bets, "strong");
  bankroll.calibration.valueWinRate = tierActualWinRate(bets, "value");
  bankroll.calibration.mlbRoi = sportRoi(bets, "mlb");
  bankroll.calibration.nflRoi = sportRoi(bets, "nfl");
  bankroll.calibration.nhlRoi = sportRoi(bets, "nhl");

  const elitePredicted = tierPredictedWinRate(bets, "elite");
  if (eliteActual !== null && elitePredicted !== null) {
    if (eliteActual < elitePredicted - WIN_RATE_TOLERANCE) bankroll.calibration.wpScoreMultiplier = 0.90;
    else if (eliteActual > elitePredicted + WIN_RATE_TOLERANCE) bankroll.calibration.wpScoreMultiplier = 1.10;
    else bankroll.calibration.wpScoreMultiplier = 1.0;
  }

  if (resolvedCount >= EV_CALIBRATION_THRESHOLD) {
    bankroll.calibration.evScoreMultiplier = bankroll.roi < 0 ? 0.92 : 1.0;
  }

  bankroll.calibration.lastCalibrated = new Date().toISOString();
}

// ─── Main handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "GET" && req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  try {
    const bankroll = await fetchBankrollFile(req);
    const pendingBets = bankroll.bets.filter(b => b.result === "pending");

    const finalsCache = new Map<string, Promise<FinalGame[]>>();
    const getFinals = (sport: RrSport, date: string): Promise<FinalGame[]> => {
      const key = `${sport}:${date}`;
      if (!finalsCache.has(key)) {
        const fetcher = sport === "mlb" ? fetchMlbFinals(date) : fetchEspnFinals(sport, date);
        finalsCache.set(key, fetcher.catch(e => {
          console.warn(`Score feed failed for ${key}:`, e);
          return [];
        }));
      }
      return finalsCache.get(key)!;
    };

    let resolvedCount = 0;
    for (const bet of pendingBets) {
      const outcome = await resolveBet(bet, getFinals);
      if (!outcome) continue;

      bet.result = outcome.result;
      bet.profitLoss = outcome.profitLoss;
      bet.resolvedAt = new Date().toISOString();
      resolvedCount += 1;
    }

    recomputeBankroll(bankroll);
    runCalibration(bankroll);

    const stillPending = bankroll.bets.filter(b => b.result === "pending").length;

    res.status(200).json({
      resolved: resolvedCount,
      pending: stillPending,
      currentBankroll: bankroll.currentBankroll,
      bankroll,
    });
  } catch (err) {
    console.error("resolve-results handler error:", err);
    res.status(500).json({
      error: "Failed to resolve results",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
