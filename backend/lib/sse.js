const clients = new Set();

export function sseHandler(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.add(res);
  res.write(`event: hello\ndata: {}\n\n`);
  req.on("close", () => clients.delete(res));
}

export function broadcastHoldings(evt) {
  const payload = `event: holdings\ndata: ${JSON.stringify(evt || {})}\n\n`;
  for (const c of clients) {
    try { c.write(payload); } catch {}
  }
}
