// routes/migration.js
import express from "express";
import * as anchor from "@coral-xyz/anchor";
import { migrateIfReady, autoScanAndMigrateAll } from "../instructions/migrate.js";
import { PublicKey } from "@solana/web3.js";
import {
  connection,
  PROGRAM_ID,
  getProgram as getCurveProgram, // optional; we’ll decode with IDL below so this isn’t required
  idl,                           // <-- you already export idl from ../config/index.js
} from "../config/index.js";

const router = express.Router();


/** Match your program’s Phase struct to a simple label. */
function phaseName(p) {
  return p?.migrating ? "Migrating" : p?.raydiumLive ? "RaydiumLive" : "Active";
}

/** Minimal read-only wallet for AnchorProvider (no tx signing). */
const READONLY_WALLET = {
  publicKey: new PublicKey("11111111111111111111111111111111"),
  async signTransaction(tx) { return tx; },
  async signAllTransactions(txs) { return txs; },
};

router.post("/migrate/one", async (req, res) => {
  try {
    const { mint } = req.body || {};
    if (!mint) return res.status(400).json({ error: "mint required" });
    const result = await migrateIfReady(mint);
    res.json(result);
  } catch (err) {
    console.error("POST /migrate/one error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/migrate/scan", async (_req, res) => {
  try {
    const summary = await autoScanAndMigrateAll();
    res.json({ ok: true, summary });
  } catch (err) {
    console.error("POST /migrate/scan error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/pool-info", async (req, res) => {
  try {
    const mintStr = String(req.query.mint || "").trim();
    if (!mintStr) return res.status(400).json({ error: "mint required" });

    const mintPk = new PublicKey(mintStr);
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("liquidity_pool"), mintPk.toBuffer()],
      PROGRAM_ID
    );

    // Use Anchor with your IDL just to decode the account neatly
    const provider = new anchor.AnchorProvider(connection, READONLY_WALLET, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    const program = new anchor.Program(idl, provider);

    const pool = await program.account.liquidityPool.fetch(poolPDA);
    const phase = phaseName(pool?.phase);
    const raydiumPool =
      pool?.raydiumPool && typeof pool.raydiumPool.toBase58 === "function"
        ? pool.raydiumPool.toBase58()
        : null;

    return res.json({
      ok: true,
      mint: mintPk.toBase58(),
      poolPDA: poolPDA.toBase58(),
      phase,
      raydiumPool,
    });
  } catch (err) {
    console.error("GET /pool-info error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
