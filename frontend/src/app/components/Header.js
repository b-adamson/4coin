"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// ---- helpers ----
function bracket(s) { return `[ ${s} ]`; }

// Full header component. It can fetch tokens itself,
// OR accept them from the parent via `tokensOverride`.
export default function Header({ wallet, onLogout, tokensOverride }) {
  const router = useRouter();
  const [tokens, setTokens] = useState([]);
  const [visibleCount, setVisibleCount] = useState(0);

  // measurement refs
  const barRef = useRef(null);
  const canvasRef = useRef(null);

  const measure = (text) => {
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    const ctx = canvasRef.current.getContext("2d");
    ctx.font = "14px Tahoma, Geneva, sans-serif";
    return Math.ceil(ctx.measureText(text).width);
  };

  // load tokens only if parent didn't provide them
  useEffect(() => {
    if (Array.isArray(tokensOverride)) {
      setTokens(tokensOverride);
      return;
    }

    let cancel = false;
    (async () => {
      try {
        const res = await fetch("http://localhost:4000/tokens", { cache: "no-store" });
        const base = await res.json();
        const enriched = await Promise.all(
          base.map(async (t) => {
            try {
              const infoRes = await fetch(`http://localhost:4000/token-info?mint=${t.mint}`, { cache: "no-store" });
              const info = await infoRes.json();
              return {
                ...t,
                reserveLamports: Number(info?.bondingCurve?.reserveSol || 0),
              };
            } catch {
              return { ...t, reserveLamports: 0 };
            }
          })
        );
        if (!cancel) setTokens(enriched);
      } catch (e) {
        if (!cancel) setTokens([]);
        console.error("Header token load failed:", e);
      }
    })();

    return () => { cancel = true; };
  }, [tokensOverride]);

  const topFunded = useMemo(
    () => [...tokens].sort(
      (a, b) => (b.reserveLamports || 0) - (a.reserveLamports || 0)
    ),
    [tokens]
  );

  // measure how many symbols fit (robust: ResizeObserver + fallbacks)
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;

    const recalc = () => {
      const maxW = el.clientWidth || 0;

      // If layout isn’t ready yet, show a few so it’s never blank
      if (!maxW) {
        setVisibleCount(Math.min(5, topFunded.length));
        return;
      }

      let used = measure("[ ");
      const tail = measure(" ]");
      let count = 0;

      for (let i = 0; i < topFunded.length; i++) {
        const sym = (topFunded[i].symbol || "").trim() || topFunded[i].mint.slice(0, 4);
        const piece = (count ? " / " : "") + sym;
        const w = measure(piece);
        if (used + w + tail > maxW) break;
        used += w;
        count++;
      }
      if (count === 0 && topFunded.length > 0) count = 1;
      setVisibleCount(count);
    };

    const ro = new ResizeObserver(recalc);
    ro.observe(el);

    // initial passes after tokens/layout/fonts settle
    requestAnimationFrame(recalc);
    setTimeout(recalc, 0);
    if (document.fonts?.ready) document.fonts.ready.then(recalc).catch(() => {});

    return () => ro.disconnect();
  }, [topFunded]);

  const slice = topFunded.slice(0, Math.max(1, visibleCount));

  return (
    <header>
      {/* Upper nav */}
      <div
        className="nav-bar"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <nav aria-label="Primary" style={{ display: "flex", gap: 8 }}>
          <Link href={`/home?wallet=${wallet || ""}`} className="chan-link">{bracket("Home 🏠")}</Link>
          <Link href={`/profile?wallet=${wallet || ""}`} className="chan-link">{bracket("Profile 👤")}</Link>
          <a
            href="#"
            className="chan-link"
            onClick={(e) => { e.preventDefault(); onLogout?.(); }}
          >
            {bracket("Logout")}
          </a>
        </nav>
        <div>
          <Link href={`/form?wallet=${wallet || ""}`} className="chan-link">
            {bracket("Create Coin 🪙")}
          </Link>
        </div>
      </div>

      {/* Lower ticker */}
      <div
        id="ticker-bar"
        ref={barRef}
        style={{
          border: "1px solid #d9bfb7",
          background: "#f7e6de",
          padding: "6px 8px",
          marginBottom: "12px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          fontSize: 14,
        }}
      >
        <span>[ </span>
        {slice.map((t, i) => (
          <span key={t.mint}>
            {i > 0 && " / "}
            <Link
              href={{ pathname: "/token", query: { mint: t.mint, wallet: wallet || "" } }}
              className="chan-link"
              style={{ margin: 0, padding: 0 }}
            >
              {(t.symbol || "").trim() || t.mint.slice(0, 4)}
            </Link>
          </span>
        ))}
        <span> ]</span>
      </div>
    </header>
  );
}
