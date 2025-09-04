import express from "express";
import crypto from "crypto";
import { resyncAllMints, resyncMintFromChain } from "../lib/chain.js";

const router = express.Router();

function generateTripcode(wallet) {
  const salt = "SuperSecretSalt123!";
  return "!!" + crypto.createHash("sha256").update(wallet + salt).digest("base64")
    .replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);
}

router.get("/tripcode", (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: "Wallet required" });
  res.json({ tripCode: generateTripcode(wallet) });
});

router.post("/resync", async (req, res) => {
  try {
    const { mint } = req.body || {};
    if (mint) return res.json({ ok: true, ...(await resyncMintFromChain(mint)) });
    res.json({ ok: true, results: await resyncAllMints() });
  } catch (err) {
    console.error("Resync API error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
