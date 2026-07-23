# Best Bets Algorithm — Monorepo

A dynamic daily sports betting dashboard. Visit the URL each morning and it auto-fetches today's picks via a four-factor algorithm backed by live data.

---

## Architecture

```
best-bets-monorepo/
├── api/
│   └── best-bets.ts          ← Vercel serverless function
├── apps/
│   └── web/                  ← React + Vite frontend
├── packages/
│   └── algorithm/            ← Shared scoring logic (TypeScript)
│       ├── types.ts           ─ Data types + constants
│       ├── scorer.ts          ─ Four-factor model
│       ├── parlays.ts         ─ Parlay builder
│       └── index.ts
├── vercel.json
└── tsconfig.json
```

**Data flow:**
```
Browser → GET /api/best-bets?date=2026-07-19&sports=mlb,nfl,nhl
              ↓ 1. schedule + lines (source of truth)
    [OddsAPI]  today's real matchups, start times, and averaged
               moneylines from DraftKings/FanDuel/BetMGM
              ↓ 2. enrichment (best-effort, ≤45s)
    [Claude API + web_search]  per-team record, last-5 form,
               current series standing, venue, situational notes
              ↓ merge
    Algorithm (scorer.ts)
    → WP (35%) + EV (35%) + MOM (20%) + CTX (10%)
    → tier picks → build parlays
              ↓
    JSON → React renders dashboard
    (Vercel edge cache: 30 min TTL)
```

**Why this split:** OddsAPI knows which games exist and what they're priced at, but
not team records. Claude fills in the context — but it has a training cutoff, so it
*must* search the web rather than answer from memory. If the enrichment call fails,
the API still returns picks and sets a `warnings` array; the UI renders that as a
"Degraded data" banner, because without real records the model treats every team as
.500 and systematically overrates longshots.

---

## The Algorithm

Four-factor model, each game scored 0–100:

| Factor | Weight | What it measures |
|---|---|---|
| **Win Probability** | 35% | Record gap, home/away splits, series H2H, division rank |
| **Expected Value** | 35% | Our estimated true win% vs book's implied probability — positive EV = mathematical edge |
| **Momentum** | 20% | Recent form (last 5 games), series record, run differentials |
| **Context** | 10% | Home field, rest, travel, rivalry, playoff pressure |

Tiers: **Elite** (80+) · **Strong** (65–79) · **Value** (50–64) · anything below 50 or negative EV is discarded.

---

## Local Development

### 1. Install dependencies
```bash
npm install
```

### 2. Set environment variables
Create `.env.local` in the root:
```env
ANTHROPIC_API_KEY=sk-ant-...
ODDS_API_KEY=your-odds-api-key
```

Both keys are required for full functionality. Without `ODDS_API_KEY` the API returns
a 500 (there is no schedule to work from); without `ANTHROPIC_API_KEY` it still serves
picks but flags them as degraded.

### 3. Run locally
```bash
npm run dev
```
That's it — one process, one port (5173 by default). The Vercel CLI is **not** required.

The `api/*.ts` handlers are served directly by the Vite dev server via the `localApi`
plugin in [`apps/web/vite.config.ts`](apps/web/vite.config.ts), which mounts the same
handler source Vercel runs in production. Because there's no second port and no proxy:

- nothing can collide with the API port, because there isn't one;
- Vite picks the next free port for itself if 5173 is taken, so you can run this
  alongside other projects without configuring anything;
- edits to `api/*.ts` take effect on the next request — no restart.

Handlers are loaded through Vite's `ssrLoadModule`. Note the `ssr.external` entry for
`@best-bets/algorithm`: that package compiles to CommonJS, and without externalizing it
Vite inlines it into the SSR graph and fails with `exports is not defined`.

#### Running the API without the frontend

For curl/Postman testing, or to point another client at the API:

```bash
npm run dev:api                # http://localhost:4176
API_PORT=4000 npm run dev:api  # pin a specific port
```

If the default port is busy it falls back to any free port and prints the URL. If you
pin `API_PORT` explicitly and *that* is busy, it fails loudly rather than moving
somewhere you're not expecting.

---

## Deployment to Vercel

### One-time setup

