import express from "express";
import crypto from "crypto";
import { loadComments, saveComments } from "../lib/files.js";
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
router.get("/comments", (req, res) => {
  try {
    const { mint, after } = req.query;
    if (!mint) return res.status(400).json({ error: "Mint required" });

    const store = loadComments();
    const all = store[mint] || [];

    // Backfill numeric 'no' once for any comment that lacks it.
    let changed = false;
    for (let i = 0; i < all.length; i++) {
      if (all[i].no == null) {
        const prevNo = i > 0 ? Number(all[i - 1]?.no || 0) : 0;
        all[i].no = prevNo + 1;
        changed = true;
      }
    }
    if (changed) saveComments(store);

    const afterTs = Number(after || 0);
    const filtered = afterTs ? all.filter((c) => c.ts > afterTs) : all;
    const sorted = filtered.slice().sort((a, b) => b.ts - a.ts);

    res.json({ mint, comments: sorted.slice(0, 200) });
  } catch (e) {
    console.error("GET /comments error:", e);
    res.status(500).json({ error: "failed" });
  }
});

// POST /comments
// Body: { mint, parentId?, author?, trip?, body }
router.post("/comments", (req, res) => {
  try {
    const { mint, parentId = null, author = "Anonymous", trip = "", body } = req.body || {};
    if (!mint) return res.status(400).json({ error: "Mint required" });

    const raw = String(body || "").trim();
    if (!raw) return res.status(400).json({ error: "Empty body" });
    if (raw.length > 2000) return res.status(400).json({ error: "Too long" });

    const store = loadComments();
    if (!store[mint]) store[mint] = [];
    const arr = store[mint];

    // numeric No that persists forward
    const lastNo = arr.length ? Number(arr[arr.length - 1]?.no || 0) : 0;
    const nextNo = lastNo + 1;

    const row = {
      id: shortId(),
      mint,
      parentId: parentId || null,
      author: String(author || "Anonymous").slice(0, 32),
      trip: String(trip || "").slice(0, 12),
      body: sanitizeBody(raw),
      ts: Date.now(),
      no: nextNo,
    };

    arr.push(row);

    // cap per-mint (keep newest ~10k)
    const MAX = 10000;
    if (arr.length > MAX) arr.splice(0, arr.length - MAX);

    saveComments(store);

    // SSE broadcast (single event)
    broadcastComment(row);

    res.json({ ok: true, comment: row });
  } catch (e) {
    console.error("POST /comments error:", e);
    res.status(500).json({ error: "failed" });
  }
});

export default router;
