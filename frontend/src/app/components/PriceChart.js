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
  metric = "PRICE",
  dark = false,         
}) {
  const hostRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const [chartReady, setChartReady] = useState(false);
  const tooltipRef = useRef(null);
  const firstDataAppliedRef = useRef(false);
  const atRightEdgeRef = useRef(true);

  const devMapRef = useRef(new Map());
  const markersRef = useRef([]); // store current markers

  // live refs for unit & rate (used inside crosshair handler)
  const displayUnitRef = useRef("SOL");
  const rateRef = useRef(Number(solUsdRate) || 0);

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

    if (high - low === 0) { high += EPS; low -= EPS; }
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

  // keep live in refs for handler
  useEffect(() => { displayUnitRef.current = displayUnit; }, [displayUnit]);
  useEffect(() => { rateRef.current = rate; }, [rate]);

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
      const sign = targetExp > 0 ? "-" : "+"; // dividing by 1e^E ⇒ label shows ×1e^{-E}
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
    const green = getCssVar("--name");
    const red   = getCssVar("--down");

    const markers = [];
    for (const [rawTime, netSol] of devMapRef.current.entries()) {
      const t = candleTimes.has(rawTime) ? rawTime : Math.floor(rawTime / bucketSec) * bucketSec;
      if (!candleTimes.has(t)) continue;

      const isBuy = netSol > 0;
      markers.push({
        time: t,
        position: isBuy ? "aboveBar" : "belowBar",
        shape: isBuy ? "arrowUp" : "arrowDown",
        color: isBuy ? green : red,   // << here
        text: "Dev",
      });
    }
    return markers;
  }

  function getCssVar(name, fallback = "#000") {
    if (typeof window === "undefined") return fallback;
    const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return val || fallback;
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
        layout: { 
          background: { type: "solid", color: getCssVar("--chart-bg") },
          textColor: getCssVar("--chart-text"),
        },
        rightPriceScale: { 
          borderVisible: true, 
          borderColor: getCssVar("--chart-axis", "#800000"),
        },
        timeScale: { 
          borderVisible: true, 
          borderColor: getCssVar("--chart-axis", "#800000"),
        },
        grid: {
          vertLines: { visible: true, color: "rgba(0,0,0,0.03)" }, // near invisible
          horzLines: { visible: true, color: "rgba(0,0,0,0.03)" }, // near invisible
        },
        crosshair: {
          mode: 1,
          vertLine: { 
            color: getCssVar("--chart-crosshair", "#800000"),
            width: 1, 
            style: 0, 
            labelBackgroundColor: getCssVar("--chart-crosshair", "#800000") 
          },
          horzLine: { 
            color: getCssVar("--chart-crosshair", "#800000"), 
            width: 1, 
            style: 0, 
            labelBackgroundColor: getCssVar("--chart-crosshair", "#800000") 
          },
        },
      });

      const series = chart.addCandlestickSeries({
        upColor:        getCssVar("--name"),
        borderUpColor:  getCssVar("--name"),
        wickUpColor:    getCssVar("--name"),
        downColor:        getCssVar("--down"),
        borderDownColor:  getCssVar("--down"),
        wickDownColor:    getCssVar("--down"),
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

  useEffect(() => {
    const ch = chartRef.current;
    const s  = seriesRef.current;
    if (!ch || !s) return;

    ch.applyOptions({
      layout: {
        background: { type: "solid", color: getCssVar("--chart-bg", "#fff") },
        textColor: getCssVar("--chart-text", "#000"),
      },
      grid: {
        vertLines: { color: "rgba(0,0,0,0.03)" },
        horzLines: { color: "rgba(0,0,0,0.03)" },
      },
      crosshair: {
        vertLine: { color: getCssVar("--chart-crosshair", "#800000"), labelBackgroundColor: getCssVar("--chart-crosshair", "#800000") },
        horzLine: { color: getCssVar("--chart-crosshair", "#800000"), labelBackgroundColor: getCssVar("--chart-crosshair", "#800000") },
      },
    });

    // Re-apply candlestick theme colors
    s.applyOptions({
      upColor:        getCssVar("--name"),
      borderUpColor:  getCssVar("--name"),
      wickUpColor:    getCssVar("--name"),
      downColor:        getCssVar("--down"),
      borderDownColor:  getCssVar("--down"),
      wickDownColor:    getCssVar("--down"),
    });

    // Rebuild markers so their color updates too
    const mk = buildMarkers();
    s.setMarkers(mk);
    markersRef.current = mk;
  }, [dark]);

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
      markersRef.current = [];
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

    const mk = buildMarkers();
    s.setMarkers(mk);
    markersRef.current = mk;
  }, [normalizedData, autoSnap, bucketSec, devNet, chartReady]);

  // --- Tooltip on marker hover (no position changes) ---
  useEffect(() => {
    const ch = chartRef.current;
    const s  = seriesRef.current;
    const host = hostRef.current;
    const tip = tooltipRef.current;
    if (!ch || !s || !host || !tip) return;

    function show(text, x, y) {
      tip.textContent = text;
      tip.style.display = "block";
      // position with clamping inside the host
      const hostRect = host.getBoundingClientRect();
      const tw = tip.offsetWidth || 0;
      const th = tip.offsetHeight || 0;
      let left = x + 8;
      let top  = y - th - 8;
      // clamp
      if (left + tw > hostRect.width - 4) left = hostRect.width - tw - 4;
      if (left < 4) left = 4;
      if (top < 4) top = y + 12; // flip under if not enough space above
      tip.style.left = `${left}px`;
      tip.style.top  = `${top}px`;
    }

    function onMove(param) {
      if (!param?.point || param.time == null) {
        hideTooltip();
        return;
      }

      // Only when near a dev marker (by time AND near the arrow pixel)
      const t = Number(param.time); // seconds
      if (!devMapRef.current.has(t)) { hideTooltip(); return; }

      // compute marker (x,y) approx
      const timeCoord = ch.timeScale().timeToCoordinate?.(t);
      if (timeCoord == null || !Number.isFinite(timeCoord)) { hideTooltip(); return; }

      // find the candle so we can place the arrow y
      const candle = (normalizedData || []).find(c => c.time === t);
      if (!candle) { hideTooltip(); return; }

      const netSol = Number(devMapRef.current.get(t) || 0);
      if (!Number.isFinite(netSol) || netSol === 0) { hideTooltip(); return; }

      const isBuy = netSol > 0;
      // marker is aboveBar (near high) for buys, belowBar (near low) for sells
      const basePrice = isBuy ? candle.high : candle.low;
      const baseY = s.priceToCoordinate?.(basePrice);
      if (baseY == null || !Number.isFinite(baseY)) { hideTooltip(); return; }

      // offset a bit away from the bar, roughly where the arrow is drawn
      const markerY = baseY + (isBuy ? -14 : 14);
      const markerX = timeCoord;

      // proximity check (~12px box)
      const dx = Math.abs((param.point.x ?? 0) - markerX);
      const dy = Math.abs((param.point.y ?? 0) - markerY);
      if (dx > 12 || dy > 12) { hideTooltip(); return; }

      // build label
      const unitNow = displayUnitRef.current; // "SOL" or "USD"
      const amtSolAbs = Math.abs(netSol);
      const label = unitNow === "USD" && rateRef.current > 0
        ? `Net dev ${isBuy ? "buy" : "sell"} ${(amtSolAbs * rateRef.current).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 })}`
        : `Net dev ${isBuy ? "buy" : "sell"} ${amtSolAbs.toFixed(4)} SOL`;

      // position in host coords (param.point is already relative to chart pane)
      show(label, param.point.x, param.point.y);
    }

    function onLeave() { hideTooltip(); }

    ch.subscribeCrosshairMove(onMove);
    ch.subscribeCrosshairMove; // no-op, keeps linter happy
    // lightweight-charts has unsubscribeCrosshairMove
    return () => {
      try { ch.unsubscribeCrosshairMove(onMove); } catch {}
      hideTooltip();
    };
  }, [chartReady, normalizedData]); // normalizedData in deps so candle lookup stays in sync

  return (
      <div
        ref={hostRef}
        style={{
          width: "100%",
          height: `${height}px`,
          minHeight: `${Math.max(180, height)}px`,
          position: "relative",
          border: "1px solid var(--panel-border)",
          background: "var(--chart-bg)",
        }}
        onMouseLeave={hideTooltip}
      >
      {/* Tooltip element */}
      <div
        ref={tooltipRef}
        style={{
          position: "absolute",
          display: "none",
          pointerEvents: "none",
          zIndex: 7,
          background: "var(--panel-alt-bg)",
          color: "var(--chart-text)",
          padding: "4px 8px",
          borderRadius: 4,
          fontSize: 12,
          border: "1px solid var(--panel-border)",
          whiteSpace: "nowrap",
        }}
      />
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
