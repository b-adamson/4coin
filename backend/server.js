import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import PinataClient from '@pinata/sdk';
import * as anchor from '@coral-xyz/anchor';
import {
  Keypair,
  Transaction,
  TransactionInstruction,
  PublicKey,
  VersionedTransaction,
  TransactionMessage
} from '@solana/web3.js';
import { createWeb3JsRpc } from '@metaplex-foundation/umi-rpc-web3js';
import {
  TOKEN_PROGRAM_ID,
  createMintToInstruction,
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
      {
        programs: umi.programs,
        transactions: umi.transactions,
      },
      DEVNET_URL
    );
    umi.transactions = createWeb3JsTransactionFactory();

    umi.use(mplToolbox()).use(mplTokenMetadata());

    // --- Mint keypair & Umi signer ---
    const mint = Keypair.fromSecretKey(Uint8Array.from(mintSecretKey));
    const mintPubkeyObj = mint.publicKey;

    const umiMint = createSignerFromKeypair(umi, {
      publicKey: mintPubkeyObj.toBytes(),
      secretKey: Uint8Array.from(mint.secretKey),
    });

    // --- Derive pool PDA ---
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("liquidity_pool"), mintPubkeyObj.toBuffer()],
      PROGRAM_ID
    );

    // --- Create token metadata instructions (versioned) ---
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

    // --- Setup Anchor provider with dummy signer ---
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

    // --- Derive pool token account (associated token account) ---
    const poolTokenAccount = await anchor.utils.token.associatedAddress({
      mint: mintPubkeyObj,
      owner: poolPDA,
    });

    // --- Create Anchor pool instruction ---
    const poolIx = await program.methods
      .createPool()
      .accounts({
        pool: poolPDA,
        tokenMint: mintPubkeyObj,
        poolTokenAccount,
        payer: new PublicKey(walletAddress),
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    // --- Fetch recent blockhash ---
    const { blockhash } = await connection.getLatestBlockhash();

    // --- Compose all instructions ---
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
    ];

    // --- Build versioned transaction message ---
    const messageV0 = new TransactionMessage({
      payerKey: new PublicKey(walletAddress),
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    // --- Create versioned transaction and partially sign mint ---
    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign([mint]);
    versionedTx.signatures[0] = new Uint8Array(64); // Clear fee payer signature slot

    // --- Serialize to base64 for frontend ---
    const txBase64 = Buffer.from(versionedTx.serialize()).toString("base64");

    // --- Respond with transaction and relevant info ---
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

app.post("/mint-to-pool", async (req, res) => {
   try {
    const { walletAddress, mintPubkey, poolTokenAccount, amount } = req.body;

    if (!walletAddress || !mintPubkey || !poolTokenAccount || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const user = new PublicKey(walletAddress);
    const mint = new PublicKey(mintPubkey);
    const ata = new PublicKey(poolTokenAccount);

    const tx = new Transaction().add(
      createMintToInstruction(
        mint,
        ata,
        user,
        BigInt(amount),
        [], // multisig signers; keep empty as original
        TOKEN_PROGRAM_ID
      )
    );

    tx.feePayer = user;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const txBase64 = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString("base64");

    res.json({ tx: txBase64 });
  } catch (err) {
    console.error("🔥 /mint-to-pool error:", err);
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

// app.listen(PORT, () => {
//   console.log(`Server running at http://localhost:${PORT}`);
// });
