// routes/misc.js
import express from "express";
import crypto from "crypto";
import { getLastPriceSample, loadDevTrades } from "../lib/files.js";
import { getSolUsdCached, refreshSolUsd } from "../lib/quotes.js";
import { resyncAllMints, resyncMintFromChain } from "../lib/chain.js";
import pool from "../db.js";

const router = express.Router();

function generateTripcode(wallet) {
  const salt = "SuperSecretSalt123!";
  return "!!" + crypto
    .createHash("sha256")
    .update(wallet + salt)
    .digest("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 6);
}

router.get("/tripcode", (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: "Wallet required" });
  res.json({ tripCode: generateTripcode(wallet) });
});

// router.post("/resync", express.json(), async (req, res) => {
//   try {
//     const { mint } = req.body || {};
//     if (mint) return res.json({ ok: true, ...(await resyncMintFromChain(mint)) });
//     return res.json({ ok: true, results: await resyncAllMints() });
//   } catch (err) {
//     console.error("Resync API error:", err);
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

router.get("/price-history", async (req, res) => {
  try {
    const { mint, limit } = req.query;
    if (!mint) return res.status(400).json({ error: "Mint required" });

    const n = Math.max(1, Math.min(Number(limit) || 2000, 50000));

    // Get the LAST n samples in ascending time (v1 returned asc)
    const { rows } = await pool.query(
      `
      select t_bucket as t,
             reserve_sol_lamports,
             pool_base_units::text as "poolBase"
      from (
        select *
        from price_samples
        where mint = $1
        order by t_bucket desc
        limit $2
      ) x
      order by t asc
      `,
      [mint, n]
    );

    const ticks = rows.map(r => ({
      t: Number(r.t),
      reserveSolLamports: Number(r.reserve_sol_lamports),
      poolBase: String(r.poolBase),
    }));

    // v1-style devTrades windowing
    let devTrades;
    if (ticks.length) {
      const firstTickTs = Number(ticks[0].t) || 0;
      const since = firstTickTs ? firstTickTs - 2 * 3600 : null;
      devTrades = await loadDevTrades(mint, { sinceTsSec: since });
    } else {
      devTrades = await loadDevTrades(mint);
    }

    res.json({ mint, ticks, devTrades });
  } catch (err) {
    console.error("GET /price-history error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

router.get("/sol-usd", async (_req, res) => {
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
