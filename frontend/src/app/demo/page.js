"use client";

import { useEffect, useMemo, useState } from "react";
import { useDarkMode } from "@/app/AppShell";

import PriceChart from "../components/PriceChart";
import BondingCurve from "../components/BondingCurve";
import { buildLUTModel, CAP_TOKENS } from "../utils";

// --- deterministic PRNG so the "history" looks the same every screenshot ---
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- same helper the real token page uses to bucket raw ticks into a range ---
function aggregateToBuckets(candles, bucketSec) {
  if (!candles?.length) return [];
  const byBucket = new Map();
  for (const c of candles) {
    const b = Math.floor(c.time / bucketSec) * bucketSec;
    const cur = byBucket.get(b);
    if (!cur) {
      byBucket.set(b, { time: b, open: c.open, high: c.high, low: c.low, close: c.close });
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    }
  }
  const keys = Array.from(byBucket.keys()).sort((a, b) => a - b);
  const out = [];
  let lastClose = null;
  for (let i = 0; i < keys.length; i++) {
    const t = keys[i];
    const cur = byBucket.get(t);
    if (i > 0) {
      const prevT = keys[i - 1];
      for (let g = prevT + bucketSec; g < t; g += bucketSec) {
        if (lastClose != null) out.push({ time: g, open: lastClose, high: lastClose, low: lastClose, close: lastClose });
      }
    }
    const open = lastClose != null ? lastClose : cur.open;
    const merged = { time: t, open, high: Math.max(cur.high, open), low: Math.min(cur.low, open), close: cur.close };
    out.push(merged);
    lastClose = merged.close;
  }
  return out;
}

// --- base 15m fake ticks covering the full 30d window; ranges just re-bucket this ---
function buildBaseCandles() {
  const rand = mulberry32(1337);
  const bucketSec = 900; // 15m, same as the real backend's canonical granularity
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = Math.floor(nowSec / bucketSec) * bucketSec - 2879 * bucketSec; // ~30 days

  const price = [];
  const mcap = [];
  const devNet = [];

  let p = 0.0000042;
  let reserveSol = 0;

  for (let i = 0; i < 2880; i++) {
    const t = startSec + i * bucketSec;
    const frac = i / 2880;

    let driftPct;
    if (frac < 0.18) driftPct = 0.004 + rand() * 0.012;
    else if (frac < 0.42) driftPct = 0.014 + rand() * 0.032; // pump phase
    else if (frac < 0.55) driftPct = -0.016 + rand() * 0.012; // correction
    else driftPct = 0.003 + rand() * 0.016; // second leg up

    const open = p;
    const close = Math.max(open * (1 + driftPct * (rand() > 0.5 ? 1 : -0.4)), 0.0000001);
    const wiggle = Math.abs(close - open) * (0.4 + rand());
    const high = Math.max(open, close) + wiggle * rand();
    const low = Math.max(0.0000001, Math.min(open, close) - wiggle * rand());
    price.push({ time: t, open, high, low, close });
    p = close;

    const mOpen = reserveSol;
    const mDrift = Math.max(-mOpen * 0.15, driftPct * 12 + (rand() - 0.4) * 0.6);
    const mClose = Math.max(0, mOpen + mDrift);
    mcap.push({
      time: t,
      open: mOpen,
      high: Math.max(mOpen, mClose) + rand() * 0.3,
      low: Math.max(0, Math.min(mOpen, mClose) - rand() * 0.3),
      close: mClose,
    });
    reserveSol = mClose;

    if (i === 180 || i === 1240 || i === 2100) {
      devNet.push({ time: t, netSol: i === 2100 ? -3.2 : 6.5 + rand() * 4 });
    }
  }

  return { price, mcap, devNet, reserveSol };
}

const RANGE_PRESETS = {
  "3d": { seconds: 3 * 86400, bucketSec: 900 },
  "1w": { seconds: 7 * 86400, bucketSec: 3600 },
  "1m": { seconds: 30 * 86400, bucketSec: 86400 },
};

const FAKE_HOLDERS = [
  { displayName: "RepperDad", trip: "!!Xk9pQ2", balanceWhole: 62_400_000, isDev: true },
  { displayName: "moon_maiden", trip: "!!aB77zR", balanceWhole: 41_150_000 },
  { displayName: "Anonymous", trip: null, balanceWhole: 29_800_000 },
  { displayName: "wagmi_walt", trip: "!!Qz13Lm", balanceWhole: 18_240_000 },
  { displayName: "diamond.eth", trip: "!!7hNn0v", balanceWhole: 12_900_000 },
  { displayName: "Anonymous", trip: null, balanceWhole: 9_050_000 },
];

