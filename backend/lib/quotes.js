// lib/quotes.js
const DEFAULT_TTL_MS = 15_000; // refresh every 15s
const TIMEOUT_MS = 4_000;

let cache = {
  solUsd: 0,
  at: 0,         // ms epoch of last success
  src: "",       // which source succeeded
};

function fetchWithTimeout(url, opts = {}, ms = TIMEOUT_MS) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

// Prefer exchange tickers; fall back to public aggregators
async function fetchFromCoinbase() {
  const r = await fetchWithTimeout("https://api.exchange.coinbase.com/products/SOL-USD/ticker", {
    headers: { "User-Agent": "solusd-fetcher" },
  });
  if (!r.ok) throw new Error(`CB HTTP ${r.status}`);
  const j = await r.json();
  const price = Number(j.price);
  if (!Number.isFinite(price)) throw new Error("CB bad price");
  return { price, src: "coinbase" };
}

async function fetchFromKraken() {
  const r = await fetchWithTimeout("https://api.kraken.com/0/public/Ticker?pair=SOLUSD");
  if (!r.ok) throw new Error(`KRAK HTTP ${r.status}`);
  const j = await r.json();
  const pair = j?.result?.SOLUSD || j?.result?.["SOLSUSD"] || j?.result?.["SOLUSD"];
  const price = Number(pair?.c?.[0]);
  if (!Number.isFinite(price)) throw new Error("Kraken bad price");
  return { price, src: "kraken" };
}

async function fetchFromCoinGecko() {
  const r = await fetchWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
  if (!r.ok) throw new Error(`CG HTTP ${r.status}`);
  const j = await r.json();
  const price = Number(j?.solana?.usd);
  if (!Number.isFinite(price)) throw new Error("CG bad price");
  return { price, src: "coingecko" };
}

export function getSolUsdCached() {
  return { price: cache.solUsd, at: cache.at, src: cache.src };
}

export async function refreshSolUsd(now = Date.now()) {
  // If cache is still fresh, keep it
  if (now - cache.at < DEFAULT_TTL_MS && cache.solUsd > 0) return cache;

  // Try preferred -> fallback
  const attempts = [fetchFromCoinbase, fetchFromKraken, fetchFromCoinGecko];
  for (const fn of attempts) {
    try {
      const { price, src } = await fn();
      if (Number.isFinite(price) && price > 0) {
        cache = { solUsd: price, at: now, src };
        return cache;
      }
    } catch {
      // continue
    }
  }

  // If all failed, leave old cache (if any) and surface it
  return cache;
}
