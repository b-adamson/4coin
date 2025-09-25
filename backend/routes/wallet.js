import express from "express";
import { getSolUsdCached, refreshSolUsd } from "../lib/quotes.js";
import { getWalletStatsAgg, getWalletLedgerChrono } from "../lib/files.js";

const router = express.Router();

/** GET /wallet-stats?wallet=... */
router.get("/wallet-stats", async (req, res) => {
  try {
    const wallet = (req.query.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    const { lamports, firstTs, lastTs } = await getWalletStatsAgg(wallet);
    const sol = lamports / 1_000_000_000;

    let { solUsd } = getSolUsdCached();
    if (!solUsd || solUsd <= 0) {
      try { ({ solUsd } = await refreshSolUsd()); } catch {}
    }
    const usd = solUsd > 0 ? sol * solUsd : null;

    res.json({
      wallet,
      netSOL: sol,
      netUSD: usd,
      firstTs,
      lastTs,
      solUsd: solUsd || 0
    });
  } catch (e) {
    console.error("GET /wallet-stats error:", e);
    res.status(500).json({ error: "failed" });
  }
});

/** GET /wallet-timeseries?wallet=...&unit=SOL|USD */
router.get("/wallet-timeseries", async (req, res) => {
  try {
    const wallet = (req.query.wallet || "").trim();
    const unit   = (req.query.unit || "SOL").toUpperCase();
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    const rows = await getWalletLedgerChrono(wallet);

    const pts = [];
    let cumSOL = 0;
    const LAMPORTS_PER_SOL = 1_000_000_000;

    if (rows.length) {
      const firstTs = rows[0].ts.getTime();
      pts.push({ t: new Date(firstTs - 1).toISOString(), sol: 0 });
    }

    for (const r of rows) {
      cumSOL += Number(r.lamports || 0) / LAMPORTS_PER_SOL;
      pts.push({ t: r.ts.toISOString(), sol: cumSOL });
    }

    const { solUsd } = getSolUsdCached();
    const out = unit === "USD" && solUsd > 0
      ? pts.map(p => ({ t: p.t, v: p.sol * solUsd }))
      : pts.map(p => ({ t: p.t, v: p.sol }));

    const stableOut = out.length === 1
      ? [out[0], { t: new Date(new Date(out[0].t).getTime() + 1).toISOString(), v: out[0].v }]
      : out;

    res.json({ wallet, unit, points: stableOut, solUsd: solUsd || 0 });
  } catch (e) {
    console.error("GET /wallet-timeseries error:", e);
    res.status(500).json({ error: "failed" });
  }
});

export default router;
