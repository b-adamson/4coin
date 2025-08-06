"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ensureWallet, disconnectWallet } from "@/app/utils";

export default function HomePage() {
  const [wallet, setWallet] = useState("");
  const [tokens, setTokens] = useState([]);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const addr = await ensureWallet();
      setWallet(addr);

      try {
        const res = await fetch("http://localhost:4000/tokens");
        let rawTokens = await res.json();

        // sort by creation time
        rawTokens.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        // fetch metadata
        const tokensWithMeta = await Promise.all(
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

        setTokens(tokensWithMeta);
      } catch (err) {
        console.error("Failed to load tokens:", err);
        const statusEl = document.getElementById("status");
        if (statusEl) statusEl.textContent = "❌ Failed to load token list.";
      }
    })();
  }, []);

  const handleSearch = () => {
    const mint = document.getElementById("search-mint").value.trim();
    if (!mint) {
      const statusEl = document.getElementById("status");
      if (statusEl) statusEl.textContent = "❌ Please enter a mint address.";
      return;
    }
    router.push(`/token?mint=${mint}&wallet=${wallet}`);
  };

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

      <div style={{ marginBottom: "1.5rem" }}>
        <input
          type="text"
          id="search-mint"
          placeholder="Enter Mint Address"
          style={{ width: "70%" }}
        />
        <button onClick={handleSearch}>Search</button>
      </div>

      <h3>All Created Tokens</h3>
      <div id="token-list">
        {tokens.map((t, i) => (
          <div
            key={t.mint}
            className="token-post"
            onClick={() =>
              router.push(`/token?mint=${t.mint}&wallet=${wallet}`)
            }
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
                )}
                {" "} {/* 👈 adds a space before the date */}
                {formatDate(t.createdAt)}{" "}
                <span
                  style={{ cursor: "pointer", color: "#0000ee" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    router.push(`/token?mint=${t.mint}&wallet=${wallet}`);
                  }}
                >
                  No.{100000 + (t.index || 0)}
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

      <p id="status"></p>
    </main>
  );
}