const FAKE_TRADES = [
  { side: "buy", sol: 4.2, who: "moon_maiden", trip: "!!aB77zR", when: "2m ago" },
  { side: "sell", sol: 1.1, who: "Anonymous", trip: null, when: "6m ago" },
  { side: "buy", sol: 0.85, who: "wagmi_walt", trip: "!!Qz13Lm", when: "14m ago" },
  { side: "buy", sol: 9.6, who: "RepperDad", trip: "!!Xk9pQ2", when: "22m ago", isDev: true },
  { side: "sell", sol: 2.3, who: "diamond.eth", trip: "!!7hNn0v", when: "41m ago" },
];

export default function DemoPreviewPage() {
  const { dark } = useDarkMode();
  const base = useMemo(buildBaseCandles, []);

  const [rangeKey, setRangeKey] = useState("3d");
  const [chartUnit, setChartUnit] = useState("SOL");
  const [metric, setMetric] = useState("PRICE");
  const [model, setModel] = useState(null);

  useEffect(() => {
    let cancel = false;
    buildLUTModel(9).then((m) => !cancel && setModel(m)).catch(() => {});
    return () => { cancel = true; };
  }, []);

  // widen the global page frame just while this preview is mounted
  useEffect(() => {
    const prev = document.body.style.maxWidth;
    document.body.style.maxWidth = "2200px";
    return () => { document.body.style.maxWidth = prev; };
  }, []);

  const visBucketSec = RANGE_PRESETS[rangeKey].bucketSec;
  const nowSec = Math.floor(Date.now() / 1000);
  const includeFrom = Math.floor((nowSec - RANGE_PRESETS[rangeKey].seconds) / visBucketSec) * visBucketSec;

  const confirmedCandles = useMemo(
    () => aggregateToBuckets(base.price.filter((c) => c.time >= includeFrom), visBucketSec),
    [base, includeFrom, visBucketSec]
  );
  const mcapCandles = useMemo(
    () => aggregateToBuckets(base.mcap.filter((c) => c.time >= includeFrom), visBucketSec),
    [base, includeFrom, visBucketSec]
  );

  const progressPct = 73.4;
  const x0 = base.reserveSol;
  const ySoldWhole = 587_200_000;

  return (
    <main style={{ maxWidth: "2180px", margin: "0", padding: "0" }}>
      <div style={{ display: "flex", gap: "2rem" }}>
        <div style={{ flex: 2, minWidth: 0 }}>
          <h2>Repper</h2>

          <img
            src="/demo-token.svg"
            alt="Token Icon"
            style={{ maxWidth: "120px", borderRadius: "16px", margin: "1rem 0" }}
          />

          <p>$REPPER — the people&apos;s coin. wagmi 🚀</p>

          <div style={{ fontSize: "12px", marginBottom: "1rem" }}>
            <b>Created by:</b>{" "}
            <span className="token__name">RepperDad</span>{" "}
            <span className="token__trip">!!Xk9pQ2</span>{" "}
            on Sat, Jul 19, 2026, 03:14 PM No.148291
          </div>

          <div style={{ fontSize: "12px", margin: "0 0 1rem 0" }}>
            <a href="#" style={{ textDecoration: "underline", color: "var(--link)", fontFamily: "monospace" }}>
              7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
            </a>
          </div>

          <div style={{ margin: "0.5rem 0", fontSize: 13 }}>
            <div>
              Progress by tokens: <b>{progressPct.toFixed(2)}%</b> (SOL deposited ≈ {x0.toFixed(6)} / 84.900000 ;
              sold ≈ {ySoldWhole.toLocaleString()} / {CAP_TOKENS.toLocaleString()} tokens)
            </div>
            <div>Raised so far: {x0.toFixed(6)} SOL / target 84.900000 SOL (remaining ~{(84.9 - x0).toFixed(6)} SOL)</div>
            <div style={{ marginTop: 4, color: "#555" }}>Phase: Active</div>
          </div>

          <div style={{ margin: "10px 0" }}>
            <div
              aria-label={`Progress ${progressPct}%`}
              style={{
                width: "100%",
                height: "14px",
                border: "1px solid var(--border)",
                background: "var(--input-bg)",
                boxSizing: "border-box",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div style={{ width: `${progressPct}%`, height: "100%", background: "var(--name)" }} />
            </div>
          </div>

          <div id="trade-box" style={{ marginTop: "1rem" }}>
            <h3>Trade</h3>
            <div style={{ fontSize: 14, marginTop: 8 }}>You need to connect your wallet to trade.</div>
            <button type="button" className="chan-link" style={{ marginTop: 8 }}>
              [Connect Wallet]
            </button>
          </div>

          {/* Chart + Bonding Curve, side by side to pack more into one view */}
          <div style={{ display: "flex", gap: "2.5rem", marginTop: "2rem", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 420px", minWidth: 0 }}>
              <h3 style={{ margin: 0 }}>
                Price (SOL per token) — {visBucketSec === 900 ? "15m" : visBucketSec === 3600 ? "1h" : "1d"} candles
              </h3>

              {/* range controls */}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                {["3d", "1w", "1m"].map((key) => (
                  <span
                    key={key}
                    className={`chan-toggle ${rangeKey === key ? "is-active" : ""}`}
                    onClick={() => setRangeKey(key)}
                    role="button"
                    aria-pressed={rangeKey === key}
                    title={key === "3d" ? "15m candles" : key === "1w" ? "1h candles" : "1d candles"}
                  >
                    [{key.toUpperCase()}]
                  </span>
                ))}
              </div>

              {/* unit + metric controls */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
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
                  className="chan-toggle chan-toggle--disabled"
                  title="Provide solUsdRate to enable USD"
                >
                  [USD]
                </button>
                <span style={{ width: 1, height: 14, background: "var(--border-light)", margin: "0 4px" }} />
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
                mcapCandles={mcapCandles}
                bucketSec={visBucketSec}
                devNet={base.devNet}
                solUsdRate={0}
                unit={chartUnit}
                metric={metric}
                showUnitToggle={false}
                dark={dark}
                height={300}
              />
            </div>

            <div style={{ flex: "1 1 380px", minWidth: 0, marginLeft: "1.75rem", marginTop: "2.5rem" }}>
              <h3 style={{ margin: 0 }}>Bonding Curve</h3>
              <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
                Tokens sold vs SOL deposited (LUT, floor/ceil aware)
              </div>
              <BondingCurve model={model} x0={x0} ySoldWhole={ySoldWhole} height={150} />
            </div>
          </div>

          <section
            style={{
              marginTop: "1.5rem",
              background: "var(--post-bg)",
              border: "1px solid var(--border-light)",
              borderRadius: 8,
              padding: 12,
            }}
          >
            <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px 0" }}>
              <span role="img" aria-label="chart">📈</span> Live Trades
            </h3>
            <hr style={{ border: 0, borderTop: "2px solid #6ba4b8", margin: "0 0 10px 0" }} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
              {FAKE_TRADES.map((r, i) => {
                const accent = r.side === "buy" ? "var(--name)" : "var(--down)";
                return (
                  <div key={i} className="post post--reply" style={{ borderLeft: `3px solid ${accent}`, margin: "6px 0" }}>
                    <div className="post__body">
                      <div className="post__head">
                        <span className="post__name" style={{ display: "inline-flex", gap: 6 }}>
                          {r.isDev && <span style={{ color: "var(--link-hover)", fontWeight: "bold" }}>[DEV]</span>}
                          {r.trip && <span>{r.trip}</span>}
                          <span>{r.who}</span>
                        </span>
                        <span className="post__meta">{r.when}</span>
                      </div>
                      <div className="post__text" style={{ marginTop: 2 }}>
                        <span style={{ color: accent, fontWeight: 700 }}>{r.side === "buy" ? "Bought" : "Sold"}</span>{" "}
                        {r.sol.toFixed(4)} SOL
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <aside
          className="post post--reply post--panel"
          style={{
            width: 280,
            background: "var(--post-bg)",
            border: "1px solid var(--border-light)",
            borderLeft: "1px solid var(--border)",
            padding: 10,
            marginLeft: "1rem",
            height: "fit-content",
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>🏆 Top Holders</h3>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
            • Percentages are each holder&apos;s share of <b>{CAP_TOKENS.toLocaleString()}</b> on-curve cap.
          </div>
          <hr style={{ border: 0, borderTop: "1px solid #800000", margin: "6px 0 8px" }} />

          <div
            style={{
              marginBottom: 8,
              padding: 8,
              background: "var(--highlight-bonding-bg)",
              borderRadius: 6,
              border: "1px solid var(--highlight-bonding-border)",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <strong style={{ color: "#2f5eff" }}>Bonding Curve</strong>
              <span style={{ marginLeft: "auto", color: "#2f5eff" }}>587,200,000 tokens</span>
            </div>
            <div style={{ color: "#4da3ff" }}>{((587_200_000 / CAP_TOKENS) * 100).toFixed(2)}%</div>
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            {FAKE_HOLDERS.map((h, i) => (
              <div key={i} style={{ fontSize: 12, lineHeight: 1.3 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <span style={{ fontWeight: h.isDev ? "bold" : "normal", color: h.isDev ? "var(--link-hover)" : "var(--name)" }}>
                    {h.isDev && "[DEV] "}
                    {h.trip && `${h.trip} `}
                    {h.displayName}
                  </span>
                  <span style={{ color: "var(--name)", marginLeft: "auto" }}>
                    {((h.balanceWhole / CAP_TOKENS) * 100).toFixed(2)}%
                  </span>
                </div>
                <div style={{ color: "var(--meta)" }}>{h.balanceWhole.toLocaleString()} tokens</div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
