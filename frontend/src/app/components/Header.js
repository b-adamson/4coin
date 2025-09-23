// src/app/components/Header.jsx
"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

function bracket(s) { return `[ ${s} ]`; }

export default function Header() {
  const [tokens, setTokens] = useState([]);
  const [visibleCount, setVisibleCount] = useState(0);
  const barRef = useRef(null);
  const canvasRef = useRef(null);

  const { publicKey, disconnect } = useAdapterWallet();
  const { setVisible: openWalletModal } = useWalletModal();
  const wallet = publicKey?.toBase58() ?? "";
  const short = wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : "";

  const measure = (text) => {
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    const ctx = canvasRef.current.getContext("2d");
    ctx.font = "14px Tahoma, Geneva, sans-serif";
    return Math.ceil(ctx.measureText(text).width);
  };

  // load tokens (same as before)
  useEffect(() => {
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
              return { ...t, reserveLamports: Number(info?.bondingCurve?.reserveSol || 0) };
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
  }, []);

  const topFunded = useMemo(
    () => [...tokens].sort((a, b) => (b.reserveLamports || 0) - (a.reserveLamports || 0)),
    [tokens]
  );

  // measure ticker (unchanged)
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;

    const recalc = () => {
      const maxW = el.clientWidth || 0;
      if (!maxW) { setVisibleCount(Math.min(5, topFunded.length)); return; }
      let used = measure("[ ");
      const tail = measure(" ]");
      let count = 0;
      for (let i = 0; i < topFunded.length; i++) {
        const sym = (topFunded[i].symbol || "").trim() || topFunded[i].mint.slice(0, 4);
        const piece = (count ? " / " : "") + sym;
        const w = measure(piece);
        if (used + w + tail > maxW) break;
        used += w; count++;
      }
      if (count === 0 && topFunded.length > 0) count = 1;
      setVisibleCount(count);
    };

    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    requestAnimationFrame(recalc);
    setTimeout(recalc, 0);
    if (document.fonts?.ready) document.fonts.ready.then(recalc).catch(() => {});
    return () => ro.disconnect();
  }, [topFunded]);

  const slice = topFunded.slice(0, Math.max(1, visibleCount));

  return (
    <header>
      {/* Upper nav */}
      <div className="nav-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative", zIndex: 100, pointerEvents: "auto" }}>
        <nav aria-label="Primary" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Link href="/" className="chan-link">[ Home 🏠 ]</Link>
          {wallet && <Link href="/profile" className="chan-link">[ Profile 👤 ]</Link>}
          {wallet && <Link href="/form" className="chan-link">[ Create Token 🪙 ]</Link>}
        </nav>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {wallet && (
            <span style={{ fontFamily: "monospace", fontSize: 12, color: "#555" }}>
              {short}
            </span>
          )}
          {!wallet ? (
            <a
              href="#"
              className="chan-link"
              onClick={(e) => { e.preventDefault(); openWalletModal(true); }}
            >
              {bracket("Connect Wallet")}
            </a>
          ) : (
            <a
              href="#"
              className="chan-link"
              onClick={async (e) => { e.preventDefault(); try { await disconnect(); } catch {} }}
            >
              {bracket("Logout")}
            </a>
          )}
        </div>
      </div>

      {/* Lower ticker */}
      <div
        id="ticker-bar"
        ref={barRef}
        className="ticker"
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
              href={{ pathname: "/token", query: { mint: t.mint } }}
              className="ticker__link chan-link"
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
