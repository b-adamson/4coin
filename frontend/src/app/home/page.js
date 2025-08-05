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
        const rawTokens = await res.json();

        const tokensWithMeta = [];
        for (const t of rawTokens) {
          try {
            const metaRes = await fetch(t.metadataUri);
            const meta = await metaRes.json();
            tokensWithMeta.push({ ...t, meta });
          } catch (err) {
            console.warn("Metadata fetch failed for", t.mint, err);
          }
        }
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
        {tokens.map((t) => (
          <div
            key={t.mint}
            className="token-post"
            onClick={() =>
              router.push(`/token?mint=${t.mint}&wallet=${wallet}`)
            }
          >
            <img src={t.meta.image} alt={t.meta.name} />
            <div className="token-post-body">
              <div className="token-header">
                {t.meta.name} ({t.meta.symbol})
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
                {t.meta.description || "No description"}
              </div>
            </div>
          </div>
        ))}
      </div>

      <p id="status"></p>
    </main>
  );
}
