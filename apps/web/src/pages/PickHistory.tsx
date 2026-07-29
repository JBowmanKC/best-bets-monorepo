import { useState } from "react";
import type {
  HistoryRun, Outcome, Pick, PickResult, ResultsSummary, Tier,
} from "@best-bets/algorithm";

import { SectionTitle } from "../components/SectionTitle";
import { useHistoryIndex, useRunDetail } from "../hooks/usePickHistory";

const TIERS: Tier[] = ["elite", "strong", "value"];

const TIER_META: Record<Tier, { label: string; color: string }> = {
  elite:  { label: "🔥 Elite",  color: "#f59e0b" },
  strong: { label: "✅ Strong", color: "#10b981" },
  value:  { label: "💎 Value",  color: "#8b5cf6" },
};

const OUTCOME_META: Record<Outcome, { label: string; color: string; bg: string }> = {
  win:     { label: "WIN",     color: "#10b981", bg: "#082f21" },
  loss:    { label: "LOSS",    color: "#f87171", bg: "#2a0d0d" },
  push:    { label: "PUSH",    color: "#94a3b8", bg: "#141c2b" },
  pending: { label: "PENDING", color: "#fbbf24", bg: "#241a06" },
  unknown: { label: "NO DATA", color: "#64748b", bg: "#111827" },
};

// ─── Formatting ───────────────────────────────────────────────────────────────
const fmtUnits = (u: number) => `${u > 0 ? "+" : ""}${u.toFixed(2)}u`;
const fmtPct   = (p: number | null) => (p === null ? "—" : `${(p * 100).toFixed(1)}%`);
const fmtOdds  = (o: number) => (o > 0 ? `+${o}` : String(o));
const unitColor = (u: number) => (u > 0 ? "#10b981" : u < 0 ? "#f87171" : "#8098b8");

function fmtRunTime(generatedAt: string) {
  const d = new Date(generatedAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function recordLabel(s: ResultsSummary) {
  return `${s.wins}W–${s.losses}L${s.pushes > 0 ? `–${s.pushes}P` : ""}`;
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
      <div style={{ fontSize: "1.4rem", fontWeight: 900, color: color ?? "#e2e8f0", margin: "6px 0 2px" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: "0.68rem", color: "#4a6080" }}>{sub}</div>}
    </div>
  );
}

