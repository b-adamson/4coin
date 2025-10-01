"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const PAGE_SIZE = 50;

export default function LiveTrades({ mint, maxRows = 500 }) {
  const [rows, setRows] = useState([]); // newest-first
  const [currentPage, setCurrentPage] = useState(1);
  const [stickToLast, setStickToLast] = useState(true);

  // filters
  const [q, setQ] = useState("");         // tripcode filter
  const [showBuys, setShowBuys] = useState(true);
  const [showSells, setShowSells] = useState(true);
  const [devOnly, setDevOnly] = useState(false);

  // view
  const [unit, setUnit] = useState("SOL"); // SOL | USD
  const [solUsd, setSolUsd] = useState(0);

  const esRef = useRef(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const r = await fetch("http://localhost:4000/sol-usd", { cache: "no-store" });
        const j = await r.json();
        if (!stop && Number.isFinite(j?.price)) setSolUsd(j.price);
      } catch {}
    }
    load();
    const id = setInterval(load, 30_000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  function normalizeIso(ts) {
    if (!ts) return new Date().toISOString();
    if (typeof ts === "string" && /\d{4}-\d{2}-\d{2}T/.test(ts)) return ts;
    const n = Number(ts);
    const ms = n < 2_000_000_000 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }

  function toRowShape(r) {
    const iso = normalizeIso(r.ts);
    return {
      id: `${iso}-${r.wallet || ""}-${Math.random().toString(36).slice(2,8)}`,
      ts: iso,
      side: (r.side || "").toLowerCase(), // buy | sell
      sol: Number(r.sol || 0),
      wallet: r.wallet || "",
      isDev: !!r.isDev,
      trip: r.trip || null,
      displayName: r.displayName || "",
      opted: !!r.opted,
    };
  }

  const fmtTs = (iso) => new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
  });

  const valStr = (sol) =>
    unit === "USD" && solUsd > 0
      ? `$${(sol * solUsd).toLocaleString(undefined,{maximumFractionDigits:2})}`
      : `${sol.toFixed(6)} SOL`;

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
          maxWidth: 320,
        }}
      >
        {parts}
      </span>
    );
  }

    // AFTER
    function namePartsForRow(r) {
    const parts = [];
    if (r.isDev) {
        parts.push(
        <span key="dev" style={{ color: "var(--link-hover)", fontWeight: "bold" }}>
            [DEV]
        </span>
        );
    }
    if (r.trip) {
        parts.push(<span key="trip">!!{r.trip}</span>);
        if (r.displayName && r.displayName !== "Anonymous") {
        parts.push(<span key="nm">{r.displayName}</span>);
        }
    } else {
        parts.push(<span key="anon">Anonymous</span>);
    }
    return parts;
    }


  const actionVerb = (r) => (r.side === "buy" ? "bought" : "sold");
  const actionPrepos = (r) => (r.side === "buy" ? "from" : "to");

  // history fetch
  useEffect(() => {
    if (!mint) return;
    let closed = false;
    (async () => {
      try {
        const r = await fetch(`http://localhost:4000/trades?mint=${encodeURIComponent(mint)}`, { cache: "no-store" });
        if (!r.ok) throw new Error("no history endpoint");
        const j = await r.json();
        const arr = Array.isArray(j?.trades) ? j.trades : [];
        const normalized =
          arr.length && (normalizeIso(arr[0].ts) > normalizeIso(arr.at(-1).ts))
            ? arr
            : arr.slice().reverse();
        if (!closed) setRows(normalized.map(toRowShape));
      } catch {}
    })();
    return () => { closed = true; };
  }, [mint]);

  // SSE
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    if (!mint) return;
    if (esRef.current) { try { esRef.current.close(); } catch {} esRef.current = null; }
    const es = new EventSource(`http://localhost:4000/stream/holdings?mint=${encodeURIComponent(mint)}`);

    const onHoldings = (ev) => {
      if (!mountedRef.current) return;
      let msg; try { msg = JSON.parse(ev.data || "{}"); } catch { return; }
      if (!msg || msg.mint !== mint) return;
      if (msg.source !== "internal") return;
      const side = (msg.side || "").toLowerCase();
      const solAbs = Number(msg.sol);
      if (!solAbs || (side !== "buy" && side !== "sell")) return;

      const row = toRowShape({
        ts: (Number(msg.t) || Date.now()/1000) * 1000,
        side,
        sol: solAbs,
        isDev: !!msg.isDev,
        opted: !!msg.opted,
        trip: msg.trip || null,
        displayName: msg.displayName || "Anonymous",
        wallet: msg.wallet || undefined,
      });
      setRows((prev) => [row, ...prev].slice(0, maxRows));
    };

    es.addEventListener("holdings", onHoldings);
    es.onerror = () => {};
    esRef.current = es;
    return () => {
      try { es.removeEventListener("holdings", onHoldings); } catch {}
      try { es.close(); } catch {}
      esRef.current = null;
    };
  }, [mint, maxRows]);

  // tripcode filter (not wallet)
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (devOnly && !r.isDev) return false;
      if (!showBuys && r.side === "buy") return false;
      if (!showSells && r.side === "sell") return false;
      if (qq && !(r.trip || "").toLowerCase().includes(qq)) return false;
      return true;
    });
  }, [rows, q, devOnly, showBuys, showSells]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  useEffect(() => {
    if (stickToLast) setCurrentPage(totalPages);
    else setCurrentPage((p) => Math.min(Math.max(1, p), totalPages));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.length, totalPages]);

  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = currentPage * PAGE_SIZE;
    return filtered.slice(start, end);
  }, [filtered, currentPage]);

  function goToPage(p) {
    const np = Math.min(Math.max(1, p), totalPages);
    setStickToLast(np === totalPages);
    setCurrentPage(np);
  }

  useEffect(() => {
    if (currentPage !== totalPages) setStickToLast(false);
  }, [currentPage, totalPages]);

  async function copyTripAndFilter(trip) {
    try { await navigator.clipboard.writeText(trip); } catch {}
    setQ(trip);
  }

  return (
    <section
      style={{
        marginTop: "2rem",
        background: "var(--panel-bg)",
        border: "1px solid var(--panel-border)",
        borderRadius: 8,
        padding: 12,
      }}
    >
      <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px 0" }}>
        <span role="img" aria-label="chart">📈</span> Live Trades
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>
          Page {currentPage} / {totalPages} • {filtered.length} shown of {rows.length} total
        </span>
      </h3>
      <hr style={{ border: 0, borderTop: "2px solid #6ba4b8", margin: 0 }} />

      {/* Controls */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "10px 0" }}>
        <label className="chan-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={showBuys} onChange={(e)=>setShowBuys(e.target.checked)} /> Buys
        </label>
        <label className="chan-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={showSells} onChange={(e)=>setShowSells(e.target.checked)} /> Sells
        </label>
        <label className="chan-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={devOnly} onChange={(e)=>setDevOnly(e.target.checked)} /> Dev only
        </label>

        <div style={{ width: 1, height: 18, background: "#ddd", margin: "0 4px" }} />

        <input
          type="text"
          value={q}
          onChange={(e)=>setQ(e.target.value)}
          placeholder="Filter by tripcode…"
          style={{
            flex: 1,
            minWidth: 180,
            maxWidth: 320,
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid var(--input-border)",
            background: "var(--input-bg)",
            color: "var(--fg)",
            fontSize: 14,
          }}
        />

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <button
            className={`chan-toggle ${unit === "SOL" ? "is-active" : ""}`}
            onClick={() => setUnit("SOL")}
            aria-pressed={unit === "SOL"}
          >
            [SOL]
          </button>
          <button
            className={`chan-toggle ${unit === "USD" ? "is-active" : ""} ${solUsd>0?"":"chan-toggle--disabled"}`}
            onClick={() => solUsd>0 && setUnit("USD")}
            aria-pressed={unit === "USD"}
            title={solUsd>0?"":"Provide solUsd to enable USD"}
          >
            [USD]
          </button>
        </div>
      </div>

      {/* List */}
      <div>
        {pageItems.map((r) => {
          const accent = r.side === "buy" ? "var(--name)" : "var(--down)";
          const actorParts = namePartsForRow(r, copyTripAndFilter);
            const actorInline = (
            <NamePieces
                parts={
                r.wallet
                    ? [
                        <a
                        key="actorlink"
                        href={`/profile?wallet=${encodeURIComponent(r.wallet)}`}
                        className="chan-link"
                        style={{ display: "inline-flex", gap: 4, alignItems: "baseline" }}
                        title="View profile"
                        >
                        {actorParts}
                        </a>,
                    ]
                    : actorParts
                }
            />
            );

          return (
            <div
              key={r.id}
              className="post post--reply"
              style={{ borderLeft: `3px solid ${accent}` }}
            >
              <div className="post__body">
                {/* Line 1: timestamp • actor • action (green/red text for the verb/preposition) */}
                <div className="post__head" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {/* ACTOR FIRST (linked when trip exists) */}
                <span className="post__name" style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
                    {actorInline}
                </span>
                {/* COPY BUTTON lives AFTER the actor, not between trip & name */}
                {r.trip && (
                    <button
                    title="Copy tripcode"
                    onClick={(e) => { e.preventDefault(); copyTripAndFilter(r.trip); }}
                    style={{
                        border: "1px solid var(--panel-border)",
                        background: "var(--panel-alt-bg)",
                        borderRadius: 4,
                        padding: "0 6px",
                        fontSize: 11,
                        lineHeight: "18px",
                        cursor: "pointer",
                    }}
                    >
                    copy
                    </button>
                )}

                {/* • TIMESTAMP */}
                <span className="post__meta" title={r.ts}>{fmtTs(r.ts)}</span>
                </div>
                {/* Line 2: amount with verb prefix (keeps the buy/sell accent) */}
                <div className="post__text" style={{ marginTop: 2 }}>
                  <span style={{ color: accent, fontWeight: 700 }}>
                    {actionVerb(r).charAt(0).toUpperCase() + actionVerb(r).slice(1)}
                  </span>{" "}
                  {valStr(r.sol)}
                </div>
              </div>
            </div>
          );
        })}

        {pageItems.length === 0 && (
          <div
            style={{
              marginTop: 8,
              padding: 12,
              border: "1px dashed var(--panel-border)",
              borderRadius: 8,
              background: "var(--panel-alt-bg)",
              color: "#666",
              fontSize: 14,
            }}
          >
            No trades yet.
          </div>
        )}
      </div>
      <Pager
        currentPage={currentPage}
        totalPages={totalPages}
        onPrev={() => goToPage(currentPage - 1)}
        onNext={() => goToPage(currentPage + 1)}
        onJump={goToPage}
        model={buildPageModel(totalPages, currentPage)}
      />
    </section>
  );
}

