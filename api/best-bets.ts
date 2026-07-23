import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import { scoreAllGames, buildParlays } from "@best-bets/algorithm";
import type { RawGame, BestBetsResponse, SportStatus, Sport, GameOdds } from "@best-bets/algorithm";

// ─── Environment variables ──────────────────────────────────────────────────
// ANTHROPIC_API_KEY  — Anthropic key (team context enrichment)
// ODDS_API_KEY       — OddsAPI key (schedule + live moneylines)

const ODDS_API_KEY = process.env.ODDS_API_KEY;

// OddsAPI is the source of truth for which games exist and what the lines are.
const ODDS_API_SPORT_MAP: Record<string, string> = {
  mlb:    "baseball_mlb",
  nfl:    "americanfootball_nfl",
  nhl:    "icehockey_nhl",
  soccer: "soccer_fifa_world_cup",
};

const SPORT_LABELS: Record<string, string> = {
  mlb:    "⚾ MLB",
  nfl:    "🏈 NFL",
  nhl:    "🏒 NHL",
  soccer: "⚽ Soccer",
};

// Enrichment is best-effort — it must never blow the function's time budget.
const ENRICHMENT_TIMEOUT_MS = 45_000;
// Cap how many games we ask Claude to research in one call.
const MAX_ENRICHED_GAMES = 24;

// ─── Step 1: OddsAPI → today's real schedule + moneylines ───────────────────
interface OddsAPIOutcome   { name: string; price: number }
interface OddsAPIMarket    { key: string; outcomes: OddsAPIOutcome[] }
interface OddsAPIBookmaker { key: string; markets: OddsAPIMarket[] }
interface OddsAPIGame {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsAPIBookmaker[];
}

/** A real, scheduled game with real lines. Team context is filled in later. */
interface ScheduledGame {
  id:        string;
  sport:     Sport;
  homeTeam:  string;
  awayTeam:  string;
  startTime: string;
  venue:     string;
  odds:      GameOdds;
}

/** Average the moneyline for one side across every book that priced it. */
function averagePrice(prices: number[]): number | null {
  if (prices.length === 0) return null;
  return Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
}

function toScheduledGame(game: OddsAPIGame, sport: Sport): ScheduledGame {
  const home: number[] = [];
  const away: number[] = [];
  const draw: number[] = [];

  for (const bm of game.bookmakers ?? []) {
    const h2h = bm.markets?.find(m => m.key === "h2h");
    if (!h2h) continue;
    for (const outcome of h2h.outcomes ?? []) {
      if      (outcome.name === game.home_team) home.push(outcome.price);
      else if (outcome.name === game.away_team) away.push(outcome.price);
      else                                      draw.push(outcome.price); // soccer
    }
  }

  return {
    id:        game.id,
    sport,
    homeTeam:  game.home_team,
    awayTeam:  game.away_team,
    startTime: game.commence_time,
    venue:     "",
    odds: {
      homeMoneyline: averagePrice(home),
      awayMoneyline: averagePrice(away),
      drawMoneyline: averagePrice(draw),
    },
  };
}

