import type { PropPick, Tier, VoidRisk } from "@best-bets/algorithm";

const TIER_CONFIG: Record<Tier, { label: string; emoji: string; color: string; barColor: string }> = {
  elite:  { label: "ELITE",  emoji: "🔥", color: "#f59e0b", barColor: "linear-gradient(90deg,#f59e0b,#fbbf24)" },
  strong: { label: "STRONG", emoji: "✅", color: "#10b981", barColor: "linear-gradient(90deg,#10b981,#6ee7b7)" },
  value:  { label: "VALUE",  emoji: "💎", color: "#8b5cf6", barColor: "linear-gradient(90deg,#8b5cf6,#c4b5fd)" },
};

const SPORT_PILL: Record<string, { bg: string; color: string; label: string }> = {
  mlb:    { bg: "#0f2d4a", color: "#60a5fa", label: "MLB"  },
  nfl:    { bg: "#26143e", color: "#c084fc", label: "NFL"  },
  nhl:    { bg: "#0a2640", color: "#38bdf8", label: "NHL"  },
  soccer: { bg: "#0a2a1a", color: "#10b981", label: "⚽ WC" },
};

const PROP_TYPE_LABELS: Record<string, string> = {
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

const VOID_RISK_BADGE: Record<Exclude<VoidRisk, "high">, { label: string; color: string; bg: string }> = {
  low:    { label: "✓ Confirmed Starter", color: "#10b981", bg: "#082f21" },
  medium: { label: "⚠ Probable",          color: "#fbbf24", bg: "#241a06" },
};

interface Props { prop: PropPick; rank: number; }

export function PropCard({ prop, rank }: Props) {
  // Defense in depth: the API never sends a "high" voidRisk prop (it's
  // skipped entirely at scoring time), but this card must never render one.
  if (prop.voidRisk === "high") return null;

  const tier   = TIER_CONFIG[prop.tier];
  const sport  = SPORT_PILL[prop.sport] ?? SPORT_PILL.mlb;
  const pct    = prop.scores.composite;
  const isPlus = prop.odds > 0;
  const risk   = VOID_RISK_BADGE[prop.voidRisk];
  const sideLabel = prop.recommendedSide === "over" ? "Over" : "Under";
  const propLabel = PROP_TYPE_LABELS[prop.propType] ?? prop.propType;

  const localTime = new Date(prop.startTime).toLocaleTimeString([], {
    hour: "numeric", minute: "2-digit",
  });

  return (
    <div style={{
      background: "#131c2e",
      border:     "1px solid #1e2d45",
      borderRadius: 14,
      padding: 18,
      position: "relative",
      overflow: "hidden",
      transition: "border-color .2s, transform .15s",
    }}>
      {/* Tier colour bar */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 3,
        background: tier.barColor,
      }} />

      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{
            background: sport.bg, color: sport.color,
            fontSize: "0.6rem", fontWeight: 800, textTransform: "uppercase",
            letterSpacing: "1.5px", padding: "3px 8px", borderRadius: 5,
          }}>{sport.label}</span>
          <span style={{
            background: "#062825", color: "#2dd4bf",
            fontSize: "0.6rem", fontWeight: 800, textTransform: "uppercase",
            letterSpacing: "1.5px", padding: "3px 8px", borderRadius: 5,
          }}>PROP</span>
          <span style={{ color: "#4a6080", fontSize: "0.68rem" }}>#{rank}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ display: "flex", gap: 2 }}>
            {[1,2,3,4,5].map(i => (
              <div key={i} style={{
                width: 5, height: 14, borderRadius: 2,
                background: i <= Math.ceil(pct / 20) ? tier.color : "#1e2d45",
              }} />
            ))}
          </div>
          <span style={{ fontSize: "0.7rem", fontWeight: 800, color: tier.color }}>
            {tier.label} {tier.emoji}
          </span>
        </div>
      </div>

      {/* Player section */}
      <div style={{ fontSize: "0.92rem", fontWeight: 800, marginBottom: 2 }}>{prop.playerName}</div>
      <div style={{ fontSize: "0.68rem", color: "#4a6080", marginBottom: 10 }}>
        {prop.team} · {prop.matchup} · {localTime}
      </div>

      {/* Prop line box */}
      <div style={{
        background: "#080c14", border: "1px solid #243450",
        borderRadius: 8, padding: "9px 12px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 10,
      }}>
        <span style={{ fontSize: "0.88rem", fontWeight: 800 }}>
          {sideLabel} {prop.line} {propLabel}
        </span>
        <span style={{ fontSize: "1rem", fontWeight: 900, color: "#f59e0b" }}>
          {isPlus ? `+${prop.odds}` : prop.odds}
        </span>
      </div>

      {/* Metrics */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
        {[
          ["Hit Rate L10", `${Math.round(prop.hitRateLast10 * 10)}/10`],
          ["Hit Rate L20", `${Math.round(prop.hitRateLast20 * 20)}/20`],
          ["Recent Avg",   prop.recentAverage.toFixed(1)],
          ["EV",           `+${Math.round(prop.evEdge * 100)}%`],
          ["Score",        `${pct}/100`],
          ["Stake",        `$${prop.stakeAmount.toFixed(2)}`],
        ].map(([label, value]) => (
          <div key={label} style={{
            background: "#080c14", border: "1px solid #1e2d45",
            borderRadius: 6, padding: "3px 8px",
            fontSize: "0.64rem", color: "#8098b8",
          }}>
            {label} <span style={{ color: "#e2e8f0", fontWeight: 700 }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Void risk badge */}
      <div style={{ marginBottom: 10 }}>
        <span style={{
          background: risk.bg, color: risk.color,
          border: `1px solid ${risk.color}44`,
          borderRadius: 6, padding: "3px 8px",
          fontSize: "0.62rem", fontWeight: 800, letterSpacing: "0.5px",
        }}>
          {risk.label}
        </span>
      </div>

      {/* Score bar */}
      <div style={{ marginBottom: 10 }}>
        <div style={{
          display: "flex", justifyContent: "space-between",
          fontSize: "0.6rem", color: "#4a6080", textTransform: "uppercase",
          letterSpacing: "1.5px", marginBottom: 4,
        }}>
          <span>Algorithm Score</span>
          <span style={{ color: tier.color, fontWeight: 800 }}>{pct} / 100</span>
        </div>
        <div style={{ background: "#1e2d45", borderRadius: 3, height: 5, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: tier.barColor, borderRadius: 3 }} />
        </div>
      </div>

      {/* Rationale */}
      <div style={{ fontSize: "0.73rem", color: "#8098b8", lineHeight: 1.55 }}>
        {prop.rationale}
      </div>
    </div>
  );
}
