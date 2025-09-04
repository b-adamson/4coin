import * as anchor from "@coral-xyz/anchor";
import { BN } from "bn.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMintToInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  createSetAuthorityInstruction,
  AuthorityType,
} from "@solana/spl-token";
import {
  PublicKey,
  Keypair,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  PROGRAM_ID,
  DEVNET_URL,
  TOKEN_DECIMALS,
  getProgram,
  connection,
} from "../config/index.js";

// UMI / Metaplex
import {
  createUmi,
  createSignerFromKeypair,
  percentAmount,
  signerIdentity,
} from "@metaplex-foundation/umi";
import { createWeb3JsRpc } from "@metaplex-foundation/umi-rpc-web3js";
import { createWeb3JsEddsa } from "@metaplex-foundation/umi-eddsa-web3js";
import { createWeb3JsTransactionFactory } from "@metaplex-foundation/umi-transaction-factory-web3js";
import { mplToolbox } from "@metaplex-foundation/mpl-toolbox";
import { createDefaultProgramRepository } from "@metaplex-foundation/umi-program-repository";
import mpl from "@metaplex-foundation/mpl-token-metadata";
const { createV1, mplTokenMetadata, TokenStandard } = mpl;

function createDummySigner(pubkeyStr) {
  const pk = new PublicKey(pubkeyStr);
  return {
    publicKey: pk,
    signMessage: async () => { throw new Error("Dummy signer cannot sign messages."); },
    signTransaction: async () => { throw new Error("Dummy signer cannot sign transactions."); },
    signAllTransactions: async () => { throw new Error("Dummy signer cannot sign transactions."); },
  };
}

