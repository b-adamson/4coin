// lib/sse.js
const GLOBAL = new Set();           // all connections
const BY_MINT = new Map();          // mint -> Set<res>

function safeEnd(res) { try { res.end(); } catch {} }

function addToMint(mint, res) {
  if (!mint) return;
  if (!BY_MINT.has(mint)) BY_MINT.set(mint, new Set());
  BY_MINT.get(mint).add(res);
  res.on("close", () => BY_MINT.get(mint)?.delete(res));
}

function removeDead(set, res) {
  try { res.end(); } catch {}
  set.delete(res);
}

function write(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

function fanout(set, event, data) {
  const snapshot = [...set];
  for (const res of snapshot) {
    try { write(res, event, data); }
    catch { removeDead(set, res); }
  }
}

/** Express handler: GET /stream/holdings?mint=<mint> */
export function sseHandler(req, res) {
  // Core SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const mint = (req.query.mint || "").trim() || null;

  GLOBAL.add(res);
  addToMint(mint, res);

  // connect + suggested retry
  res.write(`retry: 10000\n`);
  write(res, "hello", { ok: true, mint });

  // keepalive
  const keepalive = setInterval(() => {
    try { write(res, "ping", {}); }
    catch {
      clearInterval(keepalive);
      GLOBAL.delete(res);
      safeEnd(res);
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(keepalive);
    GLOBAL.delete(res);
    // (removal from BY_MINT handled by addToMint's close listener)
  });
}

/** Emit to everyone (rare). */
export function emitGlobal(event, payload) {
  fanout(GLOBAL, event, payload);
}

/** Emit only to subscribers of this mint. */
export function emitToMint(mint, event, payload) {
  const set = BY_MINT.get((mint || "").trim());
  if (!set || set.size === 0) return;
  fanout(set, event, payload);
}

/** Back-compat wrappers you already use elsewhere */
export function broadcastHoldings(evt) {
  // If evt has a mint, prefer per-mint; else global
  if (evt?.mint) emitToMint(evt.mint, "holdings", evt);
  else emitGlobal("holdings", evt);
}

export function broadcastComment(commentRow) {
  const payload = { type: "comment", ...commentRow };
  if (commentRow?.mint) emitToMint(commentRow.mint, "comment", payload);
  else emitGlobal("comment", payload);
}

/** New, explicit candle events (DB is source of truth). */
export function broadcastCandleWorking(mint, candleRow) {
  emitToMint(mint, "candle-working", { mint, candle: candleRow });
}

export function broadcastCandleFinalized(mint, candleRow) {
  emitToMint(mint, "candle-finalized", { mint, candle: candleRow });
}

export function broadcastBucketRolled(mint, data) {
  writeAll(mint, `event: bucket-roll\ndata: ${JSON.stringify({ mint, ...data })}\n\n`);
}
