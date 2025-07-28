import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { BN } from 'bn.js';


import PinataClient from '@pinata/sdk';
import * as anchor from '@coral-xyz/anchor';
import {
  Keypair,
  Transaction,
  TransactionInstruction,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram
} from '@solana/web3.js';
import { createWeb3JsRpc } from '@metaplex-foundation/umi-rpc-web3js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMintToInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress
} from '@solana/spl-token';
import mpl from '@metaplex-foundation/mpl-token-metadata';
const {
  createV1,
  mplTokenMetadata,
  TokenStandard
} = mpl;
import {
  createUmi,
  createSignerFromKeypair,
  percentAmount,
  signerIdentity,
} from '@metaplex-foundation/umi';

import { mplToolbox } from '@metaplex-foundation/mpl-toolbox';
import { createDefaultProgramRepository } from '@metaplex-foundation/umi-program-repository';
import { createWeb3JsEddsa } from '@metaplex-foundation/umi-eddsa-web3js';
import { createWeb3JsTransactionFactory } from '@metaplex-foundation/umi-transaction-factory-web3js';

// **Pinata Setup**
const pinata = new PinataClient({
    pinataApiKey: process.env.PINATA_API_KEY,
    pinataSecretApiKey: process.env.PINATA_SECRET_API_KEY
});

// Program and metadata IDs
const PROGRAM_ID = new PublicKey("2kNMersGbMJcXinsicDJ2VtekJWvXGmEvKHD3qw2bmBX");
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// Load IDL once
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const idlPath = path.resolve(__dirname, '../bonding_curve/bonding_curve/target/idl/bonding_curve.json');
const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));

// Connection & app setup
const DEVNET_URL = "https://api.devnet.solana.com";
const connection = new anchor.web3.Connection(DEVNET_URL, "confirmed");

const app = express();
app.use(cors());
app.use(express.json());
const PORT = 4000;

const TOKEN_DECIMALS = 9; 

function createDummySigner(pubkeyStr) {
  return {
    publicKey: new PublicKey(pubkeyStr),
    signMessage: async () => {
      throw new Error("Dummy signer cannot sign messages.");
    },
    signTransaction: async () => {
      throw new Error("Dummy signer cannot sign transactions.");
    },
    signAllTransactions: async () => {
      throw new Error("Dummy signer cannot sign transactions.");
    },
  };
}

