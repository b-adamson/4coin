"use client";
import { useEffect, useMemo, useRef, useState } from "react";

export default function PriceChart({
  confirmed = [],
  pending = null,
  mcapCandles = [],
  pendingMcap = null,

  devNet = [],               // [{ time, netSol }]
  height = 360,
  autoSnap = true,
  bucketSec = 900,

  solUsdRate = 0,
  defaultUnit = "SOL",
  showUnitToggle = true,

  unit: forcedUnit,          // "SOL" | "USD"
  metric = "PRICE",          // "PRICE" | "MCAP"
}) {
  const hostRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const [chartReady, setChartReady] = useState(false);
  const tooltipRef = useRef(null);
  const firstDataAppliedRef = useRef(false);
  const atRightEdgeRef = useRef(true);

  const devMapRef = useRef(new Map());

  // --- UI unit state (local, can be overridden by parent) ---
  const [unit, setUnit] = useState(defaultUnit === "USD" ? "USD" : "SOL");
  useEffect(() => {
    if (forcedUnit === "SOL" || forcedUnit === "USD") setUnit(forcedUnit);
  }, [forcedUnit]);

  // ---------- Core helpers ----------
  function clampOHLCOrdering({ time, open, high, low, close }) {
    const EPS = 1e-18;
    open  = Number.isFinite(open)  ? +open  : 0;
    high  = Number.isFinite(high)  ? +high  : open;
    low   = Number.isFinite(low)   ? +low   : open;
    close = Number.isFinite(close) ? +close : open;

    high = Math.max(high, Math.max(open, close));
    low  = Math.min(low,  Math.min(open, close));

    if (high - low === 0) {
      high += EPS;
      low  -= EPS;
    }
    return { time, open, high, low, close };
  }

  function sanitizeAndSortOHLC(data) {
    if (!Array.isArray(data)) return [];
    const out = [];
    for (const c of data) {
      if (!c || typeof c.time !== "number") continue;
      const t = Math.floor(c.time);
      if (!Number.isFinite(t)) continue;
      out.push(clampOHLCOrdering({ ...c, time: t }));
    }
    out.sort((a, b) => a.time - b.time);
    const dedup = [];
    let lastT = -Infinity;
    for (const c of out) {
      if (c.time === lastT) dedup[dedup.length - 1] = c;
      else { dedup.push(c); lastT = c.time; }
    }
    return dedup;
  }

  // PRICE: merge confirmed + pending
  const priceMerged = useMemo(() => {
    const base = Array.isArray(confirmed) ? confirmed : [];
    if (!pending || typeof pending.time !== "number") return base;
    const last = base.at(-1);
    if (!last) return [pending];
    if (pending.time > last.time) return [...base, pending];
    if (pending.time === last.time) return [...base.slice(0, -1), pending];
    return base;
  }, [confirmed, pending]);

  // MCAP: merge confirmed + pending
  const mcapMerged = useMemo(() => {
    const base = Array.isArray(mcapCandles) ? mcapCandles : [];
    if (!pendingMcap || typeof pendingMcap.time !== "number") return base;
    const last = base.at(-1);
    if (!last) return [pendingMcap];
    if (pendingMcap.time > last.time) return [...base, pendingMcap];
    if (pendingMcap.time === last.time) return [...base.slice(0, -1), pendingMcap];
    return base;
  }, [mcapCandles, pendingMcap]);

  const priceSan = useMemo(() => sanitizeAndSortOHLC(priceMerged), [priceMerged]);
  const mcapSan  = useMemo(() => sanitizeAndSortOHLC(mcapMerged),  [mcapMerged]);

  // Choose source by metric
  const sourceData = metric === "MCAP" ? mcapSan : priceSan;

  // --- Rate & unit selection ---
  const rate = useMemo(() => Number(solUsdRate) || 0, [solUsdRate]);
  const canShowUSD = rate > 0;
  const displayUnit = unit === "USD" && canShowUSD ? "USD" : "SOL";

  // --- Convert to USD if needed ---
  const unitConvertedData = useMemo(() => {
    if (!sourceData?.length) return [];
    if (displayUnit === "USD") {
      return sourceData.map(c => ({
        time: c.time,
        open:  c.open  * rate,
        high:  c.high  * rate,
        low:   c.low   * rate,
        close: c.close * rate,
      }));
    }
    return sourceData;
  }, [sourceData, displayUnit, rate]);

  // --- Auto normalization ---
   // --- Auto normalization (handles big AND tiny values) ---
   const { normalizedData, factorSuffix } = useMemo(() => {
     if (!unitConvertedData?.length) return { normalizedData: [], factorSuffix: "" };
     const values = unitConvertedData.flatMap(c => [c.open, c.high, c.low, c.close]).filter(Number.isFinite);
     if (!values.length) return { normalizedData: unitConvertedData, factorSuffix: "" };
 
     const maxVal = Math.max(...values);
     if (!(maxVal > 0)) return { normalizedData: unitConvertedData, factorSuffix: "" };
 
     // bring the max into [1, 1000) by stepping in 10^3
     const exp = Math.floor(Math.log10(maxVal)); // could be negative
     const useScaling = Math.abs(exp) >= 3;      // only scale if at least 1e3 away from 1
     const targetExp = useScaling ? exp - (exp % 3) : 0; // ...,-9,-6,-3,0,3,6,9,...
     const factor = Math.pow(10, targetExp);
 
     const norm = useScaling
       ? unitConvertedData.map(c => ({
           time: c.time,
           open:  c.open  / factor,
           high:  c.high  / factor,
           low:   c.low   / factor,
           close: c.close / factor,
         }))
       : unitConvertedData;
 
     let suffix = "";
     if (targetExp !== 0) {
       const sign = targetExp > 0 ? "-" : "+"; // dividing by 1e^E ⇒ label needs ×1e^{-E}
       suffix = ` ×1e${sign}${Math.abs(targetExp)}`;
     }
     return { normalizedData: norm, factorSuffix: suffix };
   }, [unitConvertedData]);

  // --- Dev markers ---
  useEffect(() => {
    const m = new Map();
    for (const d of devNet || []) {
      const t = typeof d?.time === "number" ? Math.floor(d.time) : NaN;
      const v = Number(d?.netSol);
      if (Number.isFinite(t) && Number.isFinite(v) && v !== 0) {
        const snapped = Math.floor(t / bucketSec) * bucketSec;
        m.set(snapped, (m.get(snapped) || 0) + v);
      }
    }
    devMapRef.current = m;
  }, [devNet, bucketSec]);

  function buildMarkers() {
    if (!normalizedData?.length || devMapRef.current.size === 0) return [];
    const candleTimes = new Set(normalizedData.map(c => c.time));
    const markers = [];
    for (const [rawTime, netSol] of devMapRef.current.entries()) {
      const t = candleTimes.has(rawTime)
        ? rawTime
        : Math.floor(rawTime / bucketSec) * bucketSec;
      if (!candleTimes.has(t)) continue;
      const isBuy = netSol > 0;
      markers.push({
        time: t,
        position: isBuy ? "aboveBar" : "belowBar",
        shape: isBuy ? "arrowUp" : "arrowDown",
        color: isBuy ? "#16a34a" : "#dc2626",
        text: "Dev",
      });
    }
    return markers;
  }

  function hideTooltip() {
    if (tooltipRef.current) tooltipRef.current.style.display = "none";
  }

  // --- Init chart once ---
  useEffect(() => {
    if (!hostRef.current || chartRef.current) return;

    let disposed = false;
    (async () => {
      const { createChart } = await import("lightweight-charts");
      const width = Math.max(20, Math.floor(hostRef.current.getBoundingClientRect().width));

      const chart = createChart(hostRef.current, {
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
      });

      if (disposed) {
        chart.remove();
        return;
      }
      chartRef.current = chart;
      seriesRef.current = series;

      chart.timeScale().subscribeVisibleTimeRangeChange(() => {
        const pos = chart.timeScale().scrollPosition?.() ?? 0;
        atRightEdgeRef.current = Math.abs(pos) < 0.05;
      });
      setChartReady(true);
    })();

    return () => {
      disposed = true;
      if (chartRef.current) {
        try { chartRef.current.remove(); } catch {}
        chartRef.current = null;
        seriesRef.current = null;
      }
      setChartReady(false);
    };
  }, [height, bucketSec]);

  // --- Axis label formatter ---
  useEffect(() => {
    const s = seriesRef.current;
    if (!s || !chartReady) return;
    const metricLabel = metric === "MCAP" ? " MCAP" : "";
    const suffix = `${factorSuffix} ${displayUnit}${metricLabel}`;
    s.applyOptions({
      priceFormat: {
        type: "custom",
        minMove: 0.000001,
        formatter: (p) => {
          if (!Number.isFinite(p)) return `–${suffix}`;
          return `${p.toLocaleString(undefined, { maximumFractionDigits: 6 })}${suffix}`;
        },
      },
    });
  }, [displayUnit, factorSuffix, metric, chartReady, bucketSec]);

  // --- Push data + markers ---
  useEffect(() => {
    const s = seriesRef.current;
    const ch = chartRef.current;
    if (!s || !ch || !chartReady) return;

    const safeData = (normalizedData || []).filter(
      d =>
        d &&
        Number.isFinite(d.time) &&
        Number.isFinite(d.open) &&
        Number.isFinite(d.high) &&
        Number.isFinite(d.low) &&
        Number.isFinite(d.close)
    );

    if (safeData.length === 0) {
      s.setData([]);
      s.setMarkers([]);
      hideTooltip();
      firstDataAppliedRef.current = false;
      return;
    }

    s.setData(safeData);

    const ts = ch.timeScale();
    if (!firstDataAppliedRef.current || safeData.length > (s._lastCount || 0)) {
      ts.fitContent();
      if (autoSnap) ts.scrollToPosition?.(0, true);
      firstDataAppliedRef.current = true;
      s._lastCount = safeData.length;
    } else if (autoSnap && atRightEdgeRef.current) {
      ts.scrollToPosition?.(0, true);
    }

    s.setMarkers(buildMarkers());
   }, [normalizedData, autoSnap, bucketSec, devNet, chartReady]);

  return (
    <div
      ref={hostRef}
      style={{
        width: "100%",
        height: `${height}px`,
        minHeight: `${Math.max(180, height)}px`,
        position: "relative",
      }}
    >
      {showUnitToggle && (
        <div style={{ position: "absolute", top: 8, right: 8, zIndex: 6, display: "flex", gap: 6 }}>
          <button
            onClick={() => setUnit("SOL")}
            className={`chan-toggle ${unit === "SOL" ? "is-active" : ""}`}
          >
            [SOL]
          </button>
          <button
            onClick={() => canShowUSD && setUnit("USD")}
            className={`chan-toggle ${unit === "USD" ? "is-active" : ""} ${canShowUSD ? "" : "chan-toggle--disabled"}`}
            title={canShowUSD ? "" : "Provide solUsdRate to enable USD"}
          >
            [USD]
          </button>
        </div>
      )}
    </div>
  );
}
