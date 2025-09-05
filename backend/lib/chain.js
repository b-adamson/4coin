// lib/chain.js
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { connection, PROGRAM_ID, holdingsFile } from "../config/index.js";
import { atomicWriteJSON } from "./files.js";
import { loadTokens, loadHoldings, loadPrices, savePrices } from "./files.js";
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

  // All ATAs for this mint
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
    poolBalBase: poolBalBaseStr, // pool ATA balance (base units as string)
    solVaultLamports,            // SOL vault lamports (number)
    treasuryPDA: treasuryPDA.toBase58(),
  };
}

export async function resyncMintFromChain(mintStr) {
  const tokens = loadTokens();
  const tokenRow = tokens.find((t) => t.mint === mintStr);
  if (!tokenRow) throw new Error("Unknown mint");

  const {
    holdersMap,
    poolPDA,
    poolTokenAccount,
    poolBalBase,
    solVaultLamports,
    treasuryPDA,
  } = await getOnChainHoldersForMint(mintStr);

  // Build the "holders" map we persist (excluding pool & aggregating treasury)
  const nextHolders = {};
  for (const [owner, baseStr] of Object.entries(holdersMap)) {
    if (owner === poolPDA) continue;
    if (owner === treasuryPDA) {
      const prev = BigInt(nextHolders["TREASURY_LOCKED"] || "0");
      nextHolders["TREASURY_LOCKED"] = (prev + BigInt(baseStr)).toString();
      continue;
    }
    const prev = BigInt(nextHolders[owner] || "0");
    nextHolders[owner] = (prev + BigInt(baseStr)).toString();
  }
  // Save pool balance under BONDING_CURVE
  nextHolders["BONDING_CURVE"] = poolBalBase;

  // Update holdings.json
  const holdings = loadHoldings();
  if (!holdings[mintStr]) {
    holdings[mintStr] = {
      dev: tokenRow?.creator || null,
      bondingCurve: { reserveSol: 0 },
      holders: {},
    };
  }
  holdings[mintStr].holders = nextHolders;
  holdings[mintStr].bondingCurve = { reserveSol: solVaultLamports };

  atomicWriteJSON(holdingsFile, holdings);

  // Append a price/state sample (10s buckets) to prices.json, but only when state changed
  const prices = loadPrices(); // { [mint]: [{ t, reserveSolLamports, poolBase }] }
  if (!prices[mintStr]) prices[mintStr] = [];

  const bucketSec = 10; // must match your frontend candle size
  const bucket = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec;

  const arr = prices[mintStr];
  const last = arr[arr.length - 1];

  const changed =
    !last ||
    Number(last.reserveSolLamports) !== Number(solVaultLamports) ||
    String(last.poolBase) !== String(poolBalBase);

  if (changed) {
    arr.push({
      t: bucket, // unix seconds (10s bucket)
      reserveSolLamports: solVaultLamports,
      poolBase: String(poolBalBase),
    });

    const MAX_SAMPLES = 50000;
    if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);

    savePrices(prices);

    // FINALIZE: tell clients this is a chain-verified finalize + new bucket boundary
    broadcastHoldings({
      source: "chain",
      mint: mintStr,
      priceFinalizedAt: bucket,
      t: bucket,
      reserveSolLamports: solVaultLamports,
      poolBase: String(poolBalBase),
    });
  } else {
    // No price sample change; still announce current chain-backed state
    broadcastHoldings({
      source: "chain",
      mint: mintStr,
      t: bucket,
      reserveSolLamports: solVaultLamports,
      poolBase: String(poolBalBase),
    });
  }

  return {
    mint: mintStr,
    poolPDA,
    poolTokenAccount,
    reserveSolLamports: solVaultLamports,
    uniqueHolders: Object.keys(holdersMap).length,
  };
}

export async function resyncAllMints() {
  const tokens = loadTokens();
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
