use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint};
use crate::{
    errors::CustomError,
    state::{LiquidityPool, PoolPhase},
    utils::curve::{cap_base, y_sold_from_pool},
};

pub fn handle(ctx: Context<StartMigration>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    // 1) re-check cap
    let decimals = ctx.accounts.token_mint.decimals;
    let cap = cap_base(decimals);
    let y_sold = y_sold_from_pool(pool.reserve_token, decimals);
    require!(y_sold >= cap, CustomError::CapNotReached);

    // --- NEW: read live balances from accounts ---
    let vault_lamports: u64 = ctx.accounts.pool_sol_vault.lamports();
    let pool_token_amount: u64 = ctx.accounts.pool_token_account.amount;
    let treasury_token_amount: u64 = ctx.accounts.treasury_token_account.amount;

    // 2) flip to Migrating + snapshot (idempotent)
    // If we are NOT Migrating/RaydiumLive yet -> flip and take snapshots.
    // If we ARE Migrating but snapshots are zero (legacy) -> take snapshots once (no flip).
    let need_initial_flip = !matches!(pool.phase, PoolPhase::Migrating | PoolPhase::RaydiumLive);
    let snapshots_missing =
        (pool.reserve_snapshot_token == 0) || (pool.reserve_snapshot_sol == 0);

    if need_initial_flip {
        let clock = Clock::get()?;
        pool.phase = PoolPhase::Migrating;
        pool.cap_reached_slot = Some(clock.slot);

        // --- NEW: snapshot from live account balances ---
        pool.reserve_snapshot_token = pool_token_amount;
        pool.reserve_snapshot_sol = vault_lamports;

        emit!(crate::MigrationStarted {
            pool: pool.key(),
            slot: clock.slot,
            reserve_token: pool.reserve_snapshot_token,
            reserve_sol: pool.reserve_snapshot_sol,
        });
    } else if matches!(pool.phase, PoolPhase::Migrating) && snapshots_missing {
        // Backfill snapshots exactly once if they were never recorded properly.
        // Do NOT change phase or cap_reached_slot here.
        if pool.reserve_snapshot_token == 0 {
            pool.reserve_snapshot_token = pool_token_amount;
        }
        if pool.reserve_snapshot_sol == 0 {
            pool.reserve_snapshot_sol = vault_lamports;
        }
    }

    // 3) drain pool tokens -> authority ATA
    if pool_token_amount > 0 {
        let token_key = pool.token.key();
        let seeds = &[
            LiquidityPool::POOL_SEED_PREFIX.as_bytes(),
            token_key.as_ref(),
            &[pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.pool_token_account.to_account_info(),
                    to: ctx.accounts.dest_token_account.to_account_info(),
                    authority: pool.to_account_info(),
                },
                signer_seeds,
            ),
            pool_token_amount,
        )?;
        // bookkeeping for the pool's internal counter
        pool.reserve_token = pool.reserve_token.saturating_sub(pool_token_amount);
    }

    // 4) drain TREASURY (whatever is there, typically 200M) -> authority ATA
    if treasury_token_amount > 0 {
        let mint_key = ctx.accounts.token_mint.key();
        let treasury_seeds = &[
            b"treasury".as_ref(),
            mint_key.as_ref(),
            &[ctx.bumps.treasury_pda],
        ];
        let treasury_signer = &[&treasury_seeds[..]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.treasury_token_account.to_account_info(),
                    to: ctx.accounts.dest_token_account.to_account_info(),
                    authority: ctx.accounts.treasury_pda.to_account_info(),
                },
                treasury_signer,
            ),
            treasury_token_amount,
        )?;
        // pool.reserve_token only tracks the pool ATA; no change here.
    }

    // 5) drain SOL vault -> authority wallet
    if vault_lamports > 0 {
        let token_key = pool.token.key();
        let sol_seeds = &[
            LiquidityPool::SOL_VAULT_PREFIX.as_bytes(),
            token_key.as_ref(),
            &[ctx.bumps.pool_sol_vault],
        ];
        let sol_signer = &[&sol_seeds[..]];
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.pool_sol_vault.key(),
            &ctx.accounts.migration_authority.key(),
            vault_lamports,
        );
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.pool_sol_vault.to_account_info(),
                ctx.accounts.migration_authority.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            sol_signer,
        )?;
        // bookkeeping for the pool's internal counter
        pool.reserve_sol = 0;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct StartMigration<'info> {
    #[account(
        mut,
        seeds = [LiquidityPool::POOL_SEED_PREFIX.as_bytes(), token_mint.key().as_ref()],
        bump = pool.bump,
        has_one = migration_authority @ CustomError::Unauthorized,
    )]
    pub pool: Box<Account<'info, LiquidityPool>>,

    pub token_mint: Box<Account<'info, Mint>>,

    // pool ATA (tokens owned by the pool PDA)
    #[account(mut)]
    pub pool_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: SOL vault PDA
    #[account(
        mut,
        seeds = [LiquidityPool::SOL_VAULT_PREFIX.as_bytes(), token_mint.key().as_ref()],
        bump
    )]
    pub pool_sol_vault: AccountInfo<'info>,

    /// CHECK: treasury PDA (owner of treasury ATA)
    #[account(
        seeds = [b"treasury", token_mint.key().as_ref()],
        bump
    )]
    pub treasury_pda: AccountInfo<'info>,

    #[account(mut)]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    // destination (authority's ATA for token_mint)
    #[account(mut)]
    pub dest_token_account: Box<Account<'info, TokenAccount>>,

    pub migration_authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