export async function buildPrepareMintAndPoolTxBase64({
  walletAddress,
  mintSecretKey,      // Uint8Array-like array
  name,
  symbol,
  metadataUri,
  initialBuyLamports, // optional lamports
}) {
  // --- UMI setup (same as OG) ---
  const umi = createUmi(DEVNET_URL);
  umi.use(signerIdentity(createDummySigner(walletAddress)));
  umi.programs = createDefaultProgramRepository(); // important to avoid ProgramRepository error
  umi.eddsa = createWeb3JsEddsa();
  umi.rpc = createWeb3JsRpc({ programs: umi.programs, transactions: umi.transactions }, DEVNET_URL);
  umi.transactions = createWeb3JsTransactionFactory();
  umi.use(mplToolbox()).use(mplTokenMetadata());

  // --- Mint keypair (keep the name "mint", like OG) ---
  const mint = Keypair.fromSecretKey(Uint8Array.from(mintSecretKey));
  const mintPubkeyObj = mint.publicKey;

  const umiMint = createSignerFromKeypair(umi, {
    publicKey: mintPubkeyObj.toBytes(),
    secretKey: Uint8Array.from(mint.secretKey),
  });

  // --- PDAs ---
  const [poolPDA]      = PublicKey.findProgramAddressSync([Buffer.from("liquidity_pool"),      mintPubkeyObj.toBuffer()], PROGRAM_ID);
  const [solVaultPDA]  = PublicKey.findProgramAddressSync([Buffer.from("liquidity_sol_vault"), mintPubkeyObj.toBuffer()], PROGRAM_ID);
  const [dexConfigPDA] = PublicKey.findProgramAddressSync([Buffer.from("CurveConfiguration")], PROGRAM_ID);
  const [treasuryPDA]  = PublicKey.findProgramAddressSync([Buffer.from("treasury"),            mintPubkeyObj.toBuffer()], PROGRAM_ID);

  // --- Create mint + metadata ---
  const createTokenTx = await createV1(umi, {
    mint: umiMint,
    authority: new PublicKey(walletAddress),
    name,
    symbol,
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(0),
    decimals: TOKEN_DECIMALS,
    tokenStandard: TokenStandard.Fungible,
  });

  // --- Anchor program ---
  const program = getProgram(walletAddress);

  // Pool ATA
  const poolTokenAccount = await anchor.utils.token.associatedAddress({
    mint: mintPubkeyObj,
    owner: poolPDA,
  });

  // Treasury ATA (off-curve owner)
  const treasuryAta = await getAssociatedTokenAddress(
    mintPubkeyObj,
    treasuryPDA,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const treasuryAtaInfo = await connection.getAccountInfo(treasuryAta);
  const ensureTreasuryAtaIx = !treasuryAtaInfo
    ? createAssociatedTokenAccountInstruction(
        new PublicKey(walletAddress),
        treasuryAta,
        treasuryPDA,
        mintPubkeyObj,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    : null;

  // Create Pool ix
  const poolIx = await program.methods
    .createPool()
    .accounts({
      pool: poolPDA,
      tokenMint: mintPubkeyObj,
      poolTokenAccount,
      poolSolVault: solVaultPDA,
      payer: new PublicKey(walletAddress),
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();

  // Amounts
  const DEC      = BigInt(TOKEN_DECIMALS);
  const POW10    = 10n ** DEC;
  const CAP_BASE = 800_000_000n * POW10;   // 800M
  const TOTAL    = 1_000_000_000n * POW10; // 1B
  const REM_BASE = TOTAL - CAP_BASE;       // 200M

  // Seed supply
  const mintToPoolIx = createMintToInstruction(
    mintPubkeyObj, poolTokenAccount, new PublicKey(walletAddress), CAP_BASE, [], TOKEN_PROGRAM_ID
  );
  const mintToTreasuryIx = createMintToInstruction(
    mintPubkeyObj, treasuryAta, new PublicKey(walletAddress), REM_BASE, [], TOKEN_PROGRAM_ID
  );

  // Optional initial buy
  let ensureUserAtaIx = null;
  let buyIx = null;
  if (initialBuyLamports && Number(initialBuyLamports) > 0) {
    const user = new PublicKey(walletAddress);
    const userTokenAccount = await getAssociatedTokenAddress(
      mintPubkeyObj, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const userAtaInfo = await connection.getAccountInfo(userTokenAccount);
    if (!userAtaInfo) {
      ensureUserAtaIx = createAssociatedTokenAccountInstruction(
        user, userTokenAccount, user, mintPubkeyObj, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );
    }

    buyIx = await program.methods
      .buy(new BN(initialBuyLamports))
      .accounts({
        dexConfigurationAccount: dexConfigPDA,
        pool: poolPDA,
        tokenMint: mintPubkeyObj,
        poolTokenAccount,
        userTokenAccount,
        poolSolVault: solVaultPDA,
        user,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
  }

  // Revoke mint authority
  const revokeMintAuthIx = createSetAuthorityInstruction(
    mintPubkeyObj,
    new PublicKey(walletAddress),
    AuthorityType.MintTokens,
    null,
    [],
    TOKEN_PROGRAM_ID
  );

  // Build instruction list (keep OG signer handling)
  const instructions = [
    ...createTokenTx.getInstructions().map(ix => new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.keys.map(k => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner:
          k.pubkey === walletAddress ||
          k.pubkey === mintPubkeyObj.toBase58() ||
          !!k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(ix.data),
    })),
    poolIx,
    ...(ensureTreasuryAtaIx ? [ensureTreasuryAtaIx] : []),
    mintToPoolIx,
    mintToTreasuryIx,
    revokeMintAuthIx,
    ...(ensureUserAtaIx ? [ensureUserAtaIx] : []),
    ...(buyIx ? [buyIx] : []),
  ];

  // Compile & sign
  const { blockhash } = await connection.getLatestBlockhash();
  const msgV0 = new TransactionMessage({
    payerKey: new PublicKey(walletAddress),
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msgV0);
  vtx.sign([mint]); // <— this now refers to the defined Keypair above
  const txBase64 = Buffer.from(vtx.serialize()).toString("base64");

  return {
    txBase64,
    pool: poolPDA.toBase58(),
    mint: mintPubkeyObj.toBase58(),
    poolTokenAccount: poolTokenAccount.toBase58(),
    treasuryPda: treasuryPDA.toBase58(),
    treasuryAta: treasuryAta.toBase58(),
  };
}
