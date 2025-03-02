const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const PinataClient = require('@pinata/sdk');

require('dotenv').config();

const app = express();
const port = 3000;
const pinata = new PinataClient({
  pinataApiKey: process.env.PINATA_API_KEY,
  pinataSecretApiKey: process.env.PINATA_SECRET_API_KEY
});

const idl = require("../bonding_curve/bonding_curve/target/idl/bonding_curve.json"); // Adjust this if the IDL JSON is stored elsewhere
const anchor = require("@project-serum/anchor");

const {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
  PublicKey
} = require("@solana/web3.js");

const {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  getMintLen,
  createInitializeMetadataPointerInstruction,
  getMint,
  getMetadataPointerState,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress ,
  getTokenMetadata,
  TYPE_SIZE,
  LENGTH_SIZE,
  createMintToInstruction,
  createSetAuthorityInstruction,
  AuthorityType
} = require("@solana/spl-token");

const {
  createInitializeInstruction,
  createUpdateFieldInstruction,
  pack,
  TokenMetadata,
} = require("@solana/spl-token-metadata");

app.use(cors());
app.use(express.json());

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

app.post('/create-token', async (req, res) => {

  const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');

  try {
      const userPublicKey = new PublicKey(req.body.walletAddress);
      const mintAccount = Keypair.generate();
      const transaction = new Transaction();

      const removeMintAuthority = req.body.removeMintAuthority || false;
      const removeFreezeAuthority = req.body.removeFreezeAuthority || false;

      console.log("User Public Key:", userPublicKey.toBase58());
      console.log("Generated Mint Public Key:", mintAccount.publicKey.toBase58());

      // Metadata setup
      const metaData = {
          updateAuthority: userPublicKey,
          mint: mintAccount.publicKey,
          name: req.body.name || "MyToken",
          symbol: req.body.symbol || "MT",
          uri: req.body.metadataUri || "https://example.com",
          additionalMetadata: [["description", req.body.description || "A Solana token"]],
      };

      // Calculate space required for the Mint Account
      const metadataExtension = 4; // Metadata extension size
      const metadataLen = pack(metaData).length;
      const mintLen = getMintLen([ExtensionType.MetadataPointer]);
      const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataExtension + metadataLen);

      // Create Mint Account
      transaction.add(
        SystemProgram.createAccount({
          fromPubkey: userPublicKey,
          newAccountPubkey: mintAccount.publicKey,
          space: mintLen,
          lamports,
          programId: TOKEN_2022_PROGRAM_ID
        })
      );

      // Initialize MetadataPointer (stores metadata in Mint Account)
      transaction.add(
        createInitializeMetadataPointerInstruction(
          mintAccount.publicKey,
          userPublicKey,
          mintAccount.publicKey, // The account that holds the metadata (itself)
          TOKEN_2022_PROGRAM_ID
        )
      );

      // Initialize Mint Account
      transaction.add(
        createInitializeMintInstruction(
          mintAccount.publicKey,
          9, // Decimals
          userPublicKey,
          userPublicKey,
          TOKEN_2022_PROGRAM_ID
        )
      );

      const userTokenAccount = await getAssociatedTokenAddress(
        mintAccount.publicKey,  // The Mint Address (your new token)
        userPublicKey,          // The Owner (who receives the tokens)
        false,                  // `allowOwnerOffCurve`: Always `false` for normal wallets
        TOKEN_2022_PROGRAM_ID   
      );

      transaction.add(
        createAssociatedTokenAccountInstruction(
          userPublicKey,        // Payer (User funds creation)
          userTokenAccount,     // Associated Token Account
          userPublicKey,        // Owner of the token account
          mintAccount.publicKey,
          TOKEN_2022_PROGRAM_ID   
        )
      );

      const amountToMint = BigInt(req.body.amount || 1_000_000_000 * 10 ** 9); // Default: 1000 tokens

      console.log(`Minting ${amountToMint} tokens to ${userTokenAccount.toBase58()}`);

      // Add the Mint instruction to send tokens to the user's token account
      transaction.add(
        createMintToInstruction(
          mintAccount.publicKey,  
          userTokenAccount,       // Destination (User's Token Account)
          userPublicKey,          // Mint Authority (who has permission to mint)
          amountToMint,         
          [],                     // Signers (none needed for user wallet)
          TOKEN_2022_PROGRAM_ID  
        )
      );
    

      // Initialize TokenMetadata and store it inside the Mint Account
      transaction.add(
        createInitializeInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          metadata: mintAccount.publicKey,
          updateAuthority: userPublicKey,
          mint: mintAccount.publicKey,
          mintAuthority: userPublicKey,
          name: metaData.name,
          symbol: metaData.symbol,
          uri: metaData.uri,
        })
      );

      // Add a custom metadata field
      transaction.add(
        createUpdateFieldInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          metadata: mintAccount.publicKey,
          updateAuthority: userPublicKey,
          field: metaData.additionalMetadata[0][0], // key
          value: metaData.additionalMetadata[0][1], // value
        })
      );

      if (removeMintAuthority) {
        console.log("Removing Mint Authority...");
        transaction.add(
          createSetAuthorityInstruction(
            mintAccount.publicKey, 
            userPublicKey, // Current Mint Authority
            AuthorityType.MintTokens, // Authority Type: Mint Authority (0)
            null, // New Authority (null = permanently removed)
            [], 
            TOKEN_2022_PROGRAM_ID 
          )
        );
      }

      if (removeFreezeAuthority) {
        console.log("Removing Freeze Authority...");
        transaction.add(
          createSetAuthorityInstruction(
            mintAccount.publicKey,
            userPublicKey, // Current Freeze Authority
            AuthorityType.FreezeAccount, // Authority Type: Freeze Authority (1)
            null, // New Authority (null = permanently removed)
            [], 
            TOKEN_2022_PROGRAM_ID 
          )
        );
      } 

      // Get the latest blockhash and set it on the transaction
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = userPublicKey;

      // Partial signing: The server signs only the Mint Account
      transaction.partialSign(mintAccount);

      // Serialize the transaction and send it to the frontend
      const serializedTransaction = transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false
      });

      await initializeBondingCurve(mintAccount.publicKey, userPublicKey);

      console.log("Transaction prepared and partially signed");

      res.json({
          transaction: serializedTransaction.toString('base64'),
          mintPublicKey: mintAccount.publicKey.toBase58(),
      });

  } catch (error) {
      console.error("Error creating mint:", error);
      res.status(500).send("Failed to create mint");
  }
});

