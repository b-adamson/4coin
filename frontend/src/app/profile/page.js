"use client";

import { useEffect, useState, useMemo } from "react";
import { useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";

const PAGE_SIZE = 30;

export default function ProfilePage() {
  const [tokens, setTokens] = useState([]);
  const [page, setPage] = useState(1);

  const { publicKey } = useAdapterWallet();
  const walletStr = publicKey ? publicKey.toBase58() : "";

  const router = useRouter();

  useEffect(() => {
    let abort = false;

    async function load() {
      if (!walletStr) {
        setTokens([]);
        return;
      }
      try {
        const res = await fetch(`http://localhost:4000/tokens-by-creator?creator=${walletStr}`);
        let myTokens = await res.json();

        myTokens = await Promise.all(
          myTokens.map(async (t) => {
            try {
              const metaRes = await fetch(t.metadataUri);
              const meta = await metaRes.json();
              return { ...t, ...meta };
            } catch {
              return { ...t, description: "No description", image: "/placeholder.png" };
            }
          })
        );

        if (!abort) setTokens(myTokens);
      } catch (err) {
        if (!abort) console.error("Failed to load my tokens:", err);
      }
    }

    load();
    return () => { abort = true; };
  }, [walletStr]);

  // sort newest first (optional; remove if you want backend order)
  const sorted = useMemo(
    () => [...tokens].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [tokens]
  );

  // pagination derived data
  const { totalPages, pageItems, model, currentPage } = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = currentPage * PAGE_SIZE;
    const pageItems = sorted.slice(start, end);

    const model = buildPageModel(totalPages, currentPage);
    return { totalPages, pageItems, model, currentPage };
  }, [sorted, page]);

  // keep page in range if token count changes
  useEffect(() => {
    const tp = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    if (page > tp) setPage(tp);
  }, [sorted.length, page]);

  const formatDate = (isoString) => {
    const date = new Date(isoString);
    return date.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  return (
    <main>

      <h1>Profile</h1>

      {walletStr && (
        <div style={{ marginBottom: "1.5rem", fontWeight: "bold", fontSize: "15px" }}>
          Wallet: {walletStr}
        </div>
      )}

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
                    router.push(`/token?mint=${t.mint}&wallet=${walletStr}`);
                  }}
                  >
                  No.{100000 + (t.id || 0)}
                </span>
              </div>
              <div className="token-header">
                {t.name} ({t.symbol})
              </div>
              <div className="token-meta">
                Mint:{" "}
                <a
                  href={`https://explorer.solana.com/address/${t.mint}?cluster=devnet`}
                  target="_blank"
                >
                  {t.mint}
                </a>
              </div>
              <div className="token-desc">
                {t.description || "No description"}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom-only pager (fixed prev/next row under numbers) */}
      {sorted.length > 0 && (
        <Pager
          currentPage={currentPage}
          totalPages={totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
          onJump={(p) => setPage(Math.min(Math.max(1, p), totalPages))}
          model={model}
        />
      )}
    </main>
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
