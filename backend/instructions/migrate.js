// instructions/migrate.js — CPMM (devnet), startMigration-first, tidy logs
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT as WSOL_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import Decimal from "decimal.js";

import { connection, PROGRAM_ID, getProgram as getCurveProgram } from "../config/index.js";
import { loadHoldings, updateRaydiumMeta } from "../lib/files.js";
import { resyncMintFromChain } from "../lib/chain.js";

import { Raydium, TxVersion } from "@raydium-io/raydium-sdk-v2";
import { broadcastHoldings } from "../lib/sse.js";

// Show Raydium SDK version in logs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
let RAYDIUM_SDK_VERSION = "unknown";
try {
  RAYDIUM_SDK_VERSION =
    require("@raydium-io/raydium-sdk-v2/package.json")?.version ?? "unknown";
} catch {}

/* ---------------------------------- CONSTS --------------------------------- */

// Raydium CPMM program (devnet)
const CPMM_PROGRAM_ID = new PublicKey("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");

// Devnet create-pool fee TOKEN ACCOUNT (Raydium requires this for SOL pairs)
const DEVNET_CPMM_CREATE_FEE_TA = "3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy";

/* --------------------------------- LOGGING --------------------------------- */

const ENABLE_LOGS = false;

const START_TIME = Date.now();
const t = () => ENABLE_LOGS ? `${((Date.now() - START_TIME) / 1000).toFixed(3)}s` : "";

const noop = () => {};

const banner = ENABLE_LOGS ? (title) => console.log(`\n===== ${title} [t+${t()}] =====`) : noop;
const step   = ENABLE_LOGS ? (msg, extra) => console.log(`→ ${msg}${extra ? " " + JSON.stringify(extra, null, 2) : ""}`) : noop;
const ok     = ENABLE_LOGS ? (msg, extra) => console.log(`✅ ${msg}${extra ? " " + JSON.stringify(extra, null, 2) : ""}`) : noop;
const warn   = ENABLE_LOGS ? (msg, extra) => console.warn(`⚠️  ${msg}${extra ? " " + JSON.stringify(extra, null, 2) : ""}`) : noop;
const fail   = ENABLE_LOGS ? (msg, extra) => console.error(`❌ ${msg}${extra ? " " + JSON.stringify(extra, null, 2) : ""}`) : noop;

const fmtPk = (x) => {
  try { return typeof x?.toBase58 === "function" ? x.toBase58() : String(x); }
  catch { return String(x); }
};
const sol = (lamports) => {
  try { return new Decimal(lamports.toString()).div(LAMPORTS_PER_SOL).toString(); }
  catch { return String(lamports); }
};
const phaseName = (p) => (p?.migrating ? "Migrating" : p?.raydiumLive ? "RaydiumLive" : "Active");
const toBigIntLike = (x) => {
  if (x == null) return 0n;
  if (typeof x === "bigint") return x;
  if (typeof x === "number") return BigInt(x);
  if (typeof x === "string") return BigInt(x);
  if (typeof x?.toString === "function") return BigInt(x.toString());
  return 0n;
};

/* --------------------------------- HELPERS --------------------------------- */

function makeNodeWallet(kp) {
  return {
    publicKey: kp.publicKey,
    payer: kp,
    feePayer: kp.publicKey,
    async signTransaction(tx) { tx.partialSign(kp); return tx; },
    async signAllTransactions(txs) { txs.forEach((t) => t.partialSign(kp)); return txs; },
  };
}

async function sendAndConfirmV0(tx, label = "tx") {
  try {
    step(`Sending transaction [${label}]`, {
      sigs: tx.signatures?.length ?? 0,
      ixs: tx.message?.instructions?.length ?? "unknown",
    });
    const sig = await connection.sendTransaction(tx, { maxRetries: 5, skipPreflight: false });
    step(`Submitted [${label}]`, { signature: sig });
    await connection.confirmTransaction(sig, "confirmed");
    ok(`Confirmed [${label}]`, {
      signature: sig,
      explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    });
    return sig;
  } catch (e) {
    fail(`Transaction [${label}] failed: ${e?.message || e}`);
    if (typeof e?.getLogs === "function") {
      try {
        const logs = await e.getLogs();
        if (logs?.length) console.error(`[${label}] simulation logs:\n${logs.join("\n")}`);
      } catch {}
    }
    throw e;
  }
}

