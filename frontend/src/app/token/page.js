"use client";

import { useEffect, useRef, useState } from "react";
import * as solanaWeb3 from "@solana/web3.js";
import { useSearchParams } from "next/navigation";
import { useWallet, useDarkMode } from "@/app/AppShell";

import Leaderboard from "../components/Leaderboard";
import BondingCurve from "../components/BondingCurve";
import PriceChart from "../components/PriceChart";
import Comments from "../components/Comments";
import LiveTrades from "../components/LiveTrades";

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

// --------- DEBUG HELPERS ----------
const DEBUG = true;
const dlog = (...a) => DEBUG && console.log(...a);
const fmt = (tSec) => new Date((Number(tSec)||0) * 1000).toISOString().slice(11,19); // HH:mm:ss

const printCandles = (tag, arr) => dlog(`${tag} [len=${arr?.length ?? 0}]`,
  (arr||[]).map(c => ({
    t: fmt(c.time ?? c.t),
    time: c.time ?? c.t,
    o: c.open, h: c.high, l: c.low, c: c.close
  }))
);

const printMarkers = (tag, arr) => dlog(`${tag} markers [len=${arr?.length ?? 0}]`,
  (arr||[]).map(m => ({ t: fmt(m.time), time: m.time, netSol: m.netSol }))
);

function alignedRangeStart(nowSec, rangeSec, bucketSec) {
  const raw = nowSec - rangeSec;
  return Math.floor(raw / bucketSec) * bucketSec;
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
 * Derive a PRICE candle from an MCAP candle by *sampling the price curve*
 * across the full MCAP range in the candle.
 *
 * We DO NOT assume price is monotonic w.r.t. reserve — we scan the range.
 *
 * @param {{time:number, open:number, high:number, low:number, close:number}} mc  // reserves in SOL
 * @param {*} model  // LUT model built by buildLUTModel(dec)
 * @param {object} [opts]
 * @param {number} [opts.samples=64]  // number of points to scan across [minX, maxX]
 * @returns {{time:number, open:number, high:number, low:number, close:number}|null}
 */
function priceFromMcapCandle(mc, model, { samples = 64 } = {}) {
  if (!mc || !Number.isFinite(mc.time)) return null;

  const pOpen  = spotPriceSOLPerToken(model, mc.open);
  const pClose = spotPriceSOLPerToken(model, mc.close);

  // Carry-forward if missing open/close
  if (!Number.isFinite(pOpen) && Number.isFinite(pClose)) {
    // open unknown: use close for now (we’ll still scan to get H/L)
  }
  if (!Number.isFinite(pOpen) && !Number.isFinite(pClose)) {
    // If both missing, we can’t form a price candle
    return null;
  }

  // Scan the curve across the entire MCAP range present in this candle
  const xMin = Math.min(mc.open, mc.high, mc.low, mc.close);
  const xMax = Math.max(mc.open, mc.high, mc.low, mc.close);
  let pMin = Number.POSITIVE_INFINITY;
  let pMax = Number.NEGATIVE_INFINITY;

  // Include open/close first (even if NaN, we filter later)
  const candidates = [pOpen, pClose];

  if (Number.isFinite(xMin) && Number.isFinite(xMax) && xMax > xMin) {
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const x = xMin * (1 - t) + xMax * t; // linear in reserve SOL
      const p = spotPriceSOLPerToken(model, x);
      candidates.push(p);
    }
  }

  for (const v of candidates) {
    if (!Number.isFinite(v)) continue;
    if (v < pMin) pMin = v;
    if (v > pMax) pMax = v;
  }

  // If we never found any finite price, bail
  if (!Number.isFinite(pMin) || !Number.isFinite(pMax)) return null;

  // Build the candle.
  // For open/close, prefer computed values; if missing, fall back to the nearest finite (pMin/pMax).
  const open  = Number.isFinite(pOpen)  ? pOpen  : (Number.isFinite(pClose) ? pClose : pMin);
  const close = Number.isFinite(pClose) ? pClose : (Number.isFinite(pOpen)  ? pOpen  : pMin);
  const high  = Math.max(pMax, open, close);
  const low   = Math.min(pMin, open, close);

  return { time: mc.time, open, high, low, close };
}

