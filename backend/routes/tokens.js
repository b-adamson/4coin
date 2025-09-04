import express from "express";
import fs from "fs";
import { loadTokens, loadHoldings } from "../lib/files.js";
import { tokensFile, TOKEN_DECIMALS } from "../config/index.js";
import { buildPrepareMintAndPoolTxBase64 } from "../instructions/prepareMintAndPool.js";

const router = express.Router();

router.post("/prepare-mint-and-pool", async (req, res) => {
  try {
    const body = req.body || {};
    const out = await buildPrepareMintAndPoolTxBase64(body);
    res.json(out);
  } catch (err) {
    console.error("🔥 /prepare-mint-and-pool error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/save-token", (req, res) => {
  const { mint, pool, poolTokenAccount, name, symbol, metadataUri, sig, creator, tripName, tripCode } = req.body;
  if (!mint || !pool || !poolTokenAccount || !name || !symbol || !metadataUri || !sig || !creator) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const finalTripCode = (typeof tripCode === "string" && tripCode.trim().length > 0) ? tripCode.trim() : null;

  const tokens = loadTokens();
  if (tokens.find(t => t.mint === mint)) return res.json({ message: "Token already saved" });

  tokens.push({
    mint, pool, poolTokenAccount, name, symbol, metadataUri, tx: sig,
    creator, tripName: tripName || "Anonymous", tripCode: finalTripCode,
    createdAt: new Date().toISOString(),
    decimals: TOKEN_DECIMALS,
  });

  fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
  res.json({ message: "Token saved successfully!", tripName: tripName || "Anonymous", tripCode: finalTripCode });
});

router.get("/tokens", (req, res) => {
  const tokens = loadTokens();
  res.json(tokens.map((t, i) => ({ ...t, index: i })));
});

router.get("/tokens-by-creator", (req, res) => {
  const { creator } = req.query;
  const tokens = loadTokens();
  const myTokens = tokens.filter(t => t.creator === creator).map(t => ({ ...t, index: tokens.findIndex(x => x.mint === t.mint) }));
  res.json(myTokens);
});

router.get("/token-info", (req, res) => {
  const { mint } = req.query;
  const tokens = loadTokens();
  const token = tokens.find(t => t.mint === mint);
  if (!token) return res.status(404).json({ error: "Token not found" });
  const index = tokens.findIndex(t => t.mint === mint);
  const reserveSol = (loadHoldings()[mint]?.bondingCurve?.reserveSol) || 0;
  res.json({ ...token, index, bondingCurve: { reserveSol } });
});

export default router;