app.post("/initialize", async (req, res) => {
  try {
    const fee = req.body.fee; // Example: 0.01 (1%)
    const [configPDA] = await PublicKey.findProgramAddress(
      [Buffer.from("config")],
      PROGRAM_ID
    );

    const tx = await program.methods.initialize(new anchor.BN(fee * 1e9))
      .accounts({
        dexConfigurationAccount: configPDA,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    res.json({ message: "Contract initialized", tx });
  } catch (error) {
    console.error("Error initializing contract:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/create-pool", async (req, res) => {
  try {
    const tokenMint = new PublicKey(req.body.tokenMint);
    const [poolPDA] = await PublicKey.findProgramAddress(
      [Buffer.from("pool"), tokenMint.toBuffer()],
      PROGRAM_ID
    );

    const tx = await program.methods.createPool()
      .accounts({
        pool: poolPDA,
        tokenMint: tokenMint,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    res.json({ message: "Pool created successfully", tx });
  } catch (error) {
    console.error("Error creating pool:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/buy", async (req, res) => {
  try {
    const amount = req.body.amount;
    const tokenMint = new PublicKey(req.body.tokenMint);
    const userPublicKey = new PublicKey(req.body.walletAddress);

    const [poolPDA] = await PublicKey.findProgramAddress(
      [Buffer.from("pool"), tokenMint.toBuffer()],
      PROGRAM_ID
    );

    const tx = await program.methods.buy(new anchor.BN(amount))
      .accounts({
        pool: poolPDA,
        tokenMint: tokenMint,
        user: userPublicKey,
        tokenProgram: anchor.web3.TOKEN_PROGRAM_ID,
      })
      .rpc();

    res.json({ message: "Buy transaction successful", tx });
  } catch (error) {
    console.error("Error buying tokens:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/sell", async (req, res) => {
  try {
    const amount = req.body.amount;
    const tokenMint = new PublicKey(req.body.tokenMint);
    const userPublicKey = new PublicKey(req.body.walletAddress);
    const bump = req.body.bump; // Get bump from PDA calculation

    const [poolPDA] = await PublicKey.findProgramAddress(
      [Buffer.from("pool"), tokenMint.toBuffer()],
      PROGRAM_ID
    );

    const tx = await program.methods.sell(new anchor.BN(amount), bump)
      .accounts({
        pool: poolPDA,
        tokenMint: tokenMint,
        user: userPublicKey,
        tokenProgram: anchor.web3.TOKEN_PROGRAM_ID,
      })
      .rpc();

    res.json({ message: "Sell transaction successful", tx });
  } catch (error) {
    console.error("Error selling tokens:", error);
    res.status(500).json({ error: error.message });
  }
});


app.post('/provide-liquidity', async (req, res) => {
  try {
    const { walletAddress, mintPublicKey, tokenAmount } = req.body;
    const userPublicKey = new PublicKey(walletAddress);
    const mintPublicKeyObj = new PublicKey(mintPublicKey);
    const transaction = new Transaction();

    console.log(`Providing liquidity: ${tokenAmount} tokens`);

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: userPublicKey, isSigner: true, isWritable: false },
        { pubkey: mintPublicKeyObj, isSigner: false, isWritable: true }
      ],
      programId: PROGRAM_ID,
      data: Buffer.from(
        JSON.stringify({
          action: "provide_liquidity",
          token_amount: tokenAmount
        })
      )
    });

    transaction.add(instruction);
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = userPublicKey;

    const serializedTx = transaction.serialize({ requireAllSignatures: false });
    res.json({ transaction: serializedTx.toString('base64'), status: "Liquidity provision transaction prepared!" });
  } catch (error) {
    console.error("Error providing liquidity:", error);
    res.status(500).send({ error: "Failed to provide liquidity." });
  }
});

async function initializeBondingCurve(mintPublicKey, userPublicKey) {
  try {
    console.log("Initializing Bonding Curve for:", mintPublicKey.toBase58());

    const [poolPDA] = await PublicKey.findProgramAddress(
      [Buffer.from("pool"), mintPublicKey.toBuffer()],
      PROGRAM_ID
    );

    const tx = await program.methods.createPool()
      .accounts({
        pool: poolPDA,
        tokenMint: mintPublicKey,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Bonding Curve Initialized! TX:", tx);
    return tx;
  } catch (error) {
    console.error("Error initializing Bonding Curve:", error);
  }
}

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

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
