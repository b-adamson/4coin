// FILE: instructions/buy.rs  (patched)

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::state::{CurveConfiguration, LiquidityPool, LiquidityPoolAccount};

/// Optional stealth announcement we emit for scanning.
/// Pass empty vec/zeroes if you don't want to emit anything.
#[event]
pub struct StealthAnnouncement {
    pub eph_pub: [u8; 32],
    pub announcement_ct: Vec<u8>,
    pub nonce: [u8; 16],
}

pub fn handle(
    ctx: Context<Buy>,
    amount: u64,                       // lamports budget (public for now)
    eph_pub: [u8; 32],                 // optional: sender ephemeral pubkey for scanning
    announcement_ct: Vec<u8>,          // optional: encrypted payload for recipient view key
    nonce: [u8; 16],                   // optional: caller-chosen nonce
) -> Result<()> {
    // Minimal logs (avoid leaking identities/amounts beyond what's already public)
    msg!("🛒 [buy] budget lamports: {}", amount);
    msg!("🛒 [buy] pool_token: {}", ctx.accounts.pool_token_account.amount);

    let pool = &mut ctx.accounts.pool;

    // token_accounts = (mint, pool_ata, recipient_ata)
    let token_accounts = (
        &mut *ctx.accounts.token_mint,
        &mut *ctx.accounts.pool_token_account,
        &mut *ctx.accounts.recipient_token_account,
    );

    // Settlement: pull SOL from relayer/fee_payer, send tokens to stealth ATA
    pool.buy(
        token_accounts,
        &mut ctx.accounts.pool_sol_vault,
        amount,
        &ctx.accounts.fee_payer,        // 👈 relayer provides the SOL; buyer never signs on-chain
        &ctx.accounts.token_program,
        &ctx.accounts.system_program,
    )?;

    // (Optional) Emit a stealth announcement for wallet scanners
    // If you don't want this, pass zero/empty from the client and we skip emit.
    if !announcement_ct.is_empty() || eph_pub != [0u8; 32] || nonce != [0u8; 16] {
        emit!(StealthAnnouncement {
            eph_pub,
            announcement_ct,
            nonce,
        });
    }

    Ok(())
}

#[derive(Accounts)]
pub struct Buy<'info> {
    // Global config
    #[account(
        mut,
        seeds = [CurveConfiguration::SEED.as_bytes()],
        bump,
    )]
    pub dex_configuration_account: Box<Account<'info, CurveConfiguration>>,

    // Pool PDA
    #[account(
        mut,
        seeds = [LiquidityPool::POOL_SEED_PREFIX.as_bytes(), token_mint.key().as_ref()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, LiquidityPool>>,

    // Token mint traded on the curve
    #[account(mut)]
    pub token_mint: Box<Account<'info, Mint>>,

    // Pool ATA (authority = pool PDA)
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = pool
    )]
    pub pool_token_account: Box<Account<'info, TokenAccount>>,

    /// System-owned SOL vault PDA for the pool (created in create_pool)
    #[account(
        mut,
        seeds = [LiquidityPool::SOL_VAULT_PREFIX.as_bytes(), token_mint.key().as_ref()],
        bump
    )]
    /// CHECK: PDA vault holds only lamports; seeds enforced; owner checked at runtime.
    pub pool_sol_vault: AccountInfo<'info>,

    // === NEW: recipient (stealth) ATA ===
    // Create ATA for one-time stealth pubkey (recipient_authority) — payer is the relayer
    #[account(
        init_if_needed,
        payer = fee_payer,
        associated_token::mint = token_mint,
        associated_token::authority = recipient_authority,
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    /// One-time stealth pubkey (ed25519) used as ATA authority.
    /// We don't require its signature — ATAs can be created for arbitrary authorities.
    /// CHECK: treated as a raw pubkey; no data is read.
    pub recipient_authority: UncheckedAccount<'info>,

    // === NEW: relayer/fee payer (also funds the purchase SOL on-chain) ===
    #[account(mut)]
    pub fee_payer: Signer<'info>,

    // Programs & sysvars
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}
