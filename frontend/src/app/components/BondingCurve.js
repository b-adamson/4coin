"use client";
import { useMemo } from "react";

// 800M => "800M"
function formatCompact(num) {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(0) + "B";
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(0) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(0) + "K";
  return String(num);
}

export default function BondingCurve({
  model,
  x0,
  ySoldWhole,
  height = 260,
  samples = 200,
  boxed = true,      // NEW
  title = "Bonding Curve — Tokens sold vs SOL deposited",
}) {
  const padding = { top: 40, right: 20, bottom: 50, left: 70 };

  const data = useMemo(() => {
    if (!model) return [];
    const pts = [];
    const X_MAX = model.X_MAX || 1;
    for (let i = 0; i <= samples; i++) {
      const x = (X_MAX * i) / samples;
      const y = model.tokens_between(0, x);
      pts.push({ x, y });
    }
    return pts;
  }, [model, samples]);

  const dims = {
    width: 800,
    height,
    innerW: 800 - padding.left - padding.right,
    innerH: height - padding.top - padding.bottom,
  };

  const xScale = (vx) => {
    if (!model) return 0;
    const t = model.X_MAX === 0 ? 0 : Math.max(0, Math.min(1, vx / model.X_MAX));
    return padding.left + t * dims.innerW;
  };
  const yScale = (vy) => {
    if (!model) return 0;
    const cap = model.CAP_TOKENS || 1;
    const t = cap === 0 ? 0 : Math.max(0, Math.min(1, vy / cap));
    return padding.top + (1 - t) * dims.innerH;
  };

  const { leftPath, rightPath } = useMemo(() => {
    if (!model || data.length === 0) return { leftPath: "", rightPath: "" };
    const markerX = Math.max(0, Math.min(model.X_MAX, x0 || 0));
    const markerIndex = data.findIndex((p) => p.x >= markerX);
    const leftPts = data.slice(0, markerIndex + 1);
    const rightPts = data.slice(markerIndex);

    const toPath = (pts) =>
      pts.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.x).toFixed(2)} ${yScale(p.y).toFixed(2)}`).join(" ");

    return { leftPath: toPath(leftPts), rightPath: toPath(rightPts) };
  }, [data, model, x0]);

  const xTicks = useMemo(() => (!model ? [] : Array.from({ length: 6 }, (_, i) => (model.X_MAX * i) / 5)), [model]);
  const yTicks = useMemo(() => (!model ? [] : Array.from({ length: 6 }, (_, i) => (model.CAP_TOKENS * i) / 5)), [model]);

  const markerX = model ? Math.max(0, Math.min(model.X_MAX, x0 || 0)) : 0;
  const markerY = model ? Math.max(0, Math.min(model.CAP_TOKENS, ySoldWhole || 0)) : 0;

  const Box = ({ children }) =>
    boxed ? (
        <section
        className="post post--reply post--panel"
        style={{
            border: "1px solid #d9bfb7",
            background: "#fdf6f1",
            padding: 8,
            marginTop: 8,
            width: "100%",          // ensure it spans the column
        }}
        >
        {title && (
            <div
            style={{
                fontWeight: "bold",
                marginBottom: 6,
                borderBottom: "1px solid #800000",
                paddingBottom: 2,
            }}
            >
            {title}
            </div>
        )}
        {children}
        </section>
    ) : (
        <>{children}</>
  );


  return (
    <Box>
      <div style={{ width: "100%" }}>
        <svg viewBox={`0 0 ${dims.width} ${dims.height}`} style={{ width: "100%", height }} preserveAspectRatio="xMidYMid meet">
          {/* axes */}
          <line x1={padding.left} y1={padding.top + dims.innerH} x2={padding.left + dims.innerW} y2={padding.top + dims.innerH} stroke="#800000" />
          <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + dims.innerH} stroke="#800000" />

          {/* x ticks */}
          {xTicks.map((vx, i) => (
            <g key={`xt-${i}`}>
              <line x1={xScale(vx)} y1={padding.top + dims.innerH} x2={xScale(vx)} y2={padding.top + dims.innerH + 6} stroke="#b17878" />
              <text x={xScale(vx)} y={padding.top + dims.innerH + 20} fontSize="11" fontWeight="bold" textAnchor="middle" fill="#333">
                {vx.toFixed(2)}
              </text>
            </g>
          ))}

          {/* y ticks */}
          {yTicks.map((vy, i) => (
            <g key={`yt-${i}`}>
              <line x1={padding.left - 6} y1={yScale(vy)} x2={padding.left} y2={yScale(vy)} stroke="#b17878" />
              <text x={padding.left - 20} y={yScale(vy) + 3} fontSize="11" fontWeight="bold" textAnchor="end" fill="#333">
                {formatCompact(vy)}
              </text>
            </g>
          ))}

          {/* curve */}
          {leftPath && <path d={leftPath} fill="none" stroke="#008000" strokeWidth="3" />}  {/* sold so far */}
          {rightPath && <path d={rightPath} fill="none" stroke="#5555aa" strokeWidth="3" />} {/* remaining */}

          {/* marker */}
          {model && (
            <>
              <line x1={xScale(markerX)} y1={yScale(0)} x2={xScale(markerX)} y2={yScale(markerY)} stroke="#bbb" strokeDasharray="4 4" />
              <line x1={xScale(0)} y1={yScale(markerY)} x2={xScale(markerX)} y2={yScale(markerY)} stroke="#bbb" strokeDasharray="4 4" />
              <circle cx={xScale(markerX)} cy={yScale(markerY)} r="6" fill="#d53f8c" />
            </>
          )}

          {/* axis labels */}
          <text x={padding.left + dims.innerW / 2} y={dims.height - 10} fontSize="13" fontWeight="bold" textAnchor="middle" fill="#111">
            SOL deposited (x)
          </text>
          <text
            x={padding.left - 65}
            y={padding.top + dims.innerH / 2}
            fontSize="13"
            fontWeight="bold"
            textAnchor="middle"
            fill="#111"
            transform={`rotate(-90 ${padding.left - 65} ${padding.top + dims.innerH / 2})`}
          >
            Tokens sold (y)
          </text>

          {/* legend */}
          {model && (
            <g>
              <rect x={padding.left} y={8} width="220" height="44" rx="0" ry="0" fill="#f6eae3" stroke="#d9bfb7" />
              <text x={padding.left + 10} y={26} fontSize="12" fontWeight="bold" fill="#111">
                x ≈ {markerX.toFixed(6)} SOL
              </text>
              <text x={padding.left + 10} y={42} fontSize="12" fontWeight="bold" fill="#111">
                y ≈ {formatCompact(markerY)} tokens
              </text>
            </g>
          )}
        </svg>
      </div>
    </Box>
  );
}
