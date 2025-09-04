// src/app/utils.js

// ---------- Wallet helpers ----------
export async function ensureWallet() {
  let walletAddress = null;

  if (window.solana?.isPhantom) {
    try {
      const resp = await window.solana.connect({ onlyIfTrusted: true });
      walletAddress = resp.publicKey.toBase58();
    } catch (e) {
      console.warn("Wallet not connected, redirecting...");
      window.location.href = "/";
      return null;
    }
  } else {
    window.location.href = "/";
    return null;
  }

  if (!walletAddress) {
    window.location.href = "/";
    return null;
  }

  const homeLink = document.getElementById("home-link");
  if (homeLink) {
    homeLink.href = `/home?wallet=${walletAddress}`;
  }

  return walletAddress;
}

export async function disconnectWallet(router, setWallet) {
  try {
    if (window.solana?.isPhantom) {
      await window.solana.disconnect();
    }
    setWallet("");
    router.push("/");
  } catch (err) {
    console.error("Error disconnecting wallet:", err);
  }
}

// ---------- Constants ----------
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const CAP_TOKENS = 800_000_000;

// ---------- LUT model ----------
function makeLUTModelFromData(json) {
  const meta = json.meta || {};
  const decimals = Number(meta.decimals ?? 9);
  const SCALE_BI = 10n ** BigInt(decimals);
  const CAP_BASE = BigInt(CAP_TOKENS) * SCALE_BI;

  const floorS = json.y_floor || [];
  const ceilS  = json.y_ceil  || json.y_floor || [];
  if (floorS.length !== ceilS.length) throw new Error("LUT floor/ceil length mismatch");

  const Y_FLOOR = floorS.map((s) => BigInt(s));
  const Y_CEIL  = ceilS.map((s) => BigInt(s));

  const N1 = Y_FLOOR.length;
  const N = N1 - 1;

  const X_MAX =
    typeof meta.x_max === "number"
      ? meta.x_max
      : typeof meta.dx === "number"
      ? meta.dx * N
      : 78.53981633974483; // default 3T if missing

  const DX = X_MAX / N;
  const clamp01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t);

  const y_interp_floor = (arr, x) => {
    if (x <= 0) return 0n;
    if (x >= X_MAX) return CAP_BASE;
    const u = x / DX;
    const i = Math.floor(u);
    const t = clamp01(u - i);
    const a = arr[i], b = arr[i + 1];
    if (b <= a || t === 0) return a > CAP_BASE ? CAP_BASE : a;
    const inc = BigInt(Math.floor(Number(b - a) * t));
    const y = a + inc;
    return y > CAP_BASE ? CAP_BASE : y;
  };

  const y_interp_ceil = (arr, x) => {
    if (x <= 0) return 0n;
    if (x >= X_MAX) return CAP_BASE;
    const u = x / DX;
    const i = Math.floor(u);
    const t = clamp01(u - i);
    const a = arr[i], b = arr[i + 1];
    if (b <= a || t === 0) return a > CAP_BASE ? CAP_BASE : a;
    const inc = BigInt(Math.ceil(Number(b - a) * t));
    const y = a + inc;
    return y > CAP_BASE ? CAP_BASE : y;
  };

  const y_floor = (x) => y_interp_floor(Y_FLOOR, x);
  const y_ceil  = (x) => y_interp_ceil (Y_CEIL , x);

  function x_from_y_floor(yBase) {
    const yb = yBase <= 0 ? 0n : yBase >= CAP_BASE ? CAP_BASE : BigInt(yBase);
    if (yb === 0n) return 0;
    if (yb >= CAP_BASE) return X_MAX;

    let lo = 0, hi = N;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const yMid = Y_FLOOR[mid] > CAP_BASE ? CAP_BASE : Y_FLOOR[mid];
      if (yMid <= yb) lo = mid;
      else hi = mid - 1;
    }
    if (lo >= N) return X_MAX;

    const yl = Y_FLOOR[lo]   > CAP_BASE ? CAP_BASE : Y_FLOOR[lo];
    const yr = Y_FLOOR[lo+1] > CAP_BASE ? CAP_BASE : Y_FLOOR[lo+1];
    const denom = Number(yr - yl);
    const num   = Number(yb - yl);
    const frac  = denom <= 0 ? 0 : Math.min(1, Math.max(0, num / denom));
    return (lo + frac) * DX;
  }

  function tokens_between(x0, x1) {
    const a = Math.max(0, Math.min(X_MAX, x0));
    const b = Math.max(0, Math.min(X_MAX, x1));
    if (b <= a) return 0;
    const dy = y_floor(b) - y_ceil(a); // conservative preview
    const whole = Number(dy) / Number(SCALE_BI);
    return whole > 0 ? whole : 0;
  }

  const cost_between_SOL    = (x0, x1) => Math.max(0, Math.min(X_MAX, x1) - Math.max(0, Math.min(X_MAX, x0)));
  const x_after_buying_SOL  = (x0, solIn)  => Math.min(X_MAX, Math.max(0, x0) + Math.max(0, solIn));
  const x_after_selling_SOL = (x0, solOut) => Math.max(0,     Math.max(0, x0) - Math.max(0, solOut));

  function x_after_buying_tokens(x0, tokensWanted, tol = 1e-6) {
    const SCALE_BI_LOCAL = SCALE_BI; // capture
    const wantBase = BigInt(Math.floor(Math.max(0, tokensWanted) * Number(SCALE_BI_LOCAL)));
    let lo = Math.max(0, Math.min(X_MAX, x0));
    let hi = X_MAX;
    for (let i = 0; i < 50; i++) {
      const mid = 0.5 * (lo + hi);
      const dy = y_floor(mid) - y_ceil(x0);
      if (dy >= wantBase) hi = mid; else lo = mid;
      if (hi - lo < tol) break;
    }
    return 0.5 * (lo + hi);
  }

  function x_after_selling_tokens(x0, tokensIn, tol = 1e-6) {
    const SCALE_BI_LOCAL = SCALE_BI;
    const wantBase = BigInt(Math.floor(Math.max(0, tokensIn) * Number(SCALE_BI_LOCAL)));
    let lo = 0;
    let hi = Math.max(0, Math.min(X_MAX, x0));
    for (let i = 0; i < 50; i++) {
      const mid = 0.5 * (lo + hi);
      const dy = y_ceil(x0) - y_floor(mid);
      if (dy >= wantBase) lo = mid; else hi = mid;
      if (hi - lo < tol) break;
    }
    return 0.5 * (lo + hi);
  }

  // legacy compat
  const invert_cost_from = (x0, solDelta) => x_after_buying_SOL(x0, solDelta);

  return {
    X_MAX, CAP_TOKENS,
    tokens_between, cost_between_SOL,
    x_after_buying_SOL, x_after_selling_SOL,
    x_after_buying_tokens, x_after_selling_tokens,
    invert_cost_from,
  };
}

export async function buildLUTModel(decimals = 9) {
  const url = `/lut.dec${decimals}.json`; // place your LUT into /public
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`LUT fetch failed at ${url}: ${res.status}`);
  const json = await res.json();
  return makeLUTModelFromData(json);
}

// ---------- small helpers ----------
export function baseToWhole(base, decimals = 9) {
  const bi = typeof base === "bigint" ? base : BigInt(base || 0);
  const scale = 10n ** BigInt(decimals);
  const whole = Number(bi / scale);
  const frac  = Number(bi % scale) / Number(scale);
  return whole + frac;
}

export function toLamports(sol) { return Math.floor((sol || 0) * LAMPORTS_PER_SOL); }
export function fromLamports(l) { return (l || 0) / LAMPORTS_PER_SOL; }
export function cap_base(dec) { return CAP_TOKENS * 10 ** dec; }
export function cap_base_big(dec) { return BigInt(CAP_TOKENS) * (10n ** BigInt(dec)); }
