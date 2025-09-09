// routes/migration.js
import express from "express";
import { migrateIfReady, autoScanAndMigrateAll } from "../instructions/migrate.js";
import { idl } from "../config/index.js"

const router = express.Router();

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

export default router;
