"use client";

import { useEffect, useRef, useState } from "react";
import * as solanaWeb3 from "@solana/web3.js";
import { useSearchParams, useRouter } from "next/navigation";
import { useWallet } from "@/app/AppShell";

import Leaderboard from "../components/leaderboard";
import BondingCurve from "../components/BondingCurve";
import PriceChart from "../components/PriceChart";
import Comments from "../components/Comments";

import {
  LAMPORTS_PER_SOL,
  CAP_TOKENS,
  toLamports,
  fromLamports,
  buildLUTModel,
  baseToWhole,
} from "../utils";

import { useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";


/**
 * Floor a timestamp (ms) to a bucket size (sec) and return unix seconds.
 */
function floorToBucketSec(tsMs, bucketSec) {
  return Math.floor(tsMs / 1000 / bucketSec) * bucketSec;
}

function buildDevNet(trades, bucketSec, candles) {
  const byBucket = new Map();
  for (const t of trades) {
    if (!t.isDev) continue; // your backend marks dev trades
    const b = Math.floor(t.tsSec / bucketSec) * bucketSec;
    const sign = t.side === "buy" ? 1 : -1;
    byBucket.set(b, (byBucket.get(b) || 0) + sign * (Number(t.sol) || 0));
  }
  const candleTimes = new Set(candles.map(c => c.time));
  return Array.from(byBucket.entries())
    .filter(([time, net]) => candleTimes.has(time) && net !== 0)
    .map(([time, netSol]) => ({ time, netSol }));
}

/**
 * Spot price (SOL per token) via a small forward secant on the curve.
 */
function spotPriceSOLPerToken(modelObj, x0) {
  if (!modelObj || !Number.isFinite(x0)) return null;
  const DX = 0.01;
  const x1 = Math.min(modelObj.X_MAX, x0 + DX);
  if (x1 <= x0) return null;
  const tokens = modelObj.tokens_between(x0, x1);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return (x1 - x0) / tokens;
}

/**
 * Build confirmed OHLC candles from movement-only ticks.
 * Buckets by `bucketSec`, fills gaps, and carries-forward opens for continuity.
 */
function buildCandlesFromTicks(ticks, model, bucketSec = 10) {
  if (!model || !Array.isArray(ticks) || ticks.length === 0) return [];

  const byBucket = new Map();

  for (const s of ticks) {
    const x = (s.reserveSolLamports || 0) / LAMPORTS_PER_SOL;
    const price = spotPriceSOLPerToken(model, x);
    if (!Number.isFinite(price)) continue;

    const b = Math.floor((s.t || 0) / bucketSec) * bucketSec;
    const c = byBucket.get(b);
    if (!c) {
      byBucket.set(b, { time: b, open: price, high: price, low: price, close: price });
    } else {
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
    }
  }
  if (byBucket.size === 0) return [];

  // Fill gaps and force each bucket's open = previous close
  const sorted = Array.from(byBucket.keys()).sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const out = [];
  let t = first;
  let lastClose = null;

  while (t <= last) {
    const real = byBucket.get(t);
    if (real) {
      const open = lastClose != null ? lastClose : real.open;
      const c = {
        time: t,
        open,
        high: Math.max(real.high, open),
        low: Math.min(real.low, open),
        close: real.close,
      };
      out.push(c);
      lastClose = c.close;
    } else if (lastClose != null) {
      out.push({ time: t, open: lastClose, high: lastClose, low: lastClose, close: lastClose });
    }
    t += bucketSec;
  }

  return out;
}

function buildCandlesAndMcapFromTicks(ticks, model, bucketSec = 10) {
  if (!model || !Array.isArray(ticks) || ticks.length === 0) return { price: [], mcap: [] };

  const priceMap = new Map();
  const mcapMap  = new Map();

  for (const s of ticks) {
    const xSol = (s.reserveSolLamports || 0) / LAMPORTS_PER_SOL;

    // PRICE (SOL per token)
    const px = spotPriceSOLPerToken(model, xSol);
    if (Number.isFinite(px)) {
      const b = Math.floor((s.t || 0) / bucketSec) * bucketSec;
      const c = priceMap.get(b);
      if (!c) priceMap.set(b, { time: b, open: px, high: px, low: px, close: px });
      else { c.high = Math.max(c.high, px); c.low = Math.min(c.low, px); c.close = px; }
    }

    // MCAP (total SOL in vault = xSol)
    if (Number.isFinite(xSol)) {
      const b = Math.floor((s.t || 0) / bucketSec) * bucketSec;
      const c = mcapMap.get(b);
      if (!c) mcapMap.set(b, { time: b, open: xSol, high: xSol, low: xSol, close: xSol });
      else { c.high = Math.max(c.high, xSol); c.low = Math.min(c.low, xSol); c.close = xSol; }
    }
  }

  // Fill gaps & carry-forward open using your existing pattern
  function finalize(map) {
    if (map.size === 0) return [];
    const sorted = Array.from(map.keys()).sort((a,b)=>a-b);
    const first = sorted[0], last = sorted[sorted.length-1];
    const out = [];
    let t = first, lastClose = null;
    while (t <= last) {
      const real = map.get(t);
      if (real) {
        const open = lastClose != null ? lastClose : real.open;
        const c = {
          time: t,
          open,
          high: Math.max(real.high, open),
          low:  Math.min(real.low, open),
          close: real.close,
        };
        out.push(c);
        lastClose = c.close;
      } else if (lastClose != null) {
        out.push({ time: t, open: lastClose, high: lastClose, low: lastClose, close: lastClose });
      }
      t += bucketSec;
    }
    return out;
  }

  return { price: finalize(priceMap), mcap: finalize(mcapMap) };
}

function ProgressBar({ pct = 0 }) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  return (
    <div
      aria-label={`Progress ${clamped.toFixed(2)}%`}
      style={{
        width: "100%",
        height: "14px",
        border: "1px solid #000",
        background: "#fff",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: `${clamped}%`,
          height: "100%",
          background: "#000",
        }}
      />
    </div>
  );
}

