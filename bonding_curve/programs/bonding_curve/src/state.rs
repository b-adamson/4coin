
use crate::errors::CustomError;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use crate::utils::curve::{cap_base, y_sold_from_pool, buy_on_curve, sell_on_curve};
use crate::consts::{INITIAL_LAMPORTS_FOR_POOL, INITIAL_PRICE_DIVIDER};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PoolPhase {
    Active,        // Bonding curve live
    Migrating,     // Curve locked, awaiting AMM pool creation
    RaydiumLive,   // Live on Raydium
}

#[account]
#[derive(InitSpace)]
pub struct CurveConfiguration {
    pub fees: f64,
}

impl CurveConfiguration {
    pub const SEED: &'static str = "CurveConfiguration";

    // Discriminator (8) + (we historically kept 32 here; left as-is for your layout) + f64 (8)
    pub const ACCOUNT_SIZE: usize = 8 + 32 + 8;

    pub fn new(fees: f64) -> Self {
        Self { fees }
    }
}

#[account]
pub struct LiquidityProvider {
    pub shares: u64, // The number of shares this provider holds in the liquidity pool
}

impl LiquidityProvider {
    pub const SEED_PREFIX: &'static str = "LiqudityProvider"; // Prefix for generating PDAs

    // Discriminator (8) + u64 (8)
    pub const ACCOUNT_SIZE: usize = 8 + 8;
}

#[account]
pub struct LiquidityPool {
    // --- existing fields you already rely on ---
    pub creator: Pubkey,
    pub token: Pubkey,          // token mint
    pub total_supply: u64,      // cached mint.supply after init
    pub reserve_token: u64,     // pool's token balance
    pub reserve_sol: u64,       // SOL in the PDA vault
    pub bump: u8,               // PDA bump for pool PDA

    // --- new fields for migration flow (append-only to keep layout compatibility) ---
    pub phase: PoolPhase,
    pub cap_reached_slot: Option<u64>,
    pub raydium_pool: Option<Pubkey>,    // AMM/CLMM pool id (once created)
    pub migration_authority: Pubkey,     // who can start/finalize migration

    // Snapshots at the moment we enter Migrating
    pub reserve_snapshot_token: u64,
    pub reserve_snapshot_sol: u64,

    // Optional locker address for LP tokens (record-only)
    pub lp_timelock: Option<Pubkey>,
}

impl LiquidityPool {
    pub const POOL_SEED_PREFIX: &'static str = "liquidity_pool";
    pub const SOL_VAULT_PREFIX: &'static str = "liquidity_sol_vault";

    // Total serialized size INCLUDING the 8-byte discriminator.
    // Base (your original layout): 8(discriminator)+32(creator)+32(token)+8(total_supply)+8(reserve_token)+8(reserve_sol)+1(bump) = 97
    // Added for migration:
    //   + phase(1)
    //   + cap_reached_slot Option<u64>(1 tag + 8 data) = 9
    //   + raydium_pool Option<Pubkey>(1 tag + 32 data) = 33
    //   + migration_authority(32)
    //   + reserve_snapshot_token(8) + reserve_snapshot_sol(8) = 16
    //   + lp_timelock Option<Pubkey>(1 tag + 32 data) = 33
    // 97 + (1+9+33+32+16+33) = 221
    pub const ACCOUNT_SIZE: usize = 221;

    pub fn new(creator: Pubkey, token: Pubkey, bump: u8) -> Self {
        Self {
            creator,
            token,
            total_supply: 0_u64,
            reserve_token: 0_u64,
            reserve_sol: 0_u64,
            bump,
            // --- migration fields (defaults) ---
            phase: PoolPhase::Active,
            cap_reached_slot: None,
            raydium_pool: None,
            migration_authority: creator,
            reserve_snapshot_token: 0,
            reserve_snapshot_sol: 0,
            lp_timelock: None,
        }
    }
}



