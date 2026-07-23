import { useState } from "react";
import type { Pick, Tier } from "@best-bets/algorithm";

const TIER_BADGE: Record<Tier, { bg: string; color: string }> = {
  elite:  { bg: "#2d1f00", color: "#f59e0b" },
  strong: { bg: "#0a2a1a", color: "#10b981" },
  value:  { bg: "#1a0d30", color: "#8b5cf6" },
};

type SortKey = "rank" | "score" | "ev" | "odds" | "winPct";

interface Props { picks: Pick[]; }

export function RankedTable({ picks }: Props) {
  const [sortKey,  setSortKey]  = useState<SortKey>("rank");
  const [sortDesc, setSortDesc] = useState(true);

  const sorted = [...picks].sort((a, b) => {
    const vals: Record<SortKey, number> = {
      rank:   picks.indexOf(a) - picks.indexOf(b),
      score:  a.scores.composite - b.scores.composite,
      ev:     a.evEdge - b.evEdge,
      odds:   a.odds - b.odds,
      winPct: a.estimatedWinPct - b.estimatedWinPct,
    };
    const v = vals[sortKey];
    return sortDesc ? -v : v;
  });

  const onSort = (key: SortKey) => {
    if (sortKey === key) setSortDesc(d => !d);
    else { setSortKey(key); setSortDesc(true); }
  };

  const th = (key: SortKey, label: string) => (
    <th
      onClick={() => onSort(key)}
      style={{
        padding: "9px 12px", textAlign: "left", cursor: "pointer",
        color: sortKey === key ? "#e2e8f0" : "#4a6080",
        fontSize: "0.6rem", fontWeight: 800, textTransform: "uppercase",
        letterSpacing: "1.5px", background: "#131c2e",
        borderBottom: "1px solid #243450", userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label} {sortKey === key ? (sortDesc ? "↓" : "↑") : ""}
    </th>
  );

  return (
    <div style={{
      background: "#0f1623", border: "1px solid #1e2d45",
      borderRadius: 12, overflow: "hidden",
    }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.76rem" }}>
          <thead>
            <tr>
              {th("rank",   "#")}
              <th style={{ padding: "9px 12px", textAlign: "left", color: "#4a6080", fontSize: "0.6rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "1.5px", background: "#131c2e", borderBottom: "1px solid #243450" }}>Pick</th>
              <th style={{ padding: "9px 12px", textAlign: "left", color: "#4a6080", fontSize: "0.6rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "1.5px", background: "#131c2e", borderBottom: "1px solid #243450" }}>Time</th>
              {th("odds",   "Odds")}
              {th("score",  "Score")}
              <th style={{ padding: "9px 12px", textAlign: "left", color: "#4a6080", fontSize: "0.6rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "1.5px", background: "#131c2e", borderBottom: "1px solid #243450" }}>Tier</th>
              {th("winPct", "Win %")}
              {th("ev",     "EV")}
            </tr>
          </thead>
          <tbody>
            {sorted.map((pick, i) => {
              const badge    = TIER_BADGE[pick.tier];
              const isPlus   = pick.odds > 0;
              const origRank = picks.indexOf(pick) + 1;
              const time     = new Date(pick.startTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

              return (
                <tr
                  key={pick.id}
                  style={{ borderBottom: "1px solid #1e2d45" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#0f1c2e")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <td style={{ padding: "9px 12px", color: "#f59e0b", fontWeight: 800 }}>{origRank}</td>
                  <td style={{ padding: "9px 12px", fontWeight: 700 }}>
                    {pick.pickLabel}
                    <span style={{ color: "#4a6080", fontWeight: 400, fontSize: "0.68rem", marginLeft: 6 }}>
                      {pick.matchup.split("@")[pick.matchup.indexOf("@") > -1 ? 0 : 0].trim()}
                    </span>
                  </td>
                  <td style={{ padding: "9px 12px", color: "#8098b8", fontSize: "0.72rem", whiteSpace: "nowrap" }}>{time}</td>
                  <td style={{ padding: "9px 12px", color: isPlus ? "#10b981" : "#f59e0b", fontWeight: 800 }}>
                    {isPlus ? `+${pick.odds}` : pick.odds}
                  </td>
                  <td style={{ padding: "9px 12px", fontWeight: 800, color: pick.tier === "elite" ? "#f59e0b" : pick.tier === "strong" ? "#10b981" : "#8b5cf6" }}>
                    {pick.scores.composite}
                  </td>
                  <td style={{ padding: "9px 12px" }}>
                    <span style={{ background: badge.bg, color: badge.color, borderRadius: 4, padding: "2px 7px", fontSize: "0.62rem", fontWeight: 800 }}>
                      {pick.tier.toUpperCase()}
                    </span>
                  </td>
                  <td style={{ padding: "9px 12px" }}>{Math.round(pick.estimatedWinPct * 100)}%</td>
                  <td style={{ padding: "9px 12px", color: "#10b981", fontWeight: 700 }}>
                    +{Math.round(pick.evEdge * 100)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
