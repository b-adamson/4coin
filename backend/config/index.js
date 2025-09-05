import dotenv from "dotenv";
dotenv.config();

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

// === Program & network ===
export const DEVNET_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "Djy6544xmrPBE59RSUuiK8yTFdrzZLpKUoFGFz9Y1PkT");
export const TOKEN_DECIMALS = 9;

// === Files ===
export const tokensFile = path.join(process.cwd(), "data", "tokens.json");
export const holdingsFile = path.join(process.cwd(), "data", "holdings.json");
export const pricesFile = path.join(process.cwd(), "data", "prices.json");
export const commentsFile = path.join(process.cwd(), "data", "comments.json");


// === Anchor connection & program loader ===
export const connection = new anchor.web3.Connection(DEVNET_URL, "confirmed");

const idlPath = path.join(__dirname, "..", "..", "bonding_curve", "bonding_curve", "target", "idl", "bonding_curve.json");
export const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

export function passThroughWallet(publicKeyString) {
  const pk = new PublicKey(publicKeyString);
  return {
    publicKey: pk,
    signAllTransactions: async (txs) => txs,
    signTransaction: async (tx) => tx,
  };
}

export function getProgram(publicKeyString) {
  const provider = new anchor.AnchorProvider(
    connection,
    passThroughWallet(publicKeyString),
    { commitment: "confirmed" }
  );
  return new anchor.Program(idl, provider);
}
