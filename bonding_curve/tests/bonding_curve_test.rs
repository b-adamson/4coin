use anchor_lang::{
    prelude::*,
    AccountDeserialize,    // for try_deserialize
    InstructionData,       // for .data()
    ToAccountMetas,        // for .to_account_metas()
};
use bonding_curve::state::CurveConfiguration;
use solana_program::instruction::Instruction;
use solana_program::sysvar::{rent::Rent, SysvarId}; // Rent::id() needs SysvarId in scope
use solana_program_test::{processor, tokio, ProgramTest};
use solana_sdk::{
    account::Account,
    signature::Keypair,
    signer::Signer,
    system_program,
    transaction::Transaction,
};

#[tokio::test]
async fn test_initialize() {
    // Register the on-chain processor for this program
    let mut validator = ProgramTest::new(
        "bonding_curve",
        bonding_curve::id(),                 // must match declare_id! in lib.rs
        processor!(bonding_curve::entry),    // wire the entrypoint
    );

    // fund a user
    let user = Keypair::new();
    validator.add_account(
        user.pubkey(),
        Account { lamports: 1_000_000_000, ..Account::default() },
    );

    // derive PDA used by your program
    let (cfg_pda, _bump) =
        Pubkey::find_program_address(&[b"CurveConfiguration"], &bonding_curve::id());

    // spin up the banks client
    let ctx = validator.start_with_context().await;

    // build the initialize ix using Anchor helpers
    let init_ix = Instruction {
        program_id: bonding_curve::id(),
        accounts: bonding_curve::accounts::InitializeCurveConfiguration {
            dex_configuration_account: cfg_pda,
            admin: user.pubkey(),
            rent: Rent::id(),                  // needs SysvarId trait
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: bonding_curve::instruction::Initialize { fee: 0.0 }.data(),
    };

    // sign & send
    let tx = Transaction::new_signed_with_payer(
        &[init_ix],
        Some(&user.pubkey()),
        &[&user],
        ctx.last_blockhash,
    );

    ctx.banks_client.process_transaction(tx).await.unwrap();

    // fetch & deserialize
    let account = ctx.banks_client.get_account(cfg_pda).await.unwrap().unwrap();
    let cfg: CurveConfiguration =
        CurveConfiguration::try_deserialize(&mut account.data.as_slice()).unwrap();

    assert_eq!(cfg.fees, 0.0);
}
