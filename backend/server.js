require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const PinataClient = require('@pinata/sdk');
const anchor = require("@project-serum/anchor");
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

const PROGRAM_ID = new PublicKey("B3Qs4ufp61VD5LGgRarXFCeykB1yWTegemAhHdKVMWWL");
const idl        = require("../bonding_curve/bonding_curve/target/idl/bonding_curve.json");

const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
const app  = express();
app.use(cors());
app.use(express.json());
const PORT = 4000;

function dummyWallet(userPk) {
  return {
    publicKey: userPk,
    signTransaction:  (tx)  => tx,
    signAllTransactions: (txs) => txs
  };
}
app.post("/create-pool", async (req, res) => {
  try {
    const {
      walletAddress,
      name,
      symbol,
      metadataUri,
      initialSol = 1_000_000_00  // 0.01 SOL default
    } = req.body;

    const userPK = new PublicKey(walletAddress);

    // Provider & Program bound to the user (no signing)
    const provider = new anchor.AnchorProvider(connection, dummyWallet(userPK), {});
    const program  = new anchor.Program(idl, PROGRAM_ID, provider);

    // Derive the pool PDA.  Use seeds you used on‑chain.
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), userPK.toBuffer()],
      PROGRAM_ID
    );

    // ============ build ix list ============

    // 1️⃣ create_pool (creates Mint + pool account)
    const ixCreatePool = await program.methods.createPool(
        name, symbol, metadataUri            // if your instruction accepts these
      )
      .accounts({
        pool: poolPDA,
        payer: userPK,
        systemProgram: SystemProgram.programId,
      })
      .instruction();                         // <-- IMPORTANT: build *Instruction*, not tx

    // 2️⃣ add_liquidity – deposit `initialSol`
    const ixAddLiq = await program.methods.addLiquidity(new anchor.BN(initialSol))
      .accounts({
        pool: poolPDA,
        payer: userPK,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Build transaction with *both* instructions
    const tx = new anchor.web3.Transaction().add(ixCreatePool, ixAddLiq);
    tx.feePayer = userPK;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    // Serialize for front‑end (no sigs yet)
    res.json({ tx: tx.serialize({ requireAllSignatures:false }).toString("base64") });

  } catch (err) {
    console.error("create‑pool error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ===== buy and sell endpoints (build‑only) ===================== */

app.post("/buy", async (req, res) => {
  try {
    const { walletAddress, pool, amountSol } = req.body;
    const userPK = new PublicKey(walletAddress);
    const provider = new anchor.AnchorProvider(connection, dummyWallet(userPK), {});
    const program  = new anchor.Program(idl, PROGRAM_ID, provider);

    const ixBuy = await program.methods.buy(new anchor.BN(amountSol))
      .accounts({ pool: new PublicKey(pool), user: userPK })
      .instruction();

    const tx = new anchor.web3.Transaction().add(ixBuy);
    tx.feePayer = userPK;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    res.json({ tx: tx.serialize({ requireAllSignatures:false }).toString("base64") });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.post("/sell", async (req, res) => {
  try {
    const { walletAddress, pool, amountTokens, bump } = req.body;
    const userPK = new PublicKey(walletAddress);
    const provider = new anchor.AnchorProvider(connection, dummyWallet(userPK), {});
    const program  = new anchor.Program(idl, PROGRAM_ID, provider);

    const ixSell = await program.methods.sell(new anchor.BN(amountTokens), bump)
      .accounts({ pool: new PublicKey(pool), user: userPK })
      .instruction();

    const tx = new anchor.web3.Transaction().add(ixSell);
    tx.feePayer = userPK;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    res.json({ tx: tx.serialize({ requireAllSignatures:false }).toString("base64") });
  } catch (e) { res.status(500).json({ error:e.message }); }
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
