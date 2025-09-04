import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import { PublicKey } from "@solana/web3.js";
import { connection, idl, PROGRAM_ID } from "../config/index.js";

export async function tryInitializeCurveConfig() {
  try {
    const adminKeypair = anchor.web3.Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync("../bonding_curve/bonding_curve/~/.config/solana/id.json", "utf8")))
    );
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(adminKeypair), { commitment: "confirmed" });
    const program = new anchor.Program(idl, provider);

    const [dexConfigurationPDA] = PublicKey.findProgramAddressSync([Buffer.from("CurveConfiguration")], PROGRAM_ID);
    const existing = await connection.getAccountInfo(dexConfigurationPDA);
    if (existing) { console.log("✅ Curve config already initialized."); return; }

    const tx = await program.methods
      .initialize(0.5)
      .accounts({
        dexConfigurationAccount: dexConfigurationPDA,
        adminKeypair,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("✅ Curve config initialized:", tx);
  } catch (err) {
    console.error("❌ Failed to initialize curve config:", err.message);
  }
}
