"use client";

import { useEffect, useState } from "react";
import initToken from "./script";

export default function TokenPage() {
  const [mint, setMint] = useState("");
  const [wallet, setWallet] = useState("");

  useEffect(() => {
    initToken(setMint, setWallet);
  }, []);

  return (
    <main
      style={{
        maxWidth: "600px",
        margin: "2rem auto",
        padding: "1rem",
        textAlign: "center",
      }}
    >
      <nav id="nav"></nav>

      <h2 id="token-name"></h2>
      <img
        id="token-icon"
        alt="Token Icon"
        style={{
          maxWidth: "120px",
          borderRadius: "16px",
          margin: "1rem 0",
        }}
      />
      <p id="token-desc" style={{ marginBottom: "1rem" }}></p>

      <div id="trade-box" style={{ display: "none", marginTop: "1rem" }}>
        <h3>Trade</h3>
        <label
          htmlFor="trade-amount"
          style={{ display: "block", marginBottom: "0.5rem" }}
        >
          Amount in SOL
        </label>
        <input
          type="number"
          id="trade-amount"
          min="0.001"
          step="0.001"
          style={{
            padding: "0.25rem",
            fontSize: "14px",
            width: "100%",
            border: "1px solid #aaa",
            marginBottom: "0.5rem",
          }}
        />
        <div style={{ marginTop: "0.5rem" }}>
          <a href="#" id="buy-btn" className="trade-link">
            [Buy]
          </a>{" "}
          <a href="#" id="sell-btn" className="trade-link">
            [Sell]
          </a>
        </div>

        <p style={{ marginTop: "1rem" }}>
          <b>Mint:</b>{" "}
          <a
            id="token-mint"
            href={`https://explorer.solana.com/address/${mint}?cluster=devnet`}
            target="_blank"
          >
            {mint}
          </a>
        </p>
      </div>

      <p id="status" style={{ marginTop: "1rem" }}></p>
    </main>
  );
}
