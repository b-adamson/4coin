import express from "express";
import { connection, PROGRAM_ID } from "../config/index.js";
import { buildBuyTxBase64 } from "../instructions/buy.js";
import { buildSellTxBase64 } from "../instructions/sell.js";
import { resyncMintFromChain } from "../lib/chain.js";
import { PublicKey } from "@solana/web3.js";

import { loadHoldings } from "../lib/files.js";
import { atomicWriteJSON } from "../lib/files.js";
import { holdingsFile } from "../config/index.js";
import { broadcastHoldings } from "../lib/sse.js";

const router = express.Router();

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

router.post("/update-holdings", async (req, res) => {
  // Accepts optimistic deltas and updates internal ledger immediately.
  // Body: { mint, type: "buy" | "sell", tokenAmountBase, solLamports }
  try {
    const { mint, type, tokenAmountBase, solLamports } = req.body || {};
    if (!mint || !type || typeof tokenAmountBase !== "number" || typeof solLamports !== "number") {
      return res.status(400).json({ error: "Missing mint/type/tokenAmountBase/solLamports" });
    }

    const holdings = loadHoldings();
    if (!holdings[mint]) {
      // Initialize minimal structure if missing
      holdings[mint] = { dev: null, bondingCurve: { reserveSol: 0 }, holders: {} };
    }

    const row = holdings[mint];
    const poolBasePrev = BigInt(row.holders?.BONDING_CURVE ?? "0");
    let reserveSol = Number(row.bondingCurve?.reserveSol || 0);

    const deltaTokens = BigInt(tokenAmountBase);
    const deltaSol = Number(solLamports);

    let poolBaseNext = poolBasePrev;
    let reserveSolNext = reserveSol;

    if (type === "buy") {
      // user buys from pool -> pool tokens down, vault SOL up
      poolBaseNext = poolBasePrev - deltaTokens;
      reserveSolNext = reserveSol + deltaSol;
    } else if (type === "sell") {
      // user sells to pool -> pool tokens up, vault SOL down
      poolBaseNext = poolBasePrev + deltaTokens;
      reserveSolNext = Math.max(0, reserveSol - deltaSol);
    } else {
      return res.status(400).json({ error: "Invalid type" });
    }

    row.holders = row.holders || {};
    row.holders.BONDING_CURVE = poolBaseNext.toString();
    row.bondingCurve = { reserveSol: reserveSolNext };

    atomicWriteJSON(holdingsFile, holdings);

    // Broadcast INTERNAL move (used by frontend to draw the pending candle)
    // source: internal (live internal ledger)
    broadcastHoldings({
      mint,
      source: "internal",
      reserveSolLamports: holdings[mint].bondingCurve.reserveSol,   // number
      poolBase: String(holdings[mint].holders["BONDING_CURVE"] || "0"),
    });


    res.json({ ok: true });
  } catch (err) {
    console.error("update-holdings (internal) error:", err);
    res.status(500).json({ error: "Failed to apply internal holdings delta" });
  }
});

export default router;