1. **Push to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   gh repo create best-bets --private --push
   ```

2. **Import to Vercel:**
   - Go to [vercel.com/new](https://vercel.com/new)
   - Import your GitHub repo
   - Framework preset: **Other** (not Vite — the vercel.json handles it)
   - Root directory: `/` (monorepo root)
   - Node.js version: **20.x or later** (Project Settings → General)

   > Do not add a `runtime` key under `functions` in `vercel.json`. It expects an npm
   > package identifier with a version (e.g. `@vercel/node@3.0.0`), so a value like
   > `nodejs20.x` fails the build with *"Function Runtimes must have a valid version"*.
   > Omitting it uses the project's configured Node version, which is what you want.

3. **Add environment variables** in Vercel dashboard → Settings → Environment Variables:
   ```
   ANTHROPIC_API_KEY   = sk-ant-...
   ODDS_API_KEY        = your-key-from-the-odds-api.com
   ```
   Apply both to Production, Preview, and Development.

4. **Deploy** — Vercel auto-deploys on every push to main.

### Production gotchas

- **`maxDuration` is 60s**, which is the Hobby-plan ceiling. The enrichment call is
  capped at 45s (`ENRICHMENT_TIMEOUT_MS`) to stay inside it. Researching many games
  can approach that limit — if enrichment starts timing out, lower
  `MAX_ENRICHED_GAMES` or move to a plan that allows a longer `maxDuration`.
- **The Anthropic account needs credit.** A zero balance returns
  `400 invalid_request_error` and every response silently falls back to degraded
  (odds-only) picks with a warning banner.
- **OddsAPI free tier is 500 requests/month.** The handler makes one request *per
  sport per uncached call*, so the default `mlb,nfl,nhl` costs 3. The 30-minute edge
  cache is what keeps this affordable — don't remove the `Cache-Control` header.

### After deploy
Your dashboard lives at: `https://your-project.vercel.app`

Every morning you visit the URL and picks auto-load for the current day. The Vercel edge cache (30 min TTL) means the function runs ~48×/day max.

---

## API

### `GET /api/best-bets`

Query params:
| Param | Default | Example |
|---|---|---|
| `date` | today (UTC) | `2026-07-19` |
| `sports` | `mlb,nfl,nhl` | `mlb,soccer` |

Response shape:
```json
{
  "date": "2026-07-19",
  "generatedAt": "2026-07-19T08:00:00Z",
  "cached": false,
  "sportStatuses": [...],
  "picks": [
    {
      "id": "game-id-home",
      "sport": "mlb",
      "matchup": "LA Dodgers @ New York Yankees",
      "betType": "Moneyline — Away Win",
      "pickLabel": "Los Angeles Dodgers ML",
      "odds": -145,
      "estimatedWinPct": 0.65,
      "impliedWinPct": 0.592,
      "evEdge": 0.058,
      "tier": "elite",
      "scores": {
        "winProbability": 82,
        "expectedValue": 88,
        "momentum": 75,
        "context": 70,
        "composite": 81
      },
      "startTime": "2026-07-19T16:35:00Z",
      "rationale": "...",
      "stake": "2–3 units",
      "isPositiveEV": true
    }
  ],
  "parlays": [
    {
      "id": "safe",
      "label": "Safety Parlay",
      "emoji": "💚",
      "legs": [...],
      "estimatedPayout": 480,
      "combinedWinPct": 0.27,
      "recommendedStake": "1–2 units"
    }
  ]
}
```

---

## OddsAPI Setup

1. Sign up at [the-odds-api.com](https://the-odds-api.com) (free tier: 500 req/month)
2. Copy your API key
3. Add to Vercel env vars as `ODDS_API_KEY`

The function fetches odds from DraftKings, FanDuel, and BetMGM and **averages** them for each game. If OddsAPI fails or a game isn't listed, it falls back to estimating odds from team records — same as the manual approach used before.

---

## Extending

- **Add more sports:** Add to `ODDS_API_SPORT_MAP` in `api/best-bets.ts` and the sports query
- **Tune the algorithm:** Edit factor weights in `packages/algorithm/types.ts` (`FACTOR_WEIGHTS`)
- **Custom rationale:** Extend `buildRationale()` in `scorer.ts`
- **Add prop bets:** Extend `RawGame` type and add a `scoreProp()` function to the algorithm package
- **Notifications:** Add a Vercel cron job (`vercel.json` → `crons`) to POST picks to a Slack webhook each morning

---

## Responsible Gambling

🇨🇦 Ontario: ConnexOntario.ca · 1-866-531-2600

This tool is for entertainment purposes only. Always confirm odds with your sportsbook before wagering.
