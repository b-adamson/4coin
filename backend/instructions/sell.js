import { BN } from "bn.js";
import { deriveForMint } from "./derive.js";
import { connection, getProgram } from "../config/index.js";
import * as anchor from "@coral-xyz/anchor";

export async function buildSellTxBase64({ walletAddress, mintPubkey, amountLamports }) {
  const program = getProgram(walletAddress);
  const { mintPk, poolPDA, solVault, solVaultBump, dexConfigPDA, poolTokenAccount, userTokenAccount, userPk } =
    await deriveForMint(mintPubkey, walletAddress);

  const sellIx = await program.methods
    .sell(new BN(amountLamports), solVaultBump)
    .accounts({
      dexConfigurationAccount: dexConfigPDA,
      pool: poolPDA,
      tokenMint: mintPk,
      poolTokenAccount,
      poolSolVault: solVault,
      userTokenAccount,
      user: userPk,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new anchor.web3.TransactionMessage({
    payerKey: userPk,
    recentBlockhash: blockhash,
    instructions: [sellIx],
  }).compileToV0Message();

  const tx = new anchor.web3.VersionedTransaction(msg);
  return Buffer.from(tx.serialize()).toString("base64");
}
