// backend/lib/chain.js
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
import { broadcastHoldings, broadcastCandleWorking, broadcastCandleFinalized } from "./sse.js";

const FIFTEEN_MIN = 900;
const ONE_HOUR = 3600;
const LAMPORTS_PER_SOL = 1_000_000_000;

// ---- activity helpers (unchanged in spirit, price-free) ----
async function getLastActivitySec(mint) {
  let last = 0;
  try {
    const candles = await loadCandles15m(mint, { limit: 1, order: "desc" });
    const lastFinal = candles?.[0]?.t ? Number(candles[0].t) : 0;
    if (lastFinal > last) last = lastFinal;
  } catch {}
  try {
    const working = await getWorkingCandle(mint);
    const tWork = working?.t ? Number(working.t) : 0;
    if (tWork > last) last = tWork;
  } catch {}
  try {
    const row = await getTokenByMint(mint);
    const createdSec = row?.createdAt ? Math.floor(new Date(row.createdAt).getTime() / 1000) : 0;
    if (createdSec > last) last = createdSec;
  } catch {}
  return last || 0;
}

async function isMintActive(mint, horizonSec, nowSec) {
  try {
    const row = await getTokenByMint(mint);
    const phase = (row?.phase || row?.poolPhase || "").trim();
    if (phase === "Active" || phase === "Migrating") return true;
  } catch {}
  const lastTs = await getLastActivitySec(mint);
  return lastTs > 0 && nowSec - lastTs <= horizonSec;
}

// ---- on-chain snapshot → DB state ----
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

  const poolTokenAccount = await anchor.utils.token.associatedAddress({ mint, owner: poolPDA });

  const accs = await connection.getParsedProgramAccounts(anchor.utils.token.TOKEN_PROGRAM_ID, {
    filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });

  const holdersMap = {};
  for (const a of accs) {
    const info = a.account.data.parsed.info;
    const owner = info.owner;
    const amountStr = info.tokenAmount.amount;
    const amt = BigInt(amountStr || "0");
    holdersMap[owner] = ((holdersMap[owner] ? BigInt(holdersMap[owner]) : 0n) + amt).toString();
  }

  const poolAtaInfo = await connection.getParsedAccountInfo(poolTokenAccount);
  const poolBalBaseStr = poolAtaInfo.value?.data?.parsed?.info?.tokenAmount?.amount || "0";

  const solVaultLamports = await connection.getBalance(solVaultPDA);

  return {
    holdersMap,
    poolPDA: poolPDA.toBase58(),
    poolTokenAccount: poolTokenAccount.toBase58(),
    poolBalBase: poolBalBaseStr,
    solVaultLamports,
    treasuryPDA: treasuryPDA.toBase58(),
  };
}

export async function resyncMintFromChain(mintStr) {
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

  // Fold holders, keep curve under BONDING_CURVE, and aggregate treasury
  const nextHolders = {};
  for (const [owner, baseStrRaw] of Object.entries(holdersMap)) {
    const baseStr = String(baseStrRaw ?? "0");
    if (owner === poolPDA) continue; // pool ATA is accounted separately
    if (owner === treasuryPDA) {
      const prev = BigInt(nextHolders["TREASURY_LOCKED"] || "0");
      nextHolders["TREASURY_LOCKED"] = (prev + BigInt(baseStr)).toString();
      continue;
    }
    const prev = BigInt(nextHolders[owner] || "0");
    nextHolders[owner] = (prev + BigInt(baseStr)).toString();
  }
  nextHolders["BONDING_CURVE"] = String(poolBalBase ?? "0");

  // Persist latest on-chain balances
  await upsertMintStateAndHolders({
    mint: mintStr,
    poolPDA,
    poolTokenAccount,
    treasuryPDA,
    reserveSolLamports: Number(solVaultLamports ?? 0),
    holders: nextHolders,
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const tBucket = Math.floor(nowSec / FIFTEEN_MIN) * FIFTEEN_MIN;

  // Finalize previous bucket if we rolled
  try {
    const finalized = await finalizeWorkingCandleIfNeeded(mintStr, nowSec);
    if (finalized) broadcastCandleFinalized(mintStr, finalized);
  } catch (e) {
    console.error("finalizeWorkingCandleIfNeeded failed (non-blocking):", mintStr, e);
  }

  // Merge current on-chain snapshot into working candle.
  // We rely on the SQL inside upsertWorkingCandle to:
  // - keep OPEN once set
  // - widen HIGH/LOW
  // - set CLOSE to current value
  try {
    // Seed OPEN if no working for this bucket: use previous CLOSE if exists; otherwise genesis
    let existing = null;
    try { existing = await getWorkingCandle(mintStr); } catch {}
    const sameBucket = !!existing && Number(existing.t) === tBucket;

    if (!sameBucket) {
      // Use previous finalized CLOSE if present; else genesis from token decimals
      try {
        const lastFinal = await loadCandles15m(mintStr, { limit: 1, order: "desc" });
        if (lastFinal?.length) {
          await upsertWorkingCandle(mintStr, {
            tSec: tBucket,
            reserveSolLamports: Number(lastFinal[0].c_reserve_lamports) || 0,
            poolBase: String(lastFinal[0].cPoolBase ?? lastFinal[0].c_pool_base ?? "0"),
          });
        } else {
          const dec = Number(tokenRow?.decimals ?? 9);
          const capBase = (800_000_000n * (10n ** BigInt(dec))).toString();
          await upsertWorkingCandle(mintStr, {
            tSec: tBucket,
            reserveSolLamports: 0,
            poolBase: capBase,
          });
        }
      } catch (e) {
        console.error("seed OPEN for working bucket failed (non-blocking):", e);
      }
    }

    // Merge the *current* on-chain state — this updates H/L/C correctly
    const workingRow = await upsertWorkingCandle(mintStr, {
      tSec: tBucket,
      reserveSolLamports: Number(solVaultLamports ?? 0),
      poolBase: String(poolBalBase ?? "0"),
    });

    if (workingRow) broadcastCandleWorking(mintStr, workingRow);
  } catch (e) {
    console.error("working-candle merge (chain) failed (non-blocking):", e);
  }

  // Broadcast holdings (for progress bars / overlays)
  broadcastHoldings({
    source: "chain",
    mint: mintStr,
    t: nowSec,
    reserveSolLamports: Number(solVaultLamports ?? 0),
    poolBase: String(poolBalBase ?? "0"),
    liveCandle: {
      tBucket,
      reserve: Number(solVaultLamports ?? 0),
      poolBase: String(poolBalBase ?? "0"),
    },
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
      if (alwaysFinalize) {
        try {
          const finalized = await finalizeWorkingCandleIfNeeded(mint, nowSec);
          if (finalized) broadcastCandleFinalized(mint, finalized);
        } catch (e) {
          console.error("finalizeWorkingCandleIfNeeded failed (non-blocking):", mint, e);
        }
      }

      const active = await isMintActive(mint, horizonSec, nowSec);
      if (!active) {
        results.push({ mint, ok: true, skipped: true, reason: "inactive" });
        continue;
      }

      const r = await resyncMintFromChain(mint);
      results.push({ mint, ok: true, ...r });
    } catch (e) {
      results.push({ mint, ok: false, error: String(e?.message || e) });
    }
  }

  return results;
}
