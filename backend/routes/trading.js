// routes/trade.js
import express from "express";
import { buildBuyTxBase64 } from "../instructions/buy.js";
import { buildSellTxBase64 } from "../instructions/sell.js";
import { loadHoldings, loadPrices, savePrices, atomicWriteJSON } from "../lib/files.js";
import { holdingsFile } from "../config/index.js";
import { broadcastHoldings } from "../lib/sse.js";

const router = express.Router();
const LAMPORTS_PER_SOL = 1_000_000_000;

router.post("/buy", async (req, res) => {
  try {
    const { walletAddress, mintPubkey, amount } = req.body;
    if (!walletAddress || !mintPubkey || !amount) return res.status(400).json({ error: "Missing walletAddress, mintPubkey, or amount" });
    const txBase64 = await buildBuyTxBase64({ walletAddress, mintPubkey, amountLamports: amount });
    res.json({ txBase64 });
  } catch (err) {
    console.error("/buy error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/sell", async (req, res) => {
  try {
    const { walletAddress, mintPubkey, amount } = req.body;
    if (!walletAddress || !mintPubkey || !amount) return res.status(400).json({ error: "Missing required fields" });
    const txBase64 = await buildSellTxBase64({ walletAddress, mintPubkey, amountLamports: amount });
    res.json({ txBase64 });
  } catch (err) {
    console.error("/sell error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Optimistic internal ledger update + dev-trade logging + SSE push.
 * Body: { mint, type: "buy"|"sell", tokenAmountBase: number, solLamports: number, wallet?: string, sig?: string }
 */
router.post("/update-holdings", async (req, res) => {
  try {
    const { mint, type, tokenAmountBase, solLamports, wallet } = req.body || {};
    if (!mint || !type || typeof tokenAmountBase !== "number" || typeof solLamports !== "number") {
      return res.status(400).json({ error: "Missing mint/type/tokenAmountBase/solLamports" });
    }

    const holdings = loadHoldings();
    if (!holdings[mint]) {
      holdings[mint] = { dev: null, bondingCurve: { reserveSol: 0 }, holders: {} };
    }

    const row = holdings[mint];
    const poolBasePrev = BigInt(row.holders?.BONDING_CURVE ?? "0");
    const reserveSolPrev = Number(row.bondingCurve?.reserveSol || 0);

    const deltaTokens = BigInt(tokenAmountBase);
    const deltaLamports = Number(solLamports);

    let poolBaseNext = poolBasePrev;
    let reserveSolNext = reserveSolPrev;

    if (type === "buy") {
      // buying from pool -> pool tokens down, SOL up
      poolBaseNext = poolBasePrev - deltaTokens;
      reserveSolNext = reserveSolPrev + deltaLamports;
    } else if (type === "sell") {
      // selling to pool -> pool tokens up, SOL down
      poolBaseNext = poolBasePrev + deltaTokens;
      reserveSolNext = Math.max(0, reserveSolPrev - deltaLamports);
    } else {
      return res.status(400).json({ error: "Invalid type" });
    }

    row.holders = row.holders || {};
    row.holders.BONDING_CURVE = poolBaseNext.toString();
    row.bondingCurve = { reserveSol: reserveSolNext };

    atomicWriteJSON(holdingsFile, holdings);

    // ---- Persist a dev-trade event for history (prices.__dev[mint])
    const prices = loadPrices();
    if (!prices.__dev) prices.__dev = {};
    if (!prices.__dev[mint]) prices.__dev[mint] = [];

    const nowSec = Math.floor(Date.now() / 1000);
    const devWallet = (holdings[mint]?.dev || "").trim() || null;
    const isDev = !!devWallet && wallet && wallet.trim() === devWallet;

    const solAbs = Math.abs(deltaLamports) / LAMPORTS_PER_SOL; // record as positive
    prices.__dev[mint].push({
      tsSec: nowSec,
      side: type,           // "buy" | "sell"
      sol: solAbs,
      wallet: wallet || null,
      isDev,
    });

    // keep it bounded
    const MAX_DEV = 5000;
    if (prices.__dev[mint].length > MAX_DEV) {
      prices.__dev[mint].splice(0, prices.__dev[mint].length - MAX_DEV);
    }
    savePrices(prices);

    // ---- Broadcast live state + dev metadata (used by chart to draw "D" immediately)
    broadcastHoldings({
      source: "internal",
      mint,
      t: nowSec,
      reserveSolLamports: holdings[mint].bondingCurve.reserveSol,
      poolBase: String(holdings[mint].holders["BONDING_CURVE"] || "0"),
      wallet: wallet || null,
      side: type,           // "buy" | "sell"
      sol: solAbs,          // positive
      isDev,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("update-holdings (internal) error:", err);
    res.status(500).json({ error: "Failed to apply internal holdings delta" });
  }
});

export default router;
