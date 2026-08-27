import { Fragment, useState } from "react";
import type { BankrollBet, BankrollCalibration, BetResult, Tier } from "@best-bets/algorithm";

import { SectionTitle } from "../components/SectionTitle";
import { useBankroll } from "../hooks/useBankroll";

type SportFilter = "mlb" | "nfl" | "nhl";
type Filter = "all" | "pending" | "win" | "loss" | SportFilter;

const TIER_META: Record<Tier, { label: string; color: string }> = {
  elite:  { label: "🔥 Elite",  color: "#f59e0b" },
  strong: { label: "✅ Strong", color: "#10b981" },
  value:  { label: "💎 Value",  color: "#8b5cf6" },
};

const RESULT_META: Record<BetResult, { label: string; color: string; bg: string }> = {
  win:     { label: "WIN",     color: "#10b981", bg: "#082f21" },
  loss:    { label: "LOSS",    color: "#f87171", bg: "#2a0d0d" },
  push:    { label: "PUSH",    color: "#94a3b8", bg: "#141c2b" },
  void:    { label: "VOID",    color: "#64748b", bg: "#111827" },
  pending: { label: "PENDING", color: "#fbbf24", bg: "#241a06" },
};

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all",     label: "All" },
  { key: "pending", label: "Pending" },
  { key: "win",     label: "Won" },
  { key: "loss",    label: "Lost" },
  { key: "mlb",     label: "⚾ MLB" },
  { key: "nfl",     label: "🏈 NFL" },
  { key: "nhl",     label: "🏒 NHL" },
];

// ─── Formatting ───────────────────────────────────────────────────────────────
const fmtMoney  = (n: number) => `$${n.toFixed(2)}`;
const fmtSigned = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
const fmtOdds   = (o: number) => (o > 0 ? `+${o}` : String(o));
const fmtPct    = (p: number | null | undefined) => (p === null || p === undefined ? "—" : `${(p * 100).toFixed(1)}%`);
const plColor   = (n: number) => (n > 0 ? "#10b981" : n < 0 ? "#f87171" : "#8098b8");

const TYPE_BADGE: Record<"single" | "parlay", { label: string; color: string; bg: string }> = {
  single: { label: "Single", color: "#8098b8", bg: "#131c2e" },
  parlay: { label: "Parlay", color: "#8b5cf6", bg: "#1a0d30" },
};

function betKind(bet: BankrollBet): "single" | "parlay" {
  return bet.betType === "parlay" ? "parlay" : "single";
}

function parlayLabel(bet: BankrollBet): string {
  return `${bet.parlayLegs?.length ?? 0}-Leg Parlay`;
}

function applyFilter(bets: BankrollBet[], filter: Filter): BankrollBet[] {
  switch (filter) {
    case "all":     return bets;
    case "pending": return bets.filter(b => b.result === "pending");
    case "win":     return bets.filter(b => b.result === "win");
    case "loss":    return bets.filter(b => b.result === "loss");
    default:        return bets.filter(b => b.sport === filter);
  }
}

// ─── Small pieces ─────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div style={{
      background: "#0f1623", border: "1px solid #1e2d45",
      borderRadius: 10, padding: 14,
    }}>
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

function ResultBadge({ result }: { result: BetResult }) {
  const meta = RESULT_META[result];
  return (
    <span style={{
      background: meta.bg, color: meta.color,
      border: `1px solid ${meta.color}44`,
      borderRadius: 6, padding: "3px 8px",
      fontSize: "0.62rem", fontWeight: 800, letterSpacing: "1px",
      whiteSpace: "nowrap",
    }}>
      {meta.label}
    </span>
  );
}

function LegResultIcon({ result }: { result?: "win" | "loss" | "void" }) {
  const meta = result === "win"
    ? { symbol: "✓", color: "#10b981", title: "Won" }
    : result === "loss"
    ? { symbol: "✗", color: "#f87171", title: "Lost" }
    : result === "void"
    ? { symbol: "–", color: "#64748b", title: "Void/push" }
    : { symbol: "•", color: "#fbbf24", title: "Pending" };

  return (
    <span title={meta.title} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 14, height: 14, borderRadius: "50%",
      fontSize: "0.62rem", fontWeight: 900, lineHeight: 1,
      color: meta.color, border: `1px solid ${meta.color}66`,
      flexShrink: 0,
    }}>
      {meta.symbol}
    </span>
  );
}

