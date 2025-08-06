"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as solanaWeb3 from "@solana/web3.js";

export default function TokenPage() {
  const [mint, setMint] = useState("");
  const [wallet, setWallet] = useState("");
  const [meta, setMeta] = useState(null);
  const [token, setToken] = useState(null);
  const [status, setStatus] = useState("Loading token info...");
  const [amount, setAmount] = useState("");
  const router = useRouter();

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const mintParam = urlParams.get("mint");
    const walletParam = urlParams.get("wallet");

    setMint(mintParam || "");
    setWallet(walletParam || "");

    async function loadToken() {
      try {
        setStatus("🔍 Loading token info...");
        const res = await fetch(`http://localhost:4000/token-info?mint=${mintParam}`);
        const tokenData = await res.json();

        if (!res.ok) {
          setStatus("❌ Token not found.");
          return;
        }

        const metaRes = await fetch(tokenData.metadataUri);
        const metaData = await metaRes.json();

        setToken(tokenData);
        setMeta(metaData);
        setStatus("");
      } catch (err) {
        console.error("Error loading token:", err);
        setStatus("❌ Failed to load token.");
      }
    }

    if (mintParam) loadToken();
  }, []);

  const handleBuy = async () => {
    if (!amount || amount <= 0) {
      setStatus("❌ Enter a valid amount.");
      return;
    }
    setStatus(`💸 Buying ${amount} SOL worth of ${meta.symbol}...`);

    try {
      const buyRes = await fetch("http://localhost:4000/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: wallet,
          mintPubkey: mint,
          amount: Math.floor(amount * solanaWeb3.LAMPORTS_PER_SOL),
        }),
      });

      const buyData = await buyRes.json();
      if (!buyRes.ok || !buyData.txBase64) {
        throw new Error(buyData.error || "Unknown buy error");
      }

      const txBytes = Uint8Array.from(atob(buyData.txBase64), (c) => c.charCodeAt(0));
      const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
      const conn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");

      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) throw new Error("Simulation failed: " + JSON.stringify(sim.value.err));

      const sig = await window.solana.signAndSendTransaction(tx);
      await conn.confirmTransaction(sig, "confirmed");

      setStatus(`✅ Buy successful! 
        <a target="_blank" href="https://explorer.solana.com/tx/${sig}?cluster=devnet">View Transaction</a>`);
    } catch (err) {
      console.error("Buy transaction error:", err);
      setStatus("❌ Buy failed: " + (err.message || err.toString()));
    }
  };

  const handleSell = async () => {
    if (!amount || amount <= 0) {
      setStatus("❌ Enter a valid amount.");
      return;
    }
    setStatus(`💸 Selling tokens for ${amount} SOL...`);

    try {
      const sellRes = await fetch("http://localhost:4000/sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: wallet,
          mintPubkey: mint,
          amount: Math.floor(amount * solanaWeb3.LAMPORTS_PER_SOL),
        }),
      });

      const sellData = await sellRes.json();
      if (!sellRes.ok || !sellData.txBase64) {
        throw new Error(sellData.error || "Unknown sell error");
      }

      const txBytes = Uint8Array.from(atob(sellData.txBase64), (c) => c.charCodeAt(0));
      const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
      const conn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");

      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) throw new Error("Simulation failed: " + JSON.stringify(sim.value.err));

      const sig = await window.solana.signAndSendTransaction(tx);
      await conn.confirmTransaction(sig, "confirmed");

      setStatus(`✅ Sell successful! 
        <a target="_blank" href="https://explorer.solana.com/tx/${sig}?cluster=devnet">View Transaction</a>`);
    } catch (err) {
      console.error("Sell transaction error:", err);
      setStatus("❌ Sell failed: " + (err.message || err.toString()));
    }
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
    <main style={{ maxWidth: "600px", margin: "2rem auto", padding: "1rem", textAlign: "center" }}>
      <nav id="nav">
        <a href={`/home?wallet=${wallet}`}>🏠 Home</a>
      </nav>

      {meta && token && (
        <>
          <h2>{meta.name}</h2>
          <img
            src={meta.image}
            alt="Token Icon"
            style={{ maxWidth: "120px", borderRadius: "16px", margin: "1rem 0" }}
          />
          <p>{meta.description || token.symbol}</p>

          {/* Creator Info */}
          <div style={{ fontSize: "12px", marginBottom: "1rem" }}>
            <b>Created by:</b>{" "}
            <span style={{ fontWeight: "bold", color: "green" }}>
              {token.tripName || "Anonymous"}
            </span>
            {token.tripCode && (
              <span style={{ color: "gray", fontFamily: "monospace" }}>
                {" "}!!{token.tripCode}
              </span>
            )}
            {" "}on {formatDate(token.createdAt)} No.{100000 + (token.index || 0)}
          </div>

          <div id="trade-box" style={{ marginTop: "1rem" }}>
            <h3>Trade</h3>
            <label htmlFor="trade-amount" style={{ display: "block", marginBottom: "0.5rem" }}>
              Amount in SOL
            </label>
            <input
              type="number"
              id="trade-amount"
              min="0.001"
              step="0.001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ padding: "0.25rem", fontSize: "14px", width: "100%", border: "1px solid #aaa" }}
            />
            <div style={{ marginTop: "0.5rem" }}>
              <button onClick={handleBuy} className="trade-link">[Buy]</button>{" "}
              <button onClick={handleSell} className="trade-link">[Sell]</button>
            </div>
          </div>
        </>
      )}

      <p id="status" style={{ marginTop: "1rem" }} dangerouslySetInnerHTML={{ __html: status }}></p>
    </main>
  );
}