function Pager({ currentPage, totalPages, onPrev, onNext, onJump, model }) {
  const [inputPage, setInputPage] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    const n = parseInt(String(inputPage), 10);
    if (!Number.isNaN(n)) onJump(n);
    setInputPage("");
  }

  return (
    <div style={{ margin: "10px 0" }}>
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
            style={{
              width: 80,
              border: "1px solid var(--input-border)",
              background: "var(--input-bg)",
              color: "var(--fg)",
              padding: "4px 6px",
              borderRadius: 4,
              fontSize: 14,
            }}
            placeholder={`${currentPage}/${totalPages}`}
          />
          <button className="chan-link" type="submit">[go]</button>
        </form>
      </div>
    </div>
  );
}

function buildPageModel(total, current) {
  const out = [];
  if (total <= 10) { for (let i = 1; i <= total; i++) out.push(i); return out; }
  const first = [1, 2];
  const last = [total - 1, total];
  const around = [current - 1, current, current + 1].filter((n) => n > 2 && n < total - 1);
  const pushWithGap = (arr, n) => {
    if (arr.length && typeof arr[arr.length - 1] === "number" && n - arr[arr.length - 1] > 1) arr.push("...");
    arr.push(n);
  };
  const seq = [];
  first.forEach((n) => pushWithGap(seq, n));
  around.forEach((n) => pushWithGap(seq, n));
  last.forEach((n) => pushWithGap(seq, n));
  return seq;
}
