import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { PROGRAM_ID } from "../config/index.js";

export async function deriveForMint(mint, userPubkey) {
  const mintPk = typeof mint === "string" ? new PublicKey(mint) : mint;

  const [poolPDA] = PublicKey.findProgramAddressSync([Buffer.from("liquidity_pool"), mintPk.toBuffer()], PROGRAM_ID);
  const [solVault, solVaultBump] = PublicKey.findProgramAddressSync([Buffer.from("liquidity_sol_vault"), mintPk.toBuffer()], PROGRAM_ID);
  const [dexConfigPDA] = PublicKey.findProgramAddressSync([Buffer.from("CurveConfiguration")], PROGRAM_ID);

  const poolTokenAccount = await anchor.utils.token.associatedAddress({ mint: mintPk, owner: poolPDA });
  const userPk = typeof userPubkey === "string" ? new PublicKey(userPubkey) : userPubkey;
  const userTokenAccount = await anchor.utils.token.associatedAddress({ mint: mintPk, owner: userPk });

  return { mintPk, poolPDA, solVault, solVaultBump, dexConfigPDA, poolTokenAccount, userTokenAccount, userPk };
}
