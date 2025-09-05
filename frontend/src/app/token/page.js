"use client";

import { useEffect, useRef, useState } from "react";
import * as solanaWeb3 from "@solana/web3.js";

import Leaderboard from "../components/leaderboard";
import BondingCurve from "../components/BondingCurve";
import PriceChart from "../components/PriceChart";
import Comments from "../components/Comments";

import initToken from "./script";
import {
  LAMPORTS_PER_SOL,
  CAP_TOKENS,
  toLamports,
  fromLamports,
  buildLUTModel,
  baseToWhole,
} from "../utils";

/**
 * Floor a timestamp (ms) to a bucket size (sec) and return unix seconds.
 */
function floorToBucketSec(tsMs, bucketSec) {
  return Math.floor(tsMs / 1000 / bucketSec) * bucketSec;
}

/**
 * Spot price (SOL per token) via a small forward secant on the curve.
 */
function spotPriceSOLPerToken(modelObj, x0) {
  if (!modelObj || !Number.isFinite(x0)) return null;
  const DX = 0.01;
  const x1 = Math.min(modelObj.X_MAX, x0 + DX);
  if (x1 <= x0) return null;
  const tokens = modelObj.tokens_between(x0, x1);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return (x1 - x0) / tokens;
}

/**
 * Build confirmed OHLC candles from movement-only ticks.
 * Buckets by `bucketSec`, fills gaps, and carries-forward opens for continuity.
 */
function buildCandlesFromTicks(ticks, model, bucketSec = 10) {
  if (!model || !Array.isArray(ticks) || ticks.length === 0) return [];

  const byBucket = new Map();

  for (const s of ticks) {
    const x = (s.reserveSolLamports || 0) / LAMPORTS_PER_SOL;
    const price = spotPriceSOLPerToken(model, x);
    if (!Number.isFinite(price)) continue;

    const b = Math.floor((s.t || 0) / bucketSec) * bucketSec;
    const c = byBucket.get(b);
    if (!c) {
      byBucket.set(b, { time: b, open: price, high: price, low: price, close: price });
    } else {
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
    }
  }
  if (byBucket.size === 0) return [];

  // Fill gaps and force each bucket's open = previous close
  const sorted = Array.from(byBucket.keys()).sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const out = [];
  let t = first;
  let lastClose = null;

  while (t <= last) {
    const real = byBucket.get(t);
    if (real) {
      const open = lastClose != null ? lastClose : real.open;
      const c = {
        time: t,
        open,
        high: Math.max(real.high, open),
        low: Math.min(real.low, open),
        close: real.close,
      };
      out.push(c);
      lastClose = c.close;
    } else if (lastClose != null) {
      out.push({ time: t, open: lastClose, high: lastClose, low: lastClose, close: lastClose });
    }
    t += bucketSec;
  }

  return out;
}