async function loadSigner() {
  const raw = process.env.MIGRATION_AUTHORITY_SECRET_KEY;
  if (!raw) throw new Error("MIGRATION_AUTHORITY_SECRET_KEY missing");
  try {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    ok("Loaded signer", { pubkey: kp.publicKey.toBase58() });
    return kp;
  } catch {
    const bs58 = (await import("bs58")).default;
    const kp = Keypair.fromSecretKey(Buffer.from(bs58.decode(raw)));
    ok("Loaded signer", { pubkey: kp.publicKey.toBase58() });
    return kp;
  }
}

async function deriveForMint(mint, userPubkey) {
  const mintPk = typeof mint === "string" ? new PublicKey(mint) : mint;
  const userPk = typeof userPubkey === "string" ? new PublicKey(userPubkey) : userPubkey;

  const [poolPDA]   = PublicKey.findProgramAddressSync([Buffer.from("liquidity_pool"),      mintPk.toBuffer()], PROGRAM_ID);
  const [solVault]  = PublicKey.findProgramAddressSync([Buffer.from("liquidity_sol_vault"), mintPk.toBuffer()], PROGRAM_ID);
  const [treasuryP] = PublicKey.findProgramAddressSync([Buffer.from("treasury"),            mintPk.toBuffer()], PROGRAM_ID);

  const poolTokenAccount = await anchor.utils.token.associatedAddress({ mint: mintPk, owner: poolPDA });
  const userTokenAccount = await anchor.utils.token.associatedAddress({ mint: mintPk, owner: userPk });
  const treasuryAta      = await anchor.utils.token.associatedAddress({ mint: mintPk, owner: treasuryP });

  ok("Derived addresses", {
    mint: mintPk.toBase58(),
    user: userPk.toBase58(),
    poolPDA: poolPDA.toBase58(),
    solVault: solVault.toBase58(),
    treasuryPDA: treasuryP.toBase58(),
    poolTokenAccount: poolTokenAccount.toBase58(),
    userTokenAccount: userTokenAccount.toBase58(),
    treasuryAta: treasuryAta.toBase58(),
  });

  return { mintPk, userPk, poolPDA, solVault, treasuryPDA: treasuryP, poolTokenAccount, userTokenAccount, treasuryAta };
}

async function fetchMintDecimals(mintPk) {
  const info = await connection.getParsedAccountInfo(mintPk);
  const d = info?.value?.data?.parsed?.info?.decimals;
  if (typeof d !== "number") throw new Error("Failed to read mint decimals");
  ok("Mint decimals", { mint: mintPk.toBase58(), decimals: d });
  return d;
}

async function ensureAtaIx(owner, mint) {
  const ata = await anchor.utils.token.associatedAddress({ mint, owner });
  const info = await connection.getAccountInfo(ata);
  return info ? { ata, ix: null } : { ata, ix: createAssociatedTokenAccountInstruction(owner, ata, owner, mint) };
}

async function ensureAtaExistsNow({ owner, mint, signer }) {
  const ata = await anchor.utils.token.associatedAddress({ mint, owner });
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    const ix = createAssociatedTokenAccountInstruction(owner, ata, owner, mint);
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [ix] })
      .compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([signer]);
    const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
    await connection.confirmTransaction(sig, "confirmed");
    step("Created ATA", { owner: owner.toBase58(), mint: mint.toBase58(), ata: ata.toBase58(), sig });
  }
  return ata;
}

/* -------------------------- RAYDIUM: LOAD + CONFIG ------------------------- */

