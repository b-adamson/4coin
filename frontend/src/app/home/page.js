"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ensureWallet, disconnectWallet } from "@/app/utils";
import { buildLUTModel, LAMPORTS_PER_SOL } from "../utils"; // <-- for X_MAX + SOL math

export default function HomePage() {
  const [wallet, setWallet] = useState("");
  const [tokens, setTokens] = useState([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [model, setModel] = useState(null); // LUT model to get X_MAX

  const router = useRouter();
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const blurTimerRef = useRef(null);

  // ---- load wallet + tokens (+meta + reserves) ----
  useEffect(() => {
    (async () => {
      const addr = await ensureWallet();
      setWallet(addr);

      try {
        const res = await fetch("http://localhost:4000/tokens");
        let rawTokens = await res.json();

        // attach metadata
        const withMeta = await Promise.all(
          rawTokens.map(async (t) => {
            try {
              const metaRes = await fetch(t.metadataUri);
              const meta = await metaRes.json();
              return { ...t, ...meta };
            } catch {
              return { ...t, description: "No description", image: "/placeholder.png" };
            }
          })
        );

        // attach reserves for “Top Funded” + % calculation
        const enriched = await Promise.all(
          withMeta.map(async (t) => {
            try {
              const infoRes = await fetch(`http://localhost:4000/token-info?mint=${t.mint}`);
              const info = await infoRes.json();
              const reserveLamports = Number(info?.bondingCurve?.reserveSol || 0);
              return { ...t, reserveLamports, decimals: t.decimals ?? info?.decimals ?? 9 };
            } catch {
              return { ...t, reserveLamports: 0, decimals: t.decimals ?? 9 };
            }
          })
        );

        setTokens(enriched);

        // Build LUT model once (all tokens share same decimals in your setup; default to 9)
        const dec = typeof enriched?.[0]?.decimals === "number" ? enriched[0].decimals : 9;
        try {
          const m = await buildLUTModel(dec);
          setModel(m);
        } catch (e) {
          console.error("LUT model build failed:", e);
        }
      } catch (err) {
        console.error("Failed to load tokens:", err);
        const statusEl = document.getElementById("status");
        if (statusEl) statusEl.textContent = "❌ Failed to load token list.";
      }
    })();
  }, []);

  // ---- search index + suggestions ----
  const index = useMemo(
    () =>
      tokens.map((t) => ({
        mint: t.mint || "",
        name: (t.name || "").trim(),
        symbol: (t.symbol || "").trim(),
        image: t.image || "/placeholder.png",
      })),
    [tokens]
  );

  const suggestions = useMemo(() => {
    const q = (query || "").trim().toLowerCase();
    if (!q) return [];

    function scoreRow(r) {
      const name = r.name.toLowerCase();
      const symbol = r.symbol.toLowerCase();
      const mint = r.mint.toLowerCase();
      if (mint === q) return 1000;
      let s = 0;
      if (name.startsWith(q)) s += 200;
      if (symbol.startsWith(q)) s += 180;
      if (mint.startsWith(q)) s += 160;
      if (name.includes(q)) s += 40;
      if (symbol.includes(q)) s += 30;
      if (mint.includes(q)) s += 20;
      s += Math.max(0, 20 - Math.min(20, name.length / 2));
      return s;
    }

    return index
      .map((r) => ({ ...r, _score: scoreRow(r) }))
      .filter((r) => r._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 8);
  }, [index, query]);

  useEffect(() => {
    if (!open) return;
    if (suggestions.length === 0) setHighlight(0);
    else if (highlight >= suggestions.length) setHighlight(suggestions.length - 1);
  }, [open, suggestions, highlight]);

  // ---- utils ----
  const formatDate = (isoString) =>
    new Date(isoString).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  const lamportsToSOL = (lamports) => Number(lamports || 0) / LAMPORTS_PER_SOL;
  const percentToCompletion = (reserveLamports) => {
    if (!model) return 0;
    const x0 = lamportsToSOL(reserveLamports);
    const pct = (x0 / model.X_MAX) * 100;
    return Math.max(0, Math.min(100, pct || 0));
  };

  const goToMint = (mint) => {
    if (!mint) return;
    router.push(`/token?mint=${mint}&wallet=${wallet}`);
    setOpen(false);
  };

  const onSubmitSearch = () => {
    const q = query.trim();
    if (!q) {
      const statusEl = document.getElementById("status");
      if (statusEl) statusEl.textContent = "❌ Please enter a mint, name, or symbol.";
      return;
    }
    const isMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);
    if (isMint) return goToMint(q);
    if (suggestions.length > 0) return goToMint(suggestions[0].mint);
    const statusEl = document.getElementById("status");
    if (statusEl) statusEl.textContent = "No match found.";
  };

  const onKeyDown = (e) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (!open) {
      if (e.key === "Enter") onSubmitSearch();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(0, suggestions.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = suggestions[highlight];
      if (row) goToMint(row.mint);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const onBlurSafe = () => {
    blurTimerRef.current = setTimeout(() => setOpen(false), 100);
  };
  const onFocusOpen = () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    if (query.trim()) setOpen(true);
  };

  // ---- columns ----
  const recentTokens = useMemo(
    () => [...tokens].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 30),
    [tokens]
  );
  const topFundedTokens = useMemo(
    () => [...tokens].sort((a, b) => Number(b.reserveLamports || 0) - Number(a.reserveLamports || 0)).slice(0, 30),
    [tokens]
  );

  // shared card (keeps your .token-post look)
  const TokenCard = ({ t }) => {
    const sol = lamportsToSOL(t.reserveLamports);
    const pct = percentToCompletion(t.reserveLamports);
    return (
      <div
        className="token-post"
        onClick={() => router.push(`/token?mint=${t.mint}&wallet=${wallet}`)}
      >
        <img src={t.image || "/placeholder.png"} alt={t.name} />
        <div className="token-post-body">
          <div style={{ fontSize: "12px", marginBottom: "4px" }}>
            <span style={{ fontWeight: "bold", color: "green" }}>
              {t.tripName || "Anonymous"}
            </span>
            {t.tripCode && (
              <span style={{ color: "gray", fontFamily: "monospace" }}>
                {" "}!!{t.tripCode}
              </span>
            )}{" "}
            {formatDate(t.createdAt)}{" "}
            <span
              style={{ cursor: "pointer", color: "#0000ee" }}
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/token?mint=${t.mint}&wallet=${wallet}`);
              }}
            >
              No.{100000 + (t.id || 0)}
            </span>
          </div>

          <div className="token-header">
            {t.name} ({t.symbol})
          </div>

          <div className="token-meta" style={{ wordBreak: "break-all" }}>
            Mint:{" "}
            <a
              href={`https://explorer.solana.com/address/${t.mint}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
            >
              {t.mint}
            </a>
          </div>

          <div className="token-desc">
            {t.description || "No description"}
          </div>

          {/* NEW: SOL + % (same on both columns) */}
          <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
            SOL in pool: <b>{sol.toFixed(3)} SOL</b>{" "}
            <span style={{ opacity: 0.85 }}>({pct.toFixed(1)}%)</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <main>
      {/* header */}
      <div
        id="header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <div style={{ display: "flex", gap: "1rem" }}>
          <a href={`/home?wallet=${wallet}`}>🏠 Home</a>
          <a href={`/profile?wallet=${wallet}`}>👤 Profile</a>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              disconnectWallet(router, setWallet);
            }}
          >
            Logout
          </a>
        </div>

        <button onClick={() => router.push(`/form?wallet=${wallet}`)}>
          + Create Coin
        </button>
      </div>

      {/* search with suggestions */}
      <div style={{ marginBottom: "1.5rem", position: "relative" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            type="text"
            id="search-mint"
            placeholder="Search by Mint / Name / Symbol"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(Boolean(e.target.value.trim()));
            }}
            onKeyDown={onKeyDown}
            onBlur={onBlurSafe}
            onFocus={onFocusOpen}
            style={{ flex: 1 }}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls="search-suggestions"
          />
          <button onMouseDown={(e) => e.preventDefault()} onClick={onSubmitSearch}>
            Search
          </button>
        </div>

        {open && suggestions.length > 0 && (
          <ul
            id="search-suggestions"
            ref={listRef}
            role="listbox"
            style={{
              position: "absolute",
              zIndex: 20,
              top: "100%",
              left: 0,
              right: 0,
              background: "#fff",
              border: "1px solid #ccc",
              borderRadius: 8,
              marginTop: 6,
              padding: 6,
              maxHeight: 300,
              overflowY: "auto",
              boxShadow: "0 6px 20px rgba(0,0,0,.12)",
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {suggestions.map((s, i) => (
              <li
                key={s.mint}
                role="option"
                aria-selected={i === highlight}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => goToMint(s.mint)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: i === highlight ? "#eef2ff" : "transparent",
                }}
              >
                <img
                  src={s.image}
                  alt=""
                  width={24}
                  height={24}
                  style={{ borderRadius: 6, objectFit: "cover" }}
                />
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {s.name || s.symbol || "(Unnamed Token)"}{s.symbol ? <span style={{ opacity: 0.7 }}> &nbsp;({s.symbol})</span> : null}
                  </span>
                  <span
                    style={{
                      fontFamily: "monospace",
                      color: "#777",
                      fontSize: 12,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {s.mint}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* two columns — same formatting */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
          gap: "1.25rem",
          alignItems: "start",
        }}
      >
        <section style={{ minWidth: 0 }}>
          <h3 style={{ marginTop: 0 }}>🕒 Most Recent</h3>
          <div id="token-list" style={{ display: "grid", gap: 12 }}>
            {recentTokens.map((t) => (
              <TokenCard key={t.mint} t={t} />
            ))}
          </div>
        </section>

        <section style={{ minWidth: 0 }}>
          <h3 style={{ marginTop: 0 }}>🚀 Top Funded</h3>
          <div id="token-list" style={{ display: "grid", gap: 12 }}>
            {topFundedTokens.map((t) => (
              <TokenCard key={t.mint} t={t} />
            ))}
          </div>
        </section>
      </div>

      <p id="status" style={{ marginTop: 16 }}></p>
    </main>
  );
}
