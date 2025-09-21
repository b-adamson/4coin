//! LUT-based bonding curve using cumulative supply tables in base units.
//! - F_floor(x): floor cumulative supply (base units) at x
//! - F_ceil (x): ceil  cumulative supply (base units) at x
//! Buys:  tokens_out = max(0, F_floor(x1) - F_ceil(x0))
//! Sells: find x1 s.t. F_ceil(x0) - F_floor(x1) >= tokens_in  (conservative)
//! Inversion (y->x) uses floor table: largest x with F_floor(x) ≤ y

#![allow(clippy::many_single_char_names)]

use anchor_lang::solana_program::native_token::LAMPORTS_PER_SOL;

// ====================== Domain / constants ======================

/// Total SOL span of the curve (should match your LUT metadata; ~78.53981633974483).
pub const X_MAX: f64 = 78.539_816_339_744_83;

/// Period length just for reference.
pub const T: f64 = X_MAX / 3.0;

/// Target total tokens sold along the curve (WHOLE tokens).
pub const CAP_TOKENS: u64 = 800_000_000;

/// LUT decimals your JSON was generated with (usually 9).
pub const LUT_DECIMALS: u8 = 9;

// ====================== Bring in the LUT data ======================
//
// Place `curve_lut_data.rs` in the same folder. It must define:
//   pub static Y_FLOOR: [u64; N_PLUS_1];
//   pub static Y_CEIL:  [u64; N_PLUS_1];
include!("curve_lut_data.rs");

// ====================== Helpers ======================

#[inline]
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

#[inline]
fn clamp01(t: f64) -> f64 {
    if t <= 0.0 { 0.0 } else if t >= 1.0 { 1.0 } else { t }
}

#[inline]
fn n_nodes() -> usize { Y_FLOOR.len() }             // = N + 1
#[inline]
fn n_intervals() -> usize { Y_FLOOR.len() - 1 }     // = N
#[inline]
fn dx_sol() -> f64 { X_MAX / (n_intervals() as f64) } // DX derived from LUT length

/// 800M × 10^dec
pub fn cap_base(decimals: u8) -> u64 {
    ((CAP_TOKENS as u128) * 10u128.pow(decimals as u32)) as u64
}

/// y_sold = 800M*10^dec - min(pool_balance, 800M*10^dec)
pub fn y_sold_from_pool(pool_balance_base: u64, decimals: u8) -> u64 {
    let cap = cap_base(decimals);
    cap.saturating_sub(pool_balance_base.min(cap))
}

const CAP_BASE_U128: u128 = (CAP_TOKENS as u128) * 10u128.pow(LUT_DECIMALS as u32);

// ====================== Interpolation on cumulative ======================
//
// We interpolate between nodes in a rounding-directed way that preserves
// the intended conservatism across the segment.

#[inline]
fn y_interp_floor(arr: &[u64], x: f64) -> u128 {
    if x <= 0.0 { return 0u128; }
    if x >= X_MAX { return CAP_BASE_U128; }

    let dx = dx_sol();
    let u = x / dx;
    let i = u.floor() as usize; // 0..=N-1
    let t = clamp01(u - (i as f64));

    let a = arr[i] as u128;
    let b = arr[i + 1] as u128;

    if b <= a || t == 0.0 { return a.min(CAP_BASE_U128); }

    // a + floor((b-a)*t)
    let delta = (b - a) as f64;
    let incr = (delta * t).floor() as u128;
    (a + incr).min(CAP_BASE_U128)
}

#[inline]
fn y_interp_ceil(arr: &[u64], x: f64) -> u128 {
    if x <= 0.0 { return 0u128; }
    if x >= X_MAX { return CAP_BASE_U128; }

    let dx = dx_sol();
    let u = x / dx;
    let i = u.floor() as usize; // 0..=N-1
    let t = clamp01(u - (i as f64));

    let a = arr[i] as u128;
    let b = arr[i + 1] as u128;

    if b <= a || t == 0.0 { return a.min(CAP_BASE_U128); }

    // a + ceil((b-a)*t)
    let delta = (b - a) as f64;
    let incr = (delta * t).ceil() as u128;
    (a + incr).min(CAP_BASE_U128)
}

#[inline]
fn y_at_x_floor_clamped(x: f64) -> u128 { y_interp_floor(&Y_FLOOR, x) }
#[inline]
fn y_at_x_ceil_clamped (x: f64) -> u128 { y_interp_ceil (&Y_CEIL , x) }

// ====================== Inversion (y -> x) ======================
//
// Largest x with F_floor(x) <= y (monotone & conservative).