export default function TokenPage() {
  // --- Routing / identity ---
  const [mint, setMint] = useState("");
  const [wallet, setWallet] = useState("");

  // --- Token + metadata ---
  const [meta, setMeta] = useState(null);
  const [token, setToken] = useState(null);

  // --- Chart state: confirmed history + live pending overlay ---
  const [confirmedCandles, setConfirmedCandles] = useState([]);
  const [pendingCandle, setPendingCandle] = useState(null);

  // --- UI status + trade state ---
  const [status, setStatus] = useState("");
  const [amount, setAmount] = useState("");
  const [unitMode, setUnitMode] = useState("sol"); // "sol" | "token"
  const [tradeMode, setTradeMode] = useState("buy"); // "buy" | "sell"
  const [conversion, setConversion] = useState(0);

  // --- Pool + wallet reserves ---
  const [reserves, setReserves] = useState({ reserveSol: 0, reserveTokenBase: "0" });
  const [walletBalance, setWalletBalance] = useState(0); // SOL (informational)

  // --- LUT model (once decimals known) ---
  const [model, setModel] = useState(null);

  // --- Leaderboard change signalling ---
  const [lbVersion, setLbVersion] = useState(0);
  const lbDebounceRef = useRef(null);
  const lastChainSnapshotRef = useRef({ reserveSol: null, poolBase: null });

  // --- Decimals / scale ---
  const dec = typeof token?.decimals === "number" ? token.decimals : 9;
  const scale = 10 ** dec;

  // --- History sampling & ranges ---
  const BASE_SAMPLE_SEC = 10; // server-side tick cadence
  const RANGE_PRESETS = {
    "3d": { seconds: 3 * 86400, bucketSec: 900 }, // 15m
    "1w": { seconds: 7 * 86400, bucketSec: 3600 }, // 1h
    "1m": { seconds: 30 * 86400, bucketSec: 86400 }, // 1d
  };
  const [rangeKey, setRangeKey] = useState("3d");
  const visBucketSec = RANGE_PRESETS[rangeKey].bucketSec;

  // --- Refs to latest candles for use inside effects/callbacks ---
  const confirmedCandlesRef = useRef(confirmedCandles);
  const pendingCandleRef = useRef(pendingCandle);
  useEffect(() => {
    confirmedCandlesRef.current = confirmedCandles;
  }, [confirmedCandles]);
  useEffect(() => {
    pendingCandleRef.current = pendingCandle;
  }, [pendingCandle]);

  // --- Small helpers that need model / state ---
  function spotFromLamports(rLamports) {
    if (!model || !Number.isFinite(rLamports)) return null;
    return spotPriceSOLPerToken(model, rLamports / LAMPORTS_PER_SOL);
  }

  function bumpLeaderboardDebounced(delay = 120) {
    if (lbDebounceRef.current) clearTimeout(lbDebounceRef.current);
    lbDebounceRef.current = setTimeout(() => setLbVersion((v) => v + 1), delay);
  }

  function makePendingFromPrice(price, tsMs = Date.now()) {
    if (!isFinite(price) || price <= 0) return null;
    const bucket = floorToBucketSec(tsMs, visBucketSec);
    const lastConf = confirmedCandlesRef.current[confirmedCandlesRef.current.length - 1];

    if (!lastConf || lastConf.time !== bucket) {
      const open = lastConf ? lastConf.close : price;
      return { time: bucket, open, high: Math.max(open, price), low: Math.min(open, price), close: price };
    }

    return {
      time: lastConf.time,
      open: lastConf.open,
      high: Math.max(lastConf.high, price),
      low: Math.min(lastConf.low, price),
      close: price,
    };
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

  // --- Initialization: mint + wallet from URL / script ---
  useEffect(() => {
    initToken(setMint, setWallet);
  }, []);

  // --- Build LUT model once decimals are known ---
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
    return () => {
      cancel = true;
    };
  }, [dec]);

  // --- Load token/meta/reserves once we have mint + wallet ---
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

        // Pool token balance from leaderboard
        const holdingsRes = await fetch(`http://localhost:4000/leaderboard?mint=${mint}`);
        const holdings = await holdingsRes.json();
        const bondRow = holdings.leaderboard.find((h) => h.isBonding);
        const poolBase = BigInt(bondRow?.balanceBase ?? "0");

        setReserves({
          reserveSol: tokenData.bondingCurve?.reserveSol || 0,
          reserveTokenBase: String(poolBase),
        });

        // Wallet SOL (informational)
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

  // --- Seed confirmed history from server on load / when range changes ---
  useEffect(() => {
    if (!mint || !model) return;
    (async () => {
      try {
        const needSec = RANGE_PRESETS[rangeKey].seconds;
        const roughNeeded = Math.ceil(needSec / BASE_SAMPLE_SEC) + 200;
        const limit = Math.min(50000, Math.max(1000, roughNeeded));

        const resp = await fetch(`http://localhost:4000/price-history?mint=${mint}&limit=${limit}`);
        if (!resp.ok) return;
        const { ticks = [] } = await resp.json();

        const full = buildCandlesFromTicks(ticks, model, visBucketSec);

        const cutoff = Math.floor(Date.now() / 1000) - RANGE_PRESETS[rangeKey].seconds;
        const pruned = full.filter((c) => c.time >= cutoff - visBucketSec);

        setConfirmedCandles(pruned);
        setPendingCandle(null);
      } catch (e) {
        console.error("Seed /price-history failed", e);
      }
    })();
  }, [mint, model, rangeKey, visBucketSec]);

  // --- Live updates via SSE ---
  useEffect(() => {
    if (!mint) return;

    const es = new EventSource("http://localhost:4000/stream/holdings");

    const onMessage = async (ev) => {
      if (!ev?.data) return;
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }

      // Filter by current mint
      const msgMint = payload?.mint;
      if (!msgMint || msgMint !== mint) return;

      const src = payload?.source; // "internal" | "chain"
      const rLamports = Number(payload?.reserveSolLamports);
      const poolBaseStr = payload?.poolBase != null ? String(payload.poolBase) : null;

      if (Number.isFinite(rLamports) && poolBaseStr) {
        setReserves({ reserveSol: rLamports, reserveTokenBase: poolBaseStr });
      }

      const liveSpot = spotFromLamports(rLamports);
      if (Number.isFinite(liveSpot)) {
        setPendingCandle(() => makePendingFromPrice(liveSpot));
      }

      if (src === "chain") {
        const tSec = Number(payload?.t);
        if (!Number.isFinite(tSec)) return;

        // Detect real chain state changes
        const sameReserve = lastChainSnapshotRef.current.reserveSol === rLamports;
        const samePool = lastChainSnapshotRef.current.poolBase === poolBaseStr;
        if (!sameReserve || !samePool) {
          lastChainSnapshotRef.current = { reserveSol: rLamports, poolBase: poolBaseStr };
          bumpLeaderboardDebounced(150);
        }

        // If the chain tick crossed a visual bucket boundary, refresh confirmed candles
        const chainVisBucket = Math.floor(tSec / visBucketSec) * visBucketSec;
        const lastConf = confirmedCandlesRef.current[confirmedCandlesRef.current.length - 1];
        const lastConfTime = lastConf?.time ?? null;

        const crossedBoundary = lastConfTime != null && chainVisBucket > lastConfTime;
        if (crossedBoundary) {
          try {
            const needSec = RANGE_PRESETS[rangeKey].seconds;
            const roughNeeded = Math.ceil(needSec / BASE_SAMPLE_SEC) + 200;
            const limit = Math.min(50000, Math.max(1000, roughNeeded));

            const fullRes = await fetch(`http://localhost:4000/price-history?mint=${mint}&limit=${limit}`);
            if (fullRes.ok) {
              const { ticks = [] } = await fullRes.json();
              const full = buildCandlesFromTicks(ticks, model, visBucketSec);
              const cutoff = Math.floor(Date.now() / 1000) - RANGE_PRESETS[rangeKey].seconds;
              const pruned = full.filter((c) => c.time >= cutoff - visBucketSec);
              setConfirmedCandles(pruned);
            }
          } catch (e) {
            console.error("Finalize (chain boundary) failed", e);
          }
          setPendingCandle(null);
        }
      }
    };

    es.addEventListener("hello", onMessage);
    es.addEventListener("holdings", onMessage);

    return () => {
      es.removeEventListener("hello", onMessage);
      es.removeEventListener("holdings", onMessage);
      es.close();
    };
  }, [mint, model, rangeKey, visBucketSec]);

  // --- Derived state from reserves + model ---
  const poolWhole = baseToWhole(reserves.reserveTokenBase, dec);
  const capWhole = CAP_TOKENS;
  const ySoldWhole = model ? capWhole - Math.min(poolWhole, capWhole) : 0;
  const x0 = model ? reserves.reserveSol / LAMPORTS_PER_SOL : 0;

  const totalRaisedSOL = fromLamports(reserves.reserveSol);
  const progressTokensPct = model ? (ySoldWhole / CAP_TOKENS) * 100 : 0;
  const targetSOL = model ? model.X_MAX : 0;
  const remainingSOL = model ? Math.max(0, model.X_MAX - x0) : 0;

  // --- Input capping vs curve limits / vault balances ---
  useEffect(() => {
    if (!model) return;
    const v = parseFloat(amount);
    if (!v || v <= 0) return;

    const remainingTokens = Math.max(0, capWhole - ySoldWhole);
    const remainingSol = model.cost_between_SOL(x0, model.X_MAX);

    if (tradeMode === "buy" && unitMode === "sol" && v > remainingSol) {
      setAmount(String(remainingSol));
    }

    if (tradeMode === "buy" && unitMode === "token" && v > remainingTokens) {
      setAmount(String(remainingTokens));
    }

    if (tradeMode === "sell" && unitMode === "token") {
      const maxTokens = Math.max(0, Math.min(poolWhole, ySoldWhole));
      if (v > maxTokens) setAmount(String(maxTokens));
    }

    if (tradeMode === "sell" && unitMode === "sol") {
      const maxCurveSol = model.cost_between_SOL(0, x0);
      const maxVaultSol = reserves.reserveSol / LAMPORTS_PER_SOL;
      const maxSolOut = Math.max(0, Math.min(maxCurveSol, maxVaultSol));
      if (v > maxSolOut) setAmount(String(maxSolOut));
    }
  }, [tradeMode, unitMode, amount, reserves, model, x0, ySoldWhole, poolWhole, capWhole]);

  // --- Live conversion preview (Buy/Sell × SOL/Token) ---
  useEffect(() => {
    if (!model) {
      setConversion(0);
      return;
    }
    const val = parseFloat(amount);
    if (!val || val <= 0) {
      setConversion(0);
      return;
    }

    let result = 0;

    if (tradeMode === "buy") {
      if (unitMode === "sol") {
        const x1 = model.x_after_buying_SOL(x0, val);
        result = model.tokens_between(x0, x1);
      } else {
        const x1 = model.x_after_buying_tokens(x0, val);
        result = model.cost_between_SOL(x0, x1);
      }
    } else {
      if (unitMode === "token") {
        const x1 = model.x_after_selling_tokens(x0, val);
        result = model.cost_between_SOL(x1, x0);
      } else {
        const x1 = model.x_after_selling_SOL(x0, val);
        result = model.tokens_between(x1, x0);
      }
    }

    setConversion(Number.isFinite(result) ? result : 0);
  }, [amount, unitMode, tradeMode, reserves, model, x0, ySoldWhole, poolWhole]);

  // --- Helpers to compute submission amounts ---
  function getLamportsForSubmit() {
    const val = parseFloat(amount) || 0;
    if (val <= 0) return 0;
    if (unitMode === "sol") return toLamports(val);
    return toLamports(conversion || 0);
  }

  function getTokenBaseForSubmit() {
    const val = parseFloat(amount) || 0;
    if (val <= 0) return 0;
    const tokensWhole = unitMode === "sol" ? conversion || 0 : val;
    return Math.floor(tokensWhole * scale);
  }

  // --- Backend notification after a confirmed chain tx ---
  async function updateHoldings(sig, type) {
    try {
      await fetch("http://localhost:4000/update-holdings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig,
          wallet,
          mint,
          type,
          tokenAmountBase: getTokenBaseForSubmit(),
          solLamports: getLamportsForSubmit(),
        }),
      });
    } catch (err) {
      console.error("Holdings update error:", err);
    }
  }

  // --- Submit buy/sell ---
  async function handleSubmit() {
    const val = parseFloat(amount);
    if (!val || val <= 0) {
      setStatus("❌ Invalid amount.");
      return;
    }

    const endpoint = tradeMode === "buy" ? "buy" : "sell";
    const lamportsBudget = getLamportsForSubmit(); // for buy
    const tokensInBase = getTokenBaseForSubmit(); // for sell
    const amountToSend = tradeMode === "buy" ? lamportsBudget : tokensInBase;

    if (!amountToSend || amountToSend <= 0) {
      setStatus("❌ Amount resolves to 0.");
      return;
    }

    setStatus(`💸 ${tradeMode === "buy" ? "Buying" : "Selling"} ${val} ${unitMode.toUpperCase()}...`);

    try {
      // Build tx on backend
      const txRes = await fetch(`http://localhost:4000/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet, mintPubkey: mint, amount: amountToSend }),
      });
      const txData = await txRes.json();
      if (!txRes.ok || !txData.txBase64) throw new Error(txData.error || "Transaction error");

      // Deserialize + simulate
      const txBytes = Uint8Array.from(atob(txData.txBase64), (c) => c.charCodeAt(0));
      const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
      const conn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");

      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) throw new Error("Simulation failed: " + JSON.stringify(sim.value.err));

      // Sign + send
      const sig = await window.solana.signAndSendTransaction(tx);
      await conn.confirmTransaction(sig, "confirmed");

      const sigstr = typeof sig === "string" ? sig : sig.signature;
      await updateHoldings(sigstr, tradeMode);
      setLbVersion((v) => v + 1);

      setStatus(
        `✅ ${tradeMode.toUpperCase()} successful! <a target="_blank" href="https://explorer.solana.com/tx/${sigstr}?cluster=devnet">View Transaction</a>`
      );
      // Pending overlay reconciled by SSE refresh
    } catch (err) {
      console.error("Transaction error:", err);
      setPendingCandle(null);
      setStatus("❌ Transaction failed: " + (err.message || String(err)));
    }
  }

  return (
    <main style={{ maxWidth: "900px", margin: "2rem auto", padding: "1rem" }}>
      <nav id="nav">
        <a href={`/home?wallet=${wallet}`}>🏠 Home</a>
      </nav>

      <div style={{ display: "flex", gap: "2rem" }}>
        <div style={{ flex: 2, minWidth: 0 }}>
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
                <span style={{ fontWeight: "bold", color: "green" }}>
                  {token.tripName || "Anonymous"}
                </span>{" "}
                {token.tripCode && (
                  <span style={{ color: "gray", fontFamily: "monospace" }}>!!{token.tripCode}</span>
                )}{" "}
                on {formatDate(token.createdAt)} No.{100000 + (token.id || 0)}
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

              {/* Progress */}
              <div style={{ margin: "0.5rem 0", fontSize: 13 }}>
                <div>
                  Progress by tokens: {progressTokensPct.toFixed(2)}% (SOL deposited ≈ {x0.toFixed(6)} /{" "}
                  {model?.X_MAX.toFixed(6) ?? "…"} ; sold ≈ {ySoldWhole.toLocaleString()} /{" "}
                  {CAP_TOKENS.toLocaleString()} tokens)
                </div>
                <div>
                  Raised so far: {totalRaisedSOL.toFixed(6)} SOL / target {targetSOL.toFixed(6)} SOL
                  {model && <> (remaining ~{remainingSOL.toFixed(6)} SOL)</>}
                </div>
              </div>

              {/* Trade */}
              <div id="trade-box" style={{ marginTop: "1rem" }}>
                <h3>Trade</h3>

                {/* Unit toggle */}
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <span className="chan-label">Units:</span>
                  <button
                    type="button"
                    className={`chan-toggle ${unitMode === "sol" ? "is-active" : ""}`}
                    aria-pressed={unitMode === "sol"}
                    onClick={() => setUnitMode("sol")}
                  >
                    [SOL]
                  </button>
                  <button
                    type="button"
                    className={`chan-toggle ${unitMode === "token" ? "is-active" : ""}`}
                    aria-pressed={unitMode === "token"}
                    onClick={() => setUnitMode("token")}
                  >
                    [Token]
                  </button>
                </div>
                {/* Trade mode toggle */}
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <span className="chan-label">Mode:</span>
                  <button
                    type="button"
                    className={`chan-toggle ${tradeMode === "buy" ? "is-active is-active--buy" : ""}`}
                    aria-pressed={tradeMode === "buy"}
                    onClick={() => setTradeMode("buy")}
                  >
                    [Buy]
                  </button>
                  <button
                    type="button"
                    className={`chan-toggle ${tradeMode === "sell" ? "is-active is-active--sell" : ""}`}
                    aria-pressed={tradeMode === "sell"}
                    onClick={() => setTradeMode("sell")}
                  >
                    [Sell]
                  </button>
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
                  ≈{" "}
                  {unitMode === "token"
                    ? `${(conversion || 0).toFixed(9)} SOL`
                    : `${(conversion || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} Tokens`}
                </div>

                {/* Submit */}
                <div>
                  <button type="button" onClick={handleSubmit} className="chan-link">[Submit]</button>
                </div>
              </div>
            </>
          ) : (
            <p>{status}</p>
          )}

          <p id="status" style={{ marginTop: "1rem" }} dangerouslySetInnerHTML={{ __html: status }} />

          {/* Price Chart */}
          <div style={{ marginTop: "2rem" }}>
            <h3 style={{ margin: 0 }}>
              Price (SOL per token) — {visBucketSec === 900 ? "15m" : visBucketSec === 3600 ? "1h" : "1d"} candles
            </h3>
           <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <span className="chan-label">Range:</span>
            {["3d","1w","1m"].map(key => (
              <span
                key={key}
                className={`chan-toggle ${rangeKey === key ? "is-active" : ""}`}
                onClick={() => setRangeKey(key)}
                title={key === "3d" ? "15m candles" : key === "1w" ? "1h candles" : "1d candles"}
                role="button"
                aria-pressed={rangeKey === key}
              >
                [{key.toUpperCase()}]
              </span>
            ))}
          </div>
            <PriceChart confirmed={confirmedCandles} pending={pendingCandle} bucketSec={visBucketSec} />
          </div>

          {/* Bonding Curve */}
          <div style={{ marginTop: "2rem" }}>
            <h3 style={{ margin: 0 }}>Bonding Curve — Tokens sold vs SOL deposited</h3>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
              Cumulative distribution from LUT (conservative, floor/ceil aware)
            </div>
            <BondingCurve model={model} x0={x0} ySoldWhole={ySoldWhole} />
          </div>

          <Comments mint={mint} wallet={wallet} />
        </div>

        <Leaderboard mint={mint} version={lbVersion} />
      </div>
    </main>
  );
}
