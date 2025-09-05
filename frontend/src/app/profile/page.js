"use client";

import { useEffect, useState } from "react";
import { ensureWallet } from "@/app/utils";
import { useRouter } from "next/navigation";

export default function ProfilePage() {
  const [wallet, setWallet] = useState("");
  const [tokens, setTokens] = useState([]);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const addr = await ensureWallet();
      setWallet(addr);

      try {
        const res = await fetch(`http://localhost:4000/tokens-by-creator?creator=${addr}`);
        let myTokens = await res.json();

        // Fetch metadata for each token
        myTokens = await Promise.all(
          myTokens.map(async (t) => {
            try {
              const metaRes = await fetch(t.metadataUri);
              const meta = await metaRes.json();
              return { ...t, ...meta }; // merge token + metadata
            } catch {
              return { ...t, description: "No description", image: "/placeholder.png" };
            }
          })
        );

        setTokens(myTokens);
      } catch (err) {
        console.error("Failed to load my tokens:", err);
      }
    })();
  }, []);

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
        </div>
        <button onClick={() => router.push(`/form?wallet=${wallet}`)}>
          + Create Coin
        </button>
      </div>

      <h1>Profile</h1>

      {wallet && (
        <div style={{ marginBottom: "1.5rem", fontWeight: "bold", fontSize: "15px" }}>
          Wallet: {wallet}
        </div>
      )}

      <h3>My Tokens</h3>

      <div id="token-list">
        {tokens.length === 0 && <p>You haven't created any tokens yet.</p>}
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
                {" "}
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
    </main>
  );
}
