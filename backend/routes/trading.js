import express from "express";
import { connection, PROGRAM_ID } from "../config/index.js";
import { buildBuyTxBase64 } from "../instructions/buy.js";
import { buildSellTxBase64 } from "../instructions/sell.js";
import { resyncMintFromChain } from "../lib/chain.js";
import { PublicKey } from "@solana/web3.js";

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
  const { sig, mint } = req.body;
  if (!sig || !mint) return res.status(400).json({ error: "Missing sig or mint" });

  try {
    const statusRes = await connection.getSignatureStatuses([sig]);
    const st = statusRes.value[0];
    if (!st || st.err) return res.status(400).json({ error: "Transaction not confirmed" });

    const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    const hasOurProgram = tx?.transaction?.message?.compiledInstructions?.some(ix => {
      const pid = tx.transaction.message.staticAccountKeys[ix.programIdIndex];
      return pid?.toBase58() === PROGRAM_ID.toBase58();
    });
    if (!hasOurProgram) return res.status(400).json({ error: "Tx not from our program" });

    const out = await resyncMintFromChain(mint);
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error("update-holdings error:", err);
    res.status(500).json({ error: "Failed to update holdings" });
  }
});

export default router;
