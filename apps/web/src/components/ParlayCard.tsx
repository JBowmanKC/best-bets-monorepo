import type { Parlay } from "@best-bets/algorithm";

const PARLAY_STYLE = {
  safe:  { border: "linear-gradient(90deg,#10b981,#6ee7b7)", nameColor: "#10b981", sub: "Highest win probability · Best for consistent bettors" },
  value: { border: "linear-gradient(90deg,#8b5cf6,#f59e0b)", nameColor: "#8b5cf6", sub: "High EV legs · Maximum profit angle"                   },
  shot:  { border: "linear-gradient(90deg,#ef4444,#f59e0b)", nameColor: "#ef4444", sub: "Lottery ticket · Tiny stake only"                       },
};

const SPORT_COLOR: Record<string, string> = {
  mlb:    "#60a5fa",
  nfl:    "#c084fc",
  nhl:    "#38bdf8",
  soccer: "#10b981",
};

interface Props { parlay: Parlay; }

export function ParlayCard({ parlay }: Props) {
  const style = PARLAY_STYLE[parlay.id];

  return (
    <div style={{
      background: "#0f1623", border: "1px solid #243450",
      borderRadius: 14, padding: 20, position: "relative", overflow: "hidden",
    }}>
      {/* Top bar */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 3,
        background: style.border,
      }} />

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: "0.66rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "2px", color: style.nameColor, marginBottom: 2 }}>
            {parlay.emoji} {parlay.label}
          </div>
          <div style={{ fontSize: "0.67rem", color: "#4a6080" }}>
            {style.sub}
            {parlay.sportsbook && ` · all legs via ${parlay.sportsbook}`}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "0.6rem", color: "#4a6080" }}>Est. Payout</div>
          <div style={{ fontSize: "1.4rem", fontWeight: 900, color: "#10b981" }}>
            +{parlay.estimatedPayout}
          </div>
        </div>
      </div>

      {/* Legs */}
      {parlay.legs.map((leg, i) => {
        const isPlus = leg.odds > 0;
        const time   = new Date(leg.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        return (
          <div key={leg.pickId} style={{
            display: "flex", alignItems: "center", gap: 9,
            padding: "7px 0",
            borderBottom: i < parlay.legs.length - 1 ? "1px solid #1e2d45" : "none",
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: "50%", background: "#1e2d45",
              fontSize: "0.64rem", fontWeight: 800,
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0, color: "#8098b8",
            }}>{i + 1}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "0.82rem", fontWeight: 700 }}>
                <span style={{
                  fontSize: "0.58rem", fontWeight: 800, textTransform: "uppercase",
                  letterSpacing: "1px", color: SPORT_COLOR[leg.sport] ?? "#60a5fa",
                  marginRight: 5,
                }}>{leg.sport.toUpperCase()}</span>
                {leg.pickLabel}
              </div>
              <div style={{ fontSize: "0.63rem", color: "#4a6080" }}>
                {leg.matchup} · {time}
              </div>
            </div>
            <div style={{
              fontSize: "0.82rem", fontWeight: 800,
              color: isPlus ? "#10b981" : "#f59e0b",
            }}>
              {isPlus ? `+${leg.odds}` : leg.odds}
            </div>
          </div>
        );
      })}

      {/* Footer stats */}
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
        {[
          ["~" + Math.round(parlay.combinedWinPct * 100) + "%", "Hit Rate"],
          [String(parlay.legs.length), "Legs"],
          [parlay.recommendedStake, "Stake"],
        ].map(([val, lbl]) => (
          <div key={lbl} style={{
            background: "#131c2e", borderRadius: 7, padding: "7px 9px", textAlign: "center",
          }}>
            <div style={{ fontSize: "0.85rem", fontWeight: 800 }}>{val}</div>
            <div style={{ fontSize: "0.58rem", color: "#4a6080", marginTop: 1 }}>{lbl}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