pub trait LiquidityPoolAccount<'info> {
    // Updates the token/SOL reserves in the liquidity pool
    fn update_reserves(&mut self, reserve_token: u64, reserve_sol: u64) -> Result<()>;

    // Allows adding liquidity by depositing token & SOL (bootstrap)
    fn add_liquidity(
        &mut self,
        token_accounts: (
            &mut Account<'info, Mint>,
            &mut Account<'info, TokenAccount>,  // pool ATA
            &mut Account<'info, TokenAccount>,  // user ATA (token source)
        ),
        pool_sol_vault: &mut AccountInfo<'info>,
        authority: &Signer<'info>,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
    ) -> Result<()>;

    // Allows removing liquidity (creator-only at instruction layer)
    fn remove_liquidity(
        &mut self,
        token_accounts: (
            &mut Account<'info, Mint>,
            &mut Account<'info, TokenAccount>,  // pool ATA
            &mut Account<'info, TokenAccount>,  // user ATA
        ),
        pool_sol_vault: &mut AccountInfo<'info>,
        authority: &Signer<'info>,
        bump: u8,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
    ) -> Result<()>;

    fn buy(
        &mut self,
        token_accounts: (
            &mut Account<'info, Mint>,
            &mut Account<'info, TokenAccount>, // pool ATA
            &mut Account<'info, TokenAccount>, // user ATA
        ),
        pool_sol_vault: &mut AccountInfo<'info>,
        amount: u64, // max lamports user is willing to spend
        authority: &Signer<'info>,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
    ) -> Result<()>;

    fn sell(
        &mut self,
        token_accounts: (
            &mut Account<'info, Mint>,
            &mut Account<'info, TokenAccount>, // pool ATA
            &mut Account<'info, TokenAccount>, // user ATA
        ),
        pool_sol_vault: &mut AccountInfo<'info>,
        amount: u64, // tokens (base units) user is selling
        bump: u8,
        authority: &Signer<'info>,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
    ) -> Result<()>;

    fn transfer_token_from_pool(
        &self,
        from: &Account<'info, TokenAccount>,
        to: &Account<'info, TokenAccount>,
        amount: u64,
        token_program: &Program<'info, Token>,
    ) -> Result<()>;

    fn transfer_token_to_pool(
        &self,
        from: &Account<'info, TokenAccount>,
        to: &Account<'info, TokenAccount>,
        amount: u64,
        authority: &Signer<'info>,
        token_program: &Program<'info, Token>,
    ) -> Result<()>;

    fn transfer_sol_to_pool(
        &self,
        from: &Signer<'info>,
        to: &mut AccountInfo<'info>,
        amount: u64,
        system_program: &Program<'info, System>,
    ) -> Result<()>;

    fn transfer_sol_from_pool(
        &self,
        from: &mut AccountInfo<'info>,
        to: &Signer<'info>,
        amount: u64,
        bump: u8,
        system_program: &Program<'info, System>,
    ) -> Result<()>;
}

