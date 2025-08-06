"use client";

import { useEffect, useState } from "react";
import initForm from "./script";
import * as solanaWeb3 from "@solana/web3.js";

export default function FormPage() {
  const [wallet, setWallet] = useState("");
  const [status, setStatus] = useState("");
  const [useTrip, setUseTrip] = useState(false);
  const [tripCode, setTripCode] = useState("");
  const [tripName, setTripName] = useState("");
  const [doInitialBuy, setDoInitialBuy] = useState(false);

  useEffect(() => {
    initForm(setWallet);

    // fetch tripcode preview if wallet exists
    (async () => {
      if (wallet) {
        try {
          const res = await fetch(`http://localhost:4000/tripcode?wallet=${wallet}`);
          const data = await res.json();
          setTripCode(data.tripCode || "");
        } catch (err) {
          console.error("Failed to fetch tripcode preview:", err);
        }
      }
    })();
  }, [wallet]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus("");

    const name = e.target.name.value.trim();
    const symbol = e.target.symbol.value.trim();
    const description = e.target.description.value.trim();
    const icon = e.target.icon.files[0] || null;
    const initialSol = doInitialBuy
      ? parseFloat(e.target["initial-sol"].value || "0")
      : 0;

    // ✅ Validation
    if (!name || !symbol) {
      setStatus("❌ Name and Symbol are required.");
      return;
    }
    if (useTrip && !tripName.trim()) {
      setStatus("❌ Trip name is required when using a tripcode.");
      return;
    }

    try {
      setStatus("📤 Uploading icon & metadata to IPFS…");

      const fd = new FormData();
      fd.append("name", name);
      fd.append("symbol", symbol);
      fd.append("description", description);
      if (icon) fd.append("icon", icon);
      fd.append("walletAddress", wallet);

      const uploadRes = await fetch("http://localhost:4000/upload", {
        method: "POST",
        body: fd,
      });
      const uploadData = await uploadRes.json();

      if (!uploadRes.ok) {
        setStatus("❌ Upload failed: " + uploadData.error);
        return;
      }

      const metadataUri = uploadData.metadataIpfsUri;
      const conn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");

      const mintKeypair = solanaWeb3.Keypair.generate();
      const mintPubkey = mintKeypair.publicKey.toBase58();

      const body = {
        walletAddress: wallet,
        mintPubkey,
        mintSecretKey: Array.from(mintKeypair.secretKey),
        name,
        symbol,
        metadataUri,
        amount: 1_000_000_000 * 10 ** 6,
      };

      if (doInitialBuy && initialSol > 0) {
        body.initialBuyLamports = Math.floor(initialSol * solanaWeb3.LAMPORTS_PER_SOL);
      }

      setStatus("⚙️ Preparing mint + pool transaction…");

      const prepRes = await fetch("http://127.0.0.1:4000/prepare-mint-and-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const prep = await prepRes.json();
      if (!prepRes.ok || !prep.txBase64) {
        setStatus("❌ Preparation failed: " + (prep.error || "No transaction returned"));
        return;
      }

      const rawTx = Uint8Array.from(atob(prep.txBase64), (c) => c.charCodeAt(0));
      const tx = solanaWeb3.VersionedTransaction.deserialize(rawTx);

      try {
        const sig = await window.solana.signAndSendTransaction(tx);
        setStatus("🚀 Submitted transaction… waiting for confirmation…");

        await conn.confirmTransaction(sig, "confirmed");

        await fetch("http://127.0.0.1:4000/save-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mint: prep.mint,
            pool: prep.pool,
            poolTokenAccount: prep.poolTokenAccount,
            name,
            symbol,
            metadataUri,
            sig,
            creator: wallet,
            tripName: useTrip ? tripName : "Anonymous",
            tripCode: useTrip ? tripCode : null,
          }),
        });

        setStatus(
          `✅ <b>Token & Pool launched!</b><br><br>
          <a href="/token?mint=${prep.mint}&wallet=${wallet}" target="_blank" 
              style="text-decoration: underline; color: #0000ee;">
              ${name}
          </a><br>
          <a href="https://explorer.solana.com/address/${prep.mint}?cluster=devnet" target="_blank"
              style="text-decoration: underline; color: #0000ee;">
              ${prep.mint}
          </a>`
        );

      } catch (err) {
        console.error("Transaction signing failed:", err);
        setStatus("❌ Transaction signing failed: " + err.message);
      }
    } catch (err) {
      console.error("Form submission error:", err);
      setStatus("❌ An error occurred while creating the token.");
    }
  };

  return (
    <main style={{ maxWidth: "600px", margin: "2rem auto", padding: "2rem", fontFamily: "Arial, sans-serif" }}>
      <nav style={{ marginBottom: "1.5rem" }}>
        <a href={`/home?wallet=${wallet}`} className="nav-link">🏠 Home</a>
      </nav>

      <h1 style={{ marginBottom: "2rem", textAlign: "center" }}>Create Token</h1>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <input type="hidden" name="wallet-address" value={wallet} />

        <div>
          <label htmlFor="name">Name</label>
          <input type="text" name="name" placeholder="Token name" required style={{ width: "100%" }} />
        </div>

        <div>
          <label htmlFor="symbol">Symbol</label>
          <input type="text" name="symbol" placeholder="Token symbol" required style={{ width: "100%" }} />
        </div>

        <div>
          <label htmlFor="description">Description (optional)</label>
          <textarea name="description" placeholder="Token description" style={{ width: "100%", minHeight: "80px" }} />
        </div>

        <div>
          <label htmlFor="icon">Icon</label>
          <input type="file" name="icon" accept="image/*" />
        </div>

        {/* Tripcode Section */}
        <div>
          <label>
            <input
              type="checkbox"
              checked={useTrip}
              onChange={(e) => setUseTrip(e.target.checked)}
              style={{ marginRight: "0.5rem" }}
            />
            Tripcode
          </label>
        </div>

        {useTrip && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input
              type="text"
              value={`!!${tripCode}`}
              readOnly
              style={{
                width: "120px",
                border: "1px solid #ccc",
                padding: "0.4rem",
                fontFamily: "monospace",
                backgroundColor: "#f5f5f5",
              }}
            />
            <input
              type="text"
              value={tripName}
              onChange={(e) => setTripName(e.target.value)}
              placeholder="Enter trip name..."
              required
              style={{
                flex: 1,
                border: "1px solid #ccc",
                padding: "0.4rem",
              }}
            />
          </div>
        )}

        {/* Do Initial Buy */}
        <div>
          <label>
            <input
              type="checkbox"
              checked={doInitialBuy}
              onChange={(e) => setDoInitialBuy(e.target.checked)}
              style={{ marginRight: "0.5rem" }}
            />
            Do initial buy
          </label>
          {doInitialBuy && (
            <input
              type="number"
              name="initial-sol"
              placeholder="SOL amount (e.g. 0.001)"
              step="0.001"
              required
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "6px",
                border: "1px solid #ccc",
                marginTop: "0.5rem",
              }}
            />
          )}
        </div>

        <button type="submit" className="form-submit">[Submit]</button>
      </form>

      <p id="status-message" style={{ marginTop: "1.5rem", textAlign: "center", color: "#f87171" }} dangerouslySetInnerHTML={{ __html: status }}></p>
    </main>
  );
}
