use anchor_lang::prelude::*;

pub mod consts;
pub mod errors;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::add_liquidity::*;
use instructions::buy::*;
use instructions::create_pool::*; 
use instructions::finalize_migration::*;
use instructions::initialize::*;
use instructions::remove_liquidity::*;
use instructions::sell::*;
use instructions::start_migration::*;

use instructions::create_pool::CreatePool;

declare_id!("EcmMaHYxoz3VhNg8M8TBFVAc7Xy4VHW6nBBWhPyE8HrP");

#[program]
pub mod bonding_curve {
    use super::*;

    pub fn initialize(ctx: Context<InitializeCurveConfiguration>, fee: f64) -> Result<()> {
        crate::instructions::initialize::handle(ctx, fee)
    }

    pub fn create_pool(
        ctx: Context<CreatePool>, // ✅ Now this resolves cleanly
        migration_authority: Pubkey,
    ) -> Result<()> {
        instructions::create_pool::handle(ctx, migration_authority)
    }

    pub fn add_liquidity(ctx: Context<AddLiquidity>) -> Result<()> {
        crate::instructions::add_liquidity::handle(ctx)
    }

    pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, bump: u8) -> Result<()> {
        crate::instructions::remove_liquidity::handle(ctx, bump)
    }

    pub fn buy(ctx: Context<Buy>, amount: u64) -> Result<()> {
        crate::instructions::buy::handle(ctx, amount)
    }

    pub fn sell(ctx: Context<Sell>, amount: u64, bump: u8) -> Result<()> {
        crate::instructions::sell::handle(ctx, amount, bump)
    }

    pub fn start_migration(ctx: Context<StartMigration>) -> Result<()> {
        crate::instructions::start_migration::handle(ctx)
    }

    pub fn finalize_migration(ctx: Context<FinalizeMigration>) -> Result<()> {
        crate::instructions::finalize_migration::handle(ctx)
    }
}


#[event]
pub struct CapReached {
    pub pool: Pubkey,
    pub slot: u64,
    pub reserve_token: u64,
    pub reserve_sol: u64,
    pub total_sold: u64,
}

#[event]
pub struct MigrationStarted {
    pub pool: Pubkey,
    pub slot: u64,
    pub reserve_token: u64,
    pub reserve_sol: u64,
}

#[event]
pub struct MigrationFinalized {
    pub pool: Pubkey,
    pub raydium_pool: Pubkey,
    pub lp_timelock: Option<Pubkey>,
}