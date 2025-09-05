"use client";
import { useEffect, useRef, useState } from "react";

const CAP_TOKENS = 800_000_000; // display copy only

export default function Leaderboard({ mint, version = 0 }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ capBase: "0" });

  const fetchingRef = useRef(false);
  const closedRef = useRef(false);
  const sseRef = useRef(null);
  const lastChainRef = useRef({});
  const debounceTimerRef = useRef(null);

  async function fetchOnce() {
    if (!mint || fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const res = await fetch(`http://localhost:4000/leaderboard?mint=${mint}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!closedRef.current) {
        setRows(Array.isArray(json.leaderboard) ? json.leaderboard : []);
        setMeta(json.meta || {});
      }
    } catch (err) {
      console.error("Leaderboard fetch error:", err);
    } finally {
      fetchingRef.current = false;
    }
  }

  useEffect(() => {
    if (!mint) return;
    closedRef.current = false;
    fetchOnce();

    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    const es = new EventSource("http://localhost:4000/stream/holdings");
    sseRef.current = es;

    const onHoldings = (ev) => {
      if (!ev?.data) return;
      let payload; try { payload = JSON.parse(ev.data); } catch { return; }
      if (!payload?.mint || payload.mint !== mint) return;
      if (payload?.source !== "chain") return;

      const rLamports = String(payload?.reserveSolLamports ?? "");
      const poolBase = String(payload?.poolBase ?? "");

      const sameReserve = lastChainRef.current.reserveSol === rLamports;
      const samePool = lastChainRef.current.poolBase === poolBase;
      if (sameReserve && samePool) return;

      lastChainRef.current = { reserveSol: rLamports, poolBase };

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        if (!closedRef.current) fetchOnce();
      }, 150);
    };

    es.addEventListener("holdings", onHoldings);

    return () => {
      closedRef.current = true;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (sseRef.current) {
        sseRef.current.removeEventListener("holdings", onHoldings);
        sseRef.current.close();
        sseRef.current = null;
      }
    };
  }, [mint]);

  useEffect(() => {
    if (!mint) return;
    fetchOnce();
  }, [version, mint]);

  const fmtNum = (n) =>
    typeof n === "number"
      ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : String(n ?? 0);

  const pctOfCap = (balanceBaseStr) => {
    const capBase = BigInt(meta.capBase || "0");
    const b = BigInt(balanceBaseStr || "0");
    if (capBase === 0n) return "0.00%";
    const hundredths = (b * 10000n) / capBase;
    if (b > 0n && hundredths === 0n) return "<0.01%";
    const pct = Number(hundredths) / 100;
    return `${pct.toFixed(2)}%`;
  };

  const Box = ({ children }) => (
    <aside
      className="post post--reply post--panel"
      style={{
        width: 280,
        background: "#f6eae3",
        border: "1px solid #d9bfb7",
        padding: 10,
      }}
    >
      {children}
    </aside>
  );

  if (!rows.length) {
    return (
      <Box>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>🏆 Top Holders</h3>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
          • Percentages are each holder’s share of the <b>{CAP_TOKENS.toLocaleString()}</b> on-curve cap.
        </div>
        <hr style={{ border: 0, borderTop: "1px solid #800000", margin: "6px 0 8px" }} />
        <p style={{ margin: 0 }}>No holders yet.</p>
      </Box>
    );
  }

  return (
    <Box>
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>🏆 Top Holders</h3>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
        • Percentages are each holder’s share of the <b>{CAP_TOKENS.toLocaleString()}</b> on-curve cap.
      </div>
      <hr style={{ border: 0, borderTop: "1px solid #800000", margin: "6px 0 8px" }} />

      <div style={{ display: "grid", gap: 6 }}>
        {rows.map((entry, idx) => {
          const isBond = !!entry.isBonding;
          const color = isBond ? "#6c63ff" : "#000";
          const name =
            entry.displayName ??
            entry.owner ??
            (isBond ? "Bonding Curve" : entry.address ?? "Unknown");

          return (
            <div key={idx} style={{ fontSize: 12, lineHeight: 1.3 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <span
                  title={entry.address}
                  style={{
                    fontWeight: entry.isDev ? "bold" : "normal",
                    color,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 180,            // was 160 — a hair wider
                  }}
                >
                  {name}
                  {entry.isDev && <span style={{ color: "red" }}> [DEV]</span>}
                  {isBond && <span> • pool</span>}
                </span>
                <span style={{ color, marginLeft: "auto" }}>
                  {pctOfCap(entry.balanceBase)}
                </span>
              </div>
              <div style={{ color: "#555" }}>
                {fmtNum(entry.balanceWhole)} tokens
              </div>
            </div>
          );
        })}
      </div>
    </Box>
  );
}