async function tryInitializeCurveConfig() {
  try {
    const adminKeypair = anchor.web3.Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync("../bonding_curve/bonding_curve/~/.config/solana/id.json", "utf-8"))) // the evil manmoder master wallet 😈
    );

    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(adminKeypair), {
      commitment: "confirmed",
    });

    const program = new anchor.Program(idl, provider);

    const [dexConfigurationPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("CurveConfiguration")],
      program.programId
    );

    // Check if account exists
    const existingAccount = await connection.getAccountInfo(dexConfigurationPDA);
    if (existingAccount) {
      console.log("✅ Curve config already initialized.");
      return;
    }

    // Build transaction
    const tx = await program.methods
      .initialize(0.5) // or your default fee
      .accounts({
        dexConfigurationAccount: dexConfigurationPDA,
        adminKeypair,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc(); // directly send the transaction from dummy wallet

    console.log("✅ Curve config initialized:", tx);
  } catch (err) {
    console.error("❌ Failed to initialize curve config:", err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  tryInitializeCurveConfig(); // ✅ boot-time call
});

// app.post("/add-liquidity", async (req, res) => {
//   try {
//     const { walletAddress, mintPubkey, amount } = req.body;

//     if (!walletAddress || !mintPubkey || !amount) {
//       return res.status(400).json({
//         error: 'Missing walletAddress, mintPubkey, or amount',
//       });
//     }

//     const user = new PublicKey(walletAddress);
//     const mint = new PublicKey(mintPubkey);
//     const lamports = Math.floor(Number(amount) * anchor.web3.LAMPORTS_PER_SOL);

//     // --- Derive PDAs ---
//     const [poolPDA] = PublicKey.findProgramAddressSync(
//       [Buffer.from('liquidity_pool'), mint.toBuffer()],
//       PROGRAM_ID
//     );

//     const [solVault] = PublicKey.findProgramAddressSync(
//       [Buffer.from('liquidity_sol_vault'), mint.toBuffer()],
//       PROGRAM_ID
//     );

//     const poolTokenAccount = await getAssociatedTokenAddress(mint, poolPDA, true);
//     const userTokenAccount = await getAssociatedTokenAddress(mint, user);

//     // --- Check if user ATA exists ---
//     const ataInstructions = [];
//     const ataInfo = await connection.getAccountInfo(userTokenAccount);
//     if (!ataInfo) {
//       ataInstructions.push(
//         createAssociatedTokenAccountInstruction(
//           user, // payer
//           userTokenAccount,
//           user,
//           mint,
//           TOKEN_PROGRAM_ID,
//           ASSOCIATED_TOKEN_PROGRAM_ID
//         )
//       );
//     }

//     // --- Setup provider & program ---
//     const provider = new anchor.AnchorProvider(
//       connection,
//       {
//         publicKey: () => user,
//         signAllTransactions: async (txs) => txs,
//         signTransaction: async (tx) => tx,
//       },
//       { commitment: 'confirmed' }
//     );
//     const program = new anchor.Program(idl, provider);

//     // --- System transfer instruction (SOL into vault) ---
//     const transferIx = SystemProgram.transfer({
//       fromPubkey: user,
//       toPubkey: solVault,
//       lamports,
//     });

//     // --- Add liquidity ix ---
//     const addLiquidityIx = await program.methods
//       .addLiquidity()
//       .accounts({
//         pool: poolPDA,
//         tokenMint: mint,
//         poolTokenAccount,
//         userTokenAccount,
//         poolSolVault: solVault,
//         user,
//         rent: anchor.web3.SYSVAR_RENT_PUBKEY,
//         tokenProgram: TOKEN_PROGRAM_ID,
//         associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
//         systemProgram: SystemProgram.programId,
//       })
//       .instruction();

//     // --- Compose final transaction ---
//     const { blockhash } = await connection.getLatestBlockhash();
//     const message = new anchor.web3.TransactionMessage({
//       payerKey: user,
//       recentBlockhash: blockhash,
//       instructions: [...ataInstructions, transferIx, addLiquidityIx],
//     }).compileToV0Message();

//     const tx = new anchor.web3.VersionedTransaction(message);
//     const txBase64 = Buffer.from(tx.serialize()).toString('base64');

//     return res.json({ txBase64 });
//   } catch (err) {
//     console.error('/add-liquidity error:', err);
//     res.status(500).json({ error: err.message });
//   }
// });

app.post("/buy", async (req, res) => {
  try {
    const { walletAddress, mintPubkey, amount } = req.body;

    if (!walletAddress || !mintPubkey || !amount) {
      return res.status(400).json({
        error: "Missing walletAddress, mintPubkey, or amount",
      });
    }

    const user = new anchor.web3.PublicKey(walletAddress);
    const mint = new anchor.web3.PublicKey(mintPubkey);

    // --- Derive PDAs ---
    const [poolPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("liquidity_pool"), mint.toBuffer()],
      PROGRAM_ID
    );

    const [solVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("liquidity_sol_vault"), mint.toBuffer()],
      PROGRAM_ID
    );

    const [dexConfigPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("CurveConfiguration")],
      PROGRAM_ID
    );

    // --- Derive Token Accounts ---
    const poolTokenAccount = await anchor.utils.token.associatedAddress({
      mint,
      owner: poolPDA,
    });

    const userTokenAccount = await anchor.utils.token.associatedAddress({
      mint,
      owner: user,
    });

    // --- Setup Anchor Provider & Program ---
    const provider = new anchor.AnchorProvider(
      connection,
      {
        publicKey: () => new PublicKey(walletAddress),
        signAllTransactions: async (txs) => txs,
        signTransaction: async (tx) => tx,
      },
      { commitment: "confirmed" }
    );
    const program = new anchor.Program(idl, provider);

    // --- Instruction ---
    const buyIx = await program.methods
      .buy(new BN(amount)) // amount in lamports
      .accounts({
        dexConfigurationAccount: dexConfigPDA,
        pool: poolPDA,
        tokenMint: mint,
        poolTokenAccount,
        userTokenAccount,
        poolSolVault: solVault,
        user,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    const { blockhash } = await connection.getLatestBlockhash();

    const message = new anchor.web3.TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [buyIx],
    }).compileToV0Message();

    const tx = new anchor.web3.VersionedTransaction(message);
    const txBase64 = Buffer.from(tx.serialize()).toString("base64");

    res.json({ txBase64 });
  } catch (err) {
    console.error("/buy error:", err);
    res.status(500).json({ error: err.message });
  }
});





