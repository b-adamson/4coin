// PriceChart.jsx (v5) — dynamic buckets
"use client";
import { useEffect, useMemo, useRef } from "react";

export default function PriceChart({
  confirmed = [],          // [{ time, open, high, low, close }]
  pending = null,          // optional overlay for current bucket
  height = 360,
  autoSnap = true,
  bucketSec = 900,         // << NEW: visual candle bucket; default 15m (900s)
}) {
  const hostRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const roRef = useRef(null);
  const initializedRef = useRef(false);
  const firstDataAppliedRef = useRef(false);

  const atRightEdgeRef = useRef(true);
  const unsubscribeRef = useRef(null);

  // Merge confirmed + pending (pending replaces last if same bucket)
  const merged = useMemo(() => {
    const base = Array.isArray(confirmed) ? confirmed : [];
    if (pending && typeof pending.time === "number") {
      const last = base[base.length - 1];
      if (!last || last.time !== pending.time) return [...base, pending];
      return [...base.slice(0, -1), pending];
    }
    return base;
  }, [confirmed, pending]);

  function sanitize(data) {
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
        const t = Math.floor(c.time); // UTCTimestamp (seconds)
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

  // Init chart once (unchanged except we hide seconds for big buckets)
  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (!hostRef.current || initializedRef.current) return;

      // wait for measurable size
      let tries = 0;
      while (!cancelled && tries < 60) {
        const el = hostRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) break;
        await new Promise((r) => requestAnimationFrame(r));
        tries++;
      }
      if (cancelled || !hostRef.current || initializedRef.current) return;

      const { createChart } = await import("lightweight-charts"); // v4

      const rect = hostRef.current.getBoundingClientRect();
      const width = Math.max(20, Math.floor(rect.width));

      const chart = createChart(hostRef.current, {
        width,
        height,
        layout: { backgroundColor: "#ffffff", textColor: "#111" },
        rightPriceScale: { borderVisible: false },
        timeScale: {
          timeVisible: true,
          secondsVisible: bucketSec < 3600,   // << seconds only for < 1h buckets
          borderVisible: false,
          rightOffset: 2,
          barSpacing: 1,
        },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      });

      const series = chart.addCandlestickSeries({
        upColor: "#16a34a",
        downColor: "#dc2626",
        wickUpColor: "#16a34a",
        wickDownColor: "#dc2626",
        borderVisible: false,
        priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
        priceLineVisible: false,
      });

      chartRef.current = chart;
      seriesRef.current = series;
      initializedRef.current = true;

      roRef.current = new ResizeObserver(() => {
        if (!hostRef.current || !chartRef.current) return;
        const w = Math.max(20, Math.floor(hostRef.current.getBoundingClientRect().width));
        chartRef.current.applyOptions({ width: w });
      });
      roRef.current.observe(hostRef.current);

      const ts = chart.timeScale();
      const onRange = () => {
        const pos = ts.scrollPosition?.() ?? 0;
        atRightEdgeRef.current = Math.abs(pos) < 0.05;
      };
      ts.subscribeVisibleTimeRangeChange(onRange);
      unsubscribeRef.current = () => {
        try { ts.unsubscribeVisibleTimeRangeChange(onRange); } catch {}
      };
    }

    const t = setTimeout(init, 0);
    return () => {
      clearTimeout(t);
      try { roRef.current?.disconnect(); } catch {}
      roRef.current = null;
      try { unsubscribeRef.current?.(); } catch {}
      unsubscribeRef.current = null;
      try { chartRef.current?.remove?.(); } catch {}
      chartRef.current = null;
      seriesRef.current = null;
      initializedRef.current = false;
      firstDataAppliedRef.current = false;
      atRightEdgeRef.current = true;
    };
  }, [height, bucketSec]);

  // Push data (unchanged)
  useEffect(() => {
    const s = seriesRef.current;
    const ch = chartRef.current;
    if (!s || !ch) return;

    const data = sanitize(merged);

    try {
      s.setData(data);
      if (!data.length) return;

      const ts = ch.timeScale();

      if (!firstDataAppliedRef.current) {
        ts.fitContent();
        firstDataAppliedRef.current = true;
        if (autoSnap) ts.scrollToPosition?.(0, true);
        return;
      }

      if (autoSnap && atRightEdgeRef.current) {
        ts.scrollToPosition?.(0, true);
      }
    } catch (e) {
      console.error("PriceChart setData error:", e);
    }
  }, [merged, autoSnap]);

  return (
    <div
      ref={hostRef}
      style={{ width: "100%", height: `${height}px`, minHeight: `${Math.max(180, height)}px` }}
    />
  );
}
