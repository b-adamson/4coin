use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{
    errors::CustomError,
    state::{LiquidityPool, PoolPhase},
};

pub fn handle(ctx: Context<FinalizeMigration>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    // Must be in Migrating phase to finalize
    require!(matches!(pool.phase, PoolPhase::Migrating), CustomError::BadPhase);

    // Record the Raydium pool id
    pool.raydium_pool = Some(ctx.accounts.raydium_pool.key());

    // Optional LP timelock can be passed as the first remaining account
    if let Some(acc) = ctx.remaining_accounts.get(0) {
        pool.lp_timelock = Some(acc.key());
    }

    // Flip to RaydiumLive
    pool.phase = PoolPhase::RaydiumLive;

    emit!(crate::MigrationFinalized {
        pool: pool.key(),
        raydium_pool: ctx.accounts.raydium_pool.key(),
        lp_timelock: pool.lp_timelock,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeMigration<'info> {
    // Pool PDA
    #[account(
        mut,
        seeds = [LiquidityPool::POOL_SEED_PREFIX.as_bytes(), token_mint.key().as_ref()],
        bump = pool.bump,
        has_one = migration_authority @ CustomError::Unauthorized,
    )]
    pub pool: Box<Account<'info, LiquidityPool>>,

    // Token mint (used in seeds)
    pub token_mint: Box<Account<'info, Mint>>,

    // Authority allowed to finalize
    pub migration_authority: Signer<'info>,

    /// CHECK: recorded only; the Raydium AMM/CLMM pool account id
    pub raydium_pool: UncheckedAccount<'info>,
}
