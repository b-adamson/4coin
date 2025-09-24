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

/**
 * Floor a timestamp (ms) to a bucket size (sec) and return unix seconds.
 */
function floorToBucketSec(tsMs, bucketSec) {
  return Math.floor(tsMs / 1000 / bucketSec) * bucketSec;
}

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

  const [historyStatus, setHistoryStatus] = useState("idle");

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

      const m = modelRef.current;
      // before price15m mapping
      let lastValidClose = null;

      const price15m = candles15m.map(c => {
        const xO = (Number(c.o_reserve_lamports) || 0) / LAMPORTS_PER_SOL;
        const xH = (Number(c.h_reserve_lamports) || 0) / LAMPORTS_PER_SOL;
        const xL = (Number(c.l_reserve_lamports) || 0) / LAMPORTS_PER_SOL;
        const xC = (Number(c.c_reserve_lamports) || 0) / LAMPORTS_PER_SOL;

        const pO = spotPriceSOLPerToken(m, xO);
        const pH = spotPriceSOLPerToken(m, xH);
        const pL = spotPriceSOLPerToken(m, xL);
        const pC = spotPriceSOLPerToken(m, xC);

        // carry-forward: if anything is missing, use lastValidClose
        const close = Number.isFinite(pC) ? pC : lastValidClose;
        const open  = Number.isFinite(pO) ? pO : (lastValidClose ?? pC);
        const high  = Number.isFinite(pH) ? pH : open ?? close;
        const low   = Number.isFinite(pL) ? pL : open ?? close;

        // If we still don't have a value, skip this candle (rare)
        if (![open, high, low, close].every(Number.isFinite)) return null;

        lastValidClose = close;
        return { time: Number(c.t), open, high: Math.max(high, open, close), low: Math.min(low, open, close), close };
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
    
        const xC = (Number(working.c_reserve_lamports) || 0) / LAMPORTS_PER_SOL;
        const pC = spotPriceSOLPerToken(modelRef.current, xC) ?? null;
    
        const lastAggPrice = aggPrice.at(-1) || null;
        const lastAggMcap  = aggMcap.at(-1)  || null;
    
        setPendingCandle(
          Number.isFinite(pC)
            ? makePendingFromValue(pC, tsMs, vis, lastAggPrice)
            : null
        );
        setPendingMcap(
          Number.isFinite(xC)
            ? makePendingFromValue(xC, tsMs, vis, lastAggMcap)
            : null
        );
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

    // helper
    const toSol = (x) => Number(x) / LAMPORTS_PER_SOL;

    // ========== handlers ==========
    const onCandleWorking = (ev) => {
      const msg = JSON.parse(ev.data || "{}");
      if (!msg || msg.mint !== mint) return;
      const c = msg.candle;
      if (!c) return;

      const t = Number(c.t || c.bucket_start);
      const xO = toSol(c.o_reserve_lamports);
      const xH = toSol(c.h_reserve_lamports);
      const xL = toSol(c.l_reserve_lamports);
      const xC = toSol(c.c_reserve_lamports);

      const m = modelRef.current;
      const pO = spotPriceSOLPerToken(m, xO);
      const pH = spotPriceSOLPerToken(m, xH);
      const pL = spotPriceSOLPerToken(m, xL);
      const pC = spotPriceSOLPerToken(m, xC);

      // pending PRICE (derived)
      if ([pO, pH, pL, pC].every(Number.isFinite)) {
        setPendingCandle({
          time: t,
          open: pO,
          high: Math.max(pH, pO, pC),
          low:  Math.min(pL, pO, pC),
          close: pC,
        });
      } else {
        setPendingCandle(null);
      }

      // pending MCAP (reserves)
      if ([xO, xH, xL, xC].every(Number.isFinite)) {
        setPendingMcap({
          time: t,
          open: xO,
          high: Math.max(xH, xO, xC),
          low:  Math.min(xL, xO, xC),
          close: xC,
        });
      } else {
        setPendingMcap(null);
      }
    };

    const onCandleFinal = (ev) => {
      const msg = JSON.parse(ev.data || "{}");
      if (!msg || msg.mint !== mint) return;
      const c = msg.candle;
      if (!c) return;

      const t  = Number(c.t || c.bucket_start);
      const xO = toSol(c.o_reserve_lamports);
      const xH = toSol(c.h_reserve_lamports);
      const xL = toSol(c.l_reserve_lamports);
      const xC = toSol(c.c_reserve_lamports);

      const m  = modelRef.current;
      const pO = spotPriceSOLPerToken(m, xO);
      const pH = spotPriceSOLPerToken(m, xH);
      const pL = spotPriceSOLPerToken(m, xL);
      const pC = spotPriceSOLPerToken(m, xC);

      // push finalized PRICE candle into confirmedCandles
      if ([pO, pH, pL, pC].every(Number.isFinite)) {
        const next = {
          time: t,
          open: pO,
          high: Math.max(pH, pO, pC),
          low:  Math.min(pL, pO, pC),
          close: pC,
        };
        setConfirmedCandles((prev) => {
          const last = prev.at(-1);
          if (last?.time === t) return [...prev.slice(0, -1), next];
          if (!last || last.time < t) return [...prev, next];
          const i = prev.findIndex((z) => z.time === t);
          if (i >= 0) { const cp = prev.slice(); cp[i] = next; return cp; }
          return [...prev, next].sort((a,b)=>a.time-b.time);
        });
      }

      // push finalized MCAP candle
      const nextM = {
        time: t,
        open: xO,
        high: Math.max(xH, xO, xC),
        low:  Math.min(xL, xO, xC),
        close: xC,
      };
      setMcapCandles((prev) => {
        const last = prev.at(-1);
        if (last?.time === t) return [...prev.slice(0, -1), nextM];
        if (!last || last.time < t) return [...prev, nextM];
        const i = prev.findIndex((z) => z.time === t);
        if (i >= 0) { const cp = prev.slice(); cp[i] = nextM; return cp; }
        return [...prev, nextM].sort((a,b)=>a.time-b.time);
      });

      // clear pending if it was for this bucket
      setPendingCandle((p) => (p?.time === t ? null : p));
      setPendingMcap((p) => (p?.time === t ? null : p));
    };

    const onBucketRoll = (ev) => {
      if (!historyReadyRef.current) return;
      const msg = JSON.parse(ev.data || "{}");
      if (msg.mint !== mint) return;
  
      const vis = visBucketSecRef.current;
      const curVisBucket = Math.floor(Number(msg.current || 0) / vis) * vis;
  
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

            {/* range + unit + metric controls (optional): you can hide them too while loading if you want */}
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

            {/* While we’re loading, show a placeholder instead of the chart */}
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
        <Leaderboard mint={mint} version={lbVersion} />
      </div>
    </main>
  );
}
