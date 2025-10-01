// backend/routes/updateHoldings.js
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
  loadTradesForMint,
  getWorkingCandle,
} from "../lib/files.js";
import {
  broadcastHoldings,
  broadcastCandleWorking,
  broadcastCandleFinalized,
} from "../lib/sse.js";
import { generateTripcodeRaw } from "../utils.js";

const router = express.Router();

router.post("/buy", async (req, res) => {
  try {
    const { walletAddress, mintPubkey, amount } = req.body;
    if (!walletAddress || !mintPubkey || !amount) {
      return res
        .status(400)
        .json({ error: "Missing walletAddress, mintPubkey, or amount" });
    }
    const txBase64 = await buildBuyTxBase64({
      walletAddress,
      mintPubkey,
      amountLamports: amount,
    });
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
    const txBase64 = await buildSellTxBase64({
      walletAddress,
      mintPubkey,
      amountLamports: amount,
    });
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
// routes/update-holdings.js
router.post("/update-holdings", async (req, res) => {
  try {
    const {
      mint,
      type,                // "buy" | "sell"
      tokenAmountBase,     // number
      solLamports,         // number
      wallet,
      lbOptIn = false,
      lbDisplayName = "",
    } = req.body || {};

    if (!mint || !type || typeof tokenAmountBase !== "number" || typeof solLamports !== "number") {
      return res.status(400).json({ error: "Missing mint/type/tokenAmountBase/solLamports" });
    }

    // Apply optimistic deltas (updates mint_state + holders atomically)
    const {
      reserveSolLamports,
      poolBase,
      preReserveSolLamports,
      prePoolBase,
    } = await applyOptimisticLedgerDelta({ mint, type, tokenAmountBase, solLamports, wallet });

    // Leaderboard prefs (non-blocking)
    const owner = (wallet || "").trim();
    const opted = !!lbOptIn;
    const name  = opted ? String(lbDisplayName || "").slice(0, 32) : "Anonymous";
    const trip  = opted && owner ? generateTripcodeRaw(owner) : null;
    if (owner) {
      upsertLeaderboardPref({ mint, owner, opted, displayName: opted ? name : null, trip })
        .catch(e => console.error("leaderboard_prefs insert failed (non-blocking):", e));
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const FIFTEEN_MIN = 900;
    const tBucket = Math.floor(nowSec / FIFTEEN_MIN) * FIFTEEN_MIN;

    // Wallet ledger (signed) - non-blocking
    const solSigned   = type === "buy" ? -Number(solLamports)     :  Number(solLamports);
    const tokenSigned = type === "buy" ?  Number(tokenAmountBase) : -Number(tokenAmountBase);
    insertWalletLedger({
      tsSec: nowSec, wallet: wallet || "", mint, side: type,
      solLamportsSigned: solSigned, tokenBaseSigned: tokenSigned,
      txSig: null, source: "internal",
    }).catch(e => console.error("wallet_ledger insert failed (non-blocking):", e));

    // Dev flag (for broadcasts + dev-trade log)
    let isDevFlag = false;
    try {
      const tokenRow = await getTokenByMint(mint);
      const devWallet = (tokenRow?.creator || "").trim() || null;
      isDevFlag = !!devWallet && !!wallet && wallet.trim() === devWallet;
    } catch {}

    // Finalize previous bucket if we rolled, then merge working with CURRENT reserve/pool
    try {
      const finalized = await finalizeWorkingCandleIfNeeded(mint, nowSec);
      if (finalized) broadcastCandleFinalized(mint, finalized);

      // If there was no working row for this bucket, seed OPEN from the pre-state
      let hadWorking = false;
      try {
        const existing = await getWorkingCandle(mint);
        hadWorking = !!existing && Number(existing.t) === tBucket;
      } catch {}

      if (!hadWorking) {
        await upsertWorkingCandle(mint, {
          tSec: tBucket,
          reserveSolLamports: Number(preReserveSolLamports),
          poolBase: String(prePoolBase || "0"),
        });
      }

      // Now merge the *post* state — SQL will widen H/L and set CLOSE
      const workingRow = await upsertWorkingCandle(mint, {
        tSec: tBucket,
        reserveSolLamports: Number(reserveSolLamports),
        poolBase: String(poolBase || "0"),
      });

      if (workingRow) {
        // 1) live candle (for charts)
        broadcastCandleWorking(mint, workingRow);

        // 2) one holdings event mirroring the working CLOSE
        const cRes  = Number(workingRow.c_reserve_lamports ?? 0);
        const cBase = String(workingRow.cPoolBase ?? workingRow.c_pool_base ?? "0");
        broadcastHoldings({
          source: "internal",
          mint,
          t: nowSec,
          tBucket,
          side: type,
          sol: Math.abs(Number(solLamports)) / 1_000_000_000,
          isDev: isDevFlag,
          opted, trip, displayName: name,
          wallet: name !== "Anonymous" ? owner : undefined,
          reserveSolLamports: cRes,
          poolBase: cBase,
          liveCandle: { tBucket, reserve: cRes, poolBase: cBase },
        });
      }
    } catch (e) {
      console.error("working-candle update/finalize failed (non-blocking):", e);
    }

    // Dev trade record (non-blocking)
    const solAbs = Math.abs(Number(solLamports)) / 1_000_000_000;
    recordDevTrade({ mint, tsSec: nowSec, side: type, sol: solAbs, wallet: wallet || null, isDev: isDevFlag })
      .catch(e => console.error("recordDevTrade failed (non-blocking):", e));

    res.json({ ok: true });
  } catch (err) {
    console.error("update-holdings (internal) error:", err);
    res.status(500).json({ error: "Failed to apply internal holdings delta" });
  }
});

router.get("/trades", async (req, res) => {
  try {
    const mint = (req.query.mint || "").trim();
    if (!mint) return res.status(400).json({ error: "mint required" });

    const trades = await loadTradesForMint(mint);
    res.json({ trades });
  } catch (e) {
    console.error("GET /trades error:", e);
    res.status(500).json({ error: "failed" });
  }
});

export default router;