async function fetchSchedule(
  sports: Sport[],
  date: string
): Promise<{ games: ScheduledGame[]; sportStatuses: SportStatus[] }> {
  // Bound the request to the requested UTC calendar day.
  const from = `${date}T00:00:00Z`;
  const to   = `${date}T23:59:59Z`;

  const results = await Promise.all(
    sports.map(async (sport): Promise<{ status: SportStatus; games: ScheduledGame[] }> => {
      const label   = SPORT_LABELS[sport] ?? sport.toUpperCase();
      const sportKey = ODDS_API_SPORT_MAP[sport];

      if (!sportKey) {
        return {
          status: { sport, label, active: false, note: "Sport not supported by the odds feed." },
          games:  [],
        };
      }

      const url = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`);
      url.searchParams.set("apiKey",           ODDS_API_KEY ?? "");
      url.searchParams.set("regions",          "us");
      url.searchParams.set("markets",          "h2h");
      url.searchParams.set("oddsFormat",       "american");
      url.searchParams.set("bookmakers",       "draftkings,fanduel,betmgm");
      url.searchParams.set("commenceTimeFrom", from);
      url.searchParams.set("commenceTimeTo",   to);

      try {
        const res = await fetch(url);
        if (!res.ok) {
          const body = await res.text();
          console.warn(`OddsAPI ${sport} failed: ${res.status} ${body}`);
          return {
            status: { sport, label, active: false, note: `Odds feed error (${res.status}).` },
            games:  [],
          };
        }

        const raw = (await res.json()) as OddsAPIGame[];
        // Drop anything already underway — we only bet games that haven't started.
        const now   = Date.now();
        const games = raw
          .filter(g => new Date(g.commence_time).getTime() > now)
          .map(g => toScheduledGame(g, sport))
          // A game with no moneyline on either side is unbettable here.
          .filter(g => g.odds.homeMoneyline !== null || g.odds.awayMoneyline !== null);

        return {
          status: {
            sport,
            label,
            active: games.length > 0,
            note:   games.length > 0
              ? `${games.length} game${games.length === 1 ? "" : "s"} scheduled today`
              : "No upcoming games today (off-season or slate complete).",
          },
          games,
        };
      } catch (e) {
        console.warn(`OddsAPI ${sport} fetch threw:`, e);
        return {
          status: { sport, label, active: false, note: "Odds feed unreachable." },
          games:  [],
        };
      }
    })
  );

  return {
    games:         results.flatMap(r => r.games),
    sportStatuses: results.map(r => r.status),
  };
}

// ─── Step 2: Claude (with web search) → team records, form, series context ──
interface TeamContext {
  wins:       number;
  losses:     number;
  recentForm: ("W" | "L")[];
  seriesWins: number;
}

interface GameContext {
  home:  TeamContext;
  away:  TeamContext;
  venue: string;
  notes: string;
}

const EMPTY_TEAM: TeamContext = { wins: 0, losses: 0, recentForm: [], seriesWins: 0 };
const EMPTY_CONTEXT: GameContext = { home: EMPTY_TEAM, away: EMPTY_TEAM, venue: "", notes: "" };

/** Pull the JSON payload out of the model's final text, tags first then braces. */
function extractJson(text: string): unknown {
  const tagged = text.match(/<json>([\s\S]*?)<\/json>/);
  const candidate = tagged
    ? tagged[1]
    : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate.replace(/```json|```/g, "").trim());
}

function coerceTeam(raw: any): TeamContext {
  if (!raw || typeof raw !== "object") return EMPTY_TEAM;
  const form = Array.isArray(raw.recentForm)
    ? raw.recentForm.filter((r: unknown) => r === "W" || r === "L").slice(0, 5)
    : [];
  return {
    wins:       Number.isFinite(raw.wins)   ? Math.max(0, Math.trunc(raw.wins))   : 0,
    losses:     Number.isFinite(raw.losses) ? Math.max(0, Math.trunc(raw.losses)) : 0,
    recentForm: form,
    seriesWins: Number.isFinite(raw.seriesWins) ? Math.max(0, Math.trunc(raw.seriesWins)) : 0,
  };
}

interface EnrichmentResult {
  contexts: Map<string, GameContext>;
  warning?: string;
}

/**
 * Without real records the four-factor model degrades badly: every team looks
 * like a .500 team, so long-odds underdogs score as large positive EV. Callers
 * must surface `warning` rather than presenting these picks as authoritative.
 */
const DEGRADED_WARNING =
  "Team records and recent form could not be loaded, so Win Probability, Momentum and " +
  "Expected Value are running on placeholder data. Rankings are unreliable and biased " +
  "toward longshots — treat these as odds listings, not picks.";

async function fetchTeamContext(
  games: ScheduledGame[],
  date: string
): Promise<EnrichmentResult> {
  const contexts = new Map<string, GameContext>();
  if (games.length === 0) return { contexts };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("ANTHROPIC_API_KEY not set — skipping team context enrichment.");
    return { contexts, warning: `${DEGRADED_WARNING} (ANTHROPIC_API_KEY is not set.)` };
  }

  const client = new Anthropic({ apiKey, timeout: ENRICHMENT_TIMEOUT_MS });
  const subset = games.slice(0, MAX_ENRICHED_GAMES);

  const roster = subset
    .map(g => `- id "${g.id}" (${g.sport}): ${g.awayTeam} @ ${g.homeTeam}`)
    .join("\n");

  const prompt = `Today is ${date}. Research the current season context for these scheduled games:

${roster}

Search the web for each team's current win-loss record, their last 5 results, and the current series standing. Do not answer from memory — records change daily and your training data is out of date. Search first, then answer.

Return your findings as JSON wrapped in <json></json> tags, with one entry per game id:

<json>
{
  "games": [
    {
      "id": "<the id exactly as given above>",
      "home": { "wins": 54, "losses": 43, "recentForm": ["W","L","W","W","L"], "seriesWins": 1 },
      "away": { "wins": 62, "losses": 36, "recentForm": ["W","W","W","L","W"], "seriesWins": 0 },
      "venue": "Yankee Stadium",
      "notes": ""
    }
  ]
}
</json>

Rules:
- "recentForm" is the last 5 completed games, most recent first.
- "seriesWins" is wins in the CURRENT series against this opponent (0 if not a series sport or the series just started).
- "notes" is short free text for anything the model should weigh: "playoff race", "rivalry", "long road trip", "doubleheader G2", "extended rest". Empty string if nothing notable.
- If you genuinely cannot find a team's record, use 0 for wins and losses rather than guessing.
- Return every game id from the list. Output only the JSON block.`;

  try {
    let message = await client.messages.create({
      model:      "claude-opus-4-8",
      max_tokens: 16000,
      thinking:   { type: "adaptive" },
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 30 }],
      messages: [{ role: "user", content: prompt }],
    });

    // Server-side tool loop can pause; resume until it finishes.
    for (let i = 0; i < 5 && message.stop_reason === "pause_turn"; i++) {
      message = await client.messages.create({
        model:      "claude-opus-4-8",
        max_tokens: 16000,
        thinking:   { type: "adaptive" },
        output_config: { effort: "medium" },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 30 }],
        messages: [
          { role: "user",      content: prompt },
          { role: "assistant", content: message.content },
        ],
      });
    }

    if (message.stop_reason === "refusal") {
      console.warn("Team context enrichment refused:", message.stop_details);
      return { contexts, warning: `${DEGRADED_WARNING} (The model declined the research request.)` };
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("");

    const parsed = extractJson(text) as { games?: any[] };
    for (const entry of parsed.games ?? []) {
      if (!entry?.id) continue;
      contexts.set(String(entry.id), {
        home:  coerceTeam(entry.home),
        away:  coerceTeam(entry.away),
        venue: typeof entry.venue === "string" ? entry.venue : "",
        notes: typeof entry.notes === "string" ? entry.notes : "",
      });
    }
  } catch (e) {
    // Enrichment is optional — the algorithm still runs on odds alone.
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("Team context enrichment failed, continuing without it:", e);
    return { contexts, warning: `${DEGRADED_WARNING} (${reason.split("\n")[0]})` };
  }

  // Partial coverage still leaves some games on placeholder data.
  const enriched = games.slice(0, MAX_ENRICHED_GAMES).filter(g => contexts.has(g.id)).length;
  if (enriched === 0) {
    return { contexts, warning: `${DEGRADED_WARNING} (No usable data came back.)` };
  }
  if (enriched < games.length) {
    return {
      contexts,
      warning: `Team context was only found for ${enriched} of ${games.length} games. ` +
               "Picks for the remaining games are based on odds alone and rank unreliably.",
    };
  }

  return { contexts };
}

// ─── Step 3: Merge schedule + context into the algorithm's input shape ──────
function toRawGame(game: ScheduledGame, ctx: GameContext): RawGame {
  const winPct = (t: TeamContext) =>
    t.wins + t.losses > 0 ? t.wins / (t.wins + t.losses) : 0.5;

  return {
    id:        game.id,
    sport:     game.sport,
    homeTeam:  game.homeTeam,
    awayTeam:  game.awayTeam,
    startTime: game.startTime,
    odds:      game.odds,
    homeRecord: { wins: ctx.home.wins, losses: ctx.home.losses, winPct: winPct(ctx.home) },
    awayRecord: { wins: ctx.away.wins, losses: ctx.away.losses, winPct: winPct(ctx.away) },
    homeRecentForm: ctx.home.recentForm,
    awayRecentForm: ctx.away.recentForm,
    homeSeriesWins: ctx.home.seriesWins,
    awaySeriesWins: ctx.away.seriesWins,
    venue:     ctx.venue || game.venue,
    notes:     ctx.notes,
  };
}

// ─── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  if (!ODDS_API_KEY) {
    return res.status(500).json({
      error:   "Server misconfigured",
      message: "ODDS_API_KEY is not set. Add it to .env.local locally, or to the Vercel project's environment variables.",
    });
  }

  try {
    const date   = (req.query.date as string) || new Date().toISOString().split("T")[0];
    const sports = ((req.query.sports as string) || "mlb,nfl,nhl")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean) as Sport[];

    // 1. Real schedule + real lines from OddsAPI.
    const { games, sportStatuses } = await fetchSchedule(sports, date);

    // 2. Records / form / series context from Claude (best-effort).
    const { contexts, warning } = await fetchTeamContext(games, date);

    // 3. Merge, then run the four-factor model.
    const rawGames = games.map(g => toRawGame(g, contexts.get(g.id) ?? EMPTY_CONTEXT));
    const picks    = scoreAllGames(rawGames);
    const parlays  = buildParlays(picks);

    const response: BestBetsResponse = {
      date,
      generatedAt: new Date().toISOString(),
      picks,
      parlays,
      sportStatuses,
      cached: false,
      ...(warning ? { warnings: [warning] } : {}),
    };

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    return res.status(200).json(response);

  } catch (err) {
    console.error("best-bets handler error:", err);
    return res.status(500).json({
      error:   "Failed to generate picks",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
