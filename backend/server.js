require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const PinataClient = require('@pinata/sdk');
const anchor = require("@coral-xyz/anchor");
const { 
    Connection, 
    Keypair, 
    SystemProgram, 
    Transaction, 
    PublicKey 
} = require("@solana/web3.js");
const {
    ExtensionType,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    MINT_SIZE,
    createInitializeMintInstruction,
    getMintLen,
    createInitializeMetadataPointerInstruction,
    createAssociatedTokenAccountInstruction,
    getAssociatedTokenAddress,
    createMintToInstruction,
    createSetAuthorityInstruction,
    AuthorityType
} = require("@solana/spl-token");
const {
    createInitializeInstruction,
    createUpdateFieldInstruction,
    pack
} = require("@solana/spl-token-metadata");

// **Pinata Setup**
const pinata = new PinataClient({
    pinataApiKey: process.env.PINATA_API_KEY,
    pinataSecretApiKey: process.env.PINATA_SECRET_API_KEY
});

const PROGRAM_ID = new PublicKey("2kNMersGbMJcXinsicDJ2VtekJWvXGmEvKHD3qw2bmBX");
const idl        = require("../bonding_curve/bonding_curve/target/idl/bonding_curve.json");

const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
const app  = express();
app.use(cors());
app.use(express.json());
const PORT = 5500;

function dummyWallet(userPk) {
  return {
    publicKey: userPk,
    signTransaction:  (tx)  => tx,
    signAllTransactions: (txs) => txs
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

app.listen(4000, () => {
  tryInitializeCurveConfig(); // ✅ boot-time call
});

app.post("/prepare-mint-and-pool", async (req, res) => {
  try {
    const { walletAddress, mintPubkey } = req.body;
    if (!walletAddress || !mintPubkey) {
      return res.status(400).json({ error: "Missing walletAddress or mintPubkey" });
    }

    const userPublicKey = new PublicKey(walletAddress);
    const mintPublicKey = new PublicKey(mintPubkey);

    const provider = new anchor.AnchorProvider(connection, dummyWallet(userPublicKey), {
      commitment: "confirmed",
    });
    const program = new anchor.Program(idl, provider);

    const transaction = new Transaction();

    // 1️⃣ Create mint account
    const mintLen = getMintLen([]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    transaction.add(
      SystemProgram.createAccount({
        fromPubkey: userPublicKey,
        newAccountPubkey: mintPublicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        mintPublicKey,
        6,
        userPublicKey,
        null,
        TOKEN_PROGRAM_ID
      )
    );

    // 2️⃣ Derive pool PDA
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("liquidity_pool"), mintPublicKey.toBuffer()],
      program.programId
    );

    // 3️⃣ Derive expected ATA for pool (we don’t create it — your Anchor instruction will)
    const poolTokenAccount = await getAssociatedTokenAddress(
      mintPublicKey,
      poolPDA,
      true
    );

    // 4️⃣ Call your create_pool instruction (which will init the PDA + ATA)
    const ix = await program.methods
      .createPool()
      .accounts({
        pool: poolPDA,
        tokenMint: mintPublicKey,
        poolTokenAccount,
        payer: userPublicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    transaction.add(ix);

    transaction.feePayer = userPublicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    res.json({
      tx: transaction.serialize({ requireAllSignatures: false }).toString("base64"),
      pool: poolPDA.toBase58(),
      poolTokenAccount: poolTokenAccount.toBase58(),
      mint: mintPublicKey.toBase58()
    });

  } catch (err) {
    console.error("🔥 /prepare-mint-and-pool error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/mint-to-pool", async (req, res) => {
  try {
    const { walletAddress, mintPubkey, poolTokenAccount, amount } = req.body;
    const user = new PublicKey(walletAddress);
    const mint = new PublicKey(mintPubkey);
    const ata = new PublicKey(poolTokenAccount);

    const tx = new Transaction().add(
      createMintToInstruction(
        mint,
        ata,
        user,
        BigInt(amount),
        [],
        TOKEN_PROGRAM_ID
      )
    );

    tx.feePayer = user;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    res.json({
      tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    });

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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
