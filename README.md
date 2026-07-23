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
              ↓ parallel
    [Claude API]           [OddsAPI]
    (games + standings     (live moneylines from
     via SportRadar)        DraftKings/FanDuel/BetMGM)
              ↓ merge
    Algorithm (scorer.ts)
    → WP (35%) + EV (35%) + MOM (20%) + CTX (10%)
    → tier picks → build parlays
              ↓
    JSON → React renders dashboard
    (Vercel edge cache: 30 min TTL)
```

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

### 3. Run locally with Vercel CLI
```bash
npm install -g vercel
vercel dev
```
This starts both the React app (port 3000) and the serverless function at `/api/best-bets`.

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

3. **Add environment variables** in Vercel dashboard → Settings → Environment Variables:
   ```
   ANTHROPIC_API_KEY   = sk-ant-...
   ODDS_API_KEY        = your-key-from-the-odds-api.com
   ```

4. **Deploy** — Vercel auto-deploys on every push to main.

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
