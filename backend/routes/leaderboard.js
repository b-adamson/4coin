import express from "express";
import { loadHoldings, loadTokens } from "../lib/files.js";
import { connection } from "../config/index.js";
import { PublicKey } from "@solana/web3.js";
import pool from "../lib/db.js";

const router = express.Router();

const TOTAL_SUPPLY_WHOLE = 1_000_000_000n;
const CURVE_CAP_WHOLE    = 800_000_000n;

router.get("/leaderboard", async (req, res) => {
  try {
    const { mint } = req.query;
    if (!mint) return res.status(400).json({ error: "Mint required" });

    const holdings = await loadHoldings();
    const tokens   = await loadTokens();

    const tokenInfo = tokens.find(t => t.mint === mint);
    if (!tokenInfo) return res.status(404).json({ error: "Token not found" });

    if (!holdings[mint]) {
      return res.json({
        mint,
        decimals: Number(tokenInfo.decimals ?? 9),
        leaderboard: [],
        meta: {}
      });
    }

    const MIG_AUTH = (process.env.MIGRATION_AUTHORITY_PUBLIC_KEY || "").trim() || null;

    const decimals = Number(tokenInfo.decimals ?? 9);
    const SCALE    = 10n ** BigInt(decimals);

    const CAP_BASE   = CURVE_CAP_WHOLE    * SCALE;
    const TOTAL_BASE = TOTAL_SUPPLY_WHOLE * SCALE;

    const row = holdings[mint];
    const { dev, holders = {} } = row;

    const poolBaseRaw = BigInt(holders["BONDING_CURVE"] ?? 0);
    const lockedBase  = BigInt(holders["TREASURY_LOCKED"] ?? 0);

    const allEntries = Object.entries(holders);

    const pct2    = (num, den) => (den === 0n ? 0 : Number((num * 10000n) / den) / 100);
    const toWhole = (base) => Number(base / SCALE);

    // ----- Build circulating rows (exclude labels)
    const circulatingEntries = allEntries.filter(([addr]) =>
      addr !== "BONDING_CURVE" && addr !== "TREASURY_LOCKED"
    );

    let circulatingBase = 0n;
    for (const [, v] of circulatingEntries) circulatingBase += BigInt(v ?? 0);

    // Derive pool balance defensively for PRE mode:
    // If the BONDING_CURVE key is missing (fresh mint), fall back to CAP - circulating.
    // Clamp at 0 to avoid negative flashes when the first buy arrives before seeding.
    const poolBaseDerived = CAP_BASE - circulatingBase >= 0n ? (CAP_BASE - circulatingBase) : 0n;
    const poolBaseEff     = poolBaseRaw > 0n ? poolBaseRaw : poolBaseDerived;

    // ----- PRE-MIG bonding row (unchanged in payload for compatibility)
    const bondingRowPre = {
      address: "BONDING_CURVE",
      displayName: "Bonding Curve",
      isBonding: true,
      isDev: false,
      balanceBase: poolBaseEff.toString(),
      balanceWhole: toWhole(poolBaseEff),
      percent: pct2(poolBaseEff, CAP_BASE),
      percentKind: "of_cap",
    };

    // ----- Holder rows (circulating holders only)
    const { rows: prefRows } = await pool.query(
      `select owner, opted, display_name, trip from leaderboard_prefs where mint=$1`,
      [mint]
    );
    const prefMap = new Map(prefRows.map(r => [String(r.owner), r]));

    let holderRows = circulatingEntries
      .map(([ownerKey, v]) => {
        const b = BigInt(v ?? 0);
        const isDeveloper = ownerKey === dev;

        const pref   = prefMap.get(ownerKey) || null;
        const opted  = !!pref?.opted;
        const effectiveOpted = opted || isDeveloper;

        const displayName = effectiveOpted
          ? (pref?.display_name || (isDeveloper ? "Developer" : "Anonymous"))
          : "Anonymous";

        const trip = effectiveOpted ? (pref?.trip || "") : "";

        return {
          // hide wallet when anonymous (null), expose when opted/dev
          address: effectiveOpted ? ownerKey : null,
          displayName,
          trip,
          isBonding: false,
          isDev: isDeveloper,
          balanceBase: b.toString(),
          balanceWhole: toWhole(b),
          percent: pct2(b, circulatingBase),
          percentKind: "of_circulating",
        };
      })
      .sort((a, b) => (BigInt(b.balanceBase) > BigInt(a.balanceBase) ? 1 : -1));

    // Always drop the migration authority from the list
    if (MIG_AUTH) {
      holderRows = holderRows.filter(r => (r.address || "").trim() !== MIG_AUTH);
    }

    // ----- STRICT POST-MIG SWITCH
    const raydiumPool       = (tokenInfo.raydiumPool || "").trim() || null;
    const raydiumBaseVault  = (tokenInfo.raydiumBaseVault || "").trim() || null;   // token account
    let   raydiumVaultOwner = (tokenInfo.raydiumVaultOwner || "").trim() || null;  // OWNER/authority

    const postMode = !!(raydiumPool || raydiumBaseVault || raydiumVaultOwner);

    if (!postMode) {
      // PRE MODE
      const curveAddress =
        (tokenInfo.curveAddress || tokenInfo.curvePda || tokenInfo.curveReserveVault || "").trim()
        || "BONDING_CURVE";

      const bondingHeader = {
        address: curveAddress,
        displayName: "Bonding Curve",
        balanceBase: poolBaseEff.toString(),
        balanceWhole: toWhole(poolBaseEff),
        percent: pct2(poolBaseEff, CAP_BASE),
        percentKind: "of_cap",
      };

      const leaderboard = [bondingRowPre, ...holderRows];
      return res.json({
        mint,
        decimals,
        leaderboard,
        bondingHeader,
        meta: {
          mode: "pre",
          decimals,
          capBase: CAP_BASE.toString(),
          circulatingBase: circulatingBase.toString(),
          poolBase: poolBaseEff.toString(),
          lockedBase: lockedBase.toString(),
          devWallet: dev,
          ignoredWallets: MIG_AUTH ? [MIG_AUTH] : [],
        },
      });
    }
    // ----- POST MODE

    // Backfill the OWNER from the vault token-account if needed (single cheap RPC)
    if (!raydiumVaultOwner && raydiumBaseVault) {
      try {
        const { value: acc } = await connection.getParsedAccountInfo(new PublicKey(raydiumBaseVault));
        raydiumVaultOwner = acc?.data?.parsed?.info?.owner || null;
      } catch (e) {
        // ignore; we'll fall back to showing 0 if we truly can't resolve it
      }
    }

    // Resolve the vault balance from HOLDERS (which is keyed by OWNER)
    let vaultKeyForRemoval = null;
    let vaultBase = 0n;

    if (raydiumVaultOwner && holders[raydiumVaultOwner] != null) {
      vaultKeyForRemoval = raydiumVaultOwner;
      vaultBase = BigInt(holders[raydiumVaultOwner] || 0);
    } else if (raydiumBaseVault && holders[raydiumBaseVault] != null) {
      // Only if your holders map ever used TA keys (normally it doesn't)
      vaultKeyForRemoval = raydiumBaseVault;
      vaultBase = BigInt(holders[raydiumBaseVault] || 0);
    }

    // Post-mig bonding curve is closed (0)
    const bondingRowPost = {
      ...bondingRowPre,
      balanceBase: "0",
      balanceWhole: 0,
      percent: 0,
      percentKind: "of_total_supply",
    };

    // Build header (we’ll show percent of TOTAL_SUPPLY)
    const raydiumHeader = {
      address: raydiumBaseVault || raydiumVaultOwner || "UNKNOWN",
      displayName: "Raydium Pool",
      balanceBase: vaultBase.toString(),
      balanceWhole: toWhole(vaultBase),
      percent: pct2(vaultBase, TOTAL_BASE),
      percentKind: "of_total_supply",
    };

    // Remove the Raydium owner row from the list (so it doesn’t double-appear)
    const visibleHolders = holderRows
      .filter(r => (r.address || "").trim() !== (vaultKeyForRemoval || ""))
      .map(r => ({
        ...r,
        percent: pct2(BigInt(r.balanceBase), TOTAL_BASE),
        percentKind: "of_total_supply",
      }));

    return res.json({
      mint,
      decimals,
      leaderboard: [bondingRowPost, ...visibleHolders],
      raydiumHeader,
      meta: {
        mode: "post",
        decimals,
        totalSupplyBase: TOTAL_BASE.toString(),
        capBase: CAP_BASE.toString(),
        poolBase: "0",
        lockedBase: lockedBase.toString(),
        devWallet: dev,
        raydiumPool: raydiumPool || null,
        raydiumBaseVault: raydiumBaseVault || null,
        raydiumVaultOwner: raydiumVaultOwner || null,
        ignoredWallets: MIG_AUTH ? [MIG_AUTH] : [],
      },
    });
  } catch (err) {
    console.error("GET /leaderboard error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

export default router;
