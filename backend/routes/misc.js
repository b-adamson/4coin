import express from "express";
import crypto from "crypto";
import { resyncAllMints, resyncMintFromChain } from "../lib/chain.js";
import { loadPrices } from "../lib/files.js";
import { getSolUsdCached, refreshSolUsd } from "../lib/quotes.js";

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

router.get("/price-history", (req, res) => {
  try {
    const { mint, limit } = req.query;
    if (!mint) return res.status(400).json({ error: "Mint required" });

    const prices = loadPrices();
    const allTicks = prices[mint] || [];
    const n = Math.max(1, Math.min(Number(limit) || 2000, 50000));
    const ticks = allTicks.slice(-n);

    const allDev = (prices.__dev && prices.__dev[mint]) ? prices.__dev[mint] : [];
    // Optionally trim dev trades roughly to the same window as ticks:
    let devTrades = allDev;
    if (ticks.length) {
      const firstTickTs = Number(ticks[0]?.t ?? ticks[0]?.tsSec ?? 0);
      if (Number.isFinite(firstTickTs) && firstTickTs > 0) {
        devTrades = allDev.filter(d => Number(d?.tsSec) >= firstTickTs - 2 * 3600); // small guard window
      }
    }

    res.json({ mint, ticks, devTrades });
  } catch (err) {
    console.error("GET /price-history error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

router.get("/sol-usd", async (req, res) => {
  try {
    const fresh = await refreshSolUsd();
    const { solUsd, at, src } = fresh;
    res.json({ price: solUsd, at, src });
  } catch (e) {
    const { solUsd, at, src } = getSolUsdCached();
    if (solUsd > 0) return res.json({ price: solUsd, at, src, stale: true });
      res.status(502).json({ price: 0, error: "quote unavailable" });
  }
});


export default router;