export default function TokenPage() {
  const search = useSearchParams();
  const router = useRouter();
  const qs = search.toString(); // changes whenever ?mint or ?wallet changes
  const { wallet, setWallet } = useWallet();

  const { publicKey, connected, sendTransaction, signTransaction } = useAdapterWallet();
  const { setVisible: openWalletModal } = useWalletModal();

  const [headerTokens, setHeaderTokens] = useState([]);

  // --- Routing / identity ---
  const [mint, setMint] = useState("");
  // const [wallet, setWallet] = useState("");

  // --- Token + metadata ---
  const [meta, setMeta] = useState(null);
  const [token, setToken] = useState(null);

  // --- Chart state: confirmed history + live pending overlay ---
  const [confirmedCandles, setConfirmedCandles] = useState([]);
  const [pendingCandle, setPendingCandle] = useState(null);
  const [devNet, setDevNet] = useState([]);

  const [chartUnit, setChartUnit] = useState("SOL"); // "SOL" | "USD"
  const [metric, setMetric] = useState("PRICE");         // "PRICE" | "MCAP"

  const [mcapCandles, setMcapCandles] = useState([]);
  const [pendingMcap, setPendingMcap] = useState(null);

  const devNetMapRef = useRef(new Map());
  const bucket = (tsSec, sec) => Math.floor(tsSec / sec) * sec;

  const mcapCandlesRef = useRef(mcapCandles);
  const pendingMcapRef = useRef(pendingMcap);
  useEffect(() => { mcapCandlesRef.current = mcapCandles; }, [mcapCandles]);
  useEffect(() => { pendingMcapRef.current = pendingMcap; }, [pendingMcap]);

  // --- UI status + trade state ---
  const [status, setStatus] = useState("");
  const [amount, setAmount] = useState("");
  const [unitMode, setUnitMode] = useState("sol"); // "sol" | "token"
  const [tradeMode, setTradeMode] = useState("buy"); // "buy" | "sell"
  const [conversion, setConversion] = useState(0);

  // --- Pool + wallet reserves ---
  const [reserves, setReserves] = useState({ reserveSol: 0, reserveTokenBase: "0" });
  const [walletBalance, setWalletBalance] = useState(0); // SOL (informational)

  // --- LUT model (once decimals known) ---
  const [model, setModel] = useState(null);

  // --- Leaderboard change signalling ---
  const [lbVersion, setLbVersion] = useState(0);
  const lbDebounceRef = useRef(null);
  const lastChainSnapshotRef = useRef({ reserveSol: null, poolBase: null });

  // --- Migration status / Raydium pool (NEW) ---
  const [poolPhase, setPoolPhase] = useState(null); // "Migrating" | "RaydiumLive" | null
  const [raydiumPool, setRaydiumPool] = useState(null); // pool id (string) once live

  // ms/sec safe -> bucket start (seconds)
  const bucketize = (tsMaybeMs, bucketSec) => {
    const sec = tsMaybeMs > 1e12 ? Math.floor(tsMaybeMs / 1000) : Math.floor(tsMaybeMs);
    return Math.floor(sec / bucketSec) * bucketSec;
  };


  // Devnet Raydium/explorer link builder (NEW)
  function raydiumDevnetLinks({ poolId, mintStr, sig }) {
    const EXPL = "https://explorer.solana.com";
    const RAY  = "https://raydium.io";
    const WSOL = "So11111111111111111111111111111111111111112";
    const m = (mintStr || "").trim();

    return {
      explorerTx:   sig ? `${EXPL}/tx/${sig}?cluster=devnet` : null,
      explorerPool: poolId ? `${EXPL}/address/${poolId}?cluster=devnet` : null,
      raydiumPool:  poolId ? `${RAY}/pool/${poolId}?cluster=devnet` : null,
      raydiumSwap:  m ? `${RAY}/swap/?cluster=devnet&inputMint=sol&outputMint=${encodeURIComponent(m)}` : null,
      raydiumAddLiq: m ? `${RAY}/liquidity/add/?cluster=devnet&base=${encodeURIComponent(m)}&quote=${WSOL}` : null,
    };
  }

  function rebuildDevNetForDisplay() {
    const mergedTimes = new Set([
      ...confirmedCandlesRef.current.map(c => c.time),
      ...(pendingCandleRef.current ? [pendingCandleRef.current.time] : []),
    ]);
    const arr = [];
    for (const [t, net] of devNetMapRef.current.entries()) {
      if (mergedTimes.has(t) && net !== 0) arr.push({ time: t, netSol: net });
    }
    arr.sort((a,b) => a.time - b.time);
    setDevNet(arr);
  }

  // --- Decimals / scale ---
  const dec = typeof token?.decimals === "number" ? token.decimals : 9;
  const scale = 10 ** dec;

  // --- History sampling & ranges ---
  const BASE_SAMPLE_SEC = 10; // server-side tick cadence
  const RANGE_PRESETS = {
    "3d": { seconds: 3 * 86400, bucketSec: 900 }, // 15m
    "1w": { seconds: 7 * 86400, bucketSec: 3600 }, // 1h
    "1m": { seconds: 30 * 86400, bucketSec: 86400 }, // 1d
  };
  const [rangeKey, setRangeKey] = useState("3d");
  const visBucketSec = RANGE_PRESETS[rangeKey].bucketSec;

  // ---- add these near your other refs (top-level in component)
  const esRef = useRef(null);

  // keep changing values in refs so the SSE effect doesn't need them as deps
  const modelRef = useRef(model);
  useEffect(() => { modelRef.current = model; }, [model]);

  const visBucketSecRef = useRef(visBucketSec);
  useEffect(() => { visBucketSecRef.current = visBucketSec; }, [visBucketSec]);

  const rangeKeyRef = useRef(rangeKey);
  useEffect(() => { rangeKeyRef.current = rangeKey; }, [rangeKey]);

  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; }, [token]);

  // --- Refs to latest candles for use inside effects/callbacks ---
  const confirmedCandlesRef = useRef(confirmedCandles);
  const pendingCandleRef = useRef(pendingCandle);
  useEffect(() => {
    confirmedCandlesRef.current = confirmedCandles;
  }, [confirmedCandles]);
  useEffect(() => {
    pendingCandleRef.current = pendingCandle;
  }, [pendingCandle]);

  // --- Small helpers that need model / state ---
  function spotFromLamports(rLamports) {
    if (!model || !Number.isFinite(rLamports)) return null;
    return spotPriceSOLPerToken(model, rLamports / LAMPORTS_PER_SOL);
  }

  function bumpLeaderboardDebounced(delay = 120) {
    if (lbDebounceRef.current) clearTimeout(lbDebounceRef.current);
    lbDebounceRef.current = setTimeout(() => setLbVersion((v) => v + 1), delay);
  }

  function makePendingFromPrice(price, tsMs = Date.now()) {
    if (!isFinite(price) || price <= 0) return null;
    const bucket = floorToBucketSec(tsMs, visBucketSec);
    const lastConf = confirmedCandlesRef.current[confirmedCandlesRef.current.length - 1];

    if (!lastConf || lastConf.time !== bucket) {
      const open = lastConf ? lastConf.close : price;
      return { time: bucket, open, high: Math.max(open, price), low: Math.min(open, price), close: price };
    }

    return {
      time: lastConf.time,
      open: lastConf.open,
      high: Math.max(lastConf.high, price),
      low: Math.min(lastConf.low, price),
      close: price,
    };
  }

  function makePendingFromValue(value, tsMs, bucketSec, lastConfirmed) {
    if (!isFinite(value) || value <= 0) return null;
    const bucketTime = floorToBucketSec(tsMs ?? Date.now(), bucketSec);

    if (!lastConfirmed || lastConfirmed.time !== bucketTime) {
      const open = lastConfirmed ? lastConfirmed.close : value;
      return { time: bucketTime, open, high: Math.max(open, value), low: Math.min(open, value), close: value };
    }
    return {
      time: lastConfirmed.time,
      open: lastConfirmed.open,
      high: Math.max(lastConfirmed.high, value),
      low: Math.min(lastConfirmed.low, value),
      close: value,
    };
  }

  function makePendingMcap(solVaultLamports, tsMs = Date.now()) {
    const xSol = (solVaultLamports || 0) / LAMPORTS_PER_SOL;
    const last = mcapCandlesRef.current[mcapCandlesRef.current.length - 1];
    return makePendingFromValue(xSol, tsMs, visBucketSecRef.current, last);
  }

  function formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function handleConnect() {
    openWalletModal(true);
  } 

  // --- Initialization: mint + wallet from URL (react to changes) ---
  useEffect(() => {
    setMint(search.get("mint") || "");
    // setWallet(search.get("wallet") || "");
  }, [qs]);

  // --- Build LUT model once decimals are known ---
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const m = await buildLUTModel(dec);
        if (!cancel) setModel(m);
      } catch (e) {
        console.error("Model build failed:", e);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [dec]);

  useEffect(() => {
    // whenever the URL mint changes, clear old state to avoid leaks
    setPoolPhase(null);
    setRaydiumPool(null);
    setConfirmedCandles([]);  
    setPendingCandle(null);
    setMcapCandles([]);
    setPendingMcap(null);
  }, [mint]);

  // --- Load token/meta/reserves once we have mint + wallet ---
  useEffect(() => {
    if (!mint) return;
    let cancelled = false;
    const mintAtCall = mint;

    (async () => {
      try {
        const res = await fetch(`http://localhost:4000/token-info?mint=${mintAtCall}`);
        const tokenData = await res.json();
        if (cancelled || mintAtCall !== mint) return; // ignore stale response

        if (!res.ok || !tokenData || !tokenData.metadataUri) {
          setStatus("❌ Token not found.");
          return;
        }

        const metaRes = await fetch(tokenData.metadataUri);
        const metaData = await metaRes.json();
        if (cancelled || mintAtCall !== mint) return;

        setToken({ ...tokenData, dev: tokenData.dev || tokenData.creator || null });
        setMeta(metaData);

        if (tokenData?.poolPhase) setPoolPhase(tokenData.poolPhase);
        if (tokenData?.phase) setPoolPhase(tokenData.phase);
        if (tokenData?.raydiumPool) setRaydiumPool(tokenData.raydiumPool);

        // ---- Seed reserves immediately (so converter/prices work instantly)
        try {
          const holdingsRes = await fetch(
            `http://localhost:4000/leaderboard?mint=${mintAtCall}`,
            { cache: "no-store" }
          );
          if (cancelled || mintAtCall !== mint) return;
 
          if (holdingsRes.ok) {
            const holdings = await holdingsRes.json();
            const bondRow = holdings?.leaderboard?.find?.(h => h.isBonding);
            const poolBase = bondRow?.balanceBase;
            const poolBaseSafe =
              (tokenData?.phase === "Active" || tokenData?.poolPhase === "Active") &&
              (!poolBase || poolBase === "0")
                ? String(800_000_000n * 10n ** BigInt(tokenData.decimals ?? 9))
                : String(poolBase ?? "0");
            setReserves({
              // token-info already carries current curve reserve (lamports)
              reserveSol: Number(tokenData?.bondingCurve?.reserveSol || 0),
              reserveTokenBase: poolBaseSafe,
            });
          } else {
            // Fall back to zeros to unlock UI logic
            setReserves({ reserveSol: 0, reserveTokenBase: "0" });
          }
        } catch {
          setReserves({ reserveSol: 0, reserveTokenBase: "0" });
        }

      } catch (err) {
        if (!cancelled) {
          console.error("Error loading token:", err);
          setStatus("❌ Failed to load token.");
        }
      }
    })();

    return () => { cancelled = true; };
  }, [mint]);

  const [solUsd, setSolUsd] = useState(0);

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const r = await fetch("http://localhost:4000/sol-usd", { cache: "no-store" });
        const j = await r.json();
        if (!stop && Number.isFinite(j?.price)) setSolUsd(j.price);
      } catch {}
    }
    load();
    const id = setInterval(load, 30_000); // 30s feels fine; server cache is 15s
    return () => { stop = true; clearInterval(id); };
  }, []);

  // --- Header tokens enrichment ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("http://localhost:4000/tokens", { cache: "no-store" });
        const base = await res.json();

        const enriched = await Promise.all(
          base.map(async (t) => {
            try {
              const infoRes = await fetch(`http://localhost:4000/token-info?mint=${t.mint}`, { cache: "no-store" });
              const info = await infoRes.json();
              return { ...t, reserveLamports: Number(info?.bondingCurve?.reserveSol || 0) };
            } catch {
              return { ...t, reserveLamports: 0 };
            }
          })
        );

        if (!cancelled) setHeaderTokens(enriched);
      } catch (e) {
        console.error("TokenPage: header tokens fetch failed", e);
        if (!cancelled) setHeaderTokens([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Poll pool phase / raydium poolId (lightweight; optional backend endpoint) (NEW) ---
  useEffect(() => {
    if (!mint) return;
    let cancelled = false;
    let timer;

    async function poll() {
      const mintAtCall = mint;
      try {
        const r = await fetch(`http://localhost:4000/pool-info?mint=${mintAtCall}`, { cache: "no-store" });
        if (!r.ok || cancelled || mintAtCall !== mint) return;
        const d = await r.json();
        if (cancelled || mintAtCall !== mint) return;
        if (d?.phase) setPoolPhase(d.phase);
        const pid = d?.raydiumPool || d?.poolId || null;
        if (pid) setRaydiumPool(pid);
      } catch {/* ignore */}
    }

    poll();
    timer = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [mint]);

  // --- Seed confirmed history from server on load / when range changes ---
  useEffect(() => {
    if (!mint || !model) return;
    (async () => {
      try {
        const needSec = RANGE_PRESETS[rangeKey].seconds;
        const roughNeeded = Math.ceil(needSec / BASE_SAMPLE_SEC) + 200;
        const limit = Math.min(50000, Math.max(1000, roughNeeded));

        const resp = await fetch(`http://localhost:4000/price-history?mint=${mint}&limit=${limit}`);
        if (!resp.ok) return;
        const { ticks = [], devTrades = [] } = await resp.json(); // backend can return devTrades too

        const both = buildCandlesAndMcapFromTicks(ticks, model, visBucketSec);
        const cutoff = Math.floor(Date.now() / 1000) - RANGE_PRESETS[rangeKey].seconds;
        const pricePruned = (both.price || []).filter(c => c.time >= cutoff - visBucketSec);
        const mcapPruned  = (both.mcap  || []).filter(c => c.time >= cutoff - visBucketSec);
        setConfirmedCandles(pricePruned);
        setMcapCandles(mcapPruned);

        devNetMapRef.current.clear();

        for (const t of devTrades || []) {
          // tolerate different field names from backend
          const ts = t.tsSec ?? t.t ?? t.time ?? 0;
          const side = t.side || (t.solDelta > 0 ? "buy" : "sell");
          const sol = Number(t.sol ?? t.solAbs ?? t.solDelta ?? 0);

          // only aggregate when explicitly marked dev, or wallet equals known dev
          const isDevTrade = t.isDev === true || t.actor === "dev" || t.wallet === token?.dev || t.owner === token?.dev;
          if (!isDevTrade || !Number.isFinite(sol) || sol === 0) continue;

          const b = bucketize(ts, visBucketSec);
          const signed = (side === "buy" ? 1 : -1) * Math.abs(sol);
          devNetMapRef.current.set(b, (devNetMapRef.current.get(b) || 0) + signed);
        }

        rebuildDevNetForDisplay();
        setPendingCandle(null);

        // build dev markers aligned with these candles
        setDevNet(buildDevNet(devTrades, visBucketSec, pricePruned));
      } catch (e) {
        console.error("Seed /price-history failed", e);
      }
    })();
  }, [mint, model, rangeKey, visBucketSec]);

  // --- Live updates via SSE ---
  useEffect(() => {
    if (!mint) return;

    // Close any existing stream first (guards Strict Mode/HMR + mint changes)
    if (esRef.current) {
      try { esRef.current.close(); } catch {}
      esRef.current = null;
    }

    // Pass mint to the server so it can filter fanout
    const url = `http://localhost:4000/stream/holdings?mint=${encodeURIComponent(mint)}`;
    const es = new EventSource(url);
    esRef.current = es;

    const onMessage = async (ev) => {
      if (!ev?.data) return;

      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }

      // hard filter on mint (extra safety even if server filters)
      const msgMint = payload?.mint;
      if (!msgMint || msgMint !== mint) return;

      // phase / raydium updates for instant UI flip
      if (payload?.phase) setPoolPhase(payload.phase);
      if (payload?.raydiumPool) setRaydiumPool(payload.raydiumPool);

      const src = payload?.source; // "internal" | "chain"
      const rLamports = Number(payload?.reserveSolLamports);
      const poolBaseStr = payload?.poolBase != null ? String(payload.poolBase) : null;

      if (Number.isFinite(rLamports) && poolBaseStr) {
        setReserves({ reserveSol: rLamports, reserveTokenBase: poolBaseStr });
      }

      // live pending candle from spot
      const liveSpot = (() => {
        const m = modelRef.current;
        if (!m || !Number.isFinite(rLamports)) return null;
        const LAMPORTS_PER_SOL = 1_000_000_000;
        return spotPriceSOLPerToken(m, rLamports / LAMPORTS_PER_SOL);
      })();

      if (Number.isFinite(liveSpot)) {
        setPendingCandle(() => makePendingFromPrice(liveSpot));
      }

      if (Number.isFinite(rLamports)) {
        setPendingMcap(() => makePendingMcap(rLamports, payload?.t ? payload.t * 1000 : Date.now()));
      }

      // dev net aggregation (use tokenRef/current state)
      const devAddr = tokenRef.current?.dev || null;
      const looksDev =
        payload?.isDev === true ||
        payload?.actor === "dev" ||
        (devAddr && (payload?.wallet === devAddr || payload?.owner === devAddr));

      const solCandidate = Number(payload?.sol ?? payload?.solAbs ?? payload?.solDelta);
      if (looksDev && Number.isFinite(solCandidate)) {
        const ts = payload.tsSec ?? payload.t ?? payload.time ?? Date.now();
        const bucketSize = visBucketSecRef.current;
        const sec = ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
        const b = Math.floor(sec / bucketSize) * bucketSize;

        const side = payload.side || (solCandidate > 0 ? "buy" : "sell");
        const signed = (side === "buy" ? 1 : -1) * Math.abs(solCandidate);
        devNetMapRef.current.set(b, (devNetMapRef.current.get(b) || 0) + signed);
        rebuildDevNetForDisplay();
      }

      // chain tick: detect state changes + bucket boundary finalize
      if (src === "chain") {
        const tSec = Number(payload?.t);
        if (!Number.isFinite(tSec)) return;

        const sameReserve = lastChainSnapshotRef.current.reserveSol === rLamports;
        const samePool = lastChainSnapshotRef.current.poolBase === poolBaseStr;
        if (!sameReserve || !samePool) {
          lastChainSnapshotRef.current = { reserveSol: rLamports, poolBase: poolBaseStr };
          bumpLeaderboardDebounced(150);
        }

        const bucketSize = visBucketSecRef.current;
        const chainVisBucket = Math.floor(tSec / bucketSize) * bucketSize;
        const lastConf = confirmedCandlesRef.current[confirmedCandlesRef.current.length - 1];
        const lastConfTime = lastConf?.time ?? null;
        const crossedBoundary = lastConfTime != null && chainVisBucket > lastConfTime;

        if (crossedBoundary) {
          try {
            const RANGE_PRESETS_LOCAL = RANGE_PRESETS; // already in scope
            const range = rangeKeyRef.current;
            const needSec = RANGE_PRESETS_LOCAL[range].seconds;
            const BASE_SAMPLE_SEC_LOCAL = BASE_SAMPLE_SEC;

            const roughNeeded = Math.ceil(needSec / BASE_SAMPLE_SEC_LOCAL) + 200;
            const limit = Math.min(50000, Math.max(1000, roughNeeded));

            const fullRes = await fetch(`http://localhost:4000/price-history?mint=${mint}&limit=${limit}`);
            if (fullRes.ok) {
              const { ticks = [] } = await fullRes.json();
              const m = modelRef.current;
              const vis = visBucketSecRef.current;
              const both = buildCandlesAndMcapFromTicks(ticks, m, vis);
              const cutoff = Math.floor(Date.now() / 1000) - RANGE_PRESETS_LOCAL[range].seconds;
              const pricePruned = (both.price || []).filter(c => c.time >= cutoff - vis);
              const mcapPruned  = (both.mcap  || []).filter(c => c.time >= cutoff - vis);
              setConfirmedCandles(pricePruned);
              setMcapCandles(mcapPruned);
            }
          } catch (e) {
            console.error("Finalize (chain boundary) failed", e);
          }
          setPendingCandle(null);
          setPendingMcap(null);
        }
      }
    };

    const onComment = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (!msg || msg.mint !== mint) return;
        window.dispatchEvent(new CustomEvent("live-comment", { detail: msg }));
      } catch {}
    };

    es.addEventListener("comment", onComment);
    es.addEventListener("hello", onMessage);
    es.addEventListener("holdings", onMessage);

    es.onopen = () => console.log("[SSE] open");
    es.onerror = (e) => {
      // Note: browsers will auto-retry based on `retry:` we send
      console.log("[SSE] error", e);
    };

    return () => {
      es.removeEventListener("hello", onMessage);
      es.removeEventListener("holdings", onMessage);
      es.removeEventListener("comment", onComment);

      try { es.close(); } catch {}
      esRef.current = null;
      console.log("[SSE] closed");
    };
  }, [mint]); // ⬅ ONLY mint

  useEffect(() => {
    rebuildDevNetForDisplay();
  }, [confirmedCandles, pendingCandle]);

  // --- Derived state from reserves + model ---
  const hasReserves =
    reserves &&
    reserves.reserveTokenBase != null &&
    reserves.reserveTokenBase !== "unknown";
  const brandNew =
    poolPhase === "Active" &&
    Number(reserves?.reserveSol ?? 0) === 0 &&
    BigInt(reserves?.reserveTokenBase ?? "0") === 0n;
  const poolWhole = brandNew
    ? CAP_TOKENS
    : (hasReserves ? baseToWhole(reserves.reserveTokenBase, dec) : 0);
  const capWhole = CAP_TOKENS;
  const ySoldWhole = brandNew
    ? 0
    : (model && hasReserves ? capWhole - Math.min(poolWhole, capWhole) : 0);
  const x0 = model && hasReserves ? reserves.reserveSol / LAMPORTS_PER_SOL : 0;

  const totalRaisedSOL = hasReserves ? fromLamports(reserves.reserveSol) : 0;
  const progressTokensPct = model ? Math.min(100, (ySoldWhole / CAP_TOKENS) * 100) : 0;
  const targetSOL = model ? model.X_MAX : 0;
  const remainingSOL = model ? Math.max(0, model.X_MAX - x0) : 0;

  // --- Input capping vs curve limits / vault balances ---
  useEffect(() => {
    if (!model || !hasReserves) return;
    const v = parseFloat(amount);
    if (!v || v <= 0) return;

    const remainingTokens = Math.max(0, capWhole - ySoldWhole);
    const remainingSol = model.cost_between_SOL(x0, model.X_MAX);

    if (tradeMode === "buy" && unitMode === "sol" && v > remainingSol) {
      setAmount(String(remainingSol));
    }

    if (tradeMode === "buy" && unitMode === "token" && v > remainingTokens) {
      setAmount(String(remainingTokens));
    }

    if (tradeMode === "sell" && unitMode === "token") {
      const maxTokens = Math.max(0, Math.min(poolWhole, ySoldWhole));
      if (v > maxTokens) setAmount(String(maxTokens));
    }

    if (tradeMode === "sell" && unitMode === "sol") {
      const maxCurveSol = model.cost_between_SOL(0, x0);
      const maxVaultSol = reserves.reserveSol / LAMPORTS_PER_SOL;
      const maxSolOut = Math.max(0, Math.min(maxCurveSol, maxVaultSol));
      if (v > maxSolOut) setAmount(String(maxSolOut));
    }
  }, [tradeMode, unitMode, amount, reserves, hasReserves, model, x0, ySoldWhole, poolWhole, capWhole]);

  // --- Live conversion preview (Buy/Sell × SOL/Token) ---
  useEffect(() => {
    if (!model || !hasReserves) {
      setConversion(0);
      return;
    }
    const val = parseFloat(amount);
    if (!val || val <= 0) {
      setConversion(0);
      return;
    }

    let result = 0;

    if (tradeMode === "buy") {
      if (unitMode === "sol") {
        const x1 = model.x_after_buying_SOL(x0, val);
        result = model.tokens_between(x0, x1);
      } else {
        const x1 = model.x_after_buying_tokens(x0, val);
        result = model.cost_between_SOL(x0, x1);
      }
    } else {
      if (unitMode === "token") {
        const x1 = model.x_after_selling_tokens(x0, val);
        result = model.cost_between_SOL(x1, x0);
      } else {
        const x1 = model.x_after_selling_SOL(x0, val);
        result = model.tokens_between(x1, x0);
      }
    }

    setConversion(Number.isFinite(result) ? result : 0);
  }, [amount, unitMode, tradeMode, reserves, hasReserves, model, x0, ySoldWhole, poolWhole]);

  // --- Helpers to compute submission amounts ---
  function getLamportsForSubmit() {
    const val = parseFloat(amount) || 0;
    if (val <= 0) return 0;
    if (unitMode === "sol") return toLamports(val);
    return toLamports(conversion || 0);
  }

  function getTokenBaseForSubmit() {
    const val = parseFloat(amount) || 0;
    if (val <= 0) return 0;
    const tokensWhole = unitMode === "sol" ? conversion || 0 : val;
    return Math.floor(tokensWhole * scale);
  }

  // --- Backend notification after a confirmed chain tx ---
  async function updateHoldings(sig, type) {
    try {
      await fetch("http://localhost:4000/update-holdings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sig,
          wallet,
          mint,
          type,
          tokenAmountBase: getTokenBaseForSubmit(),
          solLamports: getLamportsForSubmit(),
        }),
      });
    } catch (err) {
      console.error("Holdings update error:", err);
    }
  }

  // --- Submit buy/sell ---
  async function handleSubmit() {
    if (!connected || !publicKey || !wallet) {
      setStatus("❌ Please connect your wallet first.");
      return;
    }
    const val = parseFloat(amount);
    if (!val || val <= 0) {
      setStatus("❌ Invalid amount.");
      return;
    }

    const endpoint = tradeMode === "buy" ? "buy" : "sell";
    const lamportsBudget = getLamportsForSubmit(); // for buy
    const tokensInBase = getTokenBaseForSubmit(); // for sell
    const amountToSend = tradeMode === "buy" ? lamportsBudget : tokensInBase;

    if (!amountToSend || amountToSend <= 0) {
      setStatus("❌ Amount resolves to 0.");
      return;
    }

    setStatus(`💸 ${tradeMode === "buy" ? "Buying" : "Selling"} ${val} ${unitMode.toUpperCase()}...`);

    try {
      // Build tx on backend
      const txRes = await fetch(`http://localhost:4000/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet, mintPubkey: mint, amount: amountToSend }),
      });
      const txData = await txRes.json();
      if (!txRes.ok || !txData.txBase64) throw new Error(txData.error || "Transaction error");

      // Deserialize + simulate
      const txBytes = Uint8Array.from(atob(txData.txBase64), (c) => c.charCodeAt(0));
      const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
      const conn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");

      const sim = await conn.simulateTransaction(tx);
      console.log(sim);
      if (sim.value.err) throw new Error("Simulation failed: " + JSON.stringify(sim.value.err));

      // Sign + send
      let sigstr = "";
      try {
        sigstr = await sendTransaction(tx, conn, { preflightCommitment: "confirmed" });
      } catch (primaryErr) {
        // Fallback: sign locally, then send raw
        if (typeof signTransaction !== "function") throw primaryErr;
        const signed = await signTransaction(tx);
        const wire = signed.serialize();
        sigstr = await conn.sendRawTransaction(wire, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
      }

      await conn.confirmTransaction(sigstr, "confirmed");
      await updateHoldings(sigstr, tradeMode);
      setLbVersion((v) => v + 1);

      setStatus(
        `✅ ${tradeMode.toUpperCase()} successful! <a target="_blank" href="https://explorer.solana.com/tx/${sigstr}?cluster=devnet">View Transaction</a>`
      );
      // Pending overlay reconciled by SSE refresh
    } catch (err) {
      console.error("Transaction error:", err);
      setPendingCandle(null);
      setStatus("❌ Transaction failed: " + (err.message || String(err)));
    }
  }

  // --- Migration-aware UI flags (NEW) ---
  const curveComplete = !!model && hasReserves && ySoldWhole >= CAP_TOKENS;
  const migrationLive = !!raydiumPool || poolPhase === "RaydiumLive";
  const migratingNow = poolPhase === "Migrating";
  const raydiumLinks = migrationLive
    ? raydiumDevnetLinks({ poolId: raydiumPool, mintStr: mint, sig: null })
    : {};

  return (
    <main key={mint} style={{ maxWidth: "900px", margin: "0", padding: "0" }}>
      <div style={{ display: "flex", gap: "2rem" }}>
        <div style={{ flex: 2, minWidth: 0 }}>
          {meta && token ? (
            <>
              <h2>{meta.name}</h2>

              <img
                src={meta.image}
                alt="Token Icon"
                style={{ maxWidth: "120px", borderRadius: "16px", margin: "1rem 0" }}
              />

              <p>{meta.description || token.symbol}</p>

              <div style={{ fontSize: "12px", marginBottom: "1rem" }}>
                <b>Created by:</b>{" "}
                <span style={{ fontWeight: "bold", color: "green" }}>
                  {token.tripName || "Anonymous"}
                </span>{" "}
                {token.tripCode && (
                  <span style={{ color: "gray", fontFamily: "monospace" }}>!!{token.tripCode}</span>
                )}{" "}
                on {formatDate(token.createdAt)} No.{100000 + (token.id || 0)}
              </div>

              <div style={{ fontSize: "12px", margin: "0 0 1rem 0" }}>
                <a
                  href={`https://explorer.solana.com/address/${mint}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "underline", color: "#0000ee", fontFamily: "monospace" }}
                >
                  {mint}
                </a>
              </div>
              {/* Progress */}
              {migrationLive ? (
                // When on Raydium: fixed message + no pool link
                <div style={{ margin: "0.5rem 0", fontSize: 30 }}>
                  <div><b>TOKEN HAS GRADUATED</b></div>
                  {(poolPhase || raydiumPool) && (
                    <div style={{ marginTop: 4, color: "#555", fontSize: 13 }}>
                      Phase: {poolPhase || "RaydiumLive"}
                      {/* Pool address link intentionally removed */}
                    </div>
                  )}
                </div>
              ) : (
                // Otherwise keep the regular progress text
                <div style={{ margin: "0.5rem 0", fontSize: 13 }}>
                  <div>
                    Progress by tokens: <b>{progressTokensPct.toFixed(2)}%</b> (SOL deposited ≈ {x0.toFixed(6)} /{" "}
                    {model?.X_MAX.toFixed(6) ?? "…"} ; sold ≈ {ySoldWhole.toLocaleString()} /{" "}
                    {CAP_TOKENS.toLocaleString()} tokens)
                  </div>
                  <div>
                    Raised so far: {totalRaisedSOL.toFixed(6)} SOL / target {targetSOL.toFixed(6)} SOL
                    {model && <> (remaining ~{remainingSOL.toFixed(6)} SOL)</>}
                  </div>
                  {(poolPhase || raydiumPool) && (
                    <div style={{ marginTop: 4, color: "#555" }}>
                      Phase: {poolPhase || "Active"}
                      {/* Pool address link intentionally removed */}
                    </div>
                  )}
                </div>
              )}
              {/* Progress Bar — tracks bonding curve */}
              <div style={{ margin: "10px 0" }}>
                <ProgressBar pct={progressTokensPct} />
              </div>
              {/* Trade / Migration-aware UI */}
              {migratingNow ? (
                <div id="trade-box" style={{ marginTop: "1rem" }}>
                  <h3>Curve Completed — Migrating…</h3>
                  <div style={{ fontSize: 14, marginTop: 8 }}>
                    Token cap has been reached. The bonding-curve is closed and trading is paused here while the pool
                    is created on Raydium. This page will update automatically when migration completes.
                  </div>
                </div>
              ) : migrationLive ? (
                <div id="trade-box" style={{ marginTop: "1rem" }}>
                  <h3 style={{ marginBottom: 8 }}>Trading has moved to Raydium</h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
                    {raydiumLinks.raydiumSwap && (
                      <a
                        href={raydiumLinks.raydiumSwap}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontWeight: "bold", textDecoration: "underline" }}
                      >
                        Swap on Raydium (devnet)
                      </a>
                    )}
                    {raydiumLinks.raydiumAddLiq && (
                      <a
                        href={raydiumLinks.raydiumAddLiq}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ textDecoration: "underline" }}
                      >
                        Add Liquidity (devnet)
                      </a>
                    )}
                    {raydiumLinks.explorerPool && (
                      <a
                        href={raydiumLinks.explorerPool}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ textDecoration: "underline" }}
                      >
                        Explorer: Pool Address
                      </a>
                    )}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 13, color: "#666" }}>
                    The bonding curve has completed — buys/sells on this page are disabled permanently.
                  </div>
                </div>
                ) : !wallet ? (
                  <div id="trade-box" style={{ marginTop: "1rem" }}>
                    <h3>Trade</h3>
                    <div style={{ fontSize: 14, marginTop: 8 }}>
                      You need to connect your wallet to trade.
                    </div>
                    <button type="button" onClick={handleConnect} className="chan-link" style={{ marginTop: 8 }}>
                      [Connect Wallet]
                    </button>
                  </div>
                ) : (
                <div id="trade-box" style={{ marginTop: "1rem" }}>
                  <h3>Trade</h3>

                  {/* Unit toggle */}
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                    <span className="chan-label">Units:</span>
                    <button
                      type="button"
                      className={`chan-toggle ${unitMode === "sol" ? "is-active" : ""}`}
                      aria-pressed={unitMode === "sol"}
                      onClick={() => setUnitMode("sol")}
                    >
                      [SOL]
                    </button>
                    <button
                      type="button"
                      className={`chan-toggle ${unitMode === "token" ? "is-active" : ""}`}
                      aria-pressed={unitMode === "token"}
                      onClick={() => setUnitMode("token")}
                    >
                      [Token]
                    </button>
                  </div>
                  {/* Trade mode toggle */}
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                    <span className="chan-label">Mode:</span>
                    <button
                      type="button"
                      className={`chan-toggle ${tradeMode === "buy" ? "is-active is-active--buy" : ""}`}
                      aria-pressed={tradeMode === "buy"}
                      onClick={() => setTradeMode("buy")}
                    >
                      [Buy]
                    </button>
                    <button
                      type="button"
                      className={`chan-toggle ${tradeMode === "sell" ? "is-active is-active--sell" : ""}`}
                      aria-pressed={tradeMode === "sell"}
                      onClick={() => setTradeMode("sell")}
                    >
                      [Sell]
                    </button>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: "bold", marginBottom: "0.5rem" }}>
                    Mode: <span style={{ color: tradeMode === "buy" ? "green" : "red" }}>{tradeMode.toUpperCase()}</span>
                  </div>

                  {/* Amount input */}
                  <label htmlFor="trade-amount" style={{ display: "block", marginBottom: "0.5rem" }}>
                    Amount ({unitMode.toUpperCase()})
                  </label>
                  <input
                    type="number"
                    id="trade-amount"
                    min="0.000001"
                    step="0.000001"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    style={{ padding: "0.25rem", fontSize: "14px", width: "100%", border: "1px solid #aaa" }}
                  />

                  {/* Conversion preview */}
                  <div style={{ margin: "0.5rem 0" }}>
                    ≈{" "}
                    {unitMode === "token"
                      ? `${(conversion || 0).toFixed(9)} SOL`
                      : `${(conversion || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} Tokens`}
                  </div>

                  {/* Submit */}
                  <div>
                    <button type="button" onClick={handleSubmit} className="chan-link">
                      [Submit]
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p>{status}</p>
          )}

          <p id="status" style={{ marginTop: "1rem" }} dangerouslySetInnerHTML={{ __html: status }} />

          {/* Price Chart */}
          <div style={{ marginTop: "2rem" }}>
            <h3 style={{ margin: 0 }}>
              Price (SOL per token) — {visBucketSec === 900 ? "15m" : visBucketSec === 3600 ? "1h" : "1d"} candles
            </h3>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              {["3d", "1w", "1m"].map((key) => (
                <span
                  key={key}
                  className={`chan-toggle ${rangeKey === key ? "is-active" : ""}`}
                  onClick={() => setRangeKey(key)}
                  title={key === "3d" ? "15m candles" : key === "1w" ? "1h candles" : "1d candles"}
                  role="button"
                  aria-pressed={rangeKey === key}
                >
                  [{key.toUpperCase()}]
                </span>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 0 8px" }}>
              <button
                type="button"
                className={`chan-toggle ${chartUnit === "SOL" ? "is-active" : ""}`}
                onClick={() => setChartUnit("SOL")}
                aria-pressed={chartUnit === "SOL"}
              >
                [SOL]
              </button>
              <button
                type="button"
                className={`chan-toggle ${chartUnit === "USD" ? "is-active" : ""} ${solUsd > 0 ? "" : "chan-toggle--disabled"}`}
                onClick={() => solUsd > 0 && setChartUnit("USD")}
                aria-pressed={chartUnit === "USD"}
                title={solUsd > 0 ? "" : "Provide solUsdRate to enable USD"}
              >
                [USD]
              </button>
            </div>
            {/* Metric row: PRICE / MCAP */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 0 8px" }}>
              <button
                type="button"
                className={`chan-toggle ${metric === "PRICE" ? "is-active" : ""}`}
                onClick={() => setMetric("PRICE")}
                aria-pressed={metric === "PRICE"}
              >
                [PRICE]
              </button>
              <button
                type="button"
                className={`chan-toggle ${metric === "MCAP" ? "is-active" : ""}`}
                onClick={() => setMetric("MCAP")}
                aria-pressed={metric === "MCAP"}
              >
                [MCAP]
              </button>
            </div>
            <PriceChart
              // PRICE series
              confirmed={confirmedCandles}
              pending={pendingCandle}

              // MCAP series
              mcapCandles={mcapCandles}
              pendingMcap={pendingMcap}

              bucketSec={visBucketSec}
              devNet={devNet}

              // currency + external controls
              solUsdRate={solUsd}
              unit={chartUnit}          // from the SOL/USD row
              metric={metric}           // from the PRICE/MCAP row

              showUnitToggle={false}    // we control it from the page
            />
          </div>

          {/* Bonding Curve */}
          <div style={{ marginTop: "2rem" }}>
            <h3 style={{ margin: 0 }}>Bonding Curve — Tokens sold vs SOL deposited</h3>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
              Cumulative distribution from LUT (conservative, floor/ceil aware)
            </div>
            <BondingCurve model={model} x0={x0} ySoldWhole={ySoldWhole} />
          </div>

          <Comments mint={mint} wallet={wallet} />
        </div>
        <Leaderboard mint={mint} version={lbVersion} />
      </div>
    </main>
  );
}
