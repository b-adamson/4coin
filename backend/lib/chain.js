import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { connection, PROGRAM_ID, holdingsFile } from "../config/index.js";
import { atomicWriteJSON } from "./files.js";
import { loadTokens, loadHoldings } from "./files.js";
import { broadcastHoldings } from "./sse.js";

export async function getOnChainHoldersForMint(mintStr) {
  const mint = new PublicKey(mintStr);

  const [poolPDA] = PublicKey.findProgramAddressSync([Buffer.from("liquidity_pool"), mint.toBuffer()], PROGRAM_ID);
  const [solVaultPDA] = PublicKey.findProgramAddressSync([Buffer.from("liquidity_sol_vault"), mint.toBuffer()], PROGRAM_ID);
  const [treasuryPDA] = PublicKey.findProgramAddressSync([Buffer.from("treasury"), mint.toBuffer()], PROGRAM_ID);

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
    holdersMap[owner] = (holdersMap[owner] ? (BigInt(holdersMap[owner]) + amt) : amt).toString();
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
  const tokens = loadTokens();
  const tokenRow = tokens.find(t => t.mint === mintStr);
  if (!tokenRow) throw new Error("Unknown mint");

  const { holdersMap, poolPDA, poolTokenAccount, poolBalBase, solVaultLamports, treasuryPDA } =
    await getOnChainHoldersForMint(mintStr);

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
  nextHolders["BONDING_CURVE"] = poolBalBase;

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
  broadcastHoldings({ mint: mintStr });

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
    try { results.push({ mint: t.mint, ok: true, ...(await resyncMintFromChain(t.mint)) }); }
    catch (e) { results.push({ mint: t.mint, ok: false, error: String(e?.message || e) }); }
  }
  return results;
}
