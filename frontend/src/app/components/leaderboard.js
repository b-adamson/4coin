"use client";
import { useEffect, useState } from "react";

const CAP_TOKENS = 800_000_000; // 800M cap denominator

export default function Leaderboard({ mint }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ capBase: "0" });

  useEffect(() => {
    if (!mint) return;

    let closed = false;

    const fetchOnce = async () => {
      try {
        const res = await fetch(`http://localhost:4000/leaderboard?mint=${mint}`, { cache: "no-store" });
        const json = await res.json();
        if (!closed) {
          setRows(Array.isArray(json.leaderboard) ? json.leaderboard : []);
          setMeta(json.meta || {}); // <-- capture capBase etc.
        }
      } catch (err) {
        console.error("Leaderboard fetch error:", err);
      }
    };

    fetchOnce(); // initial paint

    // live refresh from backend stream
    const es = new EventSource("http://localhost:4000/stream/holdings");
    const refresh = () => fetchOnce();
    es.addEventListener("hello", refresh);
    es.addEventListener("holdings", refresh);

    return () => { closed = true; es.close(); };
  }, [mint]);

  const fmtPct = (n) => {
    if (!Number.isFinite(n)) return "0.00%";
    if (n > 0 && n < 0.01) return "<0.01%";
    return `${n.toFixed(2)}%`;
  };
  const pctOfCap = (balanceBaseStr) => {
    const capBase = BigInt(meta.capBase || "0");
    const b = BigInt(balanceBaseStr || "0");
    if (capBase === 0n) return "0.00%";
    const hundredths = (b * 10000n) / capBase; // integer hundredth-%
    if (b > 0n && hundredths === 0n) return "<0.01%";
    const pct = Number(hundredths) / 100;
    return `${pct.toFixed(2)}%`;
  };
  const fmtNum = (n) =>
    typeof n === "number"
      ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : String(n ?? 0);

  if (!rows.length) {
    return (
      <aside style={{ width: 280, background: "#f4f4f4", padding: "1rem", border: "1px solid #ccc", borderRadius: 8 }}>
        <h3>🏆 Top Holders</h3>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
          • Percentages are each holder’s share of the <b>800M</b> on-curve cap.
        </div>
        <hr style={{ margin: "0.5rem 0" }} />
        <p>No holders yet.</p>
      </aside>
    );
  }

  return (
    <aside style={{ width: 280, background: "#f4f4f4", padding: "1rem", border: "1px solid #ccc", borderRadius: 8 }}>
      <h3>🏆 Top Holders</h3>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
        • Percentages are each holder’s share of the <b>800M</b> on-curve cap.
      </div>
      <hr style={{ margin: "0.5rem 0" }} />

      {rows.map((entry, idx) => {
        const isBond = !!entry.isBonding;
        const color = isBond ? "#6c63ff" : "#000";
        const name =
          entry.displayName ??
          entry.owner ??
          (isBond ? "Bonding Curve" : entry.address ?? "Unknown");

        return (
          <div key={idx} style={{ fontSize: 13, marginBottom: 8, lineHeight: 1.3 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span
                title={entry.address}
                style={{
                  fontWeight: entry.isDev ? "bold" : "normal",
                  color,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 160,
                }}
              >
                {name}
                {entry.isDev && <span style={{ color: "red" }}> [DEV]</span>}
                {isBond && <span> • pool</span>}
              </span>
              <span style={{ color }}>{pctOfCap(entry.balanceBase)}</span>
            </div>
            <div style={{ color: "#555" }}>{fmtNum(entry.balanceWhole)} tokens</div>
          </div>
        );
      })}
    </aside>
  );
}
