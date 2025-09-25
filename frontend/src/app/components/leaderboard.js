// src/app/components/leaderboard.jsx
"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";

const CURVE_CAP = 800_000_000;
const TOTAL_SUPPLY = 1_000_000_000;

function NamePieces({ parts }) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 4,
        alignItems: "baseline",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        maxWidth: 180,
      }}
    >
      {parts}
    </span>
  );
}

export default function Leaderboard({ mint, version = 0 }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ mode: "pre", decimals: 9, capBase: "0" });
  const [rayHeader, setRayHeader] = useState(null);
  const [curveHeader, setCurveHeader] = useState(null);

  const fetchingRef = useRef(false);
  const closedRef = useRef(false);
  const sseRef = useRef(null);
  const debounceTimerRef = useRef(null);

  async function fetchOnce() {
    if (!mint || fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const res = await fetch(`http://localhost:4000/leaderboard?mint=${mint}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!closedRef.current) {
        setRows(Array.isArray(json.leaderboard) ? json.leaderboard : []);
        setMeta({
          mode: json?.meta?.mode || "pre",
          decimals: json?.meta?.decimals ?? 9,
          capBase: json?.meta?.capBase ?? "0",
        });
        setRayHeader(json?.raydiumHeader || null);
        setCurveHeader(json?.bondingHeader || null);
      }
    } catch (e) {
      console.error("Leaderboard fetch error:", e);
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
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (payload?.mint !== mint) return;
      if (
        payload?.source !== "chain" &&
        payload?.source !== "phase" &&
        payload?.source !== "internal"
      )
        return;

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        if (!closedRef.current) fetchOnce();
      }, 150);
    };

    es.addEventListener("holdings", onHoldings);
    es.addEventListener("hello", onHoldings);

    return () => {
      closedRef.current = true;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (sseRef.current) {
        sseRef.current.removeEventListener("holdings", onHoldings);
        sseRef.current.removeEventListener("hello", onHoldings);
        sseRef.current.close();
        sseRef.current = null;
      }
    };
  }, [mint]);

  useEffect(() => {
    if (mint) fetchOnce();
  }, [version, mint]);

  const fmtNum = (n) =>
    typeof n === "number"
      ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : String(n ?? 0);

  function percentOfDenom(balanceBaseStr, denomWhole) {
    const decimals = Number(meta.decimals || 9);
    const denomBase = BigInt(denomWhole) * 10n ** BigInt(decimals);
    const b = BigInt(balanceBaseStr || "0");
    if (denomBase === 0n) return "0.00%";
    const hundredths = (b * 10000n) / denomBase;
    if (b > 0n && hundredths === 0n) return "<0.01%";
    return `${(Number(hundredths) / 100).toFixed(2)}%`;
  }

  const isPost = meta.mode === "post";
  const denomWhole = isPost ? TOTAL_SUPPLY : CURVE_CAP;

  // Find bonding row in the list
  const bondingRow = rows.find((r) => r?.isBonding);

  // If we show a pre-mode header, hide the duplicate bonding row in the list
  const listRows =
    !isPost && bondingRow && curveHeader
      ? rows.filter((r) => !r.isBonding)
      : rows;

  const Box = ({ children }) => (
    <aside
      className="post post--reply post--panel"
      style={{
        width: 280,
        background: "var(--panel-bg)",
        border: "1px solid var(--panel-border)",
        borderLeft: "1px solid var(--border)",   // <<< vertical divider
        padding: 10,
        marginLeft: "1rem",                      // spacing from content
      }}
    >
      {children}
    </aside>
  );

  const nothingToShow =
    !listRows.length && !(isPost && rayHeader) && !(!isPost && curveHeader);

  if (nothingToShow) {
    return (
      <Box>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>🏆 Top Holders</h3>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
          • Percentages are each holder’s share of{" "}
          <b>{denomWhole.toLocaleString()}</b>
          {isPost ? " total supply." : " on-curve cap."}
        </div>
        <hr
          style={{ border: 0, borderTop: "1px solid #800000", margin: "6px 0 8px" }}
        />
        <p style={{ margin: 0 }}>No holders yet.</p>
      </Box>
    );
  }

  return (
    <Box>
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>🏆 Top Holders</h3>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
        • Percentages are each holder’s share of{" "}
        <b>{denomWhole.toLocaleString()}</b>
        {isPost ? " total supply." : " on-curve cap."}
      </div>
      <hr
        style={{ border: 0, borderTop: "1px solid #800000", margin: "6px 0 8px" }}
      />

      {/* POST: Raydium header */}
      {isPost && rayHeader && (
          <div
            style={{
              marginBottom: 8,
              padding: 8,
              background: "var(--highlight-raydium-bg)",
              borderRadius: 6,
              border: "1px solid var(--highlight-raydium-border)",
            }}
          >
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <strong>Raydium Pool</strong>
            <span style={{ marginLeft: "auto" }}>
              {fmtNum(rayHeader.balanceWhole)} tokens
            </span>
          </div>
          <div style={{ color: "#4da3ff" }}>
            {percentOfDenom(rayHeader.balanceBase, denomWhole)}
          </div>
          <div
            title={rayHeader.address}
            style={{
              marginTop: 4,
              fontSize: 11,
              color: "#777",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {rayHeader.address}
          </div>
        </div>
      )}

      {/* PRE: Bonding Curve header */}
      {!isPost && curveHeader && (
        <div
          style={{
            marginBottom: 8,
            padding: 8,
            background: "var(--highlight-bonding-bg)",
            borderRadius: 6,
            border: "1px solid var(--highlight-bonding-border)",
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <strong style={{ color: "#2f5eff" }}>Bonding Curve</strong>
            <span style={{ marginLeft: "auto", color: "#2f5eff" }}>
              {fmtNum(curveHeader.balanceWhole)} tokens
            </span> 
          </div>
          <div style={{ color: "#4da3ff" }}>
            {percentOfDenom(curveHeader.balanceBase, denomWhole)}
          </div>
          <div
            title={curveHeader.address}
            style={{
              marginTop: 4,
              fontSize: 11,
              color: "#777",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {curveHeader.address}
          </div>
        </div>
      )}

      {/* List */}
      <div style={{ display: "grid", gap: 6 }}>
        {listRows.map((entry, idx) => {
          const isBond = !!entry.isBonding; 
          const color = isBond ? "var(--link)" : "var(--name)"; 
          const hasTrip = !!(entry.trip && String(entry.trip).length);

          // Build: [DEV] → !!trip → display name (or Anonymous / Bonding Curve)
          const parts = [];

          if (entry.isDev) {
            parts.push(
              <span key="dev" style={{ color: "var(--link-hover)", fontWeight: "bold" }}>
                [DEV]
              </span>
            );
          }

          if (isBond) {
            parts.push(<span key="bond">Bonding Curve</span>);
          } else if (hasTrip) {
            if (entry.trip) parts.push(<span key="trip">!!{entry.trip}</span>);
            if (entry.displayName && entry.displayName !== "Anonymous") {
              parts.push(<span key="name">{entry.displayName}</span>);
            }
          } else {
            parts.push(<span key="anon">Anonymous</span>);
          }


          if (parts.length === 0) {
            parts.push(entry.displayName || entry.address || "Unknown");
          }

          const name = parts.join(" ");
          const isClickable = !isBond && hasTrip;

          const NameInner = (
            <>
              {name}
              {isBond && <span> • pool</span>}
            </>
          );

          return (
            <div key={idx} style={{ fontSize: 12, lineHeight: 1.3 }}>
              <div style={{ display: "flex", gap: 8 }}>
                {isClickable ? (
                  <Link
                    href={{ pathname: "/profile", query: { wallet: entry.address } }}
                    className="chan-link"
                    style={{
                      color, 
                      textDecoration: "none",
                    }}
                    title={`View ${entry.address} profile`}
                  >
                    <NamePieces parts={parts} />
                    {isBond && <span style={{ marginLeft: 4 }}>• pool</span>}
                  </Link>
                ) : (
                  <span
                    title={entry.address}
                    style={{
                      fontWeight: entry.isDev ? "bold" : "normal",
                      color,
                    }}
                  >
                    <NamePieces parts={parts} />
                    {isBond && <span style={{ marginLeft: 4 }}>• pool</span>}
                  </span>
                )}
                <span style={{ color, marginLeft: "auto" }}>
                  {percentOfDenom(entry.balanceBase, denomWhole)}
                </span>
              </div>
              <div style={{ color: "var(--meta)" }}>
                {fmtNum(entry.balanceWhole)} tokens
              </div>
            </div>
          );
        })}
      </div>
    </Box>
  );
}