async function ensureCpmmConfigsLoaded(r) {
  if (Array.isArray(r.apiData?.cpmmConfigs) && r.apiData.cpmmConfigs.length) return r.apiData.cpmmConfigs;

  try {
    if (typeof r.api?.getCpmmConfigs === "function") {
      const list = await r.api.getCpmmConfigs();
      if (Array.isArray(list) && list.length) {
        r.apiData = { ...(r.apiData || {}), cpmmConfigs: list };
        return list;
      }
    }
  } catch {}

  const attempts = ["updateCpmmConfigs", "fetchCpmmConfigs", "loadCpmmConfigs", "refresh"];
  for (const fn of attempts) {
    try {
      if (typeof r.api?.[fn] === "function") {
        const res = await r.api[fn]();
        const list = res?.cpmmConfigs ?? res?.data?.cpmmConfigs ?? r.apiData?.cpmmConfigs;
        if (Array.isArray(list) && list.length) {
          r.apiData = { ...(r.apiData || {}), cpmmConfigs: list };
          return list;
        }
      }
    } catch {}
  }

  throw new Error("Raydium CPMM fee configs unavailable (devnet).");
}

async function loadRaydiumSafe({ connection, ownerKeypair }) {
  // console.log("→ Raydium SDK v2 version:", RAYDIUM_SDK_VERSION);
  const ownerWallet = makeNodeWallet(ownerKeypair);

  const attempts = [
    { name: "devnet+disableLoadToken", opts: { connection, owner: ownerWallet, cluster: "devnet", disableLoadToken: true } },
    { name: "inferCluster+disableLoadToken", opts: { connection, owner: ownerWallet, disableLoadToken: true } },
  ];

  let lastErr;
  for (const a of attempts) {
    try {
      step("Raydium.load", { opts: a.name });
      const r = await Raydium.load(a.opts);

      r.wallet = ownerWallet;
      r._owner = ownerWallet;
      if (typeof r.setWallet === "function") r.setWallet(ownerWallet);

      await ensureCpmmConfigsLoaded(r);
      ok("Raydium client ready");
      return r;
    } catch (e) {
      lastErr = e;
      console.error(`❌ Raydium.load failed (${a.name}):`, e?.message || e);
    }
  }
  const err = new Error(`${lastErr?.message || lastErr}\nRaydium.load() could not initialize (devnet).`);
  err.stack = lastErr?.stack || err.stack;
  throw err;
}

/* -------------------------- RAYDIUM: CPMM BUILDER -------------------------- */

