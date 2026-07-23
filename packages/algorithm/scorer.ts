import {
  RawGame, Pick, FactorScores, Tier,
  FACTOR_WEIGHTS, TIER_THRESHOLDS, STAKE_BY_TIER,
} from "./types";

// ─── Utility: convert American odds → implied probability ───────────────────
export function oddsToImpliedProb(americanOdds: number): number {
  if (americanOdds > 0) return 100 / (americanOdds + 100);
  return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
}

// ─── Utility: record gap → win probability estimate ─────────────────────────
function recordGapToWinProb(
  favRecord: { wins: number; losses: number },
  dogRecord: { wins: number; losses: number },
  isFavHome: boolean
): number {
  const favWinPct = favRecord.wins / (favRecord.wins + favRecord.losses);
  const dogWinPct = dogRecord.wins / (dogRecord.wins + dogRecord.losses);
  const gap = favWinPct - dogWinPct;

  // Base probability from record differential (sigmoid-ish mapping)
  let prob = 0.5 + gap * 0.8;

  // Home field bump: ~4% for MLB/NHL, ~3% for NFL, ~2% for soccer
  if (isFavHome) prob += 0.04;

  return Math.min(Math.max(prob, 0.3), 0.82);
}

// ─── Factor 1: Win Probability Score (35%) ──────────────────────────────────
function scoreWinProbability(game: RawGame, pickHome: boolean): number {
  const favRecord  = pickHome ? game.homeRecord : game.awayRecord;
  const dogRecord  = pickHome ? game.awayRecord : game.homeRecord;
  const isFavHome  = pickHome;

  const prob = recordGapToWinProb(favRecord, dogRecord, isFavHome);
  // Map 50–82% range to 0–100 score
  return Math.round(((prob - 0.3) / 0.52) * 100);
}

// ─── Factor 2: Expected Value Score (35%) ───────────────────────────────────
function scoreExpectedValue(
  estimatedWinPct: number,
  impliedWinPct: number
): { score: number; evEdge: number } {
  const evEdge = estimatedWinPct - impliedWinPct;
  // Map -10% to +15% EV range → 0–100 score
  const score = Math.round(((evEdge + 0.10) / 0.25) * 100);
  return { score: Math.min(Math.max(score, 0), 100), evEdge };
}

// ─── Factor 3: Momentum Score (20%) ─────────────────────────────────────────
function scoreMomentum(game: RawGame, pickHome: boolean): number {
  const recentForm    = pickHome ? game.homeRecentForm : game.awayRecentForm;
  const seriesWins    = pickHome ? game.homeSeriesWins : game.awaySeriesWins;
  const oppSeriesWins = pickHome ? game.awaySeriesWins : game.homeSeriesWins;

  // Recent form: W=1, L=0, weight recency
  const formWeights = [0.35, 0.25, 0.20, 0.12, 0.08];
  const formScore = recentForm.reduce((acc, result, i) => {
    return acc + (result === "W" ? formWeights[i] : 0);
  }, 0);

  // Series advantage
  const seriesScore = seriesWins > oppSeriesWins
    ? 1.0
    : seriesWins === oppSeriesWins
    ? 0.5
    : 0.1;

  return Math.round((formScore * 0.6 + seriesScore * 0.4) * 100);
}

// ─── Factor 4: Context Score (10%) ──────────────────────────────────────────
function scoreContext(game: RawGame, pickHome: boolean): number {
  let score = 50; // neutral baseline

  // Home field advantage
  if (pickHome) score += 20;

  // Notes-based boosts (parsed from game notes)
  const notes = (game.notes || "").toLowerCase();
  if (notes.includes("playoff") || notes.includes("finals")) score += 15;
  if (notes.includes("revenge") || notes.includes("rivalry"))  score += 10;
  if (notes.includes("rest"))                                   score += 5;
  if (notes.includes("travel") || notes.includes("road trip")) score -= 5;
  if (notes.includes("doubleheader g2"))                        score -= 5;

  return Math.min(Math.max(score, 0), 100);
}

// ─── Composite scorer ────────────────────────────────────────────────────────
function composite(scores: Omit<FactorScores, "composite">): number {
  return Math.round(
    scores.winProbability * FACTOR_WEIGHTS.winProbability +
    scores.expectedValue  * FACTOR_WEIGHTS.expectedValue  +
    scores.momentum       * FACTOR_WEIGHTS.momentum       +
    scores.context        * FACTOR_WEIGHTS.context
  );
}

