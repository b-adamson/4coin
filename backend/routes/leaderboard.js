import express from "express";
import { loadHoldings, loadTokens } from "../lib/files.js";

const router = express.Router();

router.get("/leaderboard", (req, res) => {
  try {
    const { mint } = req.query;
    if (!mint) return res.status(400).json({ error: "Mint required" });

    const holdings = loadHoldings();
    const tokens = loadTokens();

    const tokenInfo = tokens.find(t => t.mint === mint);
    if (!tokenInfo) return res.status(404).json({ error: "Token not found" });
    if (!holdings[mint]) return res.json({ leaderboard: [], meta: {} });

    const decimals = Number(tokenInfo.decimals ?? 9);
    const SCALE = 10n ** BigInt(decimals);
    const CAP_WHOLE = 800_000_000n;
    const CAP_BASE = CAP_WHOLE * SCALE;

    const row = holdings[mint];
    const { dev, holders = {} } = row;

    const poolBase = BigInt(holders["BONDING_CURVE"] ?? 0);
    const lockedBase = BigInt(holders["TREASURY_LOCKED"] ?? 0);

    const circulatingEntries = Object.entries(holders).filter(([addr]) =>
      addr !== "BONDING_CURVE" && addr !== "TREASURY_LOCKED"
    );

    let circulatingBase = 0n;
    for (const [, v] of circulatingEntries) circulatingBase += BigInt(v ?? 0);

    const pct2 = (num, den) => (den === 0n ? 0 : Number((num * 10000n) / den) / 100);
    const toWhole = (base) => Number(base / SCALE);

    const bondingRow = {
      address: "BONDING_CURVE",
      displayName: "Bonding Curve",
      isBonding: true,
      isDev: false,
      balanceBase: poolBase.toString(),
      balanceWhole: toWhole(poolBase),
      percent: pct2(poolBase, CAP_BASE),
      percentKind: "of_cap",
    };

    const holderRows = circulatingEntries
      .map(([wallet, v]) => {
        const b = BigInt(v ?? 0);
        const isDeveloper = wallet === dev;
        return {
          address: wallet,
          displayName: isDeveloper ? "Anonymous" : wallet,
          isBonding: false,
          isDev: isDeveloper,
          balanceBase: b.toString(),
          balanceWhole: toWhole(b),
          percent: pct2(b, circulatingBase),
          percentKind: "of_circulating",
        };
      })
      .sort((a, b) => (BigInt(b.balanceBase) > BigInt(a.balanceBase) ? 1 : -1));

    const leaderboard = [bondingRow, ...holderRows];
    res.json({
      mint,
      decimals,
      leaderboard,
      meta: {
        circulatingBase: circulatingBase.toString(),
        capBase: CAP_BASE.toString(),
        poolBase: poolBase.toString(),
        lockedBase: lockedBase.toString(),
        devWallet: dev,
      },
    });
  } catch (err) {
    console.error("GET /leaderboard error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

export default router;