async function buildRaydiumCpmmIxs({
  mintPk,
  decimals,
  signerKp,
  tokenAta,
  wsolAta,
  tokenAmountBaseUnits,
  wsolLamports,
  plannedBaseTopup = 0n,
}) {
  banner("Raydium: init client");
  const raydium = await loadRaydiumSafe({ connection, ownerKeypair: signerKp });

  const cpmmConfigs = await ensureCpmmConfigsLoaded(raydium);
  const feeConfig = cpmmConfigs.find((c) => c.id) ?? cpmmConfigs[0];
  if (!feeConfig?.id || typeof feeConfig.index !== "number") throw new Error("Invalid CPMM feeConfig from API");

  // Post-startMigration balances should satisfy inputs
  const baseBalInfo = await connection.getTokenAccountBalance(tokenAta).catch(() => null);
  const wsolBalInfo = await connection.getTokenAccountBalance(wsolAta).catch(() => null);

  const baseHaveNow = BigInt(baseBalInfo?.value?.amount || "0");
  const baseNeed = tokenAmountBaseUnits;
  const baseHavePost = baseHaveNow + BigInt(plannedBaseTopup);
  if (baseHavePost < baseNeed) {
    throw new Error(
      `Preflight: base-token after top-up still short. haveNow=${baseHaveNow} topup=${plannedBaseTopup} need=${baseNeed} (ATA ${fmtPk(tokenAta)})`
    );
  }
  step("Balances (pre-builder)", {
    baseHaveNow: baseHaveNow.toString(),
    baseHavePost: baseHavePost.toString(),
    baseNeed: baseNeed.toString(),
    wsolHaveBefore: BigInt(wsolBalInfo?.value?.amount || "0").toString(),
    wsolPlanned: BigInt(wsolLamports).toString(),
  });

  // Ensure ATAs exist (SDK may probe)
  await ensureAtaExistsNow({ owner: signerKp.publicKey, mint: mintPk, signer: signerKp });
  await ensureAtaExistsNow({ owner: signerKp.publicKey, mint: WSOL_MINT, signer: signerKp });

  banner("Raydium: CPMM createPool");
  const poolFeeAccountPk = new PublicKey(DEVNET_CPMM_CREATE_FEE_TA);
  const params = {
    programId: CPMM_PROGRAM_ID,
    poolFeeAccount: poolFeeAccountPk, // create-pool fee token account (WSOL)
    mintA: { address: mintPk, decimals, programId: TOKEN_PROGRAM_ID },
    mintB: { address: WSOL_MINT, decimals: 9, programId: TOKEN_PROGRAM_ID },
    mintAAmount: new BN(tokenAmountBaseUnits.toString()),
    mintBAmount: new BN(wsolLamports.toString()),
    startTime: new BN(0),
    feeConfig, // SDK will wire the amm_config PDA
    associatedOnly: true,
    checkCreateATAOwner: true,
    ownerInfo: { owner: makeNodeWallet(signerKp), feePayer: signerKp.publicKey, useSOLBalance: false },
    feePayer: signerKp.publicKey,
    txVersion: TxVersion.V0,
  };

  step("createPool params (brief)", {
    mintA: params.mintA.address.toBase58(),
    mintB: params.mintB.address.toBase58(),
    mintAAmount: params.mintAAmount.toString(),
    mintBAmount: params.mintBAmount.toString(),
    poolFeeAccount: params.poolFeeAccount.toBase58(),
    ammConfigId: feeConfig.id,
  });

  const { builder: createPoolBuilder, extInfo, poolKeys } = await raydium.cpmm.createPool(params);

  const vaultA =
    poolKeys?.vaultA ??
    extInfo?.address?.vaultA ??
    createPoolBuilder?.extInfo?.vaultA ?? null;

  const vaultOwner =
    poolKeys?.authority ??
    poolKeys?.vaultOwner ??
    extInfo?.address?.authority ??
    createPoolBuilder?.extInfo?.authority ?? null;

  const extraSigners = createPoolBuilder?.signers ?? [];

  const ixs = [
    ...(createPoolBuilder?.instructions ?? []),
    ...(createPoolBuilder?.endInstructions ?? []),
  ];

  const addr = extInfo?.address;
  const candidates = [
    addr?.poolId,
    addr?.id,
    extInfo?.poolId,
    poolKeys?.id,
    poolKeys?.poolId,
    createPoolBuilder?.extInfo?.poolId,
    createPoolBuilder?.poolId,
    createPoolBuilder?.targetPoolId,
  ].filter(Boolean);

  if (!candidates.length) throw new Error("Raydium SDK did not surface a pool id");
  const raydiumPoolPk = new PublicKey(candidates[0]);

  ok("Raydium CPMM target", {
    poolId: raydiumPoolPk.toBase58(),
    baseTokens: tokenAmountBaseUnits.toString(),
    quoteLamports: wsolLamports.toString(),
    quoteSol: sol(wsolLamports),
  });

  return { ixs, signers: extraSigners, raydiumPoolPk, vaultA, vaultOwner };
}

/* ------------------------------- MIGRATION -------------------------------- */

