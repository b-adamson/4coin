import express from "express";
import { loadCandles15m, getWorkingCandle, loadDevTrades } from "../lib/files.js";
import { getSolUsdCached, refreshSolUsd } from "../lib/quotes.js";
import pool from "../lib/db.js";
import { generateTripcode } from "../utils.js";

const router = express.Router();

router.get("/tripcode", (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: "Wallet required" });
  res.json({ tripCode: generateTripcode(wallet) });
});

// NEW: FE uses this to know if the choice is already locked for (mint, wallet)
router.get("/leaderboard-pref", async (req, res) => {
  try {
    const { mint, wallet } = req.query || {};
    if (!mint || !wallet) return res.status(400).json({ error: "mint & wallet required" });
    const { rows } = await pool.query(
      `select opted, display_name, trip, locked_at
         from leaderboard_prefs
        where mint=$1 and owner=$2`,
      [mint, wallet]
    );
    const r = rows[0];
    res.json({
      locked: !!r,
      opted: !!r?.opted,
      displayName: r?.display_name || "",
      trip: r?.trip || "", 
      lockedAt: r?.locked_at || null,
    });
  } catch (e) {
    console.error("GET /leaderboard-pref error:", e);
    res.status(500).json({ error: "failed" });
  }
});

router.get("/price-history", async (req, res) => {
  try {
    const { mint, limit } = req.query;
    if (!mint) return res.status(400).json({ error: "Mint required" });

    const base = await loadCandles15m(mint, { limit: Number(limit) || 5000 });
    const working = await getWorkingCandle(mint);
 
    // Merge working bucket into candles15m so aggregation has the “current” bar
    let candles15m = base;
    if (working) {
        const t15 = Math.floor(Number(working.t) / 900) * 900;
        const w = {
          t: t15,
        o_reserve_lamports: Number(working.o_reserve_lamports),
        h_reserve_lamports: Number(working.h_reserve_lamports),
        l_reserve_lamports: Number(working.l_reserve_lamports),
        c_reserve_lamports: Number(working.c_reserve_lamports),
        oPoolBase: working.oPoolBase,
        hPoolBase: working.hPoolBase,
        lPoolBase: working.lPoolBase,
        cPoolBase: working.cPoolBase,
        o_price: working.o_price,
        h_price: working.h_price,
        l_price: working.l_price,
        c_price: working.c_price,
      };
      const last = base[base.length - 1];
      if (!last || Math.floor(Number(last.t)) < w.t) {
        candles15m = [...base, w];
      } else if (Math.floor(Number(last.t)) === w.t) {
        candles15m = [...base.slice(0, -1), w];
      }
    }

    // devTrades window same as before
    let devTrades;
    if (candles15m.length) {
      const firstTs = Number(candles15m[0].t) || 0;
      const since = firstTs ? firstTs - 2 * 3600 : null;
      devTrades = await loadDevTrades(mint, { sinceTsSec: since });
    } else {
      devTrades = await loadDevTrades(mint);
    }

    res.json({ mint, candles15m, working, devTrades });
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