function OutcomeBadge({ outcome, title }: { outcome: Outcome; title?: string }) {
  const meta = OUTCOME_META[outcome] ?? OUTCOME_META.unknown;
  return (
    <span title={title} style={{
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

// ─── Tier breakdown ───────────────────────────────────────────────────────────
function TierTable({ byTier }: { byTier: Record<Tier, ResultsSummary> }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
        <thead>
          <tr>
            {["Tier", "Graded", "Record", "Win %", "Units", "ROI"].map(h => (
              <th key={h} style={headStyle}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TIERS.map(tier => {
            const s = byTier[tier];
            return (
              <tr key={tier}>
                <td style={{ ...cellStyle, fontWeight: 700, color: TIER_META[tier].color }}>
                  {TIER_META[tier].label}
                </td>
                <td style={cellStyle}>{s.graded}</td>
                <td style={cellStyle}>{s.graded > 0 ? recordLabel(s) : "—"}</td>
                <td style={cellStyle}>{fmtPct(s.winRate)}</td>
                <td style={{ ...cellStyle, color: unitColor(s.unitsNet), fontWeight: 700 }}>
                  {s.graded > 0 ? fmtUnits(s.unitsNet) : "—"}
                </td>
                <td style={{ ...cellStyle, color: unitColor(s.roi ?? 0), fontWeight: 700 }}>
                  {fmtPct(s.roi)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── One expanded run ─────────────────────────────────────────────────────────
function RunDetailTable({ run }: { run: HistoryRun }) {
  const { data, loading, error } = useRunDetail(run);

  if (loading) return <div style={{ padding: 14, color: "#4a6080", fontSize: "0.75rem" }}>Loading picks…</div>;
  if (error)   return <div style={{ padding: 14, color: "#f87171", fontSize: "0.75rem" }}>Couldn’t load this run: {error}</div>;
  if (!data)   return null;

  const { picks } = data.picks;
  const resultById = new Map<string, PickResult>(
    (data.results?.results ?? []).map(r => [r.pickId, r])
  );

  if (picks.length === 0) {
    return (
      <div style={{ padding: 14, color: "#4a6080", fontSize: "0.75rem" }}>
        This run produced no qualifying picks — every game was priced above the algorithm’s estimate.
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto", padding: "4px 2px 10px" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
        <thead>
          <tr>
            {["Pick", "Matchup", "Tier", "Score", "Odds", "Est. / Impl.", "Result", "Final", "Units"].map(h => (
              <th key={h} style={headStyle}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {picks.map((pick: Pick) => {
            const result = resultById.get(pick.id);
            const outcome: Outcome = result?.outcome ?? "pending";
            const score = result?.finalScore;

            return (
              <tr key={pick.id}>
                <td style={{ ...cellStyle, fontWeight: 700 }} title={pick.rationale}>
                  {pick.pickLabel}
                </td>
                <td style={{ ...cellStyle, color: "#8098b8" }}>{pick.matchup}</td>
                <td style={{ ...cellStyle, color: TIER_META[pick.tier].color, fontWeight: 700 }}>
                  {TIER_META[pick.tier].label}
                </td>
                <td style={cellStyle}>{pick.scores.composite}</td>
                <td style={cellStyle}>{fmtOdds(pick.odds)}</td>
                <td style={{ ...cellStyle, color: "#8098b8", whiteSpace: "nowrap" }}>
                  {Math.round(pick.estimatedWinPct * 100)}% / {Math.round(pick.impliedWinPct * 100)}%
                </td>
                <td style={cellStyle}>
                  <OutcomeBadge
                    outcome={outcome}
                    title={result?.note ?? (data.results ? undefined : "This run hasn’t been graded yet.")}
                  />
                </td>
                <td style={{ ...cellStyle, color: "#8098b8", whiteSpace: "nowrap" }}>
                  {score ? `${score.awayScore}–${score.homeScore}` : "—"}
                </td>
                <td style={{ ...cellStyle, color: unitColor(result?.unitsNet ?? 0), fontWeight: 700, whiteSpace: "nowrap" }}>
                  {result && (result.outcome === "win" || result.outcome === "loss" || result.outcome === "push")
                    ? fmtUnits(result.unitsNet)
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Run list row ─────────────────────────────────────────────────────────────
function RunRow({ run, expanded, onToggle }: {
  run: HistoryRun; expanded: boolean; onToggle: () => void;
}) {
  const s = run.summary;
  const tierSummary = TIERS
    .filter(t => run.tierCounts[t] > 0)
    .map(t => `${run.tierCounts[t]} ${t}`)
    .join(" · ");

  return (
    <div style={{
      background: "#0f1623", border: `1px solid ${expanded ? "#243450" : "#1e2d45"}`,
      borderRadius: 10, marginBottom: 8, overflow: "hidden",
    }}>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          width: "100%", background: "none", border: "none", cursor: "pointer",
          color: "#e2e8f0", textAlign: "left", padding: "13px 14px",
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
          fontFamily: "inherit",
        }}
      >
        <span style={{ color: "#4a6080", fontSize: "0.7rem", width: 12 }}>{expanded ? "▾" : "▸"}</span>

        <span style={{ fontWeight: 800, fontSize: "0.84rem", minWidth: 128 }}>
          {fmtRunTime(run.generatedAt)}
        </span>

        <span style={{ color: "#4a6080", fontSize: "0.72rem", flex: 1, minWidth: 160 }}>
          {run.pickCount} pick{run.pickCount === 1 ? "" : "s"}
          {tierSummary && ` · ${tierSummary}`}
        </span>

        {s ? (
          <>
            <span style={{ fontSize: "0.75rem", fontWeight: 700 }}>{recordLabel(s)}</span>
            {s.pending > 0 && (
              <span style={{ fontSize: "0.68rem", color: "#fbbf24" }}>{s.pending} pending</span>
            )}
            <span style={{ fontSize: "0.78rem", fontWeight: 800, color: unitColor(s.unitsNet), minWidth: 62, textAlign: "right" }}>
              {fmtUnits(s.unitsNet)}
            </span>
          </>
        ) : (
          <span style={{ fontSize: "0.68rem", color: "#4a6080" }}>
            {run.pickCount === 0 ? "no picks" : "not graded yet"}
          </span>
        )}
      </button>

      {expanded && <RunDetailTable run={run} />}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export function PickHistory() {
  const { data, loading, error } = useHistoryIndex();
  const [expanded, setExpanded] = useState<string | null>(null);

  if (loading) {
    return <div style={{ color: "#4a6080", fontSize: "0.8rem", padding: "40px 0", textAlign: "center" }}>Loading history…</div>;
  }

  if (error) {
    return (
      <div style={{
        background: "#1f0a0a", border: "1px solid #5a1a1a", borderRadius: 10,
        padding: 14, color: "#f87171", fontSize: "0.82rem", lineHeight: 1.6,
      }}>
        ⚠️ Couldn’t load the pick archive ({error}). The index is generated at build time by
        <code style={{ margin: "0 4px" }}>scripts/build-history-index.mjs</code>
        — if you’re running locally, <code>npm run dev</code> regenerates it.
      </div>
    );
  }

  if (!data || data.runs.length === 0) {
    return (
      <div style={{ color: "#4a6080", fontSize: "0.8rem", padding: "40px 0", textAlign: "center", lineHeight: 1.8 }}>
        No archived runs yet.<br />
        Each Daily Picks run adds one to <code>apps/web/public/picks/</code>.
      </div>
    );
  }

  const t = data.totals;
  const decided = t.wins + t.losses;

  // Picks still waiting on a score: those in a graded run whose game hasn't
  // finished, plus every pick in a run the grader hasn't reached at all.
  const awaiting = t.pending + data.runs
    .filter(r => !r.summary)
    .reduce((n, r) => n + r.pickCount, 0);

  return (
    <>
      <SectionTitle>📈 All-Time Performance</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 10 }}>
        <StatCard
          label="Record"
          value={decided > 0 ? recordLabel(t) : "—"}
          sub={`${data.runs.length} run${data.runs.length === 1 ? "" : "s"} archived`}
        />
        <StatCard label="Win Rate" value={fmtPct(t.winRate)} sub={`${decided} decided pick${decided === 1 ? "" : "s"}`} />
        <StatCard
          label="Units"
          value={t.graded > 0 ? fmtUnits(t.unitsNet) : "—"}
          sub={`${t.unitsRisked.toFixed(0)}u risked at 1u/pick`}
          color={unitColor(t.unitsNet)}
        />
        <StatCard label="ROI" value={fmtPct(t.roi)} sub="net units ÷ units risked" color={unitColor(t.roi ?? 0)} />
        <StatCard
          label="Awaiting Result"
          value={String(awaiting)}
          sub={t.unknown > 0 ? `${t.unknown} with no score data` : "picks not yet graded"}
        />
      </div>

      <SectionTitle>🎯 Performance by Tier</SectionTitle>
      <TierTable byTier={data.byTier} />
      <div style={{ color: "#4a6080", fontSize: "0.68rem", marginTop: 8, lineHeight: 1.6 }}>
        Every pick is graded at a flat 1 unit regardless of its recommended stake, so tiers stay
        comparable. Pushes (ties and postponements) return the stake and count toward neither side.
      </div>

      <SectionTitle>🗂 Run History</SectionTitle>
      {data.runs.map(run => (
        <RunRow
          key={run.stamp}
          run={run}
          expanded={expanded === run.stamp}
          onToggle={() => setExpanded(expanded === run.stamp ? null : run.stamp)}
        />
      ))}
    </>
  );
}
