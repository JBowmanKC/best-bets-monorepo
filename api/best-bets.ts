import type { VercelRequest, VercelResponse } from "@vercel/node";
import { scoreAllGames, buildParlays } from "@best-bets/algorithm";
import type { RawGame, BestBetsResponse, SportStatus, Sport } from "@best-bets/algorithm";

// ─── Environment variables (set in Vercel dashboard) ────────────────────────
// ANTHROPIC_API_KEY  — your Anthropic key
// ODDS_API_KEY       — your OddsAPI key

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const ODDS_API_KEY      = process.env.ODDS_API_KEY!;

// OddsAPI sport keys
const ODDS_API_SPORT_MAP: Record<string, string> = {
  mlb:    "baseball_mlb",
  nfl:    "americanfootball_nfl",
  nhl:    "icehockey_nhl",
  soccer: "soccer_fifa_world_cup",
};

// ─── Step 1: Ask Claude (via Anthropic API) for today's games + context ─────
async function fetchGamesFromClaude(
  sports: string[],
  date: string
): Promise<{ games: RawGame[]; sportStatuses: SportStatus[] }> {
  const prompt = `Today's date is ${date}. You have access to live sports data via your tools.

For each of these sports: ${sports.join(", ")}

Please return a JSON object with this exact structure:
{
  "sportStatuses": [
    {
      "sport": "mlb",
      "label": "⚾ MLB",
      "active": true,
      "note": "15 games scheduled today"
    }
  ],
  "games": [
    {
      "id": "unique-game-id",
      "sport": "mlb",
      "homeTeam": "New York Yankees",
      "awayTeam": "Los Angeles Dodgers",
      "startTime": "2026-07-19T16:35:00Z",
      "homeRecord": { "wins": 54, "losses": 43, "winPct": 0.557 },
      "awayRecord": { "wins": 62, "losses": 36, "winPct": 0.633 },
      "homeRecentForm": ["W","L","W","W","L"],
      "awayRecentForm": ["W","W","W","L","W"],
      "homeSeriesWins": 0,
      "awaySeriesWins": 1,
      "venue": "Yankee Stadium",
      "notes": ""
    }
  ]
}

Rules:
- Only include games SCHEDULED for today (${date}) that have NOT started yet
- Use real current standings and recent form from your data
- homeRecentForm and awayRecentForm = last 5 games, most recent first
- If a sport is off-season or no games today, include it in sportStatuses with active:false
- Return ONLY the JSON object, no markdown, no explanation`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const text = data.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");

  // Strip any accidental markdown fences
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Step 2: Fetch live moneylines from OddsAPI ──────────────────────────────
interface OddsAPIBookmaker {
  markets: { key: string; outcomes: { name: string; price: number }[] }[];
}
interface OddsAPIGame {
  id: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsAPIBookmaker[];
}

async function fetchOdds(
  sports: string[]
): Promise<Map<string, { home: number; away: number; draw?: number }>> {
  const oddsMap = new Map<string, { home: number; away: number; draw?: number }>();

  await Promise.all(
    sports.map(async (sport) => {
      const apiKey = ODDS_API_SPORT_MAP[sport];
      if (!apiKey) return;

      const url = `https://api.the-odds-api.com/v4/sports/${apiKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`;

      try {
        const res  = await fetch(url);
        if (!res.ok) return;
        const games: OddsAPIGame[] = await res.json();

        for (const game of games) {
          // Average moneyline across available bookmakers
          let homeTotal = 0, awayTotal = 0, drawTotal = 0;
          let homeCount = 0, awayCount = 0, drawCount = 0;

          for (const bm of game.bookmakers) {
            const h2h = bm.markets.find(m => m.key === "h2h");
            if (!h2h) continue;
            for (const outcome of h2h.outcomes) {
              if (outcome.name === game.home_team) {
                homeTotal += outcome.price; homeCount++;
              } else if (outcome.name === game.away_team) {
                awayTotal += outcome.price; awayCount++;
              } else {
                // Draw (soccer)
                drawTotal += outcome.price; drawCount++;
              }
            }
          }

          const key = `${game.away_team}@${game.home_team}`.toLowerCase().replace(/\s+/g, "");
          oddsMap.set(key, {
            home: homeCount > 0 ? Math.round(homeTotal / homeCount) : -110,
            away: awayCount > 0 ? Math.round(awayTotal / awayCount) : -110,
            ...(drawCount > 0 ? { draw: Math.round(drawTotal / drawCount) } : {}),
          });
        }
      } catch (e) {
        console.warn(`OddsAPI fetch failed for ${sport}:`, e);
      }
    })
  );

  return oddsMap;
}

// ─── Step 3: Merge odds into games ──────────────────────────────────────────
function mergeOdds(
  games: RawGame[],
  oddsMap: Map<string, { home: number; away: number; draw?: number }>
): RawGame[] {
  return games.map(game => {
    const key = `${game.awayTeam}@${game.homeTeam}`.toLowerCase().replace(/\s+/g, "");
    const odds = oddsMap.get(key);

    if (odds) {
      return {
        ...game,
        odds: {
          homeMoneyline: odds.home,
          awayMoneyline: odds.away,
          drawMoneyline: odds.draw ?? null,
        },
      };
    }

    // Fallback: estimate from record differential
    const homeWinPct = game.homeRecord.winPct;
    const awayWinPct = game.awayRecord.winPct;
    const diff = homeWinPct - awayWinPct;
    const homeImplied = Math.max(0.35, Math.min(0.75, 0.54 + diff * 0.8));
    const awayImplied = 1 - homeImplied;

    const toAmerican = (p: number) =>
      p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);

    return {
      ...game,
      odds: {
        homeMoneyline: toAmerican(homeImplied),
        awayMoneyline: toAmerican(awayImplied),
        drawMoneyline: null,
      },
    };
  });
}

// ─── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const date   = (req.query.date as string) || new Date().toISOString().split("T")[0];
    const sports = ((req.query.sports as string) || "mlb,nfl,nhl")
      .split(",")
      .map(s => s.trim()) as Sport[];

    // 1. Get games + context from Claude
    const { games: rawGames, sportStatuses } = await fetchGamesFromClaude(sports, date);

    // 2. Get live odds from OddsAPI
    const activeSports = sportStatuses.filter(s => s.active).map(s => s.sport);
    const oddsMap = await fetchOdds(activeSports);

    // 3. Merge odds into games
    const gamesWithOdds = mergeOdds(rawGames, oddsMap);

    // 4. Run algorithm
    const picks   = scoreAllGames(gamesWithOdds);
    const parlays = buildParlays(picks);

    const response: BestBetsResponse = {
      date,
      generatedAt: new Date().toISOString(),
      picks,
      parlays,
      sportStatuses,
      cached: false,
    };

    res.setHeader("Access-Control-Allow-Origin", "*");
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
