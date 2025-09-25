"use client";
import { useMemo, useRef, useState, useEffect } from "react";

/* helpers */
function formatCompact(num) {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(0) + "B";
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(0) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(0) + "K";
  return String(num);
}
function toFixedNoSci(n, d = 3) {
  if (!isFinite(n)) return "0";
  return Number(n).toFixed(d);
}
function sciScale(maxVal) {
  if (!(maxVal > 0)) return { exp: 0, factor: 1 };
  const exp = Math.floor(Math.log10(maxVal));
  return { exp, factor: 10 ** exp };
}

export default function BondingCurve({
  model,
  x0 = 0,
  ySoldWhole = 0,
  height = 140,
  samples = 240,
  boxed = true,
}) {
  /* layout */
  const gutter = 8;
  const padTop = { top: 6, right: 12, bottom: 16, left: 76 };
  const padBottom = { top: 14, right: 12, bottom: 18, left: 76 };

  const viewW = 800;
  const dimsTop = { innerW: viewW - padTop.left - padTop.right, innerH: height - padTop.top - padTop.bottom };
  const dimsBot = { innerW: viewW - padBottom.left - padBottom.right, innerH: height - padBottom.top - padBottom.bottom };
  const totalHeight = height * 2.2 + gutter;

  /* x-domain window (zoom/pan) */
  const XMAX = model?.X_MAX || 1;
  const [xDomain, setXDomain] = useState([0, XMAX]);
  useEffect(() => { if (model) setXDomain([0, model.X_MAX || 1]); }, [model]);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ xView: 0, xDomain: [0, XMAX] });

  /* tooltips */
  const [tipTop, setTipTop] = useState(null);
  const [tipBot, setTipBot] = useState(null);
  const hitR = 16;

  /* marker clamps */
  const markerX = model ? Math.max(0, Math.min(XMAX, x0 || 0)) : 0;
  const markerY = model ? Math.max(0, Math.min(model.CAP_TOKENS, ySoldWhole || 0)) : 0;

  /* dynamic scales */
  const [xMin, xMax] = xDomain;
  const xScaleTop = (vx) => {
    if (!model) return 0;
    const t = (vx - xMin) / Math.max(1e-18, xMax - xMin);
    return padTop.left + Math.max(0, Math.min(1, t)) * dimsTop.innerW;
  };
  const xScaleBot = (vx) => {
    if (!model) return 0;
    const t = (vx - xMin) / Math.max(1e-18, xMax - xMin);
    return padBottom.left + Math.max(0, Math.min(1, t)) * dimsBot.innerW;
  };
  const yScaleTokens = (vy, yMinT, yMaxT) => {
    const t = (vy - yMinT) / Math.max(1e-18, yMaxT - yMinT);
    return padTop.top + (1 - Math.max(0, Math.min(1, t))) * dimsTop.innerH;
  };

  /* TOP data */
  const dataTokens = useMemo(() => {
    if (!model) return [];
    const pts = [];
    for (let i = 0; i <= samples; i++) {
      const x = xMin + ((xMax - xMin) * i) / samples;
      pts.push({ x, y: model.tokens_between(0, x) });
    }
    return pts;
  }, [model, samples, xMin, xMax]);

  const yMinTop = useMemo(() => (dataTokens.length ? dataTokens[0].y : 0), [dataTokens]);
  const yMaxTop = useMemo(() => {
    let m = yMinTop;
    for (const p of dataTokens) if (p.y > m) m = p.y;
    return m;
  }, [dataTokens, yMinTop]);

  const pathTokens = useMemo(() => {
    if (!model || dataTokens.length === 0) return "";
    return dataTokens
      .map((p, i) => `${i ? "L" : "M"} ${xScaleTop(p.x).toFixed(2)} ${yScaleTokens(p.y, yMinTop, yMaxTop).toFixed(2)}`)
      .join(" ");
  }, [dataTokens, model, xScaleTop, yMinTop, yMaxTop]);

  /* BOTTOM (price) — windowed + sci scale */
  const priceAt = (x) => {
    if (!model) return 0;
    if (typeof model.price_at === "function") return model.price_at(x);
    if (typeof model.k === "function") return model.k(x);
    const eps = (XMAX || 1) / (samples * 4);
    const xl = Math.max(0, x - eps);
    const xr = Math.min(XMAX, x + eps);
    const yl = model.tokens_between(0, xl);
    const yr = model.tokens_between(0, xr);
    const dydx = Math.max(1e-18, (yr - yl) / Math.max(1e-18, xr - xl));
    return 1 / dydx;
  };

  const dataPriceRaw = useMemo(() => {
    if (!model) return [];
    const pts = [];
    for (let i = 0; i <= samples; i++) {
      const x = xMin + ((xMax - xMin) * i) / samples;
      pts.push({ x, y: Math.max(0, priceAt(x)) });
    }
    return pts;
  }, [model, samples, xMin, xMax]);

  const priceMaxRaw = useMemo(() => {
    let m = 0;
    for (const p of dataPriceRaw) if (p.y > m) m = p.y;
    return m > 0 ? m : 1;
  }, [dataPriceRaw]);

  const { exp: priceExp, factor: priceFactor } = sciScale(priceMaxRaw);
  const dataPrice = useMemo(
    () => dataPriceRaw.map((p) => ({ x: p.x, y: p.y / (priceFactor || 1) })),
    [dataPriceRaw, priceFactor]
  );
  const priceMax = useMemo(() => {
    let m = 0;
    for (const p of dataPrice) if (p.y > m) m = p.y;
    return Math.max(1e-12, m * 1.04);
  }, [dataPrice]);

  const yScalePrice = (vy) => {
    const t = vy / Math.max(1e-18, priceMax);
    return padBottom.top + (1 - Math.max(0, Math.min(1, t))) * dimsBot.innerH;
  };

  const pathPrice = useMemo(() => {
    if (!model || dataPrice.length === 0) return "";
    return dataPrice
      .map((p, i) => `${i ? "L" : "M"} ${xScaleBot(p.x).toFixed(2)} ${yScalePrice(p.y).toFixed(2)}`)
      .join(" ");
  }, [dataPrice, model, xScaleBot, yScalePrice]);

  /* ticks */
  const xTicks = useMemo(() => Array.from({ length: 6 }, (_, i) => xMin + ((xMax - xMin) * i) / 5), [xMin, xMax]);
  const yTicksTokens = useMemo(
    () => Array.from({ length: 5 }, (_, i) => yMinTop + ((yMaxTop - yMinTop) * i) / 4),
    [yMinTop, yMaxTop]
  );
  const yTicksPrice = useMemo(() => Array.from({ length: 5 }, (_, i) => (priceMax * i) / 4), [priceMax]);

  /* markers visibility */
  const topVisible = markerX >= xMin && markerX <= xMax && markerY >= yMinTop && markerY <= yMaxTop;
  const markerTop = topVisible ? { px: xScaleTop(markerX), py: yScaleTokens(markerY, yMinTop, yMaxTop) } : null;

  const priceAtMarker = model ? Math.max(0, priceAt(markerX) / (priceFactor || 1)) : 0;
  const botVisible = markerX >= xMin && markerX <= xMax && priceAtMarker <= priceMax;
  const markerBot = botVisible ? { px: xScaleBot(markerX), py: yScalePrice(priceAtMarker) } : null;

  /* refs */
  const svgRef = useRef(null);
  const hostRef = useRef(null);
  const hoveringRef = useRef(false);

  /* zoom helper */
  function zoomAt(clientX, direction) {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scale = rect.width / viewW;
    const xView = (clientX - rect.left) / scale;

    const t = Math.max(0, Math.min(1, (xView - padTop.left) / Math.max(1e-6, dimsTop.innerW)));
    const xCenter = xMin + t * (xMax - xMin);

    const zoom = direction < 0 ? 0.85 : 1.15; // wheel up=in, down=out
    const newWidth = Math.max(XMAX * 0.01, Math.min(XMAX, (xMax - xMin) * zoom));
    let newMin = xCenter - (xCenter - xMin) * (newWidth / (xMax - xMin));
    newMin = Math.max(0, Math.min(XMAX - newWidth, newMin));
    const newMax = newMin + newWidth;
    setXDomain([newMin, newMax]);
  }

  /* React capture-phase wheel handler (prevents page scroll reliably) */
  const onWheelCapture = (e) => {
    if (e.ctrlKey || e.metaKey) return; // let browser pinch-zoom
    e.preventDefault();
    e.stopPropagation();
    zoomAt(e.clientX, e.deltaY);
  };

  useEffect(() => {
    const host = hostRef.current;
    const svg = svgRef.current;
    if (!host && !svg) return;
 
    // Global wheel interceptor: only active while hovering the chart
    const windowWheel = (e) => {
      // Allow browser pinch-zoom (cmd/ctrl+wheel)
      if (e.ctrlKey || e.metaKey) return;
      if (!hoveringRef.current) return;   // not over the chart → let page scroll
      e.preventDefault();
      e.stopPropagation();
      // Route to chart zoom
      zoomAt(e.clientX, e.deltaY);
    };

    const touchMoveHandler = (e) => {
      // block page scroll while panning/hovering the chart
      e.preventDefault();
      e.stopPropagation();
    };

    // host && host.addEventListener("wheel", wheelHandler, { passive: false, capture: true });
    // svg  && svg.addEventListener("wheel",  wheelHandler, { passive: false, capture: true });

    window.addEventListener("wheel", windowWheel, { passive: false, capture: true });

    host && host.addEventListener("touchmove", touchMoveHandler, { passive: false });
    svg  && svg.addEventListener("touchmove",  touchMoveHandler, { passive: false });

    return () => {
      // host && host.removeEventListener("wheel", wheelHandler);
      // svg  && svg.removeEventListener("wheel",  wheelHandler);
      window.removeEventListener("wheel", windowWheel, { capture: true });
      host && host.removeEventListener("touchmove", touchMoveHandler);
      svg  && svg.removeEventListener("touchmove",  touchMoveHandler);
    };
  }, [xMin, xMax, XMAX]);  // keep latest domain in closure

  /* pan handlers */
  const onPointerDown = (e) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scale = rect.width / viewW;
    const xView = (e.clientX - rect.left) / scale;
    panStart.current = { xView, xDomain: [xMin, xMax] };
    setIsPanning(true);
  };
  const onPointerMove = (e) => {
    if (!isPanning || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scale = rect.width / viewW;
    const xView = (e.clientX - rect.left) / scale;
    const dxView = xView - panStart.current.xView;
    const tdx = dxView / Math.max(1e-6, dimsTop.innerW);
    const domainDx = -tdx * (panStart.current.xDomain[1] - panStart.current.xDomain[0]);

    let nMin = panStart.current.xDomain[0] + domainDx;
    let nMax = panStart.current.xDomain[1] + domainDx;
    const width = nMax - nMin;
    if (nMin < 0) { nMin = 0; nMax = width; }
    if (nMax > XMAX) { nMax = XMAX; nMin = XMAX - width; }
    setXDomain([nMin, nMax]);
  };
  const endPan = () => setIsPanning(false);

  /* controls (bracket style) */
  const Controls = () => {
    const zoomCenter = (dir /* -1=in, +1=out */) => {
      if (!svgRef.current) return;
      const r = svgRef.current.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, dir);
    };
    return (
      <div style={{ display: "flex", gap: 8, padding: "4px 6px 0 6px", alignItems: "center" }}>
        <button className="chan-link" onClick={() => setXDomain([0, XMAX])}>[Reset]</button>
        <button className="chan-link" onClick={() => zoomCenter(+1)}>[−]</button>
        <button className="chan-link" onClick={() => zoomCenter(-1)}>[+]</button>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>drag to pan • wheel to zoom</span>
      </div>
    );
  };

  /* wrapper */
  const Box = ({ children }) =>
    boxed ? (
      <section className="post post--reply post--panel">
        <Controls />
        <div
          ref={hostRef}
          onPointerEnter={() => { hoveringRef.current = true; }}
          onPointerLeave={() => { hoveringRef.current = false; }}
          onWheelCapture={onWheelCapture}
          onTouchMove={(e) => { e.preventDefault(); e.stopPropagation(); }}
          style={{
            overscrollBehavior: "contain",
            overflow: "hidden",
            position: "relative",
            touchAction: "none",
          }}
          className="svg-host"
        >
          {children}
        </div>
      </section>
    ) : (
      <div
        ref={hostRef}
        onWheelCapture={onWheelCapture}
        onTouchMove={(e) => { e.preventDefault(); e.stopPropagation(); }}
        style={{ overscrollBehavior: "contain", overflow: "hidden", position: "relative", touchAction: "none" }}
        className="svg-host"
      >
        {children}
      </div>
    );

  /* render */
  return (
    <Box>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${viewW} ${totalHeight}`}
        style={{ display: "block", width: "100%", height: "auto", touchAction: "none" }}
        preserveAspectRatio="xMidYMid meet"
        onPointerLeave={() => { setTipTop(null); setTipBot(null); endPan(); }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {/* ===== TOP ===== */}
        <g transform="translate(0,0)">
          <line
            x1={padTop.left}
            y1={padTop.top + dimsTop.innerH}
            x2={padTop.left + dimsTop.innerW}
            y2={padTop.top + dimsTop.innerH}
            stroke="var(--chart-axis)"
          />
          <line
            x1={padTop.left}
            y1={padTop.top}
            x2={padTop.left}
            y2={padTop.top + dimsTop.innerH}
            stroke="var(--chart-axis)"
          />

          {xTicks.map((vx, i) => {
            const x = xScaleTop(vx);
            const anchor = i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle";
            const dx = i === 0 ? 2 : i === xTicks.length - 1 ? -2 : 0;
            return (
              <g key={`xt-top-${i}`}>
                <line
                  x1={x}
                  y1={padTop.top + dimsTop.innerH}
                  x2={x}
                  y2={padTop.top + dimsTop.innerH + 4}
                  stroke="var(--chart-grid)"
                />
                <text
                  x={x + dx}
                  y={padTop.top + dimsTop.innerH + 12}
                  fontSize="9"
                  fontWeight="bold"
                  textAnchor={anchor}
                  fill="var(--chart-text)"
                >
                  {vx.toFixed(2)}
                </text>
              </g>
            );
          })}
          {yTicksTokens.map((vy, i) => (
            <g key={`yt-top-${i}`}>
              <line
                x1={padTop.left - 4}
                y1={yScaleTokens(vy, yMinTop, yMaxTop)}
                x2={padTop.left}
                y2={yScaleTokens(vy, yMinTop, yMaxTop)}
                stroke="var(--chart-grid)"
              />
              <text
                x={padTop.left - 6}
                y={yScaleTokens(vy, yMinTop, yMaxTop) + 3}
                fontSize="9"
                fontWeight="bold"
                textAnchor="end"
                fill="var(--chart-text)"
              >
                {formatCompact(vy)}
              </text>
            </g>
          ))}

          {pathTokens && <path d={pathTokens} fill="none" stroke="var(--name)" strokeWidth="3" />}

          {markerTop && (
            <g
              onPointerEnter={() =>
                setTipTop({
                  text: `x=${markerX.toFixed(6)} SOL, y≈${formatCompact(markerY)} tokens`,
                  px: markerTop.px,
                  py: markerTop.py - 10,
                })
              }
              onPointerLeave={() => setTipTop(null)}
            >
              <circle cx={markerTop.px} cy={markerTop.py} r="5" fill="var(--accent)" />
              <circle cx={markerTop.px} cy={markerTop.py} r={hitR} fill="transparent" />
            </g>
          )}

          <text
            x={padTop.left - 56}
            y={padTop.top + dimsTop.innerH / 2}
            fontSize="10"
            fontWeight="bold"
            textAnchor="middle"
            fill="var(--chart-text)"
            transform={`rotate(-90 ${padTop.left - 56} ${padTop.top + dimsTop.innerH / 2})`}
          >
            Tokens sold
          </text>

          {tipTop && (
            <g pointerEvents="none">
              <rect
                x={tipTop.px + 8}
                y={tipTop.py - 16}
                width="220"
                height="16"
                rx="2"
                ry="2"
                fill="var(--panel-alt-bg)"
                stroke="var(--panel-border)"
              />
              <text
                x={tipTop.px + 12}
                y={tipTop.py - 3}
                fontSize="10"
                fontWeight="bold"
                fill="var(--chart-text)"
              >
                {tipTop.text}
              </text>
            </g>
          )}
        </g>

        {/* ===== BOTTOM ===== */}
        <g transform={`translate(0, ${height + gutter})`}>
          <line
            x1={padBottom.left}
            y1={padBottom.top + dimsBot.innerH}
            x2={padBottom.left + dimsBot.innerW}
            y2={padBottom.top + dimsBot.innerH}
            stroke="var(--chart-axis)"
          />
          <line
            x1={padBottom.left}
            y1={padBottom.top}
            x2={padBottom.left}
            y2={padBottom.top + dimsBot.innerH}
            stroke="var(--chart-axis)"
          />

          {xTicks.map((vx, i) => {
            const x = xScaleBot(vx);
            const anchor = i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle";
            const dx = i === 0 ? 2 : i === xTicks.length - 1 ? -2 : 0;
            return (
              <g key={`xt-bot-${i}`}>
                <line
                  x1={x}
                  y1={padBottom.top + dimsBot.innerH}
                  x2={x}
                  y2={padBottom.top + dimsBot.innerH + 4}
                  stroke="var(--chart-grid)"
                />
                <text
                  x={x + dx}
                  y={padBottom.top + dimsBot.innerH + 12}
                  fontSize="9"
                  fontWeight="bold"
                  textAnchor={anchor}
                  fill="var(--chart-text)"
                >
                  {vx.toFixed(2)}
                </text>
              </g>
            );
          })}
          {yTicksPrice.map((vy, i) => (
            <g key={`yt-bot-${i}`}>
              <line
                x1={padBottom.left - 4}
                y1={yScalePrice(vy)}
                x2={padBottom.left}
                y2={yScalePrice(vy)}
                stroke="var(--chart-grid)"
              />
              <text
                x={padBottom.left - 6}
                y={yScalePrice(vy) + 3}
                fontSize="9"
                fontWeight="bold"
                textAnchor="end"
                fill="var(--chart-text)"
              >
                {toFixedNoSci(vy, 3)}
              </text>
            </g>
          ))}

          {pathPrice && <path d={pathPrice} fill="none" stroke="var(--name)" strokeWidth="3" />}

          {markerBot && (
            <g
              onPointerEnter={() =>
                setTipBot({
                  text: `x=${markerX.toFixed(6)} SOL, y=${toFixedNoSci(priceAtMarker, 6)} (×10^{${priceExp}})`,
                  px: markerBot.px,
                  py: markerBot.py - 10,
                })
              }
              onPointerLeave={() => setTipBot(null)}
            >
              <circle cx={markerBot.px} cy={markerBot.py} r="5" fill="var(--accent)" />
              <circle cx={markerBot.px} cy={markerBot.py} r={hitR} fill="transparent" />
            </g>
          )}

          <text
            x={padBottom.left + dimsBot.innerW / 2}
            y={padBottom.top + dimsBot.innerH + 18}
            fontSize="11"
            fontWeight="bold"
            textAnchor="middle"
            fill="var(--chart-text)"
          >
            SOL deposited (x)
          </text>
          <text
            x={padBottom.left - 56}
            y={padBottom.top + dimsBot.innerH / 2}
            fontSize="10"
            fontWeight="bold"
            textAnchor="middle"
            fill="var(--chart-text)"
            transform={`rotate(-90 ${padBottom.left - 56} ${padBottom.top + dimsBot.innerH / 2})`}
          >
            {`Price (SOL ×10^{${priceExp}})`}
          </text>

          {tipBot && (
            <g pointerEvents="none">
              <rect
                x={tipBot.px + 8}
                y={tipBot.py - 16}
                width="270"
                height="16"
                rx="2"
                ry="2"
                fill="var(--panel-alt-bg)"
                stroke="var(--panel-border)"
              />
              <text
                x={tipBot.px + 12}
                y={tipBot.py - 3}
                fontSize="10"
                fontWeight="bold"
                fill="var(--chart-text)"
              >
                {tipBot.text}
              </text>
            </g>
          )}
        </g>
      </svg>
    </Box>
  );

}
