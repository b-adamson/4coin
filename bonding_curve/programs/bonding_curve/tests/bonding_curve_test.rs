use std::str::FromStr;

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{self},
    system_program, AccountDeserialize, InstructionData, ToAccountMetas,
};
use anyhow::Ok;
use bonding_curve::state::CurveConfiguration;
use solana_program::instruction::Instruction;
use solana_program_test::{tokio, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    rent::Rent,
    signature::Keypair,
    signer::Signer,
    sysvar::{Sysvar, SysvarId},
    transaction::Transaction,
};

#[tokio::test]
async fn test_initialize() {
    let SetUpTest {
        validator,
        user,
        bonding_curve_pda,
    } = SetUpTest::new();

    let mut context = validator.start_with_context().await;
    let init_ix = Instruction {
        program_id: bonding_curve::ID,
        accounts: bonding_curve::accounts::InitializeCurveConfiguration {
            dex_configuration_account: bonding_curve_pda,
            admin: user.pubkey(),
            rent: Rent::id(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: bonding_curve::instruction::Initialize { fee: 0f64 }.data(),
    };

    let init_tx = Transaction::new_signed_with_payer(
        &[init_ix],
        Some(&user.pubkey()),
        &[&user],
        context.last_blockhash,
    );

    context
        .banks_client
        .process_transaction(init_tx)
        .await
        .unwrap();

    let account = context
        .banks_client
        .get_account(bonding_curve_pda)
        .await
        .unwrap() //unwraps the Result into an Option<Account>
        .unwrap(); //unwraps the Option<Account> into an Account

    let config: CurveConfiguration =
        CurveConfiguration::try_deserialize(&mut account.data.as_slice()).unwrap();

    assert_eq!(config.fees, 0f64);
}

// #[tokio::test]
// async fn test_increment() {
//     let SetUpTest {
//         validator,
//         user: _,
//         counter_pda,
//     } = SetUpTest::new();

//     let mut context = validator.start_with_context().await;

//     let init_ix = Instruction {
//         program_id: anchor_counter::ID,
//         accounts: anchor_counter::accounts::Initialize {
//             counter: counter_pda,
//             user: context.payer.pubkey(),
//             system_program: system_program::ID,
//         }
//         .to_account_metas(None),
//         data: anchor_counter::instruction::Initialize {}.data(),
//     };

//     let increment_ix = Instruction {
//         program_id: anchor_counter::ID,
//         accounts: anchor_counter::accounts::Increment {
//             counter: counter_pda,
//             user: context.payer.pubkey(),
//         }
//         .to_account_metas(None),
//         data: anchor_counter::instruction::Increment {}.data(),
//     };

//     let init_increment_tx = Transaction::new_signed_with_payer(
//         &[init_ix, increment_ix],
//         Some(&context.payer.pubkey()),
//         &[&context.payer],
//         context.last_blockhash,
//     );

//     let _res = context
//         .banks_client
//         .process_transaction(init_increment_tx)
//         .await;

//     let counter: anchor_counter::Counter = load_and_deserialize(context, counter_pda).await;

//     assert_eq!(counter.count, 1);
// }

// #[tokio::test]
// async fn test_double_increment() -> anyhow::Result<()> {
//     let SetUpTest {
//         validator,
//         user,
//         counter_pda,
//     } = SetUpTest::new();

//     let mut context = validator.start_with_context().await;

//     let init_ix = Instruction {
//         program_id: anchor_counter::ID,
//         accounts: anchor_counter::accounts::Initialize {
//             counter: counter_pda,
//             user: user.pubkey(),
//             system_program: system_program::ID,
//         }
//         .to_account_metas(None),
//         data: anchor_counter::instruction::Initialize {}.data(),
//     };

//     let increment_ix = Instruction {
//         program_id: anchor_counter::ID,
//         accounts: anchor_counter::accounts::Increment {
//             counter: counter_pda,
//             user: user.pubkey(),
//         }
//         .to_account_metas(None),
//         data: anchor_counter::instruction::Increment {}.data(),
//     };

//     let increment_ix_2 = increment_ix.clone();

//     let init_increment_tx = Transaction::new_signed_with_payer(
//         &[init_ix, increment_ix, increment_ix_2],
//         Some(&user.pubkey()),
//         &[&user],
//         context.last_blockhash,
//     );

//     let _res = context
//         .banks_client
//         .process_transaction(init_increment_tx)
//         .await;

//     let counter: anchor_counter::Counter = load_and_deserialize(context, counter_pda).await;

//     assert_eq!(counter.count, 2);

//     Ok(())
// }

// #[tokio::test]
// async fn test_bogus_counter_acct() -> anyhow::Result<()> {
//     let SetUpTest {
//         validator,
//         user,
//         counter_pda,
//     } = SetUpTest::new();

//     let mut context = validator.start_with_context().await;

//     initialize(&mut context, &user, &counter_pda).await?;

//     //let (bogus_pda, _) = Pubkey::find_program_address(&[b"counter_bad"], &anchor_counter::ID);

//     let increment_ix = Instruction {
//         program_id: anchor_counter::ID,
//         accounts: anchor_counter::accounts::Increment {
//             counter: user.pubkey(), /*bogus_pda*/
//             user: user.pubkey(),
//         }
//         .to_account_metas(None),
//         data: anchor_counter::instruction::Increment {}.data(),
//     };

//     let increment_tx = Transaction::new_signed_with_payer(
//         &[increment_ix],
//         Some(&user.pubkey()),
//         &[&user],
//         context.last_blockhash,
//     );

//     let res = context.banks_client.process_transaction(increment_tx).await;

//     assert!(res.is_err());

//     Ok(())
// }

/// Struct set up to hold the validator, an optional user account, and the counter PDA.
/// Use SetUpTest::new() to create a new instance.
pub struct SetUpTest {
    pub validator: ProgramTest,
    pub user: Keypair,
    pub bonding_curve_pda: Pubkey,
}

/// Returns the validator, an optional funded user account, and the counter PDA
impl SetUpTest {
    pub fn new() -> Self {
        //Both of these work

        // let mut validator = ProgramTest::default();
        // validator.add_program("bonding_curve", bonding_curve::ID, None);
        let mut validator = ProgramTest::new("bonding_curve", bonding_curve::ID, None);

        //create a new user and fund with 1 SOL
        //add the user to the validator / ledger
        let user = Keypair::new();
        validator.add_account(
            user.pubkey(),
            Account {
                lamports: 1_000_000_000,
                ..Account::default()
            },
        );

        //get the bonding_curve PDA -- uses the same seed we used in the anchor program
        let (bonding_curve_pda, _) =
            Pubkey::find_program_address(&[b"CurveConfiguration"], &bonding_curve::ID);

        Self {
            validator,
            user,
            bonding_curve_pda,
        }
    }
}

// ///Function that initializes the counter account
// ///Useful for testing things you want to fail but need to initialize the counter account first
// pub async fn initialize(
//     ctx: &mut ProgramTestContext,
//     user: &Keypair,
//     counter_pda: &Pubkey,
// ) -> anyhow::Result<()> {
//     let init_ix = Instruction {
//         program_id: anchor_counter::ID,
//         accounts: anchor_counter::accounts::Initialize {
//             counter: *counter_pda,
//             user: user.pubkey(),
//             system_program: system_program::ID,
//         }
//         .to_account_metas(None),
//         data: anchor_counter::instruction::Initialize {}.data(),
//     };

//     let init_tx = Transaction::new_signed_with_payer(
//         &[init_ix],
//         Some(&user.pubkey()),
//         &[&user],
//         ctx.last_blockhash,
//     );

//     ctx.banks_client.process_transaction(init_tx).await.unwrap();

//     Ok(())
// }

// /// Fetch the account from the ProgramTestContext and deserialize it.
// /// Taken from the MarginFi Github tests: https://github.com/mrgnlabs/marginfi-v2/blob/main/test-utils/src/test.rs#L468
// pub async fn load_and_deserialize<T: AccountDeserialize>(
//     mut ctx: ProgramTestContext,
//     address: Pubkey,
// ) -> T {
//     let account = ctx
//         .banks_client
//         .get_account(address)
//         .await
//         .unwrap() //unwraps the Result into an Option<Account>
//         .unwrap(); //unwraps the Option<Account> into an Account

//     T::try_deserialize(&mut account.data.as_slice()).unwrap()
// }