export async function migrateIfReady(mintStr) {
  banner(`Start migration: ${mintStr}`);

  const signer = await loadSigner();
  const program = getCurveProgram(signer.publicKey.toBase58());
  ok("Curve program loaded");

  const {
    mintPk,
    poolPDA,
    solVault,
    treasuryPDA,
    poolTokenAccount,
    userTokenAccount,
    treasuryAta,
  } = await deriveForMint(mintStr, signer.publicKey);

  banner("Fetch pool account");
  let pool;
  try {
    pool = await program.account.liquidityPool.fetch(poolPDA);
    step("Pool (brief)", { token: fmtPk(pool?.token), phase: phaseName(pool?.phase) });
  } catch {
    fail("Pool not found; skipping", { poolPDA: poolPDA.toBase58() });
    return { skipped: true, reason: "pool_not_found" };
  }

  // Early exit if already migrated to Raydium
  const phase = phaseName(pool.phase);
  if (phase === "RaydiumLive" || pool.raydiumPool) {
    const poolId = fmtPk(pool.raydiumPool);
    const links = {
      explorerPool: `https://explorer.solana.com/address/${poolId}?cluster=devnet`,
      raydiumPool: `https://raydium.io/pools?cluster=devnet&poolId=${poolId}`,
      raydiumAddLiq: `https://raydium.io/liquidity/add?cluster=devnet&poolId=${poolId}`,
    };
    ok("Already RaydiumLive — skipping migration", { raydiumPool: poolId, ...links });
    return { skipped: true, reason: "already_migrated", raydiumPool: poolId, links };
  }
  
  const decimals = await fetchMintDecimals(mintPk);

  const capSold = 800_000_000n * 10n ** BigInt(decimals);
  const totalSupply = toBigIntLike(pool.totalSupply);
  const reserveToken = toBigIntLike(pool.reserveToken);
  const ySold = totalSupply - reserveToken;

  step("Cap check", {
    decimals,
    capSold: capSold.toString(),
    totalSupply: totalSupply.toString(),
    reserveToken: reserveToken.toString(),
    ySold: ySold.toString(),
  });

  if (phase !== "Migrating" && ySold < capSold) {
    warn("Cap not reached and not in Migrating phase; skipping");
    return { skipped: true, reason: "cap_not_reached" };
  }

  banner("Ensure ATAs");
  const { ata: wsolAta, ix: ensureWsolAtaIx } = await ensureAtaIx(signer.publicKey, WSOL_MINT);
  const { ata: signerTokenAta, ix: ensureTokenAtaIx } = await ensureAtaIx(signer.publicKey, mintPk);
  if (ensureTokenAtaIx) step("Create ATA (token)", { ata: signerTokenAta.toBase58() });
  if (ensureWsolAtaIx) step("Create ATA (WSOL)", { ata: wsolAta.toBase58() });

  // Base token top-up expected after startMigration (pool+treasury → signer)
  const poolTokBal = await connection.getTokenAccountBalance(poolTokenAccount).catch(() => null);
  const treTokBal  = await connection.getTokenAccountBalance(treasuryAta).catch(() => null);
  const plannedBaseTopup =
    BigInt(poolTokBal?.value?.amount || "0") + BigInt(treTokBal?.value?.amount || "0");
  step("Planned base top-up", { fromPool: poolTokBal?.value?.amount || "0", fromTreasury: treTokBal?.value?.amount || "0" });

  // Choose SOL amount (snapshot preferred, else vault balance)
  banner("Liquidity inputs");
  const vaultInfo = await connection.getAccountInfo(solVault);
  const vaultLamports = BigInt(vaultInfo?.lamports ?? 0);
  const snapshotSolLamports = toBigIntLike(pool.reserveSnapshotSol);
  const snapshotTokenBase   = toBigIntLike(pool.reserveSnapshotToken);
  const wsolLamports = snapshotSolLamports > 0n ? snapshotSolLamports : vaultLamports;

  step("Snapshots / vault", {
    tokenBaseSnapshot: snapshotTokenBase.toString(),
    solLamportsSnapshot: snapshotSolLamports.toString(),
    solVaultLamports: vaultLamports.toString(),
    chosenLamports: wsolLamports.toString(),
    chosenSol: sol(wsolLamports),
  });
  if (wsolLamports === 0n) throw new Error("No SOL in snapshot/vault; aborting migration");

  // ① startMigration: drain PDAs → signer
  banner("Build startMigration");
  const startMigIx = await program.methods
    .startMigration()
    .accounts({
      pool: poolPDA,
      tokenMint: mintPk,
      poolTokenAccount: poolTokenAccount,
      poolSolVault: solVault,
      treasuryPda: treasuryPDA,
      treasuryTokenAccount: treasuryAta,
      destTokenAccount: signerTokenAta,
      migrationAuthority: signer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  ok("startMigration ix ready");
  // Tell clients we entered Migrating as soon as we’re about to send the tx
  broadcastHoldings({ mint: fmtPk(mintPk), source: "phase", phase: "Migrating" });

  // ② Wrap SOL to WSOL (transfer lamports to WSOL ATA, then sync)
  banner("Wrap SOL → WSOL");
  const transferLamportsIx = SystemProgram.transfer({
    fromPubkey: signer.publicKey,
    toPubkey: wsolAta,
    lamports: Number(wsolLamports),
  });
  step("Wrap meta", { wsolAta: wsolAta.toBase58(), sol: sol(wsolLamports) });

  // ③ Build Raydium CPMM (createPool)
  banner("Build Raydium CPMM");
  const tokenAmountBaseUnits = 200_000_000n * 10n ** BigInt(decimals);
  const { ixs: rayIxs, signers: raySigners = [], raydiumPoolPk, vaultA, vaultOwner } = await buildRaydiumCpmmIxs({
    mintPk,
    decimals,
    signerKp: signer,
    tokenAta: signerTokenAta,
    wsolAta,
    tokenAmountBaseUnits,
    wsolLamports,
    plannedBaseTopup,
  });

  // ④ finalizeMigration
  banner("Build finalizeMigration");
  const finalizeIx = await program.methods
    .finalizeMigration()
    .accounts({
      pool: poolPDA,
      tokenMint: mintPk,
      migrationAuthority: signer.publicKey,
      raydiumPool: raydiumPoolPk,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  ok("finalizeMigration ix ready", { raydiumPool: raydiumPoolPk.toBase58() });

  // Compose & send single v0 tx (order matters)
  banner("Compose & send");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  step("Blockhash", { blockhash, lastValidBlockHeight });

  const [tokenAtaInfo, wsolAtaInfo] = await Promise.all([
    connection.getAccountInfo(signerTokenAta),
    connection.getAccountInfo(wsolAta),
  ]);
  const maybeCreateTokenAtaIx = tokenAtaInfo ? null : ensureTokenAtaIx;
  const maybeCreateWsolAtaIx  = wsolAtaInfo  ? null : ensureWsolAtaIx;

  const ixs = [
    ...(maybeCreateTokenAtaIx ? [maybeCreateTokenAtaIx] : []),
    startMigIx,
    ...(maybeCreateWsolAtaIx ? [maybeCreateWsolAtaIx] : []),
    transferLamportsIx,
    createSyncNativeInstruction(wsolAta),
    ...rayIxs,
    finalizeIx,
  ];

  const msg = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([signer, ...raySigners]);

  ok("Tx ready", { numInstr: ixs.length, hasCreateTokenAta: !!maybeCreateTokenAtaIx, hasCreateWsolAta: !!maybeCreateWsolAtaIx });

  const sig = await sendAndConfirmV0(tx, "startMigration+cpmm+finalize");
  ok("Migration tx sent", {
    signature: sig,
    explorerTx: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  });

  // Post-verify
  banner("Post-verify");
  const poolAfter = await program.account.liquidityPool.fetch(poolPDA);
  const phaseAfter = phaseName(poolAfter.phase);
  const raydiumPoolAfter = poolAfter?.raydiumPool;

  if (!raydiumPoolAfter) throw new Error("Post-verify: raydiumPool still null after finalizeMigration()");
  if (phaseAfter !== "RaydiumLive") throw new Error(`Post-verify: expected RaydiumLive, got ${phaseAfter}`);

  const poolId = fmtPk(raydiumPoolAfter);
  const { value: vaultAInfo } = await connection.getParsedAccountInfo(vaultA);
  const parsedOwner =
    vaultAInfo?.data?.parsed?.info?.owner || null;
  const raydiumBaseVault  = vaultA ? fmtPk(vaultA) : null;       // token account
  const raydiumVaultOwner = parsedOwner ? String(parsedOwner) : null;  // <-- THIS is what your holdersMap uses

  await updateRaydiumMeta(fmtPk(mintPk), {
    poolId: fmtPk(raydiumPoolAfter),
    baseVault: raydiumBaseVault,
    vaultOwner: raydiumVaultOwner,
  });

  // include the vault in the SSE so the UI flips without polling
  broadcastHoldings({
    mint: fmtPk(mintPk),
    source: "phase",
    phase: phaseAfter,
    raydiumPool: poolId,
    raydiumBaseVault,
    raydiumVaultOwner
  });

  try {
    await resyncMintFromChain(fmtPk(mintPk)); // updates mint_state/holders/price bucket
  } catch (e) {
    console.error("post-migration resync failed:", e?.message || e);
  }

  const tokenMintStr = mintPk.toBase58();
  const WSOL_MINT_STR = "So11111111111111111111111111111111111111112";

  const links = {
    explorerTx:  `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    explorerPool:`https://explorer.solana.com/address/${poolId}?cluster=devnet`,
    raydiumSwap: `https://raydium.io/swap/?cluster=devnet&inputMint=sol&outputMint=${tokenMintStr}`,
    raydiumAddLiq: `https://raydium.io/liquidity/add/?cluster=devnet&base=${tokenMintStr}&quote=${WSOL_MINT_STR}`,
    raydiumPool: `https://raydium.io/pool/${poolId}?cluster=devnet`,
  };

  ok("Post-verification OK", {
    phase: phaseAfter,
    ...links,
  });

  // Broadcast “RaydiumLive” + pool id so the UI flips immediately without refresh
  broadcastHoldings({
    mint: fmtPk(mintPk),
    source: "phase",
    phase: phaseAfter,
    raydiumPool: fmtPk(raydiumPoolAfter),
  });

  // Final summary (key addresses + links)
  console.log("\n—— Migration Summary (devnet) ——");
  console.log(JSON.stringify({
    mint: fmtPk(mintPk),
    poolPDA: fmtPk(poolPDA),
    solVault: fmtPk(solVault),
    treasuryPDA: fmtPk(treasuryPDA),
    poolTokenAccount: fmtPk(poolTokenAccount),
    signerTokenAta: fmtPk(signerTokenAta),
    wsolAta: fmtPk(wsolAta),
    raydiumPool: poolId,
    signature: sig,
    links,
  }, null, 2));

  return {
    ok: true,
    signature: sig,
    raydiumPool: poolId,
    raydiumPoolPredicted: fmtPk(raydiumPoolPk),
  };
}

/* ------------------------------ BATCH / DRIVER ----------------------------- */

export async function autoScanAndMigrateAll() {
  banner("Scan & migrate");
  const holdings = await loadHoldings() || {};
  const mints = Object.keys(holdings);
  if (!mints.length) warn("No mints found in holdings()");

  const out = [];
  for (const mint of mints) {
    banner(`Process ${mint}`);
    try {
      const result = await migrateIfReady(mint);
      ok(`Result for ${mint}`, result);
      out.push({ mint, ...result });
    } catch (e) {
      fail(`Error migrating ${mint}`, { error: e?.message || String(e) });
      out.push({ mint, error: e?.message || String(e) });
    }
  }

  banner("Loop complete");
  // console.log(JSON.stringify(out, null, 2));
  return out;
}

// CLI: `node instructions/migrate.js <MINT>` or run batch with no args
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const maybeMint = process.argv[2];
    try {
      if (maybeMint) {
        const res = await migrateIfReady(maybeMint);
        ok("Single-mint migration finished", res);
      } else {
        await autoScanAndMigrateAll();
      }
      process.exit(0);
    } catch (e) {
      fail("Fatal error", { error: e?.message || String(e) });
      try {
        const { lastValidBlockHeight } = await connection.getLatestBlockhash();
        step("LastKnownBlockHeight", { lastValidBlockHeight });
      } catch {}
      process.exit(1);
    }
  })();
}
