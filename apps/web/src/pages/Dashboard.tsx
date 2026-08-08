import { useState, useMemo } from "react";
import type { Pick, PropPick, ParlayOptions, Tier } from "@best-bets/algorithm";

import { useBestBets }     from "../hooks/useBestBets";
import { buildClientParlay } from "../utils/parlayBuilder";
import { PickCard }     from "../components/PickCard";
import { PropCard }     from "../components/PropCard";
import { ParlayCard }   from "../components/ParlayCard";
import { RankedTable }  from "../components/RankedTable";
import { SectionTitle } from "../components/SectionTitle";

const SPORTS = ["mlb", "nfl", "nhl"] as const;
const TIERS: Tier[] = ["elite", "strong", "value"];

const TIER_LABELS: Record<Tier, string> = {
  elite:  "🔥 Elite",
  strong: "✅ Strong",
  value:  "💎 Value",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

// ─── Sport Status Bar ─────────────────────────────────────────────────────────
function SportStatusBar({ statuses }: { statuses: { sport: string; label: string; active: boolean; note: string }[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10, marginBottom: 8 }}>
      {statuses.map(s => (
        <div key={s.sport} style={{
          background: "#0f1623", border: "1px solid #1e2d45",
          borderRadius: 10, padding: 14,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.active ? "#10b981" : "#ef4444", flexShrink: 0 }} />
            <span style={{ fontSize: "0.7rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "2px" }}>{s.label}</span>
          </div>
          <div style={{ fontSize: "0.72rem", color: "#8098b8", lineHeight: 1.5 }}>{s.note}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────
function Skeleton() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 14 }}>
      {[1, 2, 3].map(i => (
        <div key={i} style={{
          background: "#131c2e", border: "1px solid #1e2d45",
          borderRadius: 14, padding: 18, height: 220,
          animation: "pulse 1.5s ease-in-out infinite",
        }} />
      ))}
    </div>
  );
}

// ─── Parlay Configurator ───────────────────────────────────────────────────
const LEGS_OPTIONS = [2, 3, 4, 5, 6, 7, 8];
const RISK_LEVELS: { key: ParlayOptions["riskLevel"]; label: string; tooltip: string }[] = [
  { key: "safe",     label: "Safe",     tooltip: "Elite moneylines only" },
  { key: "standard", label: "Standard", tooltip: "Elite + Strong, 1 prop allowed" },
  { key: "risky",    label: "Risky",    tooltip: "All tiers, up to 2 props" },
  { key: "custom",   label: "Custom",   tooltip: "Mix freely by leg count" },
];

const fmtParlayOdds = (o: number) => (o > 0 ? `+${o}` : String(o));

function ParlayConfigurator({ picks, propPicks }: { picks: Pick[]; propPicks: PropPick[] }) {
  const [legs, setLegs] = useState(3);
  const [riskLevel, setRiskLevel] = useState<ParlayOptions["riskLevel"]>("standard");
  const [includeProps, setIncludeProps] = useState(true);
  const [mlbOnly, setMlbOnly] = useState(false);

  const options: ParlayOptions = useMemo(() => ({
    legs, riskLevel, includeProps,
    sports: mlbOnly ? ["mlb"] : undefined,
  }), [legs, riskLevel, includeProps, mlbOnly]);

  const preview = useMemo(() => buildClientParlay(picks, propPicks, options), [picks, propPicks, options]);
  const payoutLabel = preview.legs.length >= 2 ? fmtParlayOdds(preview.estimatedPayout) : "—";

  return (
    <div style={{ background: "#0f1623", border: "1px solid #1e2d45", borderRadius: 14, padding: 20 }}>
      {/* Row 1 — legs */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: "0.62rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "1.5px", color: "#4a6080", marginBottom: 6 }}>
          Legs
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {LEGS_OPTIONS.map(n => (
            <button
              key={n}
              onClick={() => setLegs(n)}
              style={{
                background: legs === n ? "#3d2e05" : "#080c14",
                border: `1px solid ${legs === n ? "#f59e0b" : "#243450"}`,
                color: legs === n ? "#f59e0b" : "#8098b8",
                borderRadius: 8, width: 34, height: 34,
                fontWeight: 800, fontSize: "0.8rem", cursor: "pointer",
              }}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Row 2 — risk level */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: "0.62rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "1.5px", color: "#4a6080", marginBottom: 6 }}>
          Risk Level
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {RISK_LEVELS.map(r => (
            <button
              key={r.key}
              onClick={() => setRiskLevel(r.key)}
              title={r.tooltip}
              style={{
                background: riskLevel === r.key ? "#243450" : "#080c14",
                border: `1px solid ${riskLevel === r.key ? "#4a6080" : "#243450"}`,
                color: riskLevel === r.key ? "#e2e8f0" : "#8098b8",
                borderRadius: 8, padding: "7px 14px",
                fontSize: "0.78rem", fontWeight: 700, cursor: "pointer",
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Row 3 — options */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.78rem", color: "#8098b8", cursor: "pointer" }}>
          <input type="checkbox" checked={includeProps} onChange={e => setIncludeProps(e.target.checked)} />
          Include Props
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.78rem", color: "#8098b8", cursor: "pointer" }}>
          <input type="checkbox" checked={mlbOnly} onChange={e => setMlbOnly(e.target.checked)} />
          MLB Only
        </label>
      </div>

      {/* Row 4 — live preview */}
      <div style={{ background: "#080c14", border: "1px solid #243450", borderRadius: 10, padding: 14 }}>
        {preview.legs.length === 0 ? (
          <div style={{ color: "#4a6080", fontSize: "0.78rem" }}>No qualifying legs for this configuration.</div>
        ) : (
          <>
            {preview.legs.map(leg => (
              <div key={leg.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "5px 0", borderBottom: "1px solid #1e2d45", fontSize: "0.8rem",
              }}>
                <span>
                  {leg.isProp && (
                    <span style={{ color: "#2dd4bf", fontWeight: 800, marginRight: 6, fontSize: "0.6rem" }}>PROP</span>
                  )}
                  {leg.label}
                </span>
                <span style={{ fontWeight: 800, color: leg.odds > 0 ? "#10b981" : "#f59e0b" }}>
                  {fmtParlayOdds(leg.odds)}
                </span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 12 }}>
              <div>
                <div style={{ fontSize: "0.6rem", color: "#4a6080", textTransform: "uppercase", letterSpacing: "1.5px" }}>
                  Combined Payout
                </div>
                <div style={{ fontSize: "1.6rem", fontWeight: 900, color: "#10b981" }}>{payoutLabel}</div>
              </div>
              <div style={{ fontSize: "0.76rem", color: "#8098b8" }}>
                {preview.legs.length >= 2 ? `~${Math.round(preview.combinedWinPct * 100)}% hit rate` : "Add more qualifying legs"}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function Dashboard() {
  const today                   = new Date().toISOString().split("T")[0];
  const [date, setDate]         = useState(today);
  const [activeTier, setActive] = useState<Tier | "all">("all");

  const { data, loading, error, refresh, lastFetch } = useBestBets({
    date,
    sports: [...SPORTS],
  });

  const filteredPicks = useMemo(() => {
    if (!data) return [];
    return activeTier === "all"
      ? data.picks
      : data.picks.filter(p => p.tier === activeTier);
  }, [data, activeTier]);

  return (
    <>
      {/* ── Slate date + freshness ── */}
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ color: "#4a6080", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "3px" }}>
          {data ? formatDate(data.date) : "Loading…"}
        </div>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 7,
          background: "#0f1623", border: "1px solid #243450",
          borderRadius: 20, padding: "6px 14px", fontSize: "0.72rem", color: "#8098b8", marginTop: 12,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: loading ? "#f59e0b" : "#10b981", animation: "pulse 1.5s infinite" }} />
          {loading ? "Fetching picks…" : lastFetch ? `Updated ${lastFetch.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Ready"}
        </div>
      </div>

      {/* ── Controls ── */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 24, justifyContent: "center" }}>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{
            background: "#0f1623", border: "1px solid #243450",
            color: "#e2e8f0", borderRadius: 8, padding: "7px 12px",
            fontSize: "0.8rem", cursor: "pointer",
          }}
        />

        {(["all", ...TIERS] as const).map(t => (
          <button
            key={t}
            onClick={() => setActive(t)}
            style={{
              background:  activeTier === t ? "#243450" : "#0f1623",
              border:      `1px solid ${activeTier === t ? "#4a6080" : "#1e2d45"}`,
              color:       activeTier === t ? "#e2e8f0" : "#4a6080",
              borderRadius: 8, padding: "7px 14px",
              fontSize: "0.78rem", fontWeight: 700, cursor: "pointer",
            }}
          >
            {t === "all" ? "All Tiers" : TIER_LABELS[t]}
          </button>
        ))}

        <button
          onClick={refresh}
          disabled={loading}
          style={{
            background: "#0f1623", border: "1px solid #243450",
            color: loading ? "#4a6080" : "#10b981",
            borderRadius: 8, padding: "7px 14px",
            fontSize: "0.78rem", fontWeight: 700, cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      {/* ── Error ── */}
      {error && (
        <div style={{
          background: "#1f0a0a", border: "1px solid #5a1a1a",
          borderRadius: 10, padding: 14, marginBottom: 20,
          color: "#f87171", fontSize: "0.82rem",
        }}>
          ⚠️ {error}. Check your API keys in Vercel environment variables.
        </div>
      )}

      {/* ── Degraded-data warnings ── */}
      {data?.warnings?.map((w, i) => (
        <div key={i} style={{
          background: "#1f1608", border: "1px solid #6b4a10",
          borderRadius: 10, padding: 14, marginBottom: 20,
          color: "#fbbf24", fontSize: "0.82rem", lineHeight: 1.6,
        }}>
          ⚠️ <strong>Degraded data.</strong> {w}
        </div>
      ))}

      {/* ── Sport Status ── */}
      {data?.sportStatuses && (
        <>
          <SectionTitle>📡 Sport Status</SectionTitle>
          <SportStatusBar statuses={data.sportStatuses} />
        </>
      )}

      {/* ── Pick Cards ── */}
      {filteredPicks.some(p => p.tier === "elite") && (
        <>
          <SectionTitle>🔥 Elite Picks — Algorithm Score 80+</SectionTitle>
          {loading ? <Skeleton /> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 14 }}>
              {filteredPicks.filter(p => p.tier === "elite").map(pick => (
                <PickCard key={pick.id} pick={pick} rank={data!.picks.indexOf(pick) + 1} />
              ))}
            </div>
          )}
        </>
      )}

      {filteredPicks.some(p => p.tier === "strong") && (
        <>
          <SectionTitle>✅ Strong Picks — Algorithm Score 65–79</SectionTitle>
          {loading ? <Skeleton /> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 14 }}>
              {filteredPicks.filter(p => p.tier === "strong").map(pick => (
                <PickCard key={pick.id} pick={pick} rank={data!.picks.indexOf(pick) + 1} />
              ))}
            </div>
          )}
        </>
      )}

      {filteredPicks.some(p => p.tier === "value") && (
        <>
          <SectionTitle>💎 Value Picks — Positive EV at Better Odds</SectionTitle>
          {loading ? <Skeleton /> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 14 }}>
              {filteredPicks.filter(p => p.tier === "value").map(pick => (
                <PickCard key={pick.id} pick={pick} rank={data!.picks.indexOf(pick) + 1} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Top Prop Bets ── */}
      {data && data.propPicks && data.propPicks.length > 0 && (
        <>
          <SectionTitle>⚾ Top Prop Bets</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 14 }}>
            {[...data.propPicks]
              .sort((a, b) => {
                const tierOrder: Record<Tier, number> = { elite: 3, strong: 2, value: 1 };
                const tierDiff = tierOrder[b.tier] - tierOrder[a.tier];
                return tierDiff !== 0 ? tierDiff : b.scores.composite - a.scores.composite;
              })
              .map((prop, i) => <PropCard key={prop.id} prop={prop} rank={i + 1} />)}
          </div>
        </>
      )}

      {/* ── Ranked Table ── */}
      {data && data.picks.length > 0 && (
        <>
          <SectionTitle>📊 Ranked Pick List</SectionTitle>
          <RankedTable picks={data.picks} />
        </>
      )}

      {/* ── Parlay Configurator ── */}
      {data && data.picks.length > 0 && (
        <>
          <SectionTitle>🎰 Build Custom Parlay</SectionTitle>
          <ParlayConfigurator picks={data.picks} propPicks={data.propPicks ?? []} />
        </>
      )}

      {/* ── Parlays ── */}
      {data && data.parlays.length > 0 && (
        <>
          <SectionTitle>🎰 Parlay Builder</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 14 }}>
            {data.parlays.map(p => <ParlayCard key={p.id} parlay={p} />)}
          </div>
        </>
      )}

      {/* ── Staking Guide ── */}
      <SectionTitle>📐 Staking Guide</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(155px,1fr))", gap: 9 }}>
        {[
          { units: "2–3u", color: "#f59e0b", desc: "Elite singles (80+). Highest confidence." },
          { units: "1–2u", color: "#10b981", desc: "Strong singles + 3-leg safe parlay."      },
          { units: "0.5u", color: "#8b5cf6", desc: "Value singles + 4-leg parlay."            },
          { units: "0.25u",color: "#ef4444", desc: "Shot parlays (5+ legs). Never chase."     },
          { units: "Max 5%",color:"#475569", desc: "Never risk more than 5% of bankroll/day." },
        ].map(s => (
          <div key={s.units} style={{
            background: "#0f1623", border: "1px solid #1e2d45",
            borderRadius: 10, padding: 12, textAlign: "center",
          }}>
            <div style={{ fontSize: "1rem", fontWeight: 900, color: s.color, marginBottom: 3 }}>{s.units}</div>
            <div style={{ fontSize: "0.67rem", color: "#4a6080", lineHeight: 1.4 }}>{s.desc}</div>
          </div>
        ))}
      </div>
    </>
  );
}
