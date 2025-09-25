import express from "express";
import { buildBuyTxBase64 } from "../instructions/buy.js";
import { buildSellTxBase64 } from "../instructions/sell.js";
import {
  recordDevTrade,
  applyOptimisticLedgerDelta,
  getTokenByMint,
  upsertWorkingCandle,
  finalizeWorkingCandleIfNeeded,
  upsertLeaderboardPref,   
  insertWalletLedger,  
} from "../lib/files.js";
import { broadcastHoldings, broadcastCandleWorking, broadcastCandleFinalized } from "../lib/sse.js";
import { generateTripcodeRaw } from "../utils.js";

const router = express.Router();

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
 * Also updates the in-progress 15m working candle and finalizes the previous one on rollover.
 */
router.post("/update-holdings", async (req, res) => {
  try {
    const { mint, type, tokenAmountBase, solLamports, wallet, lbOptIn = false, lbDisplayName = "", priceSOLPerToken = null } = req.body || {};
    if (!mint || !type || typeof tokenAmountBase !== "number" || typeof solLamports !== "number") {
      return res.status(400).json({ error: "Missing mint/type/tokenAmountBase/solLamports" });
    }

    // 1) Apply optimistic deltas to DB (atomic)
    const { reserveSolLamports, poolBase } = await applyOptimisticLedgerDelta({
      mint, type, tokenAmountBase, solLamports, wallet
    });

    // 1b) ONE-TIME lock leaderboard preference (first trade only) via files.js
    if (wallet && wallet.trim()) {
      const owner = wallet.trim();
      const opted = !!lbOptIn;
      const name  = opted ? String(lbDisplayName || "").slice(0, 32) : null;
      const trip  = opted ? generateTripcodeRaw(owner) : null;
      try {
        await upsertLeaderboardPref({ mint, owner, opted, displayName: name, trip });
      } catch (e) {
        console.error("leaderboard_prefs insert failed (non-blocking):", e);
      }
    }

    const nowSec  = Math.floor(Date.now() / 1000);
    const FIFTEEN_MIN = 900;
    const tBucket = Math.floor(nowSec / FIFTEEN_MIN) * FIFTEEN_MIN;
    const LAMPORTS_PER_SOL = 1_000_000_000;
    const solAbs  = Math.abs(Number(solLamports)) / LAMPORTS_PER_SOL;

    // Signed deltas from the wallet's perspective
    const solSigned   = type === "buy"  ? -Number(solLamports) :  Number(solLamports);
    const tokenSigned = type === "buy"  ?  Number(tokenAmountBase) : -Number(tokenAmountBase);

    // 1c) Write wallet_ledger via files.js
    try {
      await insertWalletLedger({
        tsSec: nowSec,
        wallet: wallet || "",
        mint,
        side: type,
        solLamportsSigned: solSigned,
        tokenBaseSigned: tokenSigned,
        txSig: null,
        source: "internal",
      });
    } catch (e) {
      console.error("wallet_ledger insert failed (non-blocking):", e);
    }

    // Dev flag once
    let isDevFlag = false;
    try {
      const tokenRow = await getTokenByMint(mint);
      const devWallet = (tokenRow?.creator || "").trim() || null;
      isDevFlag = !!devWallet && !!wallet && wallet.trim() === devWallet;
    } catch {}

    // 2) Finalize previous bucket if we rolled; then upsert current working
    try {
      const finalized = await finalizeWorkingCandleIfNeeded(mint, nowSec, { finalizeFlat: false });
      const finalizedRow = Array.isArray(finalized) ? finalized[0] : finalized;
      if (finalizedRow) broadcastCandleFinalized(mint, finalizedRow);

      const workingRow = await upsertWorkingCandle(mint, {
        tSec: tBucket,
        reserveSolLamports: Number(reserveSolLamports),
        poolBase: String(poolBase || "0"),
        cPrice: (typeof priceSOLPerToken === "number" && isFinite(priceSOLPerToken)) ? priceSOLPerToken : null,
      });
      if (workingRow) broadcastCandleWorking(mint, workingRow);
    } catch (e) {
      console.error("working-candle update/finalize failed (non-blocking):", e);
    }

    // 3) Record dev trade (best-effort)
    try {
      await recordDevTrade({
        mint,
        tsSec: nowSec,
        side: type,
        sol: solAbs,
        wallet: wallet || null,
        isDev: isDevFlag,
      });
    } catch (e) {
      console.error("recordDevTrade failed (non-blocking):", e);
    }

    // 4) Holdings / chain snapshots (unchanged)
    broadcastHoldings({
      source: "internal",
      mint,
      t: nowSec,
      tBucket,
      wallet: wallet || null,
      side: type,
      sol: solAbs,
      isDev: isDevFlag,
    });

    broadcastHoldings({
      source: "chain",
      mint,
      t: nowSec,
      reserveSolLamports: Number(reserveSolLamports),
      poolBase: String(poolBase || "0"),
      liveCandle: {
        tBucket,
        reserve: Number(reserveSolLamports),
        poolBase: String(poolBase || "0"),
      },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("update-holdings (internal) error:", err);
    res.status(500).json({ error: "Failed to apply internal holdings delta" });
  }
});

export default router;
