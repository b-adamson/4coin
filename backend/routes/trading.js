import express from "express";
import { buildBuyTxBase64 } from "../instructions/buy.js";
import { buildSellTxBase64 } from "../instructions/sell.js";
import {
  loadHoldings,
  recordDevTrade,
  getLastPriceSample,
  appendPriceSample,
  upsertLatestPrice,
  applyOptimisticLedgerDelta,
  getTokenByMint
} from "../lib/files.js";
import { broadcastHoldings } from "../lib/sse.js";

const router = express.Router();
const LAMPORTS_PER_SOL = 1_000_000_000;
const BUCKET_SEC = 900

router.post("/buy", async (req, res) => {
  try {
    const { walletAddress, mintPubkey, amount } = req.body;
    if (!walletAddress || !mintPubkey || !amount) {
      return res.status(400).json({ error: "Missing walletAddress, mintPubkey, or amount" });
    }
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
    if (!walletAddress || !mintPubkey || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const txBase64 = await buildSellTxBase64({ walletAddress, mintPubkey, amountLamports: amount });
    res.json({ txBase64 });
  } catch (err) {
    console.error("/sell error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Optimistic internal ledger update + dev-trade logging + SSE push.
 */
router.post("/update-holdings", async (req, res) => {
  try {
    const { mint, type, tokenAmountBase, solLamports, wallet } = req.body || {};
    if (!mint || !type || typeof tokenAmountBase !== "number" || typeof solLamports !== "number") {
      return res.status(400).json({ error: "Missing mint/type/tokenAmountBase/solLamports" });
    }

    // 1) Apply optimistic deltas to DB (atomic)
    const { reserveSolLamports, poolBase } = await applyOptimisticLedgerDelta({
      mint, type, tokenAmountBase, solLamports, wallet
    });

    const nowSec  = Math.floor(Date.now() / 1000);
    const tBucket = Math.floor(nowSec / BUCKET_SEC) * BUCKET_SEC;
    const solAbs  = Math.abs(Number(solLamports)) / LAMPORTS_PER_SOL; // always positive

    // 2) Live price row + sparse 15m sample
    try {
      await upsertLatestPrice(mint, {
        t: tBucket,
        reserveSolLamports: Number(reserveSolLamports),
        poolBase: String(poolBase || "0"),
      });

      const last = await getLastPriceSample(mint);
      const changed =
        !last ||
        Number(last.t) !== tBucket ||
        Number(last.reserveSolLamports) !== Number(reserveSolLamports) ||
        String(last.poolBase) !== String(poolBase || "0");

      if (changed) {
        await appendPriceSample(mint, {
          t: tBucket,
          reserveSolLamports: Number(reserveSolLamports),
          poolBase: String(poolBase || "0"),
        });
      }
    } catch (e) {
      console.error("price finalize (optimistic) failed (non-blocking):", e);
    }

    // 3) Record dev trade (history)
    try {
      await recordDevTrade({
        mint,
        tsSec: nowSec,
        side: type,         // "buy" | "sell"
        sol: solAbs,        // positive
        wallet: wallet || null,
        isDev: false,       // placeholder (we’ll compute real isDev below for SSE)
      });
    } catch (e) {
      console.error("recordDevTrade failed (non-blocking):", e);
    }

    // Determine isDev for the live SSE (v1 parity)
    let isDev = false;
    try {
      const tokenRow = await getTokenByMint(mint);
      const devWallet = (tokenRow?.creator || "").trim() || null;
      isDev = !!devWallet && wallet && wallet.trim() === devWallet;
    } catch {}

    // 4a) INTERNAL SSE — live dev delta (needed for your existing chart UI)
    broadcastHoldings({
      source: "internal",
      mint,
      t: nowSec,
      tBucket,
      wallet: wallet || null,
      side: type,          // "buy" | "sell"
      sol: solAbs,         // positive number
      isDev,
    });

    // 4b) CHAIN SSE — triggers leaderboard refetch (unchanged)
    broadcastHoldings({
      source: "chain",
      mint,
      t: nowSec,
      reserveSolLamports,
      poolBase: String(poolBase || "0"),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("update-holdings (internal) error:", err);
    res.status(500).json({ error: "Failed to apply internal holdings delta" });
  }
});

export default router;