// ─── Tier from composite ─────────────────────────────────────────────────────
function getTier(score: number): Tier | null {
  if (score >= TIER_THRESHOLDS.elite)  return "elite";
  if (score >= TIER_THRESHOLDS.strong) return "strong";
  if (score >= TIER_THRESHOLDS.value)  return "value";
  return null;
}

// ─── Main: score a single game, returns Pick or null ────────────────────────
export function scoreGame(game: RawGame): Pick[] {
  const picks: Pick[] = [];

  // Evaluate both sides of the bet (home and away)
  for (const pickHome of [true, false]) {
    const odds = pickHome ? game.odds.homeMoneyline : game.odds.awayMoneyline;
    if (odds === null) continue;

    const impliedWinPct   = oddsToImpliedProb(odds);
    const wpScore         = scoreWinProbability(game, pickHome);
    // Map wp score back to estimated win prob
    const estimatedWinPct = 0.3 + (wpScore / 100) * 0.52;

    const { score: evScore, evEdge } = scoreExpectedValue(estimatedWinPct, impliedWinPct);

    // Only process positive EV bets
    if (evEdge <= 0) continue;

    const momScore = scoreMomentum(game, pickHome);
    const ctxScore = scoreContext(game, pickHome);

    const factorScores: FactorScores = {
      winProbability: wpScore,
      expectedValue:  evScore,
      momentum:       momScore,
      context:        ctxScore,
      composite:      0, // placeholder
    };
    factorScores.composite = composite(factorScores);

    const tier = getTier(factorScores.composite);
    if (!tier) continue;

    const team      = pickHome ? game.homeTeam : game.awayTeam;
    const direction = pickHome ? "Home Win" : "Away Win";

    picks.push({
      id:               `${game.id}-${pickHome ? "home" : "away"}`,
      sport:            game.sport,
      matchup:          `${game.awayTeam} @ ${game.homeTeam}`,
      betType:          `Moneyline — ${direction}`,
      pickLabel:        `${team} ML`,
      odds,
      estimatedWinPct:  Math.round(estimatedWinPct * 1000) / 1000,
      impliedWinPct:    Math.round(impliedWinPct * 1000) / 1000,
      evEdge:           Math.round(evEdge * 1000) / 1000,
      tier,
      scores:           factorScores,
      startTime:        game.startTime,
      rationale:        buildRationale(game, pickHome, estimatedWinPct, evEdge),
      stake:            STAKE_BY_TIER[tier],
      isPositiveEV:     true,
    });
  }

  // Return only the best side per game (highest composite)
  if (picks.length === 0) return [];
  picks.sort((a, b) => b.scores.composite - a.scores.composite);
  return [picks[0]];
}

// ─── Rationale builder ───────────────────────────────────────────────────────
function buildRationale(
  game: RawGame,
  pickHome: boolean,
  winPct: number,
  evEdge: number
): string {
  const team      = pickHome ? game.homeTeam : game.awayTeam;
  const oppTeam   = pickHome ? game.awayTeam : game.homeTeam;
  const teamRec   = pickHome ? game.homeRecord : game.awayRecord;
  const oppRec    = pickHome ? game.awayRecord : game.homeRecord;
  const recDiff   = (teamRec.wins - teamRec.losses) - (oppRec.wins - oppRec.losses);
  const form      = pickHome ? game.homeRecentForm : game.awayRecentForm;
  const winsLast5 = form.filter(r => r === "W").length;
  const homeStr   = pickHome ? "at home" : "on the road";

  return [
    `${team} (${teamRec.wins}-${teamRec.losses}) vs ${oppTeam} (${oppRec.wins}-${oppRec.losses}).`,
    recDiff > 0
      ? `${team} is ${recDiff} games better on the season.`
      : `Slim record edge — value play.`,
    `Won ${winsLast5} of last 5 games ${homeStr}.`,
    `Algorithm win probability: ${Math.round(winPct * 100)}% vs implied ${Math.round((winPct - evEdge) * 100)}% — +${Math.round(evEdge * 100)}% positive EV edge.`,
  ].join(" ");
}

// ─── Score all games, rank, deduplicate ─────────────────────────────────────
export function scoreAllGames(games: RawGame[]): Pick[] {
  const allPicks = games.flatMap(scoreGame);

  // Sort: tier first (elite > strong > value), then composite score
  const tierOrder: Record<Tier, number> = { elite: 3, strong: 2, value: 1 };
  allPicks.sort((a, b) => {
    const tierDiff = tierOrder[b.tier] - tierOrder[a.tier];
    if (tierDiff !== 0) return tierDiff;
    return b.scores.composite - a.scores.composite;
  });

  return allPicks;
}
