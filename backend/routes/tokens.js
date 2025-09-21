import express from "express";
import fs from "fs";
import { loadTokens, loadHoldings } from "../lib/files.js";
import { tokensFile, TOKEN_DECIMALS } from "../config/index.js";
import { buildPrepareMintAndPoolTxBase64 } from "../instructions/prepareMintAndPool.js";
import { verifyTurnstile } from "../lib/verifyTurnstile.js"; // <-- add this

const router = express.Router();

/* ---------------------------
   Helpers for stable token IDs
---------------------------- */
function ensureTokenIds(tokens) {
  let max = 0;
  let changed = false;

  for (const t of tokens) {
    const v = Number(t.id || 0);
    if (Number.isFinite(v) && v > max) max = v;
  }

  for (const t of tokens) {
    if (t.id == null) {
      max += 1;
      t.id = max;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
  }
  return tokens;
}

function nextTokenId(tokens) {
  let max = 0;
  for (const t of tokens) {
    const v = Number(t.id || 0);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max + 1;
}

/* ---------------------------
   Routes
---------------------------- */

// Protect this route with captcha
router.post(
  "/prepare-mint-and-pool",
  express.json(),     // ensure req.body is parsed (remove if done globally)
  verifyTurnstile,    // checks req.body.cfToken
  async (req, res) => {
    try {
      const out = await buildPrepareMintAndPoolTxBase64(req.body || {});
      res.json(out);
    } catch (err) {
      console.error("🔥 /prepare-mint-and-pool error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

router.post("/save-token", (req, res) => {
  const { mint, pool, poolTokenAccount, name, symbol, metadataUri, sig, creator, tripName, tripCode } = req.body || {};
  if (!mint || !pool || !poolTokenAccount || !name || !symbol || !metadataUri || !sig || !creator) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const finalTripCode = (typeof tripCode === "string" && tripCode.trim().length > 0) ? tripCode.trim() : null;

  const tokens = ensureTokenIds(loadTokens());

  if (tokens.find(t => t.mint === mint)) {
    return res.json({ message: "Token already saved" });
  }

  const id = nextTokenId(tokens);

  tokens.push({
    id,
    mint,
    pool,
    poolTokenAccount,
    name,
    symbol,
    metadataUri,
    tx: sig,
    creator,
    tripName: tripName || "Anonymous",
    tripCode: finalTripCode,
    createdAt: new Date().toISOString(),
    decimals: TOKEN_DECIMALS,
  });

  fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
  res.json({ message: "Token saved successfully!", id, tripName: tripName || "Anonymous", tripCode: finalTripCode });
});

router.get("/tokens", (req, res) => {
  const tokens = ensureTokenIds(loadTokens());
  res.json(tokens);
});

router.get("/tokens-by-creator", (req, res) => {
  const { creator } = req.query;
  const tokens = ensureTokenIds(loadTokens());
  const myTokens = tokens.filter(t => t.creator === creator);
  res.json(myTokens);
});

router.get("/token-info", (req, res) => {
  const { mint } = req.query;
  const tokens = ensureTokenIds(loadTokens());
  const token = tokens.find(t => t.mint === mint);
  if (!token) return res.status(404).json({ error: "Token not found" });

  const reserveSol = (loadHoldings()[mint]?.bondingCurve?.reserveSol) || 0;
  res.json({ ...token, bondingCurve: { reserveSol } });
});

export default router;
