import { BN } from "bn.js";
import { deriveForMint } from "./derive.js";
import { connection, getProgram } from "../config/index.js";
import * as anchor from "@coral-xyz/anchor";

export async function buildBuyTxBase64({ walletAddress, mintPubkey, amountLamports }) {
  const program = getProgram(walletAddress);
  const { mintPk, poolPDA, solVault, dexConfigPDA, poolTokenAccount, userTokenAccount, userPk } =
    await deriveForMint(mintPubkey, walletAddress);

  const buyIx = await program.methods
    .buy(new BN(amountLamports))
    .accounts({
      dexConfigurationAccount: dexConfigPDA,
      pool: poolPDA,
      tokenMint: mintPk,
      poolTokenAccount,
      userTokenAccount,
      poolSolVault: solVault,
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
    instructions: [buyIx],
  }).compileToV0Message();

  const tx = new anchor.web3.VersionedTransaction(msg);
  return Buffer.from(tx.serialize()).toString("base64");
}