const cellStyle: React.CSSProperties = {
  padding: "9px 10px", borderBottom: "1px solid #16213a",
  fontSize: "0.74rem", textAlign: "left", verticalAlign: "middle",
};

const headStyle: React.CSSProperties = {
  ...cellStyle,
  color: "#4a6080", fontSize: "0.62rem", fontWeight: 800,
  textTransform: "uppercase", letterSpacing: "1.5px",
  borderBottom: "1px solid #1e2d45", whiteSpace: "nowrap",
};

// ─── Sparkline ────────────────────────────────────────────────────────────────
function Sparkline({ bets, initialBankroll }: { bets: BankrollBet[]; initialBankroll: number }) {
  const values = [initialBankroll, ...bets.filter(b => b.bankrollAfter !== null).map(b => b.bankrollAfter as number)];

  if (values.length < 2) {
    return (
      <div style={{ color: "#4a6080", fontSize: "0.72rem", padding: "10px 0" }}>
        Not enough resolved bets yet for a bankroll chart.
      </div>
    );
  }

  const W = 600, H = 110, PAD = 6;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const points = values.map((v, i) => {
    const x = PAD + (i / (values.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((v - min) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const color = values[values.length - 1] >= values[0] ? "#10b981" : "#f87171";
  const areaPoints = `${PAD},${H - PAD} ${points.join(" ")} ${W - PAD},${H - PAD}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 110, display: "block" }} preserveAspectRatio="none">
      <polygon points={areaPoints} fill={`${color}1a`} stroke="none" />
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth={2} />
    </svg>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────────
function FilterBar({ active, onChange }: { active: Filter; onChange: (f: Filter) => void }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "4px 0 14px" }}>
      {FILTERS.map(f => (
        <button
          key={f.key}
          onClick={() => onChange(f.key)}
          style={{
            background: active === f.key ? "#243450" : "#0f1623",
            border: `1px solid ${active === f.key ? "#4a6080" : "#1e2d45"}`,
            color: active === f.key ? "#e2e8f0" : "#4a6080",
            borderRadius: 8, padding: "6px 14px",
            fontSize: "0.72rem", fontWeight: 700,
            cursor: "pointer", fontFamily: "inherit",
          }}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

// ─── Bets table ───────────────────────────────────────────────────────────────
function BetsTable({ bets }: { bets: BankrollBet[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (bets.length === 0) {
    return <div style={{ padding: 14, color: "#4a6080", fontSize: "0.75rem" }}>No bets match this filter.</div>;
  }

  const toggle = (betId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(betId)) next.delete(betId); else next.add(betId);
      return next;
    });
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
        <thead>
          <tr>
            {["Date", "Type", "Matchup", "Pick", "Odds", "Staked", "To Win", "Result", "P&L"].map(h => (
              <th key={h} style={headStyle}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bets.map(bet => {
            const pending = bet.result === "pending";
            const isParlay = betKind(bet) === "parlay";
            const odds = isParlay ? (bet.combinedOdds ?? 0) : (bet.odds ?? 0);
            const toWin = bet.potentialPayout - bet.stakeAmount;
            const badge = TYPE_BADGE[betKind(bet)];
            const isOpen = expanded.has(bet.betId);

            return (
              <Fragment key={bet.betId}>
                <tr style={pending ? { opacity: 0.6 } : undefined}>
                  <td style={cellStyle}>{bet.date}</td>
                  <td style={cellStyle}>
                    {isParlay ? (
                      <button
                        onClick={() => toggle(bet.betId)}
                        style={{
                          background: badge.bg, color: badge.color, border: `1px solid ${badge.color}44`,
                          borderRadius: 6, padding: "3px 8px", fontSize: "0.62rem", fontWeight: 800,
                          cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 4,
                        }}
                      >
                        {isOpen ? "▾" : "▸"} {badge.label}
                      </button>
                    ) : (
                      <span style={{
                        background: badge.bg, color: badge.color, border: `1px solid ${badge.color}44`,
                        borderRadius: 6, padding: "3px 8px", fontSize: "0.62rem", fontWeight: 800,
                      }}>
                        {badge.label}
                      </span>
                    )}
                  </td>
                  <td style={{ ...cellStyle, color: "#8098b8" }}>
                    {isParlay ? `${bet.parlayLegs?.length ?? 0} games` : bet.matchup}
                  </td>
                  <td style={{ ...cellStyle, fontWeight: 700 }} title={bet.tier ? TIER_META[bet.tier].label : undefined}>
                    {isParlay ? parlayLabel(bet) : bet.pickLabel}
                  </td>
                  <td style={cellStyle}>{fmtOdds(odds)}</td>
                  <td style={cellStyle}>{fmtMoney(bet.stakeAmount)}</td>
                  <td style={{ ...cellStyle, color: "#8098b8" }}>{fmtMoney(toWin)}</td>
                  <td style={cellStyle}><ResultBadge result={bet.result} /></td>
                  <td style={{
                    ...cellStyle, fontWeight: 700,
                    color: pending ? "#4a6080" : plColor(bet.profitLoss ?? 0),
                  }}>
                    {pending ? "—" : fmtSigned(bet.profitLoss ?? 0)}
                  </td>
                </tr>
                {isParlay && isOpen && (
                  <tr>
                    <td colSpan={9} style={{ ...cellStyle, background: "#080c14", padding: "8px 10px 8px 34px" }}>
                      {(bet.parlayLegs ?? []).map((leg, i) => (
                        <div key={i} style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "3px 0", fontSize: "0.7rem", color: "#8098b8",
                        }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <LegResultIcon result={leg.result} />
                            {leg.pickLabel} <span style={{ color: "#4a6080" }}>· {leg.matchup}</span>
                          </span>
                          <span style={{ fontWeight: 700, color: "#e2e8f0" }}>{fmtOdds(leg.odds)}</span>
                        </div>
                      ))}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Calibration panel ──────────────────────────────────────────────────────
function CalibrationPanel({ calibration, bets }: { calibration: BankrollCalibration; bets: BankrollBet[] }) {
  const [open, setOpen] = useState(false);

  const predictedByTier: Record<Tier, number | null> = {
    elite:  predictedWinRate(bets, "elite"),
    strong: predictedWinRate(bets, "strong"),
    value:  predictedWinRate(bets, "value"),
  };
  const actualByTier: Record<Tier, number | null> = {
    elite:  calibration.eliteWinRate,
    strong: calibration.strongWinRate,
    value:  calibration.valueWinRate,
  };

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
        <span style={{ fontWeight: 800, fontSize: "0.78rem" }}>{open ? "Hide" : "Show"} calibration details</span>
        <span style={{ color: "#4a6080", fontSize: "0.68rem", flex: 1 }}>
          {calibration.totalResultsTracked} result{calibration.totalResultsTracked === 1 ? "" : "s"} tracked
        </span>
      </button>

      {open && (
        <div style={{ padding: "0 14px 16px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 14 }}>
            <thead>
              <tr>{["Tier", "Predicted", "Actual"].map(h => <th key={h} style={headStyle}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {(["elite", "strong", "value"] as Tier[]).map(tier => (
                <tr key={tier}>
                  <td style={{ ...cellStyle, color: TIER_META[tier].color, fontWeight: 700 }}>{TIER_META[tier].label}</td>
                  <td style={cellStyle}>{fmtPct(predictedByTier[tier])}</td>
                  <td style={cellStyle}>{fmtPct(actualByTier[tier])}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 14 }}>
            <thead>
              <tr>{["Sport", "ROI"].map(h => <th key={h} style={headStyle}>{h}</th>)}</tr>
            </thead>
            <tbody>
              <tr>
                <td style={cellStyle}>⚾ MLB</td>
                <td style={{ ...cellStyle, color: plColor(calibration.mlbRoi ?? 0), fontWeight: 700 }}>{fmtPct(calibration.mlbRoi)}</td>
              </tr>
              <tr>
                <td style={cellStyle}>🏈 NFL</td>
                <td style={{ ...cellStyle, color: plColor(calibration.nflRoi ?? 0), fontWeight: 700 }}>{fmtPct(calibration.nflRoi)}</td>
              </tr>
              <tr>
                <td style={cellStyle}>🏒 NHL</td>
                <td style={{ ...cellStyle, color: plColor(calibration.nhlRoi ?? 0), fontWeight: 700 }}>{fmtPct(calibration.nhlRoi)}</td>
              </tr>
            </tbody>
          </table>

          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: "0.74rem", color: "#8098b8", marginBottom: 10 }}>
            <div>WP multiplier: <strong style={{ color: "#e2e8f0" }}>{calibration.wpScoreMultiplier.toFixed(2)}×</strong></div>
            <div>EV multiplier: <strong style={{ color: "#e2e8f0" }}>{calibration.evScoreMultiplier.toFixed(2)}×</strong></div>
            <div>
              Last calibrated:{" "}
              <strong style={{ color: "#e2e8f0" }}>
                {calibration.lastCalibrated ? new Date(calibration.lastCalibrated).toLocaleDateString() : "never"}
              </strong>
            </div>
          </div>

          <div style={{ color: "#4a6080", fontSize: "0.68rem", lineHeight: 1.6 }}>
            Algorithm adjusts automatically after 20+ tracked results.
          </div>
        </div>
      )}
    </div>
  );
}

function predictedWinRate(bets: BankrollBet[], tier: Tier): number | null {
  const decided = bets.filter(b => b.tier === tier && (b.result === "win" || b.result === "loss"));
  if (decided.length === 0) return null;
  return decided.reduce((acc, b) => acc + (b.estimatedWinPct ?? 0), 0) / decided.length;
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export function PickHistory() {
  const { data, loading, error } = useBankroll();
  const [filter, setFilter] = useState<Filter>("all");

  if (loading) {
    return <div style={{ color: "#4a6080", fontSize: "0.8rem", padding: "40px 0", textAlign: "center" }}>Loading bankroll…</div>;
  }

  if (error) {
    return (
      <div style={{
        background: "#1f0a0a", border: "1px solid #5a1a1a", borderRadius: 10,
        padding: 14, color: "#f87171", fontSize: "0.82rem", lineHeight: 1.6,
      }}>
        ⚠️ Couldn’t load the bankroll ledger ({error}).
        <code style={{ margin: "0 4px" }}>apps/web/public/bankroll.json</code>
        is written by the Daily Picks workflow and updated by Resolve Results each morning.
      </div>
    );
  }

  if (!data || data.bets.length === 0) {
    return (
      <div style={{ color: "#4a6080", fontSize: "0.8rem", padding: "40px 0", textAlign: "center", lineHeight: 1.8 }}>
        No bets tracked yet.<br />
        Every Daily Picks run stakes its picks against the {fmtMoney(data?.initialBankroll ?? 500)} virtual bankroll.
      </div>
    );
  }

  const allTimePnl = data.currentBankroll - data.initialBankroll;
  const decided = data.wins + data.losses + data.pushes;
  const mostRecentFirst = [...data.bets].reverse();
  const filtered = applyFilter(mostRecentFirst, filter);

  return (
    <>
      <SectionTitle>💰 Bankroll</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10 }}>
        <StatCard
          label="Bankroll"
          value={fmtMoney(data.currentBankroll)}
          color={data.currentBankroll >= data.initialBankroll ? "#10b981" : "#f87171"}
          sub={`started at ${fmtMoney(data.initialBankroll)}`}
        />
        <StatCard label="All-Time P&L" value={fmtSigned(allTimePnl)} color={plColor(allTimePnl)} />
        <StatCard label="Record" value={`${data.wins}-${data.losses}-${data.pushes}`} sub={`${decided} decided${data.voids ? ` · ${data.voids} void` : ""}`} />
        <StatCard label="ROI" value={fmtPct(data.roi)} color={plColor(data.roi)} />
        <StatCard label="Peak" value={fmtMoney(data.peakBankroll)} sub={`low ${fmtMoney(data.lowestBankroll)}`} />
        <StatCard label="Total Staked" value={fmtMoney(data.totalStaked)} sub={`${data.totalBets} bet${data.totalBets === 1 ? "" : "s"}`} />
      </div>

      <SectionTitle>📉 Bankroll Over Time</SectionTitle>
      <div style={{ background: "#0f1623", border: "1px solid #1e2d45", borderRadius: 10, padding: "14px 16px" }}>
        <Sparkline bets={data.bets} initialBankroll={data.initialBankroll} />
      </div>

      <SectionTitle>🗂 Bet Ledger</SectionTitle>
      <FilterBar active={filter} onChange={setFilter} />
      <div style={{ color: "#4a6080", fontSize: "0.72rem", marginBottom: 10 }}>
        Showing {filtered.length} committed bet{filtered.length === 1 ? "" : "s"} —{" "}
        {filtered.filter(b => betKind(b) !== "parlay").length} single{filtered.filter(b => betKind(b) !== "parlay").length === 1 ? "" : "s"}
        , {filtered.filter(b => betKind(b) === "parlay").length} parlay{filtered.filter(b => betKind(b) === "parlay").length === 1 ? "" : "s"}
      </div>
      <BetsTable bets={filtered} />

      <SectionTitle>🧪 Algorithm Calibration</SectionTitle>
      <CalibrationPanel calibration={data.calibration} bets={data.bets} />
    </>
  );
}
