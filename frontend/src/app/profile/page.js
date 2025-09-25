"use client";
import { useEffect, useMemo, useState } from "react";
import { useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";
import { useSearchParams, useRouter } from "next/navigation";

const PAGE_SIZE = 30;

function Sparkline({
  data = [],
  width = 520,
  height = 140,
  strokeWidth = 2,
  maxTicks = 5,
}) {
  if (!data.length) {
    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--meta)",
        }}
      >
        No data
      </div>
    );
  }

  // Ensure at least 2 points so we draw a line
  const pts =
    data.length === 1
      ? [data[0], { t: data[0].t, v: data[0].v }]
      : data;

  const times = pts.map((p) => new Date(p.t).getTime());
  const ys = pts.map((p) => Number(p.v ?? 0));

  const minX = Math.min(...times);
  const maxX = Math.max(...times);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  // Layout
  const padL = 32;
  const padR = 8;
  const padT = 8;
  const padB = 22;

  const plotW = Math.max(1, width - padL - padR);
  const plotH = Math.max(1, height - padT - padB);

  const scaleX = (x) =>
    padL +
    (maxX === minX ? 0 : ((x - minX) / (maxX - minX)) * plotW);
  const scaleY = (y) => {
    if (maxY === minY) return padT + plotH / 2;
    const t = (y - minY) / (maxY - minY);
    return padT + (1 - t) * plotH;
  };

  // Line path
  const d = times
    .map(
      (x, i) => `${i ? "L" : "M"}${scaleX(x)},${scaleY(ys[i])}`
    )
    .join(" ");

  const crossesZero = minY < 0 && maxY > 0;
  const zeroY = scaleY(0);

  // x-axis ticks
  const tickCount = Math.min(
    maxTicks,
    Math.max(2, Math.floor(plotW / 120))
  );
  const ticks = [];
  for (let i = 0; i < tickCount; i++) {
    const f = i / (tickCount - 1);
    ticks.push(Math.round(minX + f * (maxX - minX)));
  }

  const spanMs = maxX - minX;
  const oneDay = 24 * 3600 * 1000;
  const fmt = (ms) => {
    const d = new Date(ms);
    if (spanMs < oneDay) {
      return d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
    } else if (spanMs < 90 * oneDay) {
      return d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    } else {
      return d.toLocaleDateString(undefined, {
        year: "2-digit",
        month: "short",
      });
    }
  };

  // End dots
  const rDot = 2.5;
  const firstX = scaleX(times[0]),
    firstY = scaleY(ys[0]);
  const lastX = scaleX(times[times.length - 1]),
    lastY = scaleY(ys[ys.length - 1]);

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="Earnings over time"
    >
      {/* border */}
      <rect
        x={padL}
        y={padT}
        width={plotW}
        height={plotH}
        fill="none"
        stroke="var(--panel-border)"
      />

      {/* zero line */}
      {crossesZero && (
        <line
          x1={padL}
          x2={padL + plotW}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--chart-grid)"
          strokeDasharray="3 3"
        />
      )}

      {/* series line */}
      <path
        d={d}
        fill="none"
        stroke="var(--name)"
        strokeWidth={strokeWidth}
      />
      <circle cx={firstX} cy={firstY} r={rDot} fill="var(--name)" />
      <circle cx={lastX} cy={lastY} r={rDot} fill="var(--name)" />

      {/* ticks */}
      {ticks.map((t, i) => {
        const x = Math.round(scaleX(t));
        const y = padT + plotH;
        return (
          <g key={i}>
            <line
              x1={x}
              x2={x}
              y1={y}
              y2={y + 4}
              stroke="var(--chart-grid)"
            />
            <text
              x={x}
              y={y + 16}
              fontSize="10"
              textAnchor="middle"
              fill="var(--chart-text)"
            >
              {fmt(t)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}


/* ---------- helpers ---------- */
function buildPageModel(totalPages, currentPage) {
  const out = [];
  if (totalPages <= 10) {
    for (let i = 1; i <= totalPages; i++) out.push(i);
    return out;
  }
  const first = [1, 2];
  const last = [totalPages - 1, totalPages];
  const around = [currentPage - 1, currentPage, currentPage + 1].filter(
    (n) => n > 2 && n < totalPages - 1
  );
  const seq = [];
  const pushWithGap = (arr, n) => {
    if (arr.length && typeof arr[arr.length - 1] === "number" && n - arr[arr.length - 1] > 1) arr.push("...");
    arr.push(n);
  };
  first.forEach((n) => pushWithGap(seq, n));
  around.forEach((n) => pushWithGap(seq, n));
  last.forEach((n) => pushWithGap(seq, n));
  return seq;
}

export default function ProfilePage() {
  const [tokens, setTokens] = useState([]);
  const [page, setPage] = useState(1);

  const [stats, setStats] = useState(null);
  const [series, setSeries] = useState([]);
  const [unit, setUnit] = useState("SOL");

  const [trip, setTrip] = useState("");

  const { publicKey } = useAdapterWallet();
  const router = useRouter();
  const search = useSearchParams();

  const walletParam = search.get("wallet") || "";
  const connectedWallet = publicKey ? publicKey.toBase58() : "";
  const walletStr = walletParam || connectedWallet;

  useEffect(() => {
    let abort = false;
    (async () => {
      if (!walletStr) { setTrip(""); return; }
      try {
        const r = await fetch(`http://localhost:4000/tripcode?wallet=${encodeURIComponent(walletStr)}`);
        const j = await r.json();
        if (!abort) setTrip(j?.tripCode || "");
      } catch {
        if (!abort) setTrip("");
      }
    })();
    return () => { abort = true; };
  }, [walletStr]);

  useEffect(() => {
    let abort = false;
    (async () => {
      if (!walletStr) { setTokens([]); return; }
      try {
        const res = await fetch(`http://localhost:4000/tokens-by-creator?creator=${walletStr}`);
        let myTokens = await res.json();
        myTokens = await Promise.all(myTokens.map(async (t) => {
          try { const metaRes = await fetch(t.metadataUri); const meta = await metaRes.json(); return { ...t, ...meta }; }
          catch { return { ...t, description: "No description", image: "/placeholder.png" }; }
        }));
        if (!abort) setTokens(myTokens);
      } catch (e) {
        if (!abort) console.error("Failed to load my tokens:", e);
      }
    })();
    return () => { abort = true; };
  }, [walletStr]);

  // NEW: wallet stats + series
  useEffect(() => {
    let abort = false;
    if (!walletStr) { setStats(null); setSeries([]); return; }

    (async () => {
      try {
        const s = await fetch(`http://localhost:4000/wallet-stats?wallet=${encodeURIComponent(walletStr)}`).then(r=>r.json());
        if (!abort) setStats(s);
      } catch (e) { if (!abort) setStats(null); }

      try {
        const q = new URLSearchParams({ wallet: walletStr, unit });
        const ts = await fetch(`http://localhost:4000/wallet-timeseries?${q}`).then(r => r.json());
        setSeries(ts.points || []);
      } catch (e) { if (!abort) setSeries([]); }
    })();

    return () => { abort = true; };
  }, [walletStr, unit]);

  const sorted = useMemo(
    () => [...tokens].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [tokens]
  );

  const { totalPages, pageItems, model, currentPage } = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = currentPage * PAGE_SIZE;
    const pageItems = sorted.slice(start, end);
    const model = buildPageModel(totalPages, currentPage);
    return { totalPages, pageItems, model, currentPage };
  }, [sorted, page]);

  const formatDateTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString();
  };

  /* ---------- 4chan-style pager component ---------- */
  function Pager({ currentPage, totalPages, onPrev, onNext, onJump, model }) {
    const [inputPage, setInputPage] = useState("");

    function handleSubmit(e) {
      e.preventDefault();
      const n = parseInt(String(inputPage), 10);
      if (!Number.isNaN(n)) onJump(n);
      setInputPage("");
    }

    return (
      <div style={{ margin: "14px 0" }}>
        {/* Row 1: numbers (with ellipses) */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {model.map((tok, i) =>
            tok === "..." ? (
              <span key={`gap-${i}`} style={{ marginRight: 6 }}>…</span>
            ) : (
              <button
                key={tok}
                className="chan-link"
                onClick={() => onJump(tok)}
                aria-current={tok === currentPage ? "page" : undefined}
                style={tok === currentPage ? { fontWeight: 900, textDecoration: "underline" } : undefined}
              >
                [{tok}]
              </button>
            )
          )}
        </div>

        {/* Row 2: fixed prev/next + jump box */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <button className="chan-link" onClick={onPrev} disabled={currentPage <= 1}>[prev]</button>
          <button className="chan-link" onClick={onNext} disabled={currentPage >= totalPages}>[next]</button>
          <form onSubmit={handleSubmit} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
            <label className="chan-label" htmlFor="jumpPage">Page:</label>
            <input
              id="jumpPage"
              type="number"
              min={1}
              max={totalPages}
              value={inputPage}
              onChange={(e) => setInputPage(e.target.value)}
              style={{ width: 80 }}
              placeholder={`${currentPage}/${totalPages}`}
              aria-label="Enter page number"
            />
            <button className="chan-link" type="submit">[go]</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <main>
      <h1>Profile</h1>

      {walletStr && (
        <div style={{ marginBottom: "1.5rem" }}>
          {trip && (
            <div
              style={{
                fontSize: 28,
                fontWeight: "bold",
                color: "var(--trip-strong)",
                fontFamily: "monospace",
                marginBottom: 8,
              }}
            >
              {trip}
            </div>
          )}
            <a
              href={`https://explorer.solana.com/address/${walletStr}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: "monospace",
                textDecoration: "underline",
                color: "var(--link)",
                wordBreak: "break-all",
                fontSize: 15,
              }}
              title="View on Solana Explorer (devnet)"
            >
              {walletStr}
            </a>
        </div>
      )}
      {/* NEW: Earnings summary + toggle + chart */}
      <section
        style={{
          marginBottom: 18,
          padding: 12,
          border: "1px solid var(--panel-border)",
          background: "var(--panel-bg)",
          borderRadius: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Total Earnings</h3>
          <div>
            <button
              className={`chan-toggle ${unit === "SOL" ? "is-active" : ""}`}
              onClick={() => setUnit("SOL")}
              aria-pressed={unit === "SOL"}
            >[SOL]</button>
            <button
              className={`chan-toggle ${unit === "USD" ? "is-active" : ""}`}
              onClick={() => setUnit("USD")}
              aria-pressed={unit === "USD"}
              style={{ marginLeft: 6 }}
            >[USD]</button>
          </div>
          <div style={{ marginLeft: "auto", fontSize: 12, color: "#555" }}>
            {stats ? <>since {formatDateTime(stats.firstTs)}</> : null}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 28, fontWeight: 800 }}>
            {stats
             ? (unit === "USD"
                 ? (stats.netUSD != null ? stats.netUSD.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }) : "—")
                 : `${(stats.netSOL ?? 0).toFixed(6)} SOL`)
              : "—"}
          </div>
          {unit === "USD" && stats?.solUsd > 0 && (
            <div style={{ fontSize: 12, color: "#666" }}>
              (SOL≈${stats.solUsd.toFixed(2)})
            </div>
          )}
        </div>

        <Sparkline data={series} width={520} height={120} />
      </section>

      <h3>
        My Tokens{" "}
        <span style={{ marginLeft: 8, fontSize: 12, color: "#666" }}>
          Page {currentPage} / {totalPages} • {sorted.length} total
        </span>
      </h3>

      <div id="token-list">
        {sorted.length === 0 && <p>You haven't created any tokens yet.</p>}
        {pageItems.map((t) => (
          <div
            key={t.mint}
            className="token-post"
            onClick={() => router.push(`/token?mint=${t.mint}&wallet=${walletStr}`)}
          >
            <img src={t.image || "/placeholder.png"} alt={t.name} />
            <div className="token-post-body">
              <div style={{ fontSize: 12, marginBottom: 4 }}>
                <span style={{ fontWeight: "bold", color: "green" }}>
                  {t.tripName || "Anonymous"}
                </span>
                {t.tripCode && (
                  <span style={{ color: "gray", fontFamily: "monospace" }}>
                    {" "}!!{t.tripCode}
                  </span>
                )}{" "}
                {new Date(t.createdAt).toLocaleString()}{" "}
                <span
                  style={{ cursor: "pointer", color: "#0000ee" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    router.push(`/token?mint=${t.mint}&wallet=${walletStr}`);
                  }}
                >
                  No.{100000 + (t.id || 0)}
                </span>
              </div>
              <div className="token-header">{t.name} ({t.symbol})</div>
              <div className="token-meta">
                Mint:{" "}
                <a href={`https://explorer.solana.com/address/${t.mint}?cluster=devnet`} target="_blank">
                  {t.mint}
                </a>
              </div>
              <div className="token-desc">{t.description || "No description"}</div>
            </div>
          </div>
        ))}
      </div>

      {sorted.length > 0 && (
        <Pager
          currentPage={currentPage}
          totalPages={totalPages}
          onPrev={() => setPage(p => Math.max(1, p - 1))}
          onNext={() => setPage(p => Math.min(totalPages, p + 1))}
          onJump={(p) => setPage(Math.min(Math.max(1, p), totalPages))}
          model={buildPageModel(totalPages, currentPage)}
        />
      )}
    </main>
  );
}

/* helpers: buildPageModel + Pager unchanged from your file */