app.post("/prepare-mint-and-pool", async (req, res) => {
  try {
    const {
      walletAddress,
      mintPubkey,
      mintSecretKey,
      name,
      symbol,
      metadataUri,
      amount = 1_000_000_000 * 10 ** TOKEN_DECIMALS,
      initialBuyLamports // 👈 optional
    } = req.body;

    if (!walletAddress || !name || !symbol || !metadataUri) {
      return res.status(400).json({
        error: "Missing fields: walletAddress, name, symbol, metadataUri required",
      });
    }

    // --- Setup Umi ---
    const umi = createUmi(DEVNET_URL);
    const dummySigner = createDummySigner(walletAddress);
    umi.use(signerIdentity(dummySigner));
    umi.programs = createDefaultProgramRepository();
    umi.eddsa = createWeb3JsEddsa();
    umi.rpc = createWeb3JsRpc(
      { programs: umi.programs, transactions: umi.transactions },
      DEVNET_URL
    );
    umi.transactions = createWeb3JsTransactionFactory();
    umi.use(mplToolbox()).use(mplTokenMetadata());

    // --- Mint keypair ---
    const mint = Keypair.fromSecretKey(Uint8Array.from(mintSecretKey));
    const mintPubkeyObj = mint.publicKey;

    const umiMint = createSignerFromKeypair(umi, {
      publicKey: mintPubkeyObj.toBytes(),
      secretKey: Uint8Array.from(mint.secretKey),
    });

    // --- Derive PDAs ---
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("liquidity_pool"), mintPubkeyObj.toBuffer()],
      PROGRAM_ID
    );
    const [solVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("liquidity_sol_vault"), mintPubkeyObj.toBuffer()],
      PROGRAM_ID
    );
    const [dexConfigPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("CurveConfiguration")],
      PROGRAM_ID
    );

    // --- Token metadata instructions ---
    const createTokenTx = await createV1(umi, {
      mint: umiMint,
      authority: new PublicKey(walletAddress),
      name,
      symbol,
      uri: metadataUri,
      sellerFeeBasisPoints: percentAmount(0),
      decimals: TOKEN_DECIMALS,
      tokenStandard: TokenStandard.Fungible,
    });

    // --- Anchor provider ---
    const provider = new anchor.AnchorProvider(
      connection,
      {
        publicKey: () => new PublicKey(walletAddress),
        signAllTransactions: async (txs) => txs,
        signTransaction: async (tx) => tx,
      },
      { commitment: "confirmed" }
    );
    const program = new anchor.Program(idl, provider);

    // --- Pool ATA ---
    const poolTokenAccount = await anchor.utils.token.associatedAddress({
      mint: mintPubkeyObj,
      owner: poolPDA,
    });

    // --- Create Pool instruction ---
    const poolIx = await program.methods
      .createPool()
      .accounts({
        pool: poolPDA,
        tokenMint: mintPubkeyObj,
        poolTokenAccount,
        poolSolVault: solVaultPDA,
        payer: new PublicKey(walletAddress),
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    // --- MintTo (seed liquidity) ---
    const mintToIx = createMintToInstruction(
      mintPubkeyObj,
      poolTokenAccount,
      new PublicKey(walletAddress),
      BigInt(amount),
      [],
      TOKEN_PROGRAM_ID
    );

    const instructions = [
      ...createTokenTx.getInstructions().map(
        (ix) =>
          new TransactionInstruction({
            programId: new PublicKey(ix.programId),
            keys: ix.keys.map((k) => ({
              pubkey: new PublicKey(k.pubkey),
              isSigner:
                k.pubkey === walletAddress ||
                k.pubkey === mintPubkeyObj.toBase58() ||
                k.isSigner,
              isWritable: k.isWritable,
            })),
            data: Buffer.from(ix.data),
          })
      ),
      poolIx,
      mintToIx,
    ];

    // --- Optional Initial Buy ---
    if (initialBuyLamports && Number(initialBuyLamports) > 0) {
      const user = new PublicKey(walletAddress);

      // Derive user's ATA
      const userTokenAccount = await anchor.utils.token.associatedAddress({
        mint: mintPubkeyObj,
        owner: user,
      });

      // Ensure ATA exists
      const ataInfo = await connection.getAccountInfo(userTokenAccount);
      if (!ataInfo) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            user, // payer
            userTokenAccount,
            user,
            mintPubkeyObj
          )
        );
      }

      // Build Buy instruction
      const buyIx = await program.methods
        .buy(new BN(initialBuyLamports))
        .accounts({
          dexConfigurationAccount: dexConfigPDA,
          pool: poolPDA,
          tokenMint: mintPubkeyObj,
          poolTokenAccount,
          userTokenAccount,
          poolSolVault: solVaultPDA,
          user,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction();

      instructions.push(buyIx);
    }

    // --- Build versioned transaction ---
    const { blockhash } = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: new PublicKey(walletAddress),
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const versionedTx = new VersionedTransaction(messageV0);

    // Partially sign with mint key
    versionedTx.sign([mint]);
    versionedTx.signatures[0] = new Uint8Array(64);

    const txBase64 = Buffer.from(versionedTx.serialize()).toString("base64");

    res.json({
      txBase64,
      pool: poolPDA.toBase58(),
      mint: mintPubkeyObj.toBase58(),
      poolTokenAccount: poolTokenAccount.toBase58(),
    });
  } catch (err) {
    console.error("🔥 /prepare-mint-and-pool error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

app.post('/upload', upload.single('icon'), async (req, res) => {
  const { name, symbol, description, walletAddress } = req.body;
  const date = new Date().toISOString().split('T')[0]; // Format the date as YYYY-MM-DD
  const fileNamePrefix = `${walletAddress}_${date}`;

  try {
    // Rename the uploaded icon with the wallet address and date
    const iconPath = path.join(__dirname, 'uploads', `${fileNamePrefix}_icon.png`);
    fs.renameSync(req.file.path, iconPath);

    // Upload the icon to Pinata
    const iconIpfsUri = await uploadFileToPinata(iconPath);
    if (!iconIpfsUri) {
      return res.status(500).json({ error: 'Failed to upload icon to Pinata' });
    }
    console.log('Icon uploaded to:', iconIpfsUri);

    // Step 3: Create metadata.json with the icon's IPFS URI
    const metadata = {
      name,
      symbol,
      description,
      image: iconIpfsUri // Use the icon's IPFS URI
    };

    // Step 4: Save metadata.json with a wallet-based name
    const metadataPath = path.join(__dirname, 'uploads', `${fileNamePrefix}_metadata.json`);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    // Step 5: Upload metadata.json to Pinata
    const metadataIpfsUri = await uploadFileToPinata(metadataPath);
    if (!metadataIpfsUri) {
      return res.status(500).json({ error: 'Failed to upload metadata to Pinata' });
    }
    console.log('Metadata uploaded to:', metadataIpfsUri);

    // Return both IPFS URIs
    res.json({
      message: 'Icon and metadata uploaded successfully!',
      iconIpfsUri,
      metadataIpfsUri
    });

    // Clean up temporary files
    fs.unlinkSync(iconPath);
    fs.unlinkSync(metadataPath);
  } catch (error) {
    console.error('Error handling upload:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function uploadFileToPinata(filePath) {
  const readableStreamForFile = fs.createReadStream(filePath);
  const options = { pinataMetadata: { name: path.basename(filePath) } };

  try {
    const result = await pinata.pinFileToIPFS(readableStreamForFile, options);
    return `https://coffee-far-termite-270.mypinata.cloud/ipfs/${result.IpfsHash}`;
  } catch (error) {
    console.error('Error uploading file to Pinata:', error);
    return null;
  }
}

