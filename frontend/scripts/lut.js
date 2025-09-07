// lut_poly.js
// Generate a monotone cumulative LUT F(x) for your bonding curve using the new raw-in-x polynomial.
// Usage: node lut_poly.js --decimals=9 --nodes=4096 --out=lut.dec9.json

import fs from "node:fs/promises";

// ---------- CLI ----------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  })
);

const DECIMALS = Number(args.decimals ?? 9);
const N = Number(args.nodes ?? 4096); // N intervals → N+1 samples
const OUT = args.out || `lut.dec${DECIMALS}.json`;

// ---------- Domain / targets ----------
const CAP_TOKENS = 800_000_000;
const T = 26.1799387799149450017921481048688292503357;
const X_MAX = 3 * T;
const capBase = BigInt(CAP_TOKENS) * (10n ** BigInt(DECIMALS));

// ---------- Price polynomial on [0, T] (RAW IN x) ----------
const P = [
  102001241.383929669857025375000,  // x^0
  -24339854.057240757803318730000,  // x^1
  -3118869.576150425010217276875,   // x^2
  1766137.196820179010204505125,    // x^3
  -183717.474136566102274613625,    // x^4
  8875.544105487513181387500,       // x^5
  -239.329141335857214037125,       // x^6
  3.823898180409012326625,          // x^7
  -0.036037497039981367500,         // x^8
  0.000185372546842890000,          // x^9
  -0.000000401790645216000000       // x^10
];

// ---------- Math helpers ----------
function polyEvalX(x, coef) { // Horner
  let a = 0;
  for (let i = coef.length - 1; i >= 0; i--) a = a * x + coef[i];
  return a;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Base segment price k1(x) for x∈[0,T]
function k1(x) { return polyEvalX(x, P); }

// Repeated shape by shift only
function k_unscaled(x) {
  const xx = clamp(x, 0, X_MAX);
  if (xx <= T) return k1(xx);
  if (xx <= 2 * T) return k1(xx - T);
  return k1(xx - 2 * T);
}

// Composite Simpson on a single small interval [a,b] (m panels)
function simpsonInvK_local(a, b, m = 2) {
  if (b <= a) return 0;
  const Nloc = m % 2 ? m + 1 : m;
  const h = (b - a) / Nloc;
  let s = 0;
  for (let i = 0; i <= Nloc; i++) {
    const x = a + i * h;
    const w = (i === 0 || i === Nloc) ? 1 : (i % 2 ? 4 : 2);
    // Guard against any accidental non-positive price
    const kx = Math.max(k_unscaled(x), 1e-18);
    s += w * (1 / kx);
  }
  return (s * h) / 3;
}

// ---------- Build LUT by per-bin accumulation ----------
const dx = X_MAX / N;
const xs = Array.from({ length: N + 1 }, (_, i) => i * dx);

// Accumulate WHOLE tokens (pre-calibration) so F is monotone by construction
const F_int = new Array(N + 1);
F_int[0] = 0.0;
for (let i = 0; i < N; i++) {
  const inc = simpsonInvK_local(xs[i], xs[i + 1], 2); // ∫ 1/k over this bin
  F_int[i + 1] = F_int[i] + Math.max(0, inc);
}

// Calibrate so total supply hits CAP_TOKENS at x = X_MAX
const beta = CAP_TOKENS / F_int[N]; // tokens per unit of integral(1/k)

// Final WHOLE tokens cumulative
const F_whole = F_int.map((v) => beta * v);

// ---------- Convert to base units with directed rounding ----------
function toBaseUnitsBigInt(tokensWhole, decimals, mode /* "floor" | "ceil" */) {
  const whole = Math.floor(tokensWhole);      // ≤ 800,000,000
  const frac = tokensWhole - whole;           // [0,1)
  const scale = 10 ** decimals;               // up to 1e9
  let fracInt = mode === "ceil"
    ? Math.ceil(frac * scale - 1e-12)
    : Math.floor(frac * scale + 1e-12);
  if (fracInt < 0) fracInt = 0;
  if (fracInt >= scale) return BigInt(whole + 1) * BigInt(scale);
  return BigInt(whole) * BigInt(scale) + BigInt(fracInt);
}
function cumaxBigInt(arr) {
  let prev = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < prev) arr[i] = prev;
    else prev = arr[i];
  }
  return arr;
}

let y_floor = F_whole.map((t) => toBaseUnitsBigInt(t, DECIMALS, "floor"));
let y_ceil  = F_whole.map((t) => toBaseUnitsBigInt(t, DECIMALS, "ceil"));

// Clamp to cap and enforce monotone non-decreasing
y_floor = y_floor.map(v => v > capBase ? capBase : v);
y_ceil  = y_ceil .map(v => v > capBase ? capBase : v);
y_floor = cumaxBigInt(y_floor);
y_ceil  = cumaxBigInt(y_ceil);

// Tail hygiene
y_floor[y_floor.length - 1] = capBase;
y_ceil [y_ceil .length - 1] = capBase;

// ---------- Diagnostics ----------
const idxT  = Math.round(T / dx);
const idx2T = Math.round(2 * T / dx);
const fracAtT  = Number(y_floor[idxT] ) / Number(capBase);
const fracAt2T = Number(y_floor[idx2T]) / Number(capBase);

// ---------- Write JSON ----------
const out = {
  meta: {
    decimals: DECIMALS,
    nodes: N,
    t: T,
    x_max: X_MAX,
    dx,
    cap_tokens: CAP_TOKENS,
    cap_base_units: capBase.toString(),
    frac_at_T: +fracAtT.toFixed(6),
    frac_at_2T: +fracAt2T.toFixed(6),
    note: "k(x) on [0,T] is raw polynomial; [T,2T] and [2T,3T] repeat by shift only.",
  },
  y_floor: y_floor.map((v) => v.toString()),
  y_ceil:  y_ceil .map((v) => v.toString()),
};

await fs.writeFile(OUT, JSON.stringify(out, null, 2));
console.log(`[ok] LUT → ${OUT}`);
console.log(`F(T)/cap ≈ ${fracAtT.toFixed(6)},  F(2T)/cap ≈ ${fracAt2T.toFixed(6)}`);
