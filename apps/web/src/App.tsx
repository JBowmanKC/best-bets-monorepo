import { Dashboard }   from "./pages/Dashboard";
import { PickHistory } from "./pages/PickHistory";
import { NavLink, useRoute } from "./router";

export default function App() {
  const route = useRoute();

  return (
    <div style={{
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      background: "#080c14", color: "#e2e8f0",
      minHeight: "100vh", padding: "28px 20px 48px",
      maxWidth: 1200, margin: "0 auto",
    }}>
      {/* ── Header ── */}
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <h1 style={{
          fontSize: "2rem", fontWeight: 900, letterSpacing: "-1px", margin: 0,
          background: "linear-gradient(135deg,#f59e0b 0%,#ef4444 45%,#8b5cf6 100%)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>
          ⚡ Best Bets Algorithm
        </h1>

        <nav style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 16 }}>
          <NavLink to="/"             active={route === "/"}>Today’s Picks</NavLink>
          <NavLink to="/pick-history" active={route === "/pick-history"}>📜 Pick History</NavLink>
        </nav>
      </div>

      {route === "/pick-history" ? <PickHistory /> : <Dashboard />}

      {/* ── Disclaimer ── */}
      <div style={{
        textAlign: "center", marginTop: 36, color: "#243450",
        fontSize: "0.65rem", lineHeight: 1.8,
        borderTop: "1px solid #1e2d45", paddingTop: 18,
      }}>
        ⚠️ For entertainment purposes only. Odds are sourced from OddsAPI and may vary by sportsbook — confirm before wagering.<br />
        Algorithm: Win Probability (35%) + Expected Value (35%) + Momentum (20%) + Context (10%).<br />
        🇨🇦 Ontario residents: <strong>ConnexOntario.ca · 1-866-531-2600</strong> · Please gamble responsibly.
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
        * { box-sizing: border-box; }
        body { margin: 0; }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.5); }
      `}</style>
    </div>
  );
}
