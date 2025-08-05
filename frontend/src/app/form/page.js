"use client";

import { useEffect, useState } from "react";
import initForm from "./script";

export default function FormPage() {
  const [wallet, setWallet] = useState("");

  useEffect(() => {
    initForm(setWallet);
  }, []);

  return (
    <main style={{ maxWidth: "600px", margin: "2rem auto", padding: "2rem", fontFamily: "Arial, sans-serif" }}>
      <nav style={{ marginBottom: "1.5rem" }}>
        <a href="/" className="nav-link">🏠 Home</a>
      </nav>


      <h1 style={{ marginBottom: "2rem", textAlign: "center" }}>Create Token</h1>

      <form id="metadata-form" style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <input type="hidden" id="wallet-address" value={wallet} />

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <label htmlFor="name" style={{ marginBottom: "0.5rem" }}>Name</label>
          <input
            type="text"
            id="name"
            placeholder="Token name"
            required
            style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid #ccc" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <label htmlFor="symbol" style={{ marginBottom: "0.5rem" }}>Symbol</label>
          <input
            type="text"
            id="symbol"
            placeholder="Token symbol"
            required
            style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid #ccc" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <label htmlFor="description" style={{ marginBottom: "0.5rem" }}>Description (optional)</label>
          <textarea
            id="description"
            placeholder="Token description"
            style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid #ccc", minHeight: "80px" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <label htmlFor="icon" style={{ marginBottom: "0.5rem" }}>Icon</label>
          <input
            type="file"
            id="icon"
            accept="image/*"
            style={{ padding: "0.25rem 0" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <label style={{ marginBottom: "0.5rem" }}>
            <input type="checkbox" id="buy-initial-checkbox" style={{ marginRight: "0.5rem" }} />
            Do initial buy
          </label>
          <input
            type="number"
            id="initial-sol"
            placeholder="SOL amount (e.g. 0.001)"
            step="0.001"
            style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid #ccc" }}
          />
        </div>

        <button type="submit" className="form-submit">
          [Submit]
        </button>

      </form>

      <p id="status-message" style={{ marginTop: "1.5rem", textAlign: "center", color: "#f87171" }}></p>
    </main>
  );
}
