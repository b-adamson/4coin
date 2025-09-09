#![allow(dead_code)]

use anchor_lang::prelude::Pubkey;

// Lamports per one token (pre-decimal). Used by your legacy math helper.
pub const INITIAL_PRICE_DIVIDER: u64 = 800_000;

// Seed SOL in the pool vault at bootstrap (0.01 SOL).
pub const INITIAL_LAMPORTS_FOR_POOL: u64 = 10_000_000;

// Max percent of tokens a user can sell in one go (basis points).
pub const TOKEN_SELL_LIMIT_PERCENT: u64 = 8000; // 80%

// Curve tuning note from your repo:
// 800M tokens sold on 500 SOL => proportion = 1280.
pub const PROPORTION: u64 = 1280;

// Hard cap for total tokens sold via the curve (base units, no decimals).
pub const SOLD_CAP: u64 = 800_000_000;

// (Optional) Defense-in-depth: only accept these Raydium program IDs when finalizing.
// Leave empty for now; you can fill with known CLMM/AMM IDs later.
pub const ALLOWLISTED_RAYDIUM_PROGRAMS: &[Pubkey] = &[
    // Example: Pubkey::new_from_array(*b"................................"),
];
