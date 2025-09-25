// routes/comments.js
import express from "express";
import crypto from "crypto";
import pool from "../lib/db.js";
import { loadCommentsForMint, insertCommentRow } from "../lib/files.js";
import { broadcastComment } from "../lib/sse.js";

const router = express.Router();

function sanitizeBody(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function shortId() {
  return crypto.randomBytes(3).toString("hex"); // 6 hex chars
}

// GET /comments?mint=... [&after=ts]
router.get("/comments", async (req, res) => {
  try {
    const { mint, after } = req.query;
    if (!mint) return res.status(400).json({ error: "Mint required" });

    const afterTs = Number(after || 0);
    const comments = await loadCommentsForMint(mint, { afterTs });
    res.json({ mint, comments });
  } catch (e) {
    console.error("GET /comments error:", e);
    res.status(500).json({ error: "failed" });
  }
});

// POST /comments
router.post("/comments", async (req, res) => {
  const client = await pool.connect();
  try {
    const { mint, parentId = null, trip = "", body } = req.body || {};
    if (!mint) return res.status(400).json({ error: "Mint required" });

    const raw = String(body || "").trim();
    if (!raw) return res.status(400).json({ error: "Empty body" });
    if (raw.length > 2000) return res.status(400).json({ error: "Too long" });

    let author = "";
    if ("author" in req.body) {
      author = String(req.body.author || "").trim().slice(0, 32);
    }

    await client.query("begin");

    const row = {
      id: shortId(),
      mint,
      parentId,
      author,
      trip: String(trip || "").slice(0, 12),
      body: sanitizeBody(raw),
      ts: Date.now(),
      // no: let DB handle this!
    };

    await insertCommentRow(client, row);  // row.no will be filled here
    await client.query("commit");

    broadcastComment(row);  // includes the global no
    res.json({ ok: true, comment: row });
  } catch (e) {
    try { await client.query("rollback"); } catch {}
    console.error("POST /comments error:", e);
    res.status(500).json({ error: "failed" });
  } finally {
    client.release();
  }
});

export default router;
