// sse.js
const clients = new Set();

/**
 * Express handler for the SSE endpoint, e.g.
 *   app.get("/stream/holdings", sseHandler)
 */
export function sseHandler(req, res) {
  // Core SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Helpful when behind proxies (nginx) and during local dev
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Flush immediately (if available)
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Tell the client how long to wait before attempting a reconnect
  res.write(`retry: 10000\n`);

  // Initial hello event so the client knows it's connected
  res.write(`event: hello\ndata: {}\n\n`);

  clients.add(res);

  // Keep-alive to prevent idle timeouts (Heroku, proxies, browsers)
  const keepalive = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {}\n\n`);
    } catch {
      // If write fails, drop the client
      clearInterval(keepalive);
      clients.delete(res);
      try { res.end(); } catch {}
    }
  }, 25000); // 25s is a safe, conservative interval

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(keepalive);
    clients.delete(res);
  });
}

/** Internal helper to fan out an SSE event to all clients safely. */
function writeAll(eventName, dataObj) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(dataObj || {})}\n\n`;
  for (const client of [...clients]) {
    try {
      client.write(payload);
    } catch {
      // Remove dead/broken clients
      try { client.end(); } catch {}
      clients.delete(client);
    }
  }
}

/**
 * Broadcast a holdings/reserves update.
 * Expected shape (example):
 * {
 *   source: "internal" | "chain",
 *   mint: "<mint>",
 *   t: <unixSeconds>,
 *   reserveSolLamports: <number>,
 *   poolBase: "<string>"
 * }
 */
export function broadcastHoldings(evt) {
  writeAll("holdings", evt);
}

/**
 * Broadcast a single new/edited comment row.
 * You can send the exact row your GET /comments returns, e.g.:
 * {
 *   mint, id, parentId, author, trip, body, ts
 * }
 */
export function broadcastComment(commentRow) {
  writeAll("comment", { type: "comment", ...commentRow });
}

/** Optional: generic emitter if you want to fan out other event types later. */
export function broadcast(event, data) {
  writeAll(event, data);
}
