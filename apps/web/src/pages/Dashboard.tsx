import { useState } from "react";
import type { Pick, PropPick, BestBetsResponse } from "@best-bets/algorithm";

import { useBestBets }  from "../hooks/useBestBets";
import { useBankroll }  from "../hooks/useBankroll";
import { PickCard }     from "../components/PickCard";
import { PropCard }     from "../components/PropCard";
import { ParlayCard }   from "../components/ParlayCard";
import { RankedTable }  from "../components/RankedTable";
import { SectionTitle } from "../components/SectionTitle";

const SPORTS = ["mlb", "nfl", "nhl"] as const;

function isPropPick(x: Pick | PropPick): x is PropPick {
  return "playerName" in x;
}

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

// ─── Loading skeletons ────────────────────────────────────────────────────────
function CardSkeleton({ count, height }: { count: number; height: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 14 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{
          background: "#131c2e", border: "1px solid #1e2d45",
          borderRadius: 14, padding: 18, height,
          animation: "pulse 1.5s ease-in-out infinite",
        }} />
      ))}
    </div>
  );
}

function EmptyNotice({ text }: { text: string }) {
  return (
    <div style={{ color: "#4a6080", fontSize: "0.8rem", padding: "30px 0", textAlign: "center" }}>
      {text}
    </div>
  );
}

// ─── Daily Summary Bar ────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: "#0f1623", border: "1px solid #1e2d45", borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: "0.62rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "2px", color: "#4a6080" }}>
        {label}
      </div>
      <div style={{ fontSize: "1.3rem", fontWeight: 900, color: color ?? "#e2e8f0", margin: "6px 0 2px" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: "0.68rem", color: "#4a6080" }}>{sub}</div>}
    </div>
  );
}

// ─── Today's Top 10 Analysis (collapsible) ───────────────────────────────────
function TopTenAnalysisSection({ data }: { data: BestBetsResponse }) {
  const [open, setOpen] = useState(false);

  // RankedTable only understands moneyline Pick[], not the mixed Pick|PropPick
  // shortlist — feed it the moneyline subset (still capped at 10, since it's
  // a filter of the shortlist, never more).
  const rankedPicks = data.shortlist.filter((item): item is Pick => !isPropPick(item));

  return (
    <div style={{ background: "#0f1623", border: "1px solid #1e2d45", borderRadius: 10, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: "100%", background: "none", border: "none", cursor: "pointer",
          color: "#e2e8f0", textAlign: "left", padding: "13px 14px",
          display: "flex", alignItems: "center", gap: 10, fontFamily: "inherit",
        }}
      >
        <span style={{ color: "#4a6080", fontSize: "0.7rem" }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontWeight: 800, fontSize: "0.82rem" }}>{open ? "Hide" : "Show"} today's top 10 analysis</span>
        <span style={{ color: "#4a6080", fontSize: "0.68rem", flex: 1 }}>
          {data.shortlist.length} pick{data.shortlist.length === 1 ? "" : "s"} shortlisted
        </span>
      </button>

      {open && (
        <div style={{ padding: "0 16px 18px" }}>
          <div style={{ color: "#4a6080", fontSize: "0.72rem", lineHeight: 1.6, marginBottom: 16 }}>
            Top 10 picks by algorithm score — top 3 selected for today's bets.
          </div>

          <SectionTitle>Shortlist</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 14, marginBottom: 8 }}>
            {data.shortlist.map((item, i) =>
              isPropPick(item)
                ? <PropCard key={item.id} prop={item} rank={i + 1} />
                : <PickCard key={item.id} pick={item} rank={i + 1} />
            )}
          </div>

          <SectionTitle>Ranked Table</SectionTitle>
          <RankedTable picks={rankedPicks} />
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  const today = new Date().toISOString().split("T")[0];
  const [date, setDate] = useState(today);

  const { data, loading, error, refresh, lastFetch } = useBestBets({ date, sports: [...SPORTS] });
  const { data: bankroll } = useBankroll();

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

      {/* ── Section 1: Daily Summary Bar ── */}
      {data && bankroll && (
        <>
          <SectionTitle>📊 Daily Summary</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 10 }}>
            <StatCard label="Today's Bankroll" value={`$${bankroll.currentBankroll.toFixed(2)}`} />
            <StatCard label="Bets Today" value={String(data.summary.totalBetsPlaced)} />
            <StatCard
              label="At Risk"
              value={`$${data.summary.totalStaked.toFixed(2)}`}
              sub={`${(data.summary.bankrollAtRisk * 100).toFixed(1)}% of bankroll`}
            />
            <StatCard label="Potential Return" value={`$${data.summary.totalPotentialPayout.toFixed(2)}`} color="#10b981" />
            <StatCard
              label="All-Time ROI"
              value={`${(bankroll.roi * 100).toFixed(1)}%`}
              color={bankroll.roi >= 0 ? "#10b981" : "#f87171"}
            />
          </div>
        </>
      )}

      {/* ── Section 2: Today's Best Bets ── */}
      <SectionTitle>🏆 Today's Best Bets</SectionTitle>
      {loading ? (
        <CardSkeleton count={3} height={220} />
      ) : !data || data.bestBets.length === 0 ? (
        <EmptyNotice text="Picks generate at 8:00 AM EDT" />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 14 }}>
          {data.bestBets.map((item, i) => (
            <div key={item.id} style={{ position: "relative", border: "2px solid #f59e0b", borderRadius: 14 }}>
              <span style={{
                position: "absolute", top: -10, left: 14, zIndex: 1,
                background: "#f59e0b", color: "#080c14",
                fontSize: "0.6rem", fontWeight: 900, letterSpacing: "0.5px",
                padding: "2px 10px", borderRadius: 6,
              }}>
                #{i + 1} BEST BET
              </span>
              {isPropPick(item) ? <PropCard prop={item} rank={i + 1} /> : <PickCard pick={item} rank={i + 1} />}
            </div>
          ))}
        </div>
      )}

      {/* ── Section 3: Committed Parlays ── */}
      <SectionTitle>🎰 Committed Parlays</SectionTitle>
      {loading ? (
        <CardSkeleton count={2} height={260} />
      ) : data && (data.safeParlay.legs.length > 0 || data.highOddsParlay.legs.length > 0) ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 14 }}>
          {data.safeParlay.legs.length > 0 && <ParlayCard parlay={data.safeParlay} />}
          {data.highOddsParlay.legs.length > 0 && <ParlayCard parlay={data.highOddsParlay} />}
        </div>
      ) : (
        <EmptyNotice text="Picks generate at 8:00 AM EDT" />
      )}

      {/* ── Section 4: Today's Top 10 Analysis ── */}
      {data && data.shortlist.length > 0 && (
        <>
          <SectionTitle>🔍 Today's Top 10 Analysis</SectionTitle>
          <TopTenAnalysisSection data={data} />
        </>
      )}

      {/* ── Staking Guide ── */}
      <SectionTitle>📐 Staking Guide</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(155px,1fr))", gap: 9 }}>
        {[
          { units: "2–3u", color: "#f59e0b", desc: "Elite singles (80+). Highest confidence." },
          { units: "1–2u", color: "#10b981", desc: "Strong singles + safe parlay."             },
          { units: "0.5u", color: "#8b5cf6", desc: "Value singles."                            },
          { units: "0.25u",color: "#ef4444", desc: "High odds parlay. Never chase."            },
          { units: "Max 20%",color:"#475569", desc: "Never risk more than 20% of bankroll/day." },
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
