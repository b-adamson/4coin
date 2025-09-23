// routes/tokens.js
import express from "express";
import { TOKEN_DECIMALS } from "../config/index.js";
import {
  loadTokens,
  createToken,
  getTokensByCreator,
  getTokenByMint,
  getReserveSolForMint,
} from "../lib/files.js";
import { buildPrepareMintAndPoolTxBase64 } from "../instructions/prepareMintAndPool.js";

const router = express.Router();

/* ---------------------------
   Routes
---------------------------- */

// Generate the Solana transaction for mint+pool setup
router.post("/prepare-mint-and-pool", async (req, res) => {
  try {
    const out = await buildPrepareMintAndPoolTxBase64(req.body || {});
    res.json(out);
  } catch (err) {
    console.error("🔥 /prepare-mint-and-pool error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Save a new token into the DB
router.post("/save-token", async (req, res) => {
  try {
    const {
      mint,
      pool,
      poolTokenAccount,
      name,
      symbol,
      metadataUri,
      sig,
      creator,
      tripName,
      tripCode,
    } = req.body || {};

    if (
      !mint ||
      !pool ||
      !poolTokenAccount ||
      !name ||
      !symbol ||
      !metadataUri ||
      !sig ||
      !creator
    ) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const token = await createToken({
      mint,
      pool,
      poolTokenAccount,
      name,
      symbol,
      metadataUri,
      sig,
      creator,
      tripName: tripName || "Anonymous",
      tripCode: tripCode?.trim() || null,
      decimals: TOKEN_DECIMALS,
    });

    if (!token) {
      return res.json({ message: "Token already saved" });
    }

    res.json({
      message: "Token saved successfully!",
      id: token.id,
      tripName: tripName || "Anonymous",
      tripCode: tripCode?.trim() || null,
    });
  } catch (err) {
    console.error("🔥 /save-token error:", err);
    res.status(500).json({ error: "Failed to save token" });
  }
});

// List all tokens
router.get("/tokens", async (req, res) => {
  try {
    const tokens = await loadTokens();
    res.json(tokens);
  } catch (err) {
    res.status(500).json({ error: "Failed to load tokens" });
  }
});

// Tokens by creator
router.get("/tokens-by-creator", async (req, res) => {
  try {
    const { creator } = req.query;
    const tokens = await getTokensByCreator(creator);
    res.json(tokens);
  } catch (err) {
    res.status(500).json({ error: "Failed to load tokens" });
  }
});

// Detailed token info (includes reserve SOL)
router.get("/token-info", async (req, res) => {
  try {
    const { mint } = req.query;
    const token = await getTokenByMint(mint);
    if (!token) return res.status(404).json({ error: "Token not found" });

    const reserveSol = await getReserveSolForMint(mint);
    res.json({ ...token, bondingCurve: { reserveSol } });
  } catch (err) {
    res.status(500).json({ error: "Failed to load token info" });
  }
});

export default router;