pub fn x_from_y_lut(y_base: u64) -> f64 {
    let yb = (y_base as u128).min(CAP_BASE_U128);
    if yb == 0 { return 0.0; }
    if yb >= CAP_BASE_U128 { return X_MAX; }

    // Binary search over node indices [0, N]
    let mut lo: usize = 0;
    let mut hi: usize = n_intervals();

    while lo < hi {
        let mid = (lo + hi + 1) >> 1; // bias upward
        let y_mid = (Y_FLOOR[mid] as u128).min(CAP_BASE_U128);
        if y_mid <= yb { lo = mid; } else { hi = mid - 1; }
    }

    if lo >= n_intervals() { return X_MAX; }

    // Fractional position within [lo, lo+1]
    let yl = (Y_FLOOR[lo] as u128).min(CAP_BASE_U128);
    let yr = (Y_FLOOR[lo + 1] as u128).min(CAP_BASE_U128);
    let denom = yr.saturating_sub(yl);

    let frac = if denom == 0 {
        0.0
    } else {
        let num = yb.saturating_sub(yl) as f64;
        (num / (denom as f64)).clamp(0.0, 1.0)
    };

    (lo as f64 + frac) * dx_sol()
}

// ====================== Frontend-identical sell solver ======================

#[inline]
fn x_after_selling_tokens(x0: f64, tokens_in_base: u64) -> f64 {
    if tokens_in_base == 0 { return x0; }

    let want: u128 = tokens_in_base as u128;
    let y0_ceil: u128 = y_at_x_ceil_clamped(x0);

    // search x1 in [0, x0] such that  F_ceil(x0) - F_floor(x1) >= want
    let mut lo = 0.0_f64;
    let mut hi = x0;

    for _ in 0..50 {
        let mid = 0.5 * (lo + hi);
        let y_mid_floor = y_at_x_floor_clamped(mid);
        if y0_ceil.saturating_sub(y_mid_floor) >= want {
            // still enough tokens released — move right to reduce SOL out (conservative)
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

// ====================== Public trading helpers ======================

// BUY by lamports budget.
// Returns (tokens_out_base_units, lamports_used).
pub fn buy_on_curve(
    y_current_base: u64,   // cumulative sold so far (base units)
    lamports_in: u64,      // pay-in budget
    decimals: u8,
) -> (u64, u64) {
    debug_assert_eq!(decimals, LUT_DECIMALS, "LUT decimals must match token decimals");
    if lamports_in == 0 { return (0, 0); }

    // Position from cumulative sold so far
    let x0 = x_from_y_lut(y_current_base);

    // Advance by SOL budget
    let sol_budget = (lamports_in as f64) / (LAMPORTS_PER_SOL as f64);
    let x1 = clamp(x0 + sol_budget, 0.0, X_MAX);

    // Conservative tokens_out: F_floor(x1) - F_ceil(x0), clamped at remaining cap
    let y0_ceil = y_at_x_ceil_clamped(x0);
    let y1_floor = y_at_x_floor_clamped(x1);

    let cap_remaining = CAP_BASE_U128.saturating_sub(y_current_base as u128);
    let dy = y1_floor.saturating_sub(y0_ceil).min(cap_remaining);

    // Lamports actually used (floor; never overcharge)
    let used_sol = (x1 - x0).max(0.0);
    let used_lamports = (used_sol * (LAMPORTS_PER_SOL as f64)).floor() as u64;

    (dy as u64, used_lamports.min(lamports_in))
}

/// Temporary buy curve for testing
/// Gives you exactly 800,000,000 tokens for 0.02 SOL (2,000,000 lamports)
/// Scales linearly in between.
// pub fn buy_on_curve(
//     _y_sold: u64,
//     lamports_budget: u64,
//     _decimals: u8,
// ) -> (u64, u64) {
//     const TOKENS_OUT: u64 = 800_000_000u64 * 1_000_000_000u64;
//     (TOKENS_OUT, lamports_budget)
// }





/// SELL by tokens-in (base units). Returns lamports_out.
pub fn sell_on_curve(
    y_current_base: u64, // cumulative sold so far (base units)
    tokens_in_base: u64, // tokens to burn (base units)
    decimals: u8,
) -> u64 {
    debug_assert_eq!(decimals, LUT_DECIMALS, "LUT decimals must match token decimals");
    if tokens_in_base == 0 { return 0; }

    // position on curve from cumulative sold
    let x0 = x_from_y_lut(y_current_base);

    // identical to frontend: binary-search x1 so that ceil(x0) - floor(x1) >= tokens_in
    let x1 = x_after_selling_tokens(x0, tokens_in_base);

    // lamports out (floor; never overpay)
    let sol_out = (x0 - x1).max(0.0);
    (sol_out * (LAMPORTS_PER_SOL as f64)).floor() as u64
}

// ====================== (Optional) spot helper ======================
//
// Approximate spot price from slope of FLOOR cumulative (for UI only).
#[allow(dead_code)]
pub fn spot_price_sol_per_token(x: f64) -> f64 {
    let h = dx_sol();
    let xl = clamp(x - 0.5 * h, 0.0, X_MAX);
    let xr = clamp(x + 0.5 * h, 0.0, X_MAX);
    let yl = y_at_x_floor_clamped(xl);
    let yr = y_at_x_floor_clamped(xr);
    let d_tokens = (yr.saturating_sub(yl)) as f64 / 10f64.powi(LUT_DECIMALS as i32);
    if d_tokens <= 0.0 { return f64::INFINITY; }
    (xr - xl) / d_tokens
}
