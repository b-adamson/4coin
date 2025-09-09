use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::state::{CurveConfiguration, LiquidityPool, LiquidityPoolAccount};

pub fn handle(ctx: Context<Sell>, amount: u64, bump: u8) -> Result<()> {
    // Trace logs
    msg!("💸 [sell] amount (tokens in): {}", amount);
    msg!("💸 [sell] user token ATA: {}", ctx.accounts.user_token_account.amount);
    msg!("💸 [sell] pool token ATA: {}", ctx.accounts.pool_token_account.amount);
    msg!("💸 [sell] pool SOL vault lamports: {}", ctx.accounts.pool_sol_vault.lamports());

    let pool = &mut ctx.accounts.pool;

    let token_accounts = (
        &mut *ctx.accounts.token_mint,
        &mut *ctx.accounts.pool_token_account,
        &mut *ctx.accounts.user_token_account,
    );

    pool.sell(
        token_accounts,
        &mut ctx.accounts.pool_sol_vault,
        amount,
        bump,
        &ctx.accounts.user,
        &ctx.accounts.token_program,
        &ctx.accounts.system_program,
    )
}

#[derive(Accounts)]
pub struct Sell<'info> {
    // Global config (present for future fee handling)
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

    // Token mint being traded on the curve
    #[account(mut)]
    pub token_mint: Box<Account<'info, Mint>>,

    // Pool's token ATA (authority = pool PDA)
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

    // User's token ATA (auto-create if missing)
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = token_mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    // Seller
    #[account(mut)]
    pub user: Signer<'info>,

    // Programs & sysvars
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}
