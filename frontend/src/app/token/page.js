"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as solanaWeb3 from "@solana/web3.js";
import Leaderboard from "../components/leaderboard";
import initToken from "./script";
import {
  LAMPORTS_PER_SOL,
  CAP_TOKENS,
  toLamports,
  fromLamports,
  buildLUTModel,
  baseToWhole
} from "../utils";

export default function TokenPage() {
  const [mint, setMint] = useState("");
  const [wallet, setWallet] = useState("");
  const [meta, setMeta] = useState(null);
  const [token, setToken] = useState(null);

  const [status, setStatus] = useState("");
  const [amount, setAmount] = useState("");
  const [unitMode, setUnitMode] = useState("sol");   // "sol" | "token"
  const [tradeMode, setTradeMode] = useState("buy"); // "buy" | "sell"
  const [conversion, setConversion] = useState(0);

  const [bondingReserve, setBondingReserve] = useState(0); // pool ATA (base units)
  const [walletBalance, setWalletBalance] = useState(0);   // SOL
  const [reserves, setReserves] = useState({ reserveSol: 0, reserveToken: 0 }); // lamports & base units

  // model (built once we know decimals)
  const [model, setModel] = useState(null);

  const router = useRouter();

  // decimals / scale
  const dec = typeof token?.decimals === "number" ? token.decimals : 9;
  const scale = 10 ** dec;

  // 1) init URL + nav
  useEffect(() => {
    initToken(setMint, setWallet);
  }, []);

  // 2) build polynomial model once we know decimals
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const m = await buildLUTModel(dec);
        if (!cancel) setModel(m);
      } catch (e) {
        console.error("Model build failed:", e);
      }
    })();
    return () => { cancel = true; };
  }, [dec]);

  // 3) load token/meta/reserves once we have mint+wallet
  useEffect(() => {
    if (!mint || !wallet) return;

    async function loadToken() {
      try {
        const res = await fetch(`http://localhost:4000/token-info?mint=${mint}`);
        const tokenData = await res.json();
        if (!res.ok || !tokenData || !tokenData.metadataUri) {
          setStatus("❌ Token not found.");
          return;
        }

        const metaRes = await fetch(tokenData.metadataUri);
        const metaData = await metaRes.json();

        setToken(tokenData);
        setMeta(metaData);

        // pool token balance from leaderboard
        const holdingsRes = await fetch(`http://localhost:4000/leaderboard?mint=${mint}`);
        const holdings = await holdingsRes.json();
        const bondRow = holdings.leaderboard.find(h => h.isBonding);
        const poolBase = BigInt(bondRow?.balanceBase ?? "0");

        setBondingReserve(Number(poolBase)); // if you still display this somewhere
        setReserves({
          reserveSol: tokenData.bondingCurve?.reserveSol || 0, // lamports
          reserveTokenBase: String(poolBase),                  // keep as string/bigint
        });

        // wallet SOL
        const conn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");
        const bal = await conn.getBalance(new solanaWeb3.PublicKey(wallet));
        setWalletBalance(bal / LAMPORTS_PER_SOL);
      } catch (err) {
        console.error("Error loading token:", err);
        setStatus("❌ Failed to load token.");
      }
    }

    loadToken();
  }, [mint, wallet]);

   useEffect(() => {
    if (!mint) return;
    const es = new EventSource("http://localhost:4000/stream/holdings");

    const refresh = async () => {
      try {
        const [tokenRes, lbRes] = await Promise.all([
          fetch(`http://localhost:4000/token-info?mint=${mint}`),
          fetch(`http://localhost:4000/leaderboard?mint=${mint}`)
        ]);
        const tokenData = await tokenRes.json();
        const lb = await lbRes.json();
        const bondRow = lb.leaderboard.find(h => h.isBonding);
        const poolBase = BigInt(bondRow?.balanceBase ?? "0");
        setReserves({
          reserveSol: tokenData.bondingCurve?.reserveSol || 0,
          reserveTokenBase: String(poolBase),
        });
      } catch {}
    };

    es.addEventListener("hello", refresh);    // initial
    es.addEventListener("holdings", refresh); // subsequent pushes

    return () => es.close();
  }, [mint]);

  // derived state from reserves + model
  const poolWhole = baseToWhole(reserves.reserveTokenBase, dec);
  const capWhole = CAP_TOKENS;

  // tokens sold so far (WHOLE)
  const ySoldWhole = model
    ? (capWhole - Math.min(poolWhole, capWhole))
    : 0;

  // current x position (model coordinate)
  const x0 = model ? (reserves.reserveSol / LAMPORTS_PER_SOL) : 0; // since tokens = s_base * x

  // 4) cap the INPUT (not outputs) based on mode & curve limits
  useEffect(() => {
    if (!model) return;
    const v = parseFloat(amount);
    if (!v || v <= 0) return;

    // Remaining tokens and remaining SOL budget to cap
    const remainingTokens = Math.max(0, capWhole - ySoldWhole);
    const remainingSol = model.cost_between_SOL(x0, model.X_MAX); // SOL to finish sale

    if (tradeMode === "buy" && unitMode === "sol") {
      if (v > remainingSol) setAmount(String(remainingSol));
    }

    if (tradeMode === "buy" && unitMode === "token") {
      if (v > remainingTokens) setAmount(String(remainingTokens));
    }

    if (tradeMode === "sell" && unitMode === "token") {
      const maxTokens = Math.max(0, Math.min(poolWhole, ySoldWhole));
      if (v > maxTokens) setAmount(String(maxTokens));
    }
    if (tradeMode === "sell" && unitMode === "sol") {
      // Cap by: (1) curve path back to x=0, and (2) vault's actual SOL
      const maxCurveSol = model.cost_between_SOL(0, x0);
      const maxVaultSol = reserves.reserveSol / LAMPORTS_PER_SOL;
      const maxSolOut = Math.max(0, Math.min(maxCurveSol, maxVaultSol));
      if (v > maxSolOut) setAmount(String(maxSolOut));
    }
    // (sell+sol left permissive; preview will reflect feasibility)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeMode, unitMode, amount, reserves, model, x0, ySoldWhole]);

  // 5) live conversion (Buy/Sell × SOL/Token)
  useEffect(() => {
    if (!model) { setConversion(0); return; }

    const val = parseFloat(amount);
    if (!val || val <= 0) { setConversion(0); return; }

    let result = 0;

    if (tradeMode === "buy") {
      if (unitMode === "sol") {
        // SOL in → tokens out
        const x1 = model.x_after_buying_SOL(x0, val);
        result = model.tokens_between(x0, x1);
      } else {
        // tokens target → SOL required
        const x1 = model.x_after_buying_tokens(x0, val);
        result = model.cost_between_SOL(x0, x1);  // = x1 - x0
      }
    } else {
      if (tradeMode === "sell") {
        if (unitMode === "token") {
          const x1 = model.x_after_selling_tokens(x0, val);
          result = model.cost_between_SOL(x1, x0);
        } else {
          const x1 = model.x_after_selling_SOL(x0, val);
          result = model.tokens_between(x1, x0);
        }
      }

    }

    setConversion(Number.isFinite(result) ? result : 0);
  }, [amount, unitMode, tradeMode, reserves, model, ySoldWhole, x0, poolWhole]);

  // 6) Lamports to send to backend
  function getLamportsForSubmit() {
    const val = parseFloat(amount) || 0;
    if (val <= 0) return 0;
    if (unitMode === "sol") return toLamports(val); // user typed SOL
    // unitMode === "token": conversion is SOL (buy=SOL in, sell=SOL out)
    return toLamports(conversion || 0);
  }

  // NEW: tokens in base units (whole tokens × 10^dec)
  function getTokenBaseForSubmit() {
    const val = parseFloat(amount) || 0;
    if (val <= 0) return 0;
    const tokensWhole = unitMode === "sol" ? (conversion || 0) : val;
    return Math.floor(tokensWhole * scale);
  }

  // 7) TX handlers
  async function updateHoldings(sig, type) {
    try {
      await fetch("http://localhost:4000/update-holdings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig,
          wallet,
          mint,
          type,                           // "buy" | "sell"
          tokenAmountBase: getTokenBaseForSubmit(), // token base units
          solLamports: getLamportsForSubmit(),      // SOL lamports
        }),
      });
    } catch (err) {
      console.error("Holdings update error:", err);
    }
  }

  async function handleSubmit() {
    const val = parseFloat(amount);
    if (!val || val <= 0) { setStatus("❌ Invalid amount."); return; }

    const endpoint = tradeMode === "buy" ? "buy" : "sell";
    const lamportsBudget = getLamportsForSubmit();       // used only for buy
    const tokensInBase   = getTokenBaseForSubmit();      // used only for sell
    const amountToSend   = tradeMode === "buy" ? lamportsBudget : tokensInBase;
    if (!amountToSend || amountToSend <= 0) {
      setStatus("❌ Amount resolves to 0.");
      return;
    }

    setStatus(`💸 ${tradeMode === "buy" ? "Buying" : "Selling"} ${val} ${unitMode.toUpperCase()}...`);

    try {
      const txRes = await fetch(`http://localhost:4000/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet, mintPubkey: mint, amount: amountToSend }),
      });
      const txData = await txRes.json();
      if (!txRes.ok || !txData.txBase64) throw new Error(txData.error || "Transaction error");

      const txBytes = Uint8Array.from(atob(txData.txBase64), (c) => c.charCodeAt(0));
      const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
      const conn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");

      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) throw new Error("Simulation failed: " + JSON.stringify(sim.value.err));

      const sig = await window.solana.signAndSendTransaction(tx);
      await conn.confirmTransaction(sig, "confirmed");

      const sigstr = typeof sig === "string" ? sig : sig.signature;
      await updateHoldings(sigstr, tradeMode);

      setStatus(`✅ ${tradeMode.toUpperCase()} successful! <a target="_blank" href="https://explorer.solana.com/tx/${sigstr}?cluster=devnet">View Transaction</a>`);
    } catch (err) {
      console.error("Transaction error:", err);
      setStatus("❌ Transaction failed: " + (err.message || err.toString()));
    }
  }

  function formatDate(isoString) {
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
  }

  const totalRaisedSOL = fromLamports(reserves.reserveSol); // purely informational
  const progressTokensPct = model ? ((ySoldWhole / CAP_TOKENS) * 100) : 0;
  const targetSOL = model ? model.X_MAX : 0;                     // ≈ 78.539816
  const remainingSOL = model ? Math.max(0, model.X_MAX - x0) : 0;


  return (
    <main style={{ maxWidth: "900px", margin: "2rem auto", padding: "1rem" }}>
      <nav id="nav">
        <a href={`/home?wallet=${wallet}`}>🏠 Home</a>
      </nav>

      <div style={{ display: "flex", gap: "2rem" }}>
        <div style={{ flex: 2 }}>
          {meta && token ? (
            <>
              <h2>{meta.name}</h2>
              <img
                src={meta.image}
                alt="Token Icon"
                style={{ maxWidth: "120px", borderRadius: "16px", margin: "1rem 0" }}
              />
              <p>{meta.description || token.symbol}</p>

              <div style={{ fontSize: "12px", marginBottom: "1rem" }}>
                <b>Created by:</b>{" "}
                <span style={{ fontWeight: "bold", color: "green" }}>{token.tripName || "Anonymous"}</span>{" "}
                {token.tripCode && <span style={{ color: "gray", fontFamily: "monospace" }}>!!{token.tripCode}</span>}{" "}
                on {formatDate(token.createdAt)} No.{100000 + (token.index || 0)}
              </div>

              <div style={{ fontSize: "12px", margin: "0 0 1rem 0" }}>
                <a
                  href={`https://explorer.solana.com/address/${mint}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "underline", color: "#0000ee", fontFamily: "monospace" }}
                >
                  {mint}
                </a>
              </div>

              {/* progress */}
              <div style={{ margin: "0.5rem 0", fontSize: 13 }}>
                <div>
                  Progress by tokens: {progressTokensPct.toFixed(2)}% (
                  SOL deposited ≈ {x0.toFixed(6)} / {model?.X_MAX.toFixed(6) ?? "…"} ; sold ≈ {ySoldWhole.toLocaleString()} / {CAP_TOKENS.toLocaleString()} tokens)
                </div>
                <div>
                  Raised so far: {totalRaisedSOL.toFixed(6)} SOL / target {targetSOL.toFixed(6)} SOL
                  {model && (
                    <> (remaining ~{remainingSOL.toFixed(6)} SOL)</>
                  )}
                </div>
              </div>

              <div id="trade-box" style={{ marginTop: "1rem" }}>
                <h3>Trade</h3>

                {/* Unit toggle */}
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <button onClick={() => setUnitMode("sol")} style={{ background: unitMode === "sol" ? "#eef" : undefined }}>SOL</button>
                  <button onClick={() => setUnitMode("token")} style={{ background: unitMode === "token" ? "#eef" : undefined }}>Token</button>
                </div>

                {/* Trade mode toggle */}
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <button onClick={() => setTradeMode("buy")} style={{ background: tradeMode === "buy" ? "#d0ffd0" : undefined }}>Buy</button>
                  <button onClick={() => setTradeMode("sell")} style={{ background: tradeMode === "sell" ? "#ffd0d0" : undefined }}>Sell</button>
                </div>
                <div style={{ fontSize: 14, fontWeight: "bold", marginBottom: "0.5rem" }}>
                  Mode: <span style={{ color: tradeMode === "buy" ? "green" : "red" }}>{tradeMode.toUpperCase()}</span>
                </div>

                {/* Amount input */}
                <label htmlFor="trade-amount" style={{ display: "block", marginBottom: "0.5rem" }}>
                  Amount ({unitMode.toUpperCase()})
                </label>
                <input
                  type="number"
                  id="trade-amount"
                  min="0.000001"
                  step="0.000001"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  style={{ padding: "0.25rem", fontSize: "14px", width: "100%", border: "1px solid #aaa" }}
                />

                {/* Conversion preview */}
                <div style={{ margin: "0.5rem 0" }}>
                  ≈ {unitMode === "token"
                    ? `${(conversion || 0).toFixed(9)} SOL`
                    : `${(conversion || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} Tokens`}
                </div>

                {/* Submit */}
                <div>
                  <button onClick={handleSubmit} className="trade-link">[Submit]</button>
                </div>
              </div>
            </>
          ) : (
            <p>{status}</p>
          )}

          <p id="status" style={{ marginTop: "1rem" }} dangerouslySetInnerHTML={{ __html: status }}></p>
        </div>

        <Leaderboard mint={mint} />
      </div>
    </main>
  );
}
