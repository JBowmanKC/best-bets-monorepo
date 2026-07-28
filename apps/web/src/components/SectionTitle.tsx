export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: "0.66rem", fontWeight: 800, textTransform: "uppercase",
      letterSpacing: "3px", color: "#4a6080",
      margin: "28px 0 14px",
      display: "flex", alignItems: "center", gap: 12,
    }}>
      {children}
      <div style={{ flex: 1, height: 1, background: "#1e2d45" }} />
    </div>
  );
}
