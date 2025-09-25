// lib/chain.js
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { connection, PROGRAM_ID } from "../config/index.js";
import {
  upsertMintStateAndHolders,
  loadTokens,
  getTokenByMint,
  upsertWorkingCandle,
  finalizeWorkingCandleIfNeeded,
  loadCandles15m,
  getWorkingCandle,
} from "./files.js";
import { broadcastHoldings } from "./sse.js";

const ONE_HOUR = 3600;

/** Cheap activity detector (no chain RPC). */
async function getLastActivitySec(mint) {
  let last = 0;

  try {
    // Last finalized 15m candle
    const candles = await loadCandles15m(mint, { limit: 1, order: "desc" });
    const lastFinal = candles?.[0]?.t ? Number(candles[0].t) : 0;
    if (lastFinal > last) last = lastFinal;
  } catch {}

  try {
    // Current working bucket (t = bucket start)
    const working = await getWorkingCandle(mint);
    const tWork = working?.t ? Number(working.t) : 0;
    if (tWork > last) last = tWork;
  } catch {}

  // As a fallback, use token.createdAt (if present)
  try {
    const row = await getTokenByMint(mint);
    const createdSec = row?.createdAt ? Math.floor(new Date(row.createdAt).getTime() / 1000) : 0;
    if (createdSec > last) last = createdSec;
  } catch {}

  return last || 0;
}

/** Decide if a mint should be chain-resynced right now. */
async function isMintActive(mint, horizonSec, nowSec) {
  // Phase “Active” or “Migrating” => always active
  try {
    const row = await getTokenByMint(mint);
    const phase = (row?.phase || row?.poolPhase || "").trim();
    if (phase === "Active" || phase === "Migrating") return true;
  } catch {}

  // Recent activity window
  const lastTs = await getLastActivitySec(mint);
  return lastTs > 0 && (nowSec - lastTs) <= horizonSec;
}


export async function getOnChainHoldersForMint(mintStr) {
  const mint = new PublicKey(mintStr);

  const [poolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_pool"), mint.toBuffer()],
    PROGRAM_ID
  );
  const [solVaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_sol_vault"), mint.toBuffer()],
    PROGRAM_ID
  );
  const [treasuryPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), mint.toBuffer()],
    PROGRAM_ID
  );

  const poolTokenAccount = await anchor.utils.token.associatedAddress({
    mint,
    owner: poolPDA,
  });

  // All token accounts for this mint
  const accs = await connection.getParsedProgramAccounts(
    anchor.utils.token.TOKEN_PROGRAM_ID,
    {
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: mint.toBase58() } },
      ],
    }
  );

  const holdersMap = {};
  for (const a of accs) {
    const info = a.account.data.parsed.info;
    const owner = info.owner;
    const amountStr = info.tokenAmount.amount;
    const amt = BigInt(amountStr || "0");
    holdersMap[owner] = (
      (holdersMap[owner] ? BigInt(holdersMap[owner]) : 0n) + amt
    ).toString();
  }

  const poolAtaInfo = await connection.getParsedAccountInfo(poolTokenAccount);
  const poolBalBaseStr =
    poolAtaInfo.value?.data?.parsed?.info?.tokenAmount?.amount || "0";

  const solVaultLamports = await connection.getBalance(solVaultPDA);

  return {
    holdersMap,
    poolPDA: poolPDA.toBase58(),
    poolTokenAccount: poolTokenAccount.toBase58(),
    poolBalBase: poolBalBaseStr, // base units as string
    solVaultLamports,            // number
    treasuryPDA: treasuryPDA.toBase58(),
  };
}

export async function resyncMintFromChain(mintStr) {
  // Validate mint exists in tokens list
  const tokenRow = await getTokenByMint(mintStr);
  if (!tokenRow) throw new Error("Unknown mint");

  const {
    holdersMap,
    poolPDA,
    poolTokenAccount,
    poolBalBase,
    solVaultLamports,
    treasuryPDA,
  } = await getOnChainHoldersForMint(mintStr);

  // Build holders for DB (exclude pool owner, fold treasury under sentinel)
  const nextHolders = {};
  for (const [owner, baseStrRaw] of Object.entries(holdersMap)) {
    const baseStr = String(baseStrRaw ?? "0");

    if (owner === poolPDA) continue;

    if (owner === treasuryPDA) {
      const prev = BigInt(nextHolders["TREASURY_LOCKED"] || "0");
      nextHolders["TREASURY_LOCKED"] = (prev + BigInt(baseStr)).toString();
      continue;
    }

    const prev = BigInt(nextHolders[owner] || "0");
    nextHolders[owner] = (prev + BigInt(baseStr)).toString();
  }
  // Save pool balance under BONDING_CURVE (frontend sentinel)
  nextHolders["BONDING_CURVE"] = String(poolBalBase ?? "0");

  // Persist state + holders (DB)
  await upsertMintStateAndHolders({
    mint: mintStr,
    poolPDA,
    poolTokenAccount,
    treasuryPDA,
    reserveSolLamports: Number(solVaultLamports ?? 0),
    holders: nextHolders,
  });

  // --- NEW: update the live working candle + finalize previous 15m if needed
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    // finalize previous bucket first (if the 15m window rolled)
    await finalizeWorkingCandleIfNeeded(mintStr, nowSec);
    // then write the current working bucket
    await upsertWorkingCandle(mintStr, {
      tSec: nowSec,
      reserveSolLamports: Number(solVaultLamports ?? 0),
      poolBase: String(poolBalBase ?? "0"),
    });
  } catch (e) {
    console.error("working-candle update/finalize (chain) failed (non-blocking):", e);
  }

  // Broadcast current chain-backed state (UI builds pending candle)
  broadcastHoldings({
    source: "chain",
    mint: mintStr,
    t: nowSec, // UI bucketizes using its current granularity
    reserveSolLamports: Number(solVaultLamports ?? 0),
    poolBase: String(poolBalBase ?? "0"),
  });

  return {
    mint: mintStr,
    poolPDA,
    poolTokenAccount,
    reserveSolLamports: Number(solVaultLamports ?? 0),
    uniqueHolders: Object.keys(holdersMap).length,
  };
}

export async function resyncAllMints({
  horizonSec = ONE_HOUR,
  alwaysFinalize = true,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  const tokens = await loadTokens();
  const results = [];

  for (const t of tokens) {
    const mint = t.mint;
    try {
      // 1) Cheap finalize for everyone (no chain RPC)
      if (alwaysFinalize) {
        try {
          await finalizeWorkingCandleIfNeeded(mint, nowSec);
        } catch (e) {
          console.error("finalizeWorkingCandleIfNeeded failed (non-blocking):", mint, e);
        }
      }

      // 2) Only do expensive on-chain resync for active mints
      const active = await isMintActive(mint, horizonSec, nowSec);
      if (!active) {
        results.push({ mint, ok: true, skipped: true, reason: "inactive" });
        continue;
      }

      // 3) Active -> full chain resync (updates DB + working candle + broadcast)
      const r = await resyncMintFromChain(mint);
      results.push({ mint, ok: true, ...r });
    } catch (e) {
      results.push({ mint, ok: false, error: String(e?.message || e) });
    }
  }

  return results;
}