impl<'info> LiquidityPoolAccount<'info> for Account<'info, LiquidityPool> {
    fn update_reserves(&mut self, reserve_token: u64, reserve_sol: u64) -> Result<()> {
        self.reserve_token = reserve_token;
        self.reserve_sol = reserve_sol;
        Ok(())
    }

    fn add_liquidity(
        &mut self,
        token_accounts: (
            &mut Account<'info, Mint>,
            &mut Account<'info, TokenAccount>,
            &mut Account<'info, TokenAccount>,
        ),
        pool_sol_vault: &mut AccountInfo<'info>,
        authority: &Signer<'info>,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
    ) -> Result<()> {
        // pool receives all tokens from user's token account (bootstrap)
        self.transfer_token_to_pool(
            token_accounts.2,
            token_accounts.1,
            token_accounts.0.supply,
            authority,
            token_program,
        )?;

        // pool receives the initial SOL seed
        self.transfer_sol_to_pool(
            authority,
            pool_sol_vault,
            INITIAL_LAMPORTS_FOR_POOL,
            system_program,
        )?;

        self.total_supply = token_accounts.0.supply;
        self.update_reserves(token_accounts.1.amount, pool_sol_vault.lamports())?;
        Ok(())
    }

    fn remove_liquidity(
        &mut self,
        token_accounts: (
            &mut Account<'info, Mint>,
            &mut Account<'info, TokenAccount>,
            &mut Account<'info, TokenAccount>,
        ),
        pool_sol_vault: &mut AccountInfo<'info>,
        authority: &Signer<'info>,
        bump: u8,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
    ) -> Result<()> {
        // Transfer all pool tokens back to user
        self.transfer_token_from_pool(
            token_accounts.1,
            token_accounts.2,
            token_accounts.1.amount as u64,
            token_program,
        )?;

        // Transfer all SOL back to user
        let amount = pool_sol_vault.to_account_info().lamports() as u64;
        self.transfer_sol_from_pool(pool_sol_vault, authority, amount, bump, system_program)?;
        Ok(())
    }

    fn buy(
        &mut self,
        token_accounts: (
            &mut Account<'info, Mint>,
            &mut Account<'info, TokenAccount>, // pool ATA
            &mut Account<'info, TokenAccount>, // user ATA
        ),
        pool_sol_vault: &mut AccountInfo<'info>,
        amount: u64,
        authority: &Signer<'info>,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
    ) -> Result<()> {
        if amount == 0 {
            return err!(CustomError::InvalidAmount);
        }

        // Halt trading if not Active
        if !matches!(self.phase, PoolPhase::Active) {
            return err!(CustomError::InvalidAmount); // use a dedicated error later
        }

        msg!("Trying to buy from the pool");

        // 🔑 Auto-initialize reserves if uninitialized
        if self.reserve_token == 0 && self.reserve_sol == 0 {
            let pool_balance = token_accounts.1.amount;
            self.total_supply = token_accounts.0.supply;
            self.reserve_token = pool_balance;
            self.reserve_sol = pool_sol_vault.lamports();
            msg!(
                "Initialized: total_supply {}, reserve_token {}, reserve_sol {}",
                self.total_supply, self.reserve_token, self.reserve_sol
            );
        }

        let decimals = token_accounts.0.decimals;
        let cap = cap_base(decimals);

        // How many tokens have been sold so far on the curve
        let y_sold = y_sold_from_pool(self.reserve_token, decimals);

        // ⚖️ Compute tokens_out and the exact lamports to charge from the curve
        // We pass `amount` as the *budget*; helper will not exceed it.
        let (tokens_out, lamports_used) = buy_on_curve(y_sold, amount, decimals);
        msg!("curve buy → tokens_out: {}, lamports_used: {}", tokens_out, lamports_used);

        // Reject if nothing would be bought or pool doesn't have enough tokens
        if tokens_out == 0 || tokens_out > self.reserve_token {
            return err!(CustomError::InvalidAmount);
        }

        // Check if cap would be exceeded
        let total_after = y_sold.saturating_add(tokens_out);
        if total_after > cap {
            return err!(CustomError::InvalidAmount);
        }

        // If this trade *fills* the cap exactly, transition to Migrating
        if total_after == cap {
            let clock = Clock::get()?;
            self.phase = PoolPhase::Migrating;
            self.cap_reached_slot = Some(clock.slot);
            self.reserve_snapshot_token = self.reserve_token;
            self.reserve_snapshot_sol = self.reserve_sol;
        }

        // ✅ Update reserves using the exact lamports we will actually take
        self.reserve_sol = self
            .reserve_sol
            .checked_add(lamports_used)
            .ok_or_else(|| error!(CustomError::OverflowOrUnderflowOccurred))?;

        self.reserve_token = self
            .reserve_token
            .checked_sub(tokens_out)
            .ok_or_else(|| error!(CustomError::OverflowOrUnderflowOccurred))?;

        // 💸 Transfer exactly lamports_used from buyer → pool vault
        self.transfer_sol_to_pool(authority, pool_sol_vault, lamports_used, system_program)?;

        // 🪙 Transfer tokens from pool → buyer
        self.transfer_token_from_pool(
            token_accounts.1, // pool ATA
            token_accounts.2, // user ATA
            tokens_out,
            token_program,
        )?;

        Ok(())
    }

    fn sell(
        &mut self,
        token_accounts: (
            &mut Account<'info, Mint>,
            &mut Account<'info, TokenAccount>, // pool ATA
            &mut Account<'info, TokenAccount>, // user ATA
        ),
        pool_sol_vault: &mut AccountInfo<'info>,
        amount: u64, // tokens (base units) user is selling
        bump: u8,
        authority: &Signer<'info>,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
    ) -> Result<()> {
        if amount == 0 {
            return err!(CustomError::InvalidAmount);
        }
        if self.reserve_token < amount {
            return err!(CustomError::TokenAmountToSellTooBig);
        }

        // Halt trading if not Active
        if !matches!(self.phase, PoolPhase::Active) {
            return err!(CustomError::InvalidAmount); // dedicate an error later
        }

        let decimals = token_accounts.0.decimals;

        // How many have been sold so far on the curve
        let y_sold = y_sold_from_pool(self.reserve_token, decimals);

        // 💵 Lamports owed from curve area
        let lamports_out = sell_on_curve(y_sold, amount, decimals);
        msg!("curve sell → tokens_in: {}, lamports_out: {}", amount, lamports_out);

        require!(self.reserve_sol >= lamports_out, CustomError::NotEnoughSolInVault);

        // Ensure SOL vault exists (if your flow expects a system account PDA)
        if pool_sol_vault.lamports() == 0 {
            msg!("⚡ Funding SOL vault PDA for the first time");

            let rent = Rent::get()?.minimum_balance(0);
            let mint_key = token_accounts.0.key();

            let seeds = &[
                LiquidityPool::SOL_VAULT_PREFIX.as_bytes(),
                mint_key.as_ref(),
                &[bump],
            ];
            let signer_seeds = &[&seeds[..]];

            anchor_lang::system_program::create_account(
                CpiContext::new_with_signer(
                    system_program.to_account_info(),
                    anchor_lang::system_program::CreateAccount {
                        from: authority.to_account_info(),
                        to: pool_sol_vault.clone(),
                    },
                    signer_seeds,
                ),
                rent,
                0,
                &system_program::ID,
            )?;
        }

        // Update reserves to reflect the trade
        self.reserve_sol = self
            .reserve_sol
            .checked_sub(lamports_out)
            .ok_or_else(|| error!(CustomError::OverflowOrUnderflowOccurred))?;

        self.reserve_token = self
            .reserve_token
            .checked_add(amount)
            .ok_or_else(|| error!(CustomError::OverflowOrUnderflowOccurred))?;

        // User → Pool (tokens)
        self.transfer_token_to_pool(
            token_accounts.2,
            token_accounts.1,
            amount,
            authority,
            token_program,
        )?;

        // Pool → User (lamports)
        self.transfer_sol_from_pool(
            pool_sol_vault,
            authority,
            lamports_out,
            bump,
            system_program,
        )?;

        Ok(())
    }

    fn transfer_token_from_pool(
        &self,
        from: &Account<'info, TokenAccount>,
        to: &Account<'info, TokenAccount>,
        amount: u64,
        token_program: &Program<'info, Token>,
    ) -> Result<()> {
        let token_key = self.token.key();
        let seeds = &[
            LiquidityPool::POOL_SEED_PREFIX.as_bytes(),
            token_key.as_ref(),
            &[self.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                token::Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: self.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
        Ok(())
    }

    fn transfer_token_to_pool(
        &self,
        from: &Account<'info, TokenAccount>,
        to: &Account<'info, TokenAccount>,
        amount: u64,
        authority: &Signer<'info>,
        token_program: &Program<'info, Token>,
    ) -> Result<()> {
        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                token::Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: authority.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    fn transfer_sol_from_pool(
        &self,
        from: &mut AccountInfo<'info>,
        to: &Signer<'info>,
        amount: u64,
        bump: u8,
        system_program: &Program<'info, System>,
    ) -> Result<()> {
        let token_key = self.token.key();
        let seeds = &[
            LiquidityPool::SOL_VAULT_PREFIX.as_bytes(),
            token_key.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &from.key(),
            &to.key(),
            amount,
        );

        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[from.clone(), to.to_account_info().clone(), system_program.to_account_info()],
            signer_seeds,
        )?;

        Ok(())
    }

    fn transfer_sol_to_pool(
        &self,
        from: &Signer<'info>,
        to: &mut AccountInfo<'info>,
        amount: u64,
        system_program: &Program<'info, System>,
    ) -> Result<()> {
        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }
}

// NOTE: This helper remains in your file. Not used by the LUT math paths, but kept intact.
fn calculate_amount_out(reserve_token_with_decimal: u64, amount_with_decimal: u64) -> Result<u64> {
    // Convert to f64 for decimal calculations (⚠ consider fixed-point long term)
    let reserve_token = (reserve_token_with_decimal as f64) / 1_000_000_000.0;
    let amount = (amount_with_decimal as f64) / 1_000_000_000.0;

    msg!(
        "Starting calculation with reserve_token: {}, amount: {}",
        reserve_token,
        amount
    );

    let two_reserve_token = reserve_token * 2.0;
    let one_added = two_reserve_token + 1.0;
    let squared = one_added * one_added;
    let amount_added = squared + amount * 8.0;
    let sqrt_result = amount_added.sqrt();
    if sqrt_result < 0.0 {
        return err!(CustomError::NegativeNumber);
    }
    let subtract_one = sqrt_result - one_added;
    let amount_out = subtract_one / 2.0;

    // back to base units
    let amount_out_decimal =
        (amount_out * 1_000_000_000.0 * INITIAL_PRICE_DIVIDER as f64).round() as u64;

    Ok(amount_out_decimal)
}

/* ---------------------------------------------------------------------------------
   The long commented linear-curve section you had stays here (omitted for brevity).
   --------------------------------------------------------------------------------- */