function ProgressBar({ pct = 0 }) {
  const { dark } = useDarkMode();
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const border = dark ? "#333" : "#000";
  const bg     = dark ? "#111" : "#fff";
  const fill   = dark ? "#e5e5e5" : "#000"; // light fill in dark mode for contrast

  return (
    <div
      aria-label={`Progress ${clamped.toFixed(2)}%`}
      style={{
        width: "100%",
        height: "14px",
        border: `1px solid ${border}`,
        background: bg,
        boxSizing: "border-box",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${clamped}%`,
          height: "100%",
          background: fill,
          transition: "width 120ms linear",
        }}
      />
    </div>
  );
}

function pushOrMergeWithGapFill(setSeries, next, bucketSec) {
  setSeries(prev => {
    const out = prev ? prev.slice() : [];
    const last = out.at(-1);

    // fill any missing buckets between last and next with carry-forward close
    if (last && Number.isFinite(last.time) && next.time > last.time) {
      for (let t = last.time + bucketSec; t < next.time; t += bucketSec) {
        out.push({
          time: t,
          open:  last.close,
          high:  last.close,
          low:   last.close,
          close: last.close,
        });
      }
    }

    const idx = out.findIndex(c => c.time === next.time);
    if (idx >= 0) {
      const cur = out[idx];

      // keep original OPEN; widen H/L; CLOSE comes from latest tick
      const open  = Number.isFinite(cur.open) ? cur.open : next.open;
      const high  = Math.max(
        Number(cur.high   ?? -Infinity),
        Number(next.high  ?? -Infinity),
        Number(open       ?? -Infinity),
        Number(next.close ?? -Infinity)
      );
      const low   = Math.min(
        Number(cur.low    ?? +Infinity),
        Number(next.low   ?? +Infinity),
        Number(open       ?? +Infinity),
        Number(next.close ?? +Infinity)
      );
      const close = Number.isFinite(next.close) ? next.close : cur.close;

      out[idx] = { time: next.time, open, high, low, close };
    } else {
      out.push(next);
    }

    return out;
  });
}

function mergePendingCandle(next, prev, lastConfirmed, bucketSec) {
  if (!next) return prev;

  // normalize time to the bucket (defensive; onCandleWorking already buckets)
  const t = Math.floor(next.time / bucketSec) * bucketSec;

  // if no prior pending or bucket changed -> start a fresh pending with proper OPEN
  if (!prev || prev.time !== t) {
    const open =
      lastConfirmed && lastConfirmed.time === t
        ? lastConfirmed.open
        : (lastConfirmed ? lastConfirmed.close : next.open);

    return {
      time: t,
      open,
      high: Math.max(next.high ?? next.close ?? open, open),
      low:  Math.min(next.low  ?? next.close ?? open, open),
      close: next.close,
    };
  }

  // same bucket -> widen envelope, keep original OPEN, update CLOSE
  return {
    time: t,
    open: prev.open,
    high: Math.max(prev.high, Number(next.high ?? next.close ?? -Infinity), Number(prev.close ?? -Infinity)),
    low:  Math.min(prev.low,  Number(next.low  ?? next.close ?? +Infinity), Number(prev.close ?? +Infinity)),
    close: next.close,
  };
}


function aggregateToBuckets(candles, bucketSec, { fillGaps = true } = {}) {
  if (!candles?.length) return [];
  const byBucket = new Map();

  for (const c of candles) {
    const vals = [c?.open, c?.high, c?.low, c?.close].map(Number);
    if (!vals.every(Number.isFinite) || vals.every(v => v === 0)) continue;
    const b = Math.floor(c.time / bucketSec) * bucketSec;
    const cur = byBucket.get(b);
    if (!cur) {
      byBucket.set(b, { time: b, open: c.open, high: c.high, low: c.low, close: c.close });
    } else {
      cur.high  = Math.max(cur.high, c.high);
      cur.low   = Math.min(cur.low,  c.low);
      cur.close = c.close;
    }
  }

  const keys = Array.from(byBucket.keys()).sort((a,b)=>a-b);
  if (!fillGaps) return keys.map(k => byBucket.get(k));

  // carry-forward open for gaps so lines don’t disappear
  const out = [];
  let lastClose = null;
  for (let i = 0; i < keys.length; i++) {
    const t = keys[i];
    const cur = byBucket.get(t);

    // backfill gaps between previous bucket and this one
    if (i > 0) {
      const prevT = keys[i - 1];
      for (let g = prevT + bucketSec; g < t; g += bucketSec) {
        if (lastClose != null) {
          out.push({ time: g, open: lastClose, high: lastClose, low: lastClose, close: lastClose });
        }
      }
    }

    const open = lastClose != null ? lastClose : cur.open;
    const merged = {
      time: t,
      open,
      high: Math.max(cur.high, open),
      low:  Math.min(cur.low,  open),
      close: cur.close,
    };
    out.push(merged);
    lastClose = merged.close;
  }
  return out;
}

export default function TokenPage() {
  const search = useSearchParams();
  const qs = search.toString(); // changes whenever ?mint or ?wallet changes
  const { wallet, setWallet } = useWallet();

  const { publicKey, connected, sendTransaction, signTransaction } = useAdapterWallet();
  const { setVisible: openWalletModal } = useWalletModal();

  const { dark } = useDarkMode();

  const theme = dark
  ? {
      card: "#151515",
      cardMuted: "#1d1d1d",
      bg: "#0f0f0f",
      text: "#eaeaea",
      textMuted: "#a1a1a1",
      border: "#2a2a2a",
      link: "#8ab4ff",
      inputBg: "#1b1b1b",
      inputDisabled: "#171717",
      inputText: "#f0f0f0",
    }
  : {
      card: "#ffffff",
      cardMuted: "#fafafa",
      bg: "#ffffff",
      text: "#111111",
      textMuted: "#666666",
      border: "#aaaaaa",
      link: "#0000ee",
      inputBg: "#ffffff",
      inputDisabled: "#f4f4f4",
      inputText: "#111111",
    };


  const [historyStatus, setHistoryStatus] = useState("idle");

  const [lbLocked, setLbLocked] = useState(false);
  const [lbOptIn, setLbOptIn] = useState(false);
  const [lbDisplayName, setLbDisplayName] = useState("");
  const [showIrrevModal, setShowIrrevModal] = useState(false);

  // --- Routing / identity ---
  const [mint, setMint] = useState("");

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

  const devTradesRef = useRef([]); // array of { tsSec, side, sol, isDev }
  const historyReadyRef = useRef(false);

  const metricRef = useRef(metric);
  useEffect(() => { metricRef.current = metric; }, [metric]);

  // near other refs
  const lastFinalizedBucketRef = useRef(null);
  const finalizeInFlightRef = useRef(false);

  const mcapCandlesRef = useRef(mcapCandles);
  const pendingMcapRef = useRef(pendingMcap);
  useEffect(() => { mcapCandlesRef.current = mcapCandles; }, [mcapCandles]);
  useEffect(() => { pendingMcapRef.current = pendingMcap; }, [pendingMcap]);

  const confirmedCandlesRef = useRef(confirmedCandles);
  const pendingCandleRef = useRef(pendingCandle);
  useEffect(() => { confirmedCandlesRef.current = confirmedCandles; }, [confirmedCandles]);
  useEffect(() => { pendingCandleRef.current = pendingCandle; }, [pendingCandle]);

  // --- UI status + trade state ---
  const [status, setStatus] = useState("");
  const [amount, setAmount] = useState("");
  const [unitMode, setUnitMode] = useState("sol"); // "sol" | "token"
  const [tradeMode, setTradeMode] = useState("buy"); // "buy" | "sell"
  const [conversion, setConversion] = useState(0);

  // --- Pool + wallet reserves ---
  const [reserves, setReserves] = useState({ reserveSol: 0, reserveTokenBase: "0" });

  // --- LUT model (once decimals known) ---
  const [model, setModel] = useState(null);

  // --- Leaderboard change signalling ---
  const [lbVersion, setLbVersion] = useState(0);
  const lbDebounceRef = useRef(null);

  // --- Migration status / Raydium pool (NEW) ---
  const [poolPhase, setPoolPhase] = useState(null); // "Migrating" | "RaydiumLive" | null
  const [raydiumPool, setRaydiumPool] = useState(null); // pool id (string) once live

  const isDevSelf =
    !!token &&
    !!wallet &&
    wallet.trim() === (token.dev || token.creator || "").trim();

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

  // add near top-level
  const reqIdRef = useRef(0);

  async function fetchAndApplyHistory(reason = "generic") {
    if (!mint || !model) return;
    const myId = ++reqIdRef.current;

    historyReadyRef.current = false;
    setHistoryStatus("loading");

    try {
      const needSec = RANGE_PRESETS[rangeKey].seconds;
      const roughNeeded = Math.ceil(needSec / BASE_SAMPLE_SEC) + 200;
      const limit = Math.min(50000, Math.max(1000, roughNeeded));

      const resp = await fetch(
        `http://localhost:4000/price-history?mint=${mint}&limit=${limit}`,
        { cache: "no-store" }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const { candles15m = [], working = null, devTrades = [] } = await resp.json();
      if (myId !== reqIdRef.current) return; // stale response

      devTradesRef.current = devTrades;

      // --- build MCAP and PRICE arrays ---
      const mcap15m = candles15m.map(c => ({
        time: Number(c.t),
        open:  (Number(c.o_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
        high:  (Number(c.h_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
        low:   (Number(c.l_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
        close: (Number(c.c_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
      }));

      // PRICE derived on the client from MCAP (with range scan for min/max)
      const m = modelRef.current;
      let lastValidClose = null;

      const price15m = mcap15m.map(mc => {
        const pc = priceFromMcapCandle(mc, m, { samples: 64 });

        // carry-forward if needed
        if (!pc) return null;
        if (!Number.isFinite(pc.close)) {
          if (Number.isFinite(lastValidClose)) pc.close = lastValidClose;
          else return null;
        }
        if (!Number.isFinite(pc.open)) {
          pc.open = Number.isFinite(lastValidClose) ? lastValidClose : pc.close;
        }
        // Ensure envelope includes open/close
        pc.high = Math.max(pc.high, pc.open, pc.close);
        pc.low  = Math.min(pc.low,  pc.open, pc.close);

        lastValidClose = pc.close;
        return pc;
      }).filter(Boolean);

      dlog("[history] raw15 count", candles15m.length,
        "first", fmt(candles15m[0]?.t), "last", fmt(candles15m.at(-1)?.t));
      printCandles("[history] PRICE15 (tail)", price15m.slice(-5));
      printCandles("[history] MCAP15  (tail)", mcap15m.slice(-5));

      // --- prune to visible window ---
      const vis = RANGE_PRESETS[rangeKey].bucketSec;
      const nowSec = Math.floor(Date.now() / 1000);
      const start  = alignedRangeStart(nowSec, RANGE_PRESETS[rangeKey].seconds, vis);
      const includeFrom = start;

      let pricePruned = price15m.filter(c => c.time >= includeFrom);
      let mcapPruned  = mcap15m.filter(c => c.time >= includeFrom);

      // --- aggregate and push to state ---
      const aggPrice = aggregateToBuckets(pricePruned, vis);
      const aggMcap  = aggregateToBuckets(mcapPruned,  vis);

      printCandles("[history] agg PRICE (tail)", aggPrice.slice(-5));
      printCandles("[history] agg MCAP  (tail)", aggMcap.slice(-5));

      setConfirmedCandles(aggPrice);
      setMcapCandles(aggMcap);

      if (working) {
        const vis = RANGE_PRESETS[rangeKey].bucketSec;
        const workingSec = Number(working.t);
        const tsMs = workingSec * 1000;

        const mc = {
          time: Math.floor(workingSec / vis) * vis,
          open:  (Number(working.o_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
          high:  (Number(working.h_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
          low:   (Number(working.l_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
          close: (Number(working.c_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
        };

        const m = modelRef.current;
        const pc = priceFromMcapCandle(mc, m, { samples: 64 });

        const lastAggMcap  = aggMcap.at(-1)  || null;

        setPendingCandle(pc || null);
        setPendingMcap({
          time: mc.time,
          open: lastAggMcap && lastAggMcap.time === mc.time ? lastAggMcap.open : (lastAggMcap ? lastAggMcap.close : mc.close),
          high: Math.max(mc.high, mc.open, mc.close),
          low:  Math.min(mc.low,  mc.open, mc.close),
          close: mc.close,
        });
      } else {
        setPendingCandle(null);
        setPendingMcap(null);
      }

      // --- dev overlay based on updated sets ---
      recomputeDevNet();

      // --- update finalized bucket tracker ---
      const last = (metricRef.current === "MCAP" ? mcapPruned : pricePruned).at(-1);
      const lastBucket = last ? Math.floor(last.time / vis) * vis : null;
      lastFinalizedBucketRef.current = lastBucket;
      dlog("[history] set lastFinalizedBucketRef", lastBucket, fmt(lastBucket||0));

      setHistoryStatus("ready");
      historyReadyRef.current = true;
    } catch (e) {
      if (myId !== reqIdRef.current) return;
      console.error(`[history] ${reason} failed`, e);
      setHistoryStatus("error");
    }
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

  function recomputeDevNet() {
    const vis = visBucketSecRef.current;
    const isMCAP = metricRef.current === "MCAP";
    const visConfirmed = isMCAP ? mcapCandlesRef.current : confirmedCandlesRef.current;
    const visPending   = isMCAP ? pendingMcapRef.current : pendingCandleRef.current;

    // set of visual bucket times actually rendered
    const renderTimes = new Set([
      ...visConfirmed.map(c => c.time),
      ...(visPending ? [visPending.time] : []),
    ]);

    printCandles("[overlay] confirmed (vis tail)", visConfirmed.slice(-4));
    if (visPending) dlog("[overlay] pending (vis)", { t: fmt(visPending.time), ...visPending });

    // Accumulate Dev net SOL by visual bucket derived from canonical 15m
    const acc = new Map();
    for (const t of devTradesRef.current) {
      if (!t?.isDev) continue;
      const b15   = Math.floor(Number(t.bucket15 ?? t.tsSec ?? 0) / 900) * 900; // canonical 15m
      const vTime = Math.floor(b15 / vis) * vis;
      const signed = (t.side === "buy" ? 1 : -1) * Math.abs(Number(t.sol) || 0);
      acc.set(vTime, (acc.get(vTime) || 0) + signed);
    }

    const out = [];
    for (const [time, netSol] of acc.entries()) {
      if (netSol !== 0 && renderTimes.has(time)) out.push({ time, netSol });
    }
    out.sort((a,b) => a.time - b.time);

    dlog("[overlay] dev acc (all buckets)",
      Array.from(acc.entries()).map(([t,v]) => ({ t: fmt(t), time:t, netSol:v })));
    printMarkers("[overlay] dev shown (filtered)", out);

    setDevNet(out);
  }

  useEffect(() => {
    if (!mint || !model) return;
    // pending from the previous resolution has a different bucket size; drop it now
    setPendingCandle(null);
    setPendingMcap(null);
    fetchAndApplyHistory("range-change");
  }, [mint, model, rangeKey]);  // 👈 include rangeKey here to refetch on 3D/1W/1M

  useEffect(() => { recomputeDevNet(); }, [
    confirmedCandles, pendingCandle,
    mcapCandles, pendingMcap,
    rangeKey, metric
  ]);

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
    setHistoryStatus("idle");
  }, [mint]);

 useEffect(() => {
   let stop = false;
   (async () => {
     // If creator, lock immediately and skip server fetch.
     if (!mint || !wallet || isDevSelf) {
       setLbLocked(!!isDevSelf);
       setLbOptIn(!!isDevSelf);
       setLbDisplayName(isDevSelf ? (token?.tripName || "") : "");
       return;
     }
      try {
        const r = await fetch(`http://localhost:4000/leaderboard-pref?mint=${encodeURIComponent(mint)}&wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" });
        const j = await r.json();
        if (stop) return;
        if (j?.locked) {
          setLbLocked(true);
          setLbOptIn(!!j.opted);
          setLbDisplayName(j.displayName || "");
        } else {
          setLbLocked(false);
          setLbOptIn(false);
          setLbDisplayName("");
        }
      } catch {}
    })();
    return () => { stop = true; };
   }, [mint, wallet, isDevSelf, token]);


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

  useEffect(() => {
    if (mint && model) {
      setPendingCandle(null);
      setPendingMcap(null);
      fetchAndApplyHistory("initial");
    }
  }, [mint, model]);

  useEffect(() => {
    if (isDevSelf) {
      setLbLocked(true);
      setLbOptIn(true);
      setLbDisplayName(token?.tripName || "");
    }
  }, [isDevSelf, token]);

  // --- Live updates via SSE ---
  useEffect(() => {
    if (!mint) return;

    // close any prior stream
    if (esRef.current) {
      try { esRef.current.close(); } catch {}
      esRef.current = null;
    }

    const url = `http://localhost:4000/stream/holdings?mint=${encodeURIComponent(mint)}`;
    const es = new EventSource(url);

    // ========== handlers ==========
    const onCandleWorking = (ev) => {
      const msg = JSON.parse(ev.data || "{}");
      if (!msg || msg.mint !== mint) return;
      const c = msg.candle;
      if (!c) return;

      const t = Number(c.t || c.bucket_start);

      // MCAP (reserve SOL) from SSE payload
      const mc = {
        time: Math.floor(t / visBucketSecRef.current) * visBucketSecRef.current,
        open:  (Number(c.o_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
        high:  (Number(c.h_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
        low:   (Number(c.l_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
        close: (Number(c.c_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
      };

      // PRICE from MCAP with range scan
      const m = modelRef.current;
      const nextPrice = priceFromMcapCandle(mc, m, { samples: 64 });

      // MCAP candle used as-is (open carry-forward handled by your push/gap-fill logic)
      const nextMcap = {
        time: mc.time,
        open:  mc.open,
        high:  Number.isFinite(mc.high) ? mc.high : Math.max(mc.open, mc.close),
        low:   Number.isFinite(mc.low)  ? mc.low  : Math.min(mc.open, mc.close),
        close: mc.close,
      };

      const vis = visBucketSecRef.current;
       if (nextPrice) pushOrMergeWithGapFill(setConfirmedCandles, nextPrice, vis);
       if (nextMcap)  pushOrMergeWithGapFill(setMcapCandles,      nextMcap,  vis);
 
       const lastPriceConfirmed = confirmedCandlesRef.current.at(-1) || null;
       const lastMcapConfirmed  = mcapCandlesRef.current.at(-1) || null;
 
       setPendingCandle((prev) =>
         nextPrice
           ? mergePendingCandle(nextPrice, prev, lastPriceConfirmed, vis)
           : prev
       );
       setPendingMcap((prev) =>
         nextMcap
           ? mergePendingCandle(nextMcap, prev, lastMcapConfirmed, vis)
           : prev
       );

      // If history hasn’t arrived yet, start rendering immediately.
      if (historyStatus !== "ready") {
        setHistoryStatus("ready");
        historyReadyRef.current = true;
      }
    };

    // ========= onCandleFinal =========
    const onCandleFinal = (ev) => {
      const msg = JSON.parse(ev.data || "{}");
      if (!msg || msg.mint !== mint) return;
      const c = msg.candle;
      if (!c) return;

      const vis = visBucketSecRef.current;
      const tRaw = Number(c.t || c.bucket_start);
      const tVis = Math.floor(tRaw / vis) * vis;
      const mc = {
        time: tVis,
        open:  (Number(c.o_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
        high:  (Number(c.h_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
        low:   (Number(c.l_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
        close: (Number(c.c_reserve_lamports) || 0) / LAMPORTS_PER_SOL,
      };

      const m = modelRef.current;
      const finPrice = priceFromMcapCandle(mc, m, { samples: 64 });
      const finMcap  = {
        time: mc.time,
        open: mc.open,
        high: Math.max(mc.high, mc.open, mc.close),
        low:  Math.min(mc.low,  mc.open, mc.close),
        close: mc.close,
      };

      if (finPrice) pushOrMergeWithGapFill(setConfirmedCandles, finPrice, vis);
      if (finMcap)  pushOrMergeWithGapFill(setMcapCandles,      finMcap,  vis);

      setPendingCandle(p => (p?.time === mc.time ? null : p));
      setPendingMcap  (p => (p?.time === mc.time ? null : p));

      lastFinalizedBucketRef.current = Math.max(lastFinalizedBucketRef.current ?? 0, tVis);
    };

    const onBucketRoll = (ev) => {
      if (!historyReadyRef.current) return;
      const msg = JSON.parse(ev.data || "{}");
      if (msg.mint !== mint) return;

      const vis = visBucketSecRef.current;
      const curVisBucket = Math.floor(Number(msg.current || 0) / vis) * vis;

      // keep the tracker from going backwards
      lastFinalizedBucketRef.current = Math.max(
        lastFinalizedBucketRef.current ?? 0,
        curVisBucket
      );

      if (
        lastFinalizedBucketRef.current != null &&
        curVisBucket > lastFinalizedBucketRef.current &&
        !finalizeInFlightRef.current
      ) {
        finalizeInFlightRef.current = true;
        fetchAndApplyHistory("bucket-roll")
          .finally(() => {
            lastFinalizedBucketRef.current = curVisBucket;
            finalizeInFlightRef.current = false;
          });
      }
    };

    const onMessage = (ev) => {
      if (!ev?.data) return;
      if (!historyReadyRef.current) return;

      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }

      dlog("[SSE] evt", {
        src: payload?.source,
        mint: payload?.mint,
        t: payload?.t,
        tBucket: payload?.liveCandle?.tBucket ?? payload?.t,
        rLamports: payload?.reserveSolLamports,
        poolBase: payload?.poolBase
      });

      if (payload?.mint !== mint) return;

      if (payload?.phase) setPoolPhase(payload.phase);
      if (payload?.raydiumPool) setRaydiumPool(payload.raydiumPool);

      // keep UI reserves in sync
      const rLamports  = Number(payload?.reserveSolLamports);
      const poolBaseStr = payload?.poolBase != null ? String(payload.poolBase) : null;
      if (Number.isFinite(rLamports) && poolBaseStr) {
        setReserves({ reserveSol: rLamports, reserveTokenBase: poolBaseStr });
      }

      // dev-trade tracking for overlay (canonical 15m -> visual buckets)
      const devAddr  = tokenRef.current?.dev || null;
      const looksDev =
        payload?.isDev === true ||
        payload?.actor === "dev" ||
        (devAddr && (payload?.wallet === devAddr || payload?.owner === devAddr));

      const solCandidate = Number(payload?.sol ?? payload?.solAbs ?? payload?.solDelta);
      if (looksDev && Number.isFinite(solCandidate)) {
        const bucket15 = Number.isFinite(payload?.tBucket)
          ? Math.floor(Number(payload.tBucket) / 900) * 900
          : Math.floor((Number(payload.tsSec ?? payload.t ?? 0)) / 900) * 900;

        const entry = {
          bucket15,
          side: payload.side || (solCandidate > 0 ? "buy" : "sell"),
          sol: Math.abs(solCandidate),
          isDev: true,
        };
        devTradesRef.current.push(entry);
        dlog("[SSE] dev push", { ...entry, t: fmt(entry.bucket15) });
        recomputeDevNet();
      }

      // On bucket-roll signals from chain, refetch history to stay consistent
      if (payload?.source === "chain") {
        const vis = visBucketSecRef.current;
        const tsSec = Number(payload?.liveCandle?.tBucket ?? payload?.t ?? (Date.now()/1000|0));
        const curVisBucket = Math.floor(tsSec / vis) * vis;

        if (
          lastFinalizedBucketRef.current != null &&
          curVisBucket > lastFinalizedBucketRef.current &&
          !finalizeInFlightRef.current
        ) {
          finalizeInFlightRef.current = true;
          dlog("[SSE] bucket roll -> refetch", {
            prev: fmt(lastFinalizedBucketRef.current),
            cur:  fmt(curVisBucket)
          });
          fetchAndApplyHistory("bucket-roll")
            .finally(() => {
              lastFinalizedBucketRef.current = curVisBucket;
              finalizeInFlightRef.current = false;
            });
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

    // ========== wire up ==========
    es.addEventListener("candle-working",   onCandleWorking);
    es.addEventListener("candle-finalized", onCandleFinal);
    es.addEventListener("bucket-roll",      onBucketRoll);   
    es.addEventListener("comment",          onComment);
    es.addEventListener("hello",            onMessage);
    es.addEventListener("holdings",         onMessage);

    es.onopen  = () => console.log("[SSE] open");
    es.onerror = (e) => console.log("[SSE] error", e);

    esRef.current = es;

    // ========== cleanup ==========
    return () => {
      es.removeEventListener("candle-working",   onCandleWorking);
      es.removeEventListener("candle-finalized", onCandleFinal);
      es.removeEventListener("bucket-roll",      onBucketRoll);
      es.removeEventListener("comment",          onComment);
      es.removeEventListener("hello",            onMessage);
      es.removeEventListener("holdings",         onMessage);
      try { es.close(); } catch {}
      esRef.current = null;
      console.log("[SSE] closed");
    };
  }, [mint]);

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
          lbOptIn,      
          lbDisplayName,      
         priceSOLPerToken: (() => {
           const x0 = reserves.reserveSol / LAMPORTS_PER_SOL;
           const m  = modelRef.current || model;
           const p  = m ? spotPriceSOLPerToken(m, x0) : null;
           return Number.isFinite(p) ? p : null;
         })(),
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
      setLbLocked(true);

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

  // --- Migration-aware UI flags ---
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
                <span className="token__name">
                  {token.tripName || "Anonymous"}
                </span>
                {token.tripCode && (
                  <>{" "}<span className="token__trip">!!{token.tripCode}</span></>
                )}{" "}
                on {formatDate(token.createdAt)} No.{100000 + (token.id || 0)}
              </div>

              <div style={{ fontSize: "12px", margin: "0 0 1rem 0" }}>
                <a
                  href={`https://explorer.solana.com/address/${mint}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "underline", color: theme.link, fontFamily: "monospace" }}
                >
                  {mint}
                </a>
              </div>
              {/* Progress */}
              {migrationLive ? (
                <div style={{ margin: "0.5rem 0", fontSize: 30 }}>
                  <div><b>TOKEN HAS GRADUATED</b></div>
                  {(poolPhase || raydiumPool) && (
                    <div style={{ marginTop: 4, color: "#555", fontSize: 13 }}>
                      Phase: {poolPhase || "RaydiumLive"}
                    </div>
                  )}
                </div>
              ) : (
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
                    </div>
                  )}
                </div>
              )}

              {/* Progress Bar */}
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
                      Mode:{" "}
                      <span
                        style={{
                          color: tradeMode === "buy" ? "var(--name)" : "var(--down)",
                        }}
                      >
                        {tradeMode.toUpperCase()}
                      </span>
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
                      style={{
                        padding: "0.25rem",
                        fontSize: "14px",
                        width: "100%",
                        background: "var(--input-bg)",
                        border: "1px solid var(--input-border)",
                        color: "var(--fg)",
                      }}
                    />
                  {/* Conversion preview */}
                  <div style={{ margin: "0.5rem 0" }}>
                    ≈{" "}
                    {unitMode === "token"
                      ? `${(conversion || 0).toFixed(9)} SOL`
                      : `${(conversion || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} Tokens`}
                  </div>

                  {/* --- Display Mode (Leaderboard appearance) --- */}
                  <div
                    style={{
                      margin: "0.75rem 0 0.5rem",
                      padding: "8px 10px",
                      border: `1px dashed ${theme.border}`,
                      borderRadius: 6,
                      background: lbLocked ? theme.cardMuted : theme.card,
                      color: theme.text,
                      opacity: lbLocked ? 0.9 : 1,
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>Display on leaderboard as:</div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input
                          type="radio"
                          name="lb-mode"
                          checked={!lbOptIn}
                          disabled={lbLocked}
                          onChange={() => setLbOptIn(false)}
                        />
                        <span>Anonymous</span>
                      </label>

                      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input
                          type="radio"
                          name="lb-mode"
                          checked={!!lbOptIn}
                          disabled={lbLocked}
                          onChange={() => setLbOptIn(true)}
                        />
                        <span>
                          Wallet tripcode + display name
                          {isDevSelf && token?.tripName ? <> — <b>{token.tripName}</b></> : null}
                        </span>
                      </label>
                    </div>

                    <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                      <input
                        type="text"
                        placeholder="Display name (optional)"
                        value={lbDisplayName}
                        maxLength={24}
                        disabled={!lbOptIn || lbLocked}
                        onChange={(e) => setLbDisplayName(e.target.value)}
                        style={{
                          flex: 1,
                          padding: "6px 8px",
                          fontSize: 14,
                          border: `1px solid ${theme.border}`,
                          borderRadius: 4,
                          background: !lbOptIn || lbLocked ? theme.inputDisabled : theme.inputBg,
                          color: theme.inputText,
                          outline: "none",
                        }}
                      />
                    </div>
                     <div style={{ marginTop: 6, fontSize: 12, color: theme.textMuted, lineHeight: 1.3 }}>
                       {isDevSelf ? (
                         <>
                           <b>Creator identity locked:</b> as the token creator, your trades for this token
                           will always display as <span style={{ color: "var(--link-hover)" }}>[DEV]</span>{" "}
                           {!!token?.tripCode && <>!!{token.tripCode} </>}
                           {token?.tripName || ""}. Anonymous mode isn’t available.
                         </>
                       ) : lbLocked ? (
                         <>Your leaderboard appearance is locked for this token.</>
                       ) : (
                         <>Your choice will be locked on your first trade for this token (irreversible).</>
                       )}
                     </div>
                  </div>

                  {/* Submit */}
                  <div>
                    <button
                      type="button"
                      className="chan-link"
                      onClick={() => {
                        // Lock the chosen appearance on first trade (either mode).
                        if (!lbLocked) {
                          setShowIrrevModal(true);
                        } else {
                          handleSubmit();
                        }
                      }}
                    >
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
            {/* range + unit + metric controls */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              {["3d", "1w", "1m"].map((key) => (
                <span
                  key={key}
                  className={`chan-toggle ${rangeKey === key ? "is-active" : ""} ${historyStatus !== "ready" ? "chan-toggle--disabled" : ""}`}
                  onClick={() => historyStatus === "ready" && setRangeKey(key)}
                  role="button"
                  aria-pressed={rangeKey === key}
                  title={historyStatus === "ready" ? (key === "3d" ? "15m candles" : key === "1w" ? "1h candles" : "1d candles") : "Loading…"}
                >
                  [{key.toUpperCase()}]
                </span>
              ))}
            </div>
            {historyStatus !== "ready" ? (
              <div
                style={{
                  width: "100%",
                  height: "360px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid #eee",
                  borderRadius: 8,
                  background: "#fafafa",
                  fontSize: 14,
                  color: "#666",
                }}
                aria-busy="true"
                aria-live="polite"
              >
                {historyStatus === "error" ? "Failed to load price history." : "Loading price history…"}
              </div>
            ) : (
              <>
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
                  key={dark ? "dark" : "light"}
                  confirmed={confirmedCandles}
                  pending={pendingCandle}
                  mcapCandles={mcapCandles}
                  pendingMcap={pendingMcap}
                  bucketSec={visBucketSec}
                  devNet={devNet}
                  solUsdRate={solUsd}
                  unit={chartUnit}
                  metric={metric}
                  showUnitToggle={false}
                  dark={dark}
                />
              </>
            )}
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
        {/* Sidebar: fixed Leaderboard, LiveTrades fills the rest */}
        <div
          style={{
            flex: "0 0 300px",          // fixed column width
            display: "flex",
            flexDirection: "column",   // stack children
          }}
        >
          {/* Leaderboard: fixed height */}
          <div
            style={{
              flex: "0 0 320px",        // lock at 320px tall (tweak as needed)
              minHeight: 0,
              overflowY: "auto",        // scroll if too many entries
            }}
          >
            <Leaderboard mint={mint} version={lbVersion} />
          </div>

          {/* LiveTrades: takes the rest */}
          <div
            style={{
              flex: "1 1 auto",         // grow/shrink to fill remaining space
              minHeight: 0,
              overflowY: "auto",        // scroll if overflowing
            }}
          >
            <LiveTrades mint={mint} />
          </div>
        </div>
      </div>
      {/* ===== Lock choice confirm modal ===== */}
      {showIrrevModal && (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="irrev-title"
        style={{
          position: "fixed",
          inset: 0,
          background: dark ? "rgba(0,0,0,0.7)" : "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
        }}
        onClick={() => setShowIrrevModal(false)}
      >
        <div
          style={{
            background: theme.card,
            color: theme.text,
            padding: 16,
            borderRadius: 8,
            width: "min(520px, 92%)",
            border: `1px solid ${theme.border}`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <h3 id="irrev-title" style={{ marginTop: 0 }}>Lock leaderboard appearance?</h3>
          <div style={{ fontSize: 14, lineHeight: 1.5, color: theme.text }}>
            {/* ... */}
            <p style={{ margin: 0, color: dark ? "#ff6b6b" : "#a00" }}>
              <b>Irreversible:</b> once locked, you can’t change this later.
            </p>
          </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="chan-link"
                onClick={() => { setShowIrrevModal(false); handleSubmit(); }}
              >
                [Confirm &amp; Trade]
              </button>
              <button
                type="button"
                className="chan-link"
                onClick={() => setShowIrrevModal(false)}
              >
                [Cancel]
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
