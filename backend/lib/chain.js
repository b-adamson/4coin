// lib/chain.js
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { connection, PROGRAM_ID } from "../config/index.js";
import {
  upsertMintStateAndHolders,
  appendPriceSample,
  loadTokens,
  getTokenByMint,
  getLastPriceSample,
} from "./files.js";
import { broadcastHoldings } from "./sse.js";

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
  // Restore OLD behavior: validate the mint exists in tokens list
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

  // Restore OLD sampling semantics: only write a sample if state changed
  const BUCKET_SEC = 10;
  const bucket = Math.floor(Date.now() / 1000 / BUCKET_SEC) * BUCKET_SEC;

  const last = await getLastPriceSample(mintStr); // { t, reserveSolLamports, poolBase } | null
  const changed =
    !last ||
    Number(last.reserveSolLamports) !== Number(solVaultLamports ?? 0) ||
    String(last.poolBase) !== String(poolBalBase ?? "0");

  if (changed) {
    await appendPriceSample(mintStr, {
      t: bucket,
      reserveSolLamports: Number(solVaultLamports ?? 0),
      poolBase: String(poolBalBase ?? "0"),
    });

    // Broadcast with priceFinalizedAt when we wrote a new/updated bucket
    broadcastHoldings({
      source: "chain",
      mint: mintStr,
      priceFinalizedAt: bucket,
      t: bucket,
      reserveSolLamports: Number(solVaultLamports ?? 0),
      poolBase: String(poolBalBase ?? "0"),
    });
  } else {
    // No sample change; still announce current chain-backed state
    broadcastHoldings({
      source: "chain",
      mint: mintStr,
      t: bucket,
      reserveSolLamports: Number(solVaultLamports ?? 0),
      poolBase: String(poolBalBase ?? "0"),
    });
  }

  return {
    mint: mintStr,
    poolPDA,
    poolTokenAccount,
    reserveSolLamports: Number(solVaultLamports ?? 0),
    uniqueHolders: Object.keys(holdersMap).length,
  };
}

export async function resyncAllMints() {
  const tokens = await loadTokens();
  const results = [];
  for (const t of tokens) {
    try {
      results.push({
        mint: t.mint,
        ok: true,
        ...(await resyncMintFromChain(t.mint)),
      });
    } catch (e) {
      results.push({
        mint: t.mint,
        ok: false,
        error: String(e?.message || e),
      });
    }
  }
  return results;
}
