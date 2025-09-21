"use client";
import { useEffect, useMemo, useRef, useState } from "react";

export default function PriceChart({
  // PRICE candles (SOL per token), same as before
  confirmed = [],            // [{ time, open, high, low, close }]
  pending = null,            // optional overlay for current bucket (PRICE)
  // MCAP candles (total SOL in the curve vault over time, as OHLC)
  mcapCandles = [],          // [{ time, open, high, low, close }] in SOL
  pendingMcap = null,        // optional overlay for MCAP (if you have latest reserve)

  devNet = [],               // [{ time, netSol }]
  height = 360,
  autoSnap = true,
  bucketSec = 900,

  // ---- Normalization ----
  normalize = true,
  normalizeFactor = 1e6,
  normalizedPrecision = 6,

  // ---- Currency ----
  solUsdRate = 0,            // SOL -> USD rate
  defaultUnit = "SOL",       // fallback if no external unit
  showUnitToggle = true,     // internal toggle (can be hidden when controlled)

  // ---- External controls ----
  unit: forcedUnit,          // "SOL" | "USD" (optional)
  metric = "PRICE",          // "PRICE" | "MCAP"
}) {
  const hostRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const roRef = useRef(null);
  const tooltipRef = useRef(null);
  const initializedRef = useRef(false);
  const firstDataAppliedRef = useRef(false);
  const atRightEdgeRef = useRef(true);
  const unsubscribeRef = useRef(null);
  const unsubCrosshairRef = useRef(null);

  // keep latest dev map in a ref so crosshair handler always sees fresh data
  const devMapRef = useRef(new Map());

  // --- UI unit state (local, can be overridden by parent) ---
  const [unit, setUnit] = useState(defaultUnit === "USD" ? "USD" : "SOL");
  useEffect(() => {
    if (forcedUnit === "SOL" || forcedUnit === "USD") setUnit(forcedUnit);
  }, [forcedUnit]);

  // --- Merge helper (for PRICE and MCAP separately) ---
  function sanitizeOHLC(data) {
    const out = [];
    let lastT = -Infinity;
    for (const c of data || []) {
      if (
        c &&
        typeof c.time === "number" &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      ) {
        const t = Math.floor(c.time);
        if (t > lastT) {
          out.push({
            time: t,
            open: +c.open,
            high: +c.high,
            low: +c.low,
            close: +c.close,
          });
          lastT = t;
        }
      }
    }
    return out;
  }

  // PRICE: merge confirmed + pending
  const priceMerged = useMemo(() => {
    const base = Array.isArray(confirmed) ? confirmed : [];
    if (pending && typeof pending.time === "number") {
      const last = base[base.length - 1];
      if (!last || last.time !== pending.time) return [...base, pending];
      return [...base.slice(0, -1), pending];
    }
    return base;
  }, [confirmed, pending]);

  // MCAP: merge mcapCandles + pendingMcap (if provided)
  const mcapMerged = useMemo(() => {
    const base = Array.isArray(mcapCandles) ? mcapCandles : [];
    if (pendingMcap && typeof pendingMcap.time === "number") {
      const last = base[base.length - 1];
      if (!last || last.time !== pendingMcap.time) return [...base, pendingMcap];
      return [...base.slice(0, -1), pendingMcap];
    }
    return base;
  }, [mcapCandles, pendingMcap]);

  const priceSan = useMemo(() => sanitizeOHLC(priceMerged), [priceMerged]);
  const mcapSan  = useMemo(() => sanitizeOHLC(mcapMerged), [mcapMerged]);

  // Choose source by metric
  const sourceData = metric === "MCAP" ? mcapSan : priceSan;

  // --- Rate & unit selection ---
  const rate = useMemo(() => Number(solUsdRate) || 0, [solUsdRate]);
  const canShowUSD = rate > 0;
  const displayUnit = unit === "USD" && canShowUSD ? "USD" : "SOL";

  // --- Convert to unit BEFORE normalization ---
  const unitConvertedData = useMemo(() => {
    if (!sourceData?.length) return sourceData;
    if (displayUnit === "USD") {
      return sourceData.map(c => ({
        time: c.time,
        open: c.open * rate,
        high: c.high * rate,
        low:  c.low  * rate,
        close:c.close* rate,
      }));
    }
    return sourceData; // SOL
  }, [sourceData, displayUnit, rate]);

  // --- Normalization (Option C) ---
  const factorSuffix = useMemo(() => {
    if (!normalize || !Number.isFinite(normalizeFactor) || normalizeFactor === 1) return "";
    const k = Math.round(Math.log10(normalizeFactor));
    const pow10 = Math.abs(Math.pow(10, k) - normalizeFactor) < 1e-12;
    return pow10 ? ` ×1e-${k}` : ` ÷${normalizeFactor}`;
  }, [normalize, normalizeFactor]);

  const normalizedData = useMemo(() => {
    if (!normalize || !Number.isFinite(normalizeFactor) || normalizeFactor === 1) {
      return unitConvertedData;
    }
    const f = normalizeFactor;
    return (unitConvertedData || []).map(c => ({
      time: c.time,
      open: c.open * f,
      high: c.high * f,
      low:  c.low  * f,
      close:c.close* f,
    }));
  }, [unitConvertedData, normalize, normalizeFactor]);

  // --- Update dev map (net SOL by bucket) ---
  useEffect(() => {
    const m = new Map();
    for (const d of devNet || []) {
      if (typeof d?.time === "number" && Number.isFinite(d?.netSol) && d.netSol !== 0) {
        m.set(Math.floor(d.time), Number(d.netSol));
      }
    }
    devMapRef.current = m;
  }, [devNet]);

  // --- Markers at buckets with dev activity (times align for PRICE & MCAP) ---
  function buildMarkers() {
    if (!normalizedData?.length || devMapRef.current.size === 0) return [];
    const candleTimes = new Set(normalizedData.map(c => c.time));
    const markers = [];
    for (const [time, netSol] of devMapRef.current.entries()) {
      if (!candleTimes.has(time)) continue;
      const isBuy = netSol > 0;
      markers.push({
        time,
        position: isBuy ? "aboveBar" : "belowBar",
        shape: isBuy ? "arrowUp" : "arrowDown",
        color: isBuy ? "#16a34a" : "#dc2626",
        text: "Dev",
      });
    }
    return markers;
  }

  // --- Tooltip helpers (kept simple; still mentions SOL for dev flow) ---
  function ensureTooltip(rootEl) {
    if (tooltipRef.current) return tooltipRef.current;
    const tip = document.createElement("div");
    tip.style.position = "absolute";
    tip.style.zIndex = "5";
    tip.style.pointerEvents = "none";
    tip.style.padding = "6px 8px";
    tip.style.borderRadius = "6px";
    tip.style.boxShadow = "0 4px 12px rgba(0,0,0,0.12)";
    tip.style.font = "12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    tip.style.background = "#fff";
    tip.style.border = "1px solid #e5e7eb";
    tip.style.color = "#111";
    tip.style.transform = "translate(-50%, -100%)";
    tip.style.display = "none";
    if (getComputedStyle(rootEl).position === "static") {
      rootEl.style.position = "relative";
    }
    rootEl.appendChild(tip);
    tooltipRef.current = tip;
    return tip;
  }
  function hideTooltip() { const tip = tooltipRef.current; if (tip) tip.style.display = "none"; }
  function fmtTimeSec(sec) { try { return new Date(sec * 1000).toLocaleString(); } catch { return String(sec); } }

  // --- Init chart once ---
  useEffect(() => {
    let cancelled = false;

    async function init() {
      const rootEl = hostRef.current;
      if (!rootEl || initializedRef.current) return;

      // wait for measurable size
      let tries = 0;
      while (!cancelled && tries < 60) {
        if (!rootEl || !rootEl.isConnected) return;
        const r = rootEl.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) break;
        await new Promise((r) => requestAnimationFrame(r));
        tries++;
      }
      if (cancelled || !rootEl || !rootEl.isConnected || initializedRef.current) return;

      const { createChart } = await import("lightweight-charts"); // v4
      const width = Math.max(20, Math.floor(rootEl.getBoundingClientRect().width));

      const chart = createChart(rootEl, {
        width,
        height,
        layout: { backgroundColor: "#ffffff", textColor: "#111" },
        rightPriceScale: { borderVisible: false },
        timeScale: {
          timeVisible: true,
          secondsVisible: bucketSec < 3600,
          borderVisible: false,
          rightOffset: 2,
          barSpacing: 1,
        },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        crosshair: { mode: 1 },
      });

      const series = chart.addCandlestickSeries({
        upColor: "#16a34a",
        downColor: "#dc2626",
        wickUpColor: "#16a34a",
        wickDownColor: "#dc2626",
        borderVisible: false,
        priceFormat: { type: "custom", minMove: 0.000001, formatter: (p) => (Number.isFinite(p) ? String(p) : "–") },
        priceLineVisible: false,
      });

      chartRef.current = chart;
      seriesRef.current = series;
      initializedRef.current = true;

      // Resize observer
      roRef.current = new ResizeObserver(() => {
        if (!rootEl || !chartRef.current) return;
        const w = Math.max(20, Math.floor(rootEl.getBoundingClientRect().width));
        chartRef.current.applyOptions({ width: w });
      });
      if (rootEl.isConnected) roRef.current.observe(rootEl);

      // Right-edge tracking
      const ts = chart.timeScale();
      const onRange = () => {
        const pos = ts.scrollPosition?.() ?? 0;
        atRightEdgeRef.current = Math.abs(pos) < 0.05;
      };
      ts.subscribeVisibleTimeRangeChange(onRange);
      unsubscribeRef.current = () => { try { ts.unsubscribeVisibleTimeRangeChange(onRange); } catch {} };

      // Tooltip & crosshair
      ensureTooltip(rootEl);
      const onCrosshairMove = (param) => {
        if (!param?.time || !param?.point || !seriesRef.current || !chartRef.current) { hideTooltip(); return; }
        const tSec = typeof param.time === "number" ? param.time : Number(param.time);
        if (!Number.isFinite(tSec)) { hideTooltip(); return; }
        const net = devMapRef.current.get(Math.floor(tSec)) || 0;
        if (net === 0) { hideTooltip(); return; }

        const sd = param.seriesData && param.seriesData.get ? param.seriesData.get(seriesRef.current) : null;
        const anchorPrice = net > 0 ? (sd?.high ?? sd?.close ?? undefined) : (sd?.low ?? sd?.close ?? undefined);
        const s = seriesRef.current;
        const yCoord = anchorPrice != null ? s.priceToCoordinate(anchorPrice) : param.point.y;
        const x = param.point.x;
        const y = (yCoord ?? param.point.y) + (net > 0 ? -10 : 10);

        const tip = tooltipRef.current; if (!tip) return;
        tip.textContent = `${net > 0 ? "Net dev buy" : "Net dev sell"} ${Math.abs(net).toFixed(6)} SOL • ${fmtTimeSec(tSec)}`;
        tip.style.display = "block";
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
        tip.style.background = net > 0 ? "#f0fdf4" : "#fef2f2";
        tip.style.border = `1px solid ${net > 0 ? "#bbf7d0" : "#fecaca"}`;
        tip.style.color = net > 0 ? "#065f46" : "#7f1d1d";
      };
      chart.subscribeCrosshairMove(onCrosshairMove);
      unsubCrosshairRef.current = () => { try { chart.unsubscribeCrosshairMove(onCrosshairMove); } catch {} };
    }

    const t = setTimeout(init, 0);
    return () => {
      clearTimeout(t);
      hideTooltip();
      try { roRef.current?.disconnect(); } catch {}
      roRef.current = null;
      try { unsubscribeRef.current?.(); } catch {}
      unsubscribeRef.current = null;
      try { unsubCrosshairRef.current?.(); } catch {}
      unsubCrosshairRef.current = null;
      try {
        const tip = tooltipRef.current;
        const root = hostRef.current;
        if (tip && root && tip.parentNode === root) root.removeChild(tip);
      } catch {}
      tooltipRef.current = null;
      try { chartRef.current?.remove?.(); } catch {}
      chartRef.current = null;
      seriesRef.current = null;
      initializedRef.current = false;
      firstDataAppliedRef.current = false;
      atRightEdgeRef.current = true;
    };
  }, [height, bucketSec]);

  // --- Keep the axis label unit & normalization suffix in sync ---
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;

    const metricLabel = metric === "MCAP" ? " MCAP" : ""; // postfix after unit
    const suffix = factorSuffix ? `${factorSuffix} ${displayUnit}${metricLabel}` : ` ${displayUnit}${metricLabel}`;

    s.applyOptions({
      priceFormat: {
        type: "custom",
        minMove: 0.000001,
        formatter: (p) => {
          if (!Number.isFinite(p)) return `–${suffix}`;
          return `${p.toFixed(normalizedPrecision)}${suffix}`;
        },
      },
    });
  }, [displayUnit, factorSuffix, normalizedPrecision, metric]);

  // --- Push data + (re)apply markers ---
  useEffect(() => {
    const s = seriesRef.current;
    const ch = chartRef.current;
    if (!s || !ch) return;

    try {
      s.setData(normalizedData || []);
      if (!normalizedData?.length) {
        s.setMarkers([]);
        hideTooltip();
        return;
      }

      const ts = ch.timeScale();
      if (!firstDataAppliedRef.current) {
        ts.fitContent();
        firstDataAppliedRef.current = true;
        if (autoSnap) ts.scrollToPosition?.(0, true);
      } else if (autoSnap && atRightEdgeRef.current) {
        ts.scrollToPosition?.(0, true);
      }

      s.setMarkers(buildMarkers());
    } catch (e) {
      console.error("PriceChart setData/markers error:", e);
    }
  }, [normalizedData, autoSnap, bucketSec, devNet]);

  // --- If devNet changes independently, still update markers ---
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    try { s.setMarkers(buildMarkers()); } catch {}
  }, [devNet]);

  // --- Optional internal SOL/USD toggle (if you still want it) ---
  return (
    <div
      ref={hostRef}
      style={{ width: "100%", height: `${height}px`, minHeight: `${Math.max(180, height)}px`, position: "relative" }}
    >
      {showUnitToggle && (
        <div style={{ position: "absolute", top: 8, right: 8, zIndex: 6, display: "flex", gap: 6 }}>
          <button
            onClick={() => setUnit("SOL")}
            className={`chan-toggle ${unit === "SOL" ? "is-active" : ""}`}
            aria-pressed={unit === "SOL"}
          >
            [SOL]
          </button>
          <button
            onClick={() => canShowUSD && setUnit("USD")}
            className={`chan-toggle ${unit === "USD" ? "is-active" : ""} ${canShowUSD ? "" : "chan-toggle--disabled"}`}
            aria-pressed={unit === "USD"}
            title={canShowUSD ? "" : "Provide solUsdRate to enable USD"}
          >
            [USD]
          </button>
        </div>
      )}

      {unit === "USD" && !canShowUSD && (
        <div
          style={{
            position: "absolute",
            top: 40,
            right: 8,
            zIndex: 6,
            fontSize: 12,
            background: "#fff7ed",
            border: "1px solid #fed7aa",
            color: "#7c2d12",
            padding: "6px 8px",
            borderRadius: 6,
            boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
          }}
        >
          USD view needs <code>solUsdRate</code>. Showing SOL instead.
        </div>
      )}
    </div>
  );
}
