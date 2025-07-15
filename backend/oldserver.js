app.post('/create-token', async (req, res) => {

  // // const connection = new Connection(clusterApiUrl('devnet'), 'confirmed')

  // try {
  //     const userPublicKey = new PublicKey(req.body.walletAddress);
  //     const mintAccount = Keypair.generate();
  //     const transaction = new Transaction();

  //     const removeMintAuthority = req.body.removeMintAuthority || false;
  //     const removeFreezeAuthority = req.body.removeFreezeAuthority || false;

  //     console.log("User Public Key:", userPublicKey.toBase58());
  //     console.log("Generated Mint Public Key:", mintAccount.publicKey.toBase58());

  //     // Metadata setup
  //     const metaData = {
  //         updateAuthority: userPublicKey,
  //         mint: mintAccount.publicKey,
  //         name: req.body.name || "MyToken",
  //         symbol: req.body.symbol || "MT",
  //         uri: req.body.metadataUri || "https://example.com",
  //         additionalMetadata: [["description", req.body.description || "A Solana token"]],
  //     };

  //     // Calculate space required for the Mint Account
  //     const metadataExtension = 4; // Metadata extension size
  //     const metadataLen = pack(metaData).length;
  //     const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  //     const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataExtension + metadataLen);

  //     // Create Mint Account
  //     transaction.add(
  //       SystemProgram.createAccount({
  //         fromPubkey: userPublicKey,
  //         newAccountPubkey: mintAccount.publicKey,
  //         space: mintLen,
  //         lamports,
  //         programId: TOKEN_2022_PROGRAM_ID
  //       })
  //     );

  //     // Initialize MetadataPointer (stores metadata in Mint Account)
  //     transaction.add(
  //       createInitializeMetadataPointerInstruction(
  //         mintAccount.publicKey,
  //         userPublicKey,
  //         mintAccount.publicKey, // The account that holds the metadata (itself)
  //         TOKEN_2022_PROGRAM_ID
  //       )
  //     );

  //     // Initialize Mint Account
  //     transaction.add(
  //       createInitializeMintInstruction(
  //         mintAccount.publicKey,
  //         9, // Decimals
  //         userPublicKey,
  //         userPublicKey,
  //         TOKEN_2022_PROGRAM_ID
  //       )
  //     );

  //     const userTokenAccount = await getAssociatedTokenAddress(
  //       mintAccount.publicKey,  // The Mint Address (your new token)
  //       userPublicKey,          // The Owner (who receives the tokens)
  //       false,                  // `allowOwnerOffCurve`: Always `false` for normal wallets
  //       TOKEN_2022_PROGRAM_ID   
  //     );

  //     transaction.add(
  //       createAssociatedTokenAccountInstruction(
  //         userPublicKey,        // Payer (User funds creation)
  //         userTokenAccount,     // Associated Token Account
  //         userPublicKey,        // Owner of the token account
  //         mintAccount.publicKey,
  //         TOKEN_2022_PROGRAM_ID   
  //       )
  //     );

  //     const amountToMint = BigInt(req.body.amount || 1_000_000_000 * 10 ** 9); // Default: 1000 tokens

  //     console.log(`Minting ${amountToMint} tokens to ${userTokenAccount.toBase58()}`);

  //     // Add the Mint instruction to send tokens to the user's token account
  //     transaction.add(
  //       createMintToInstruction(
  //         mintAccount.publicKey,  
  //         userTokenAccount,       // Destination (User's Token Account)
  //         userPublicKey,          // Mint Authority (who has permission to mint)
  //         amountToMint,         
  //         [],                     // Signers (none needed for user wallet)
  //         TOKEN_2022_PROGRAM_ID  
  //       )
  //     );
    

  //     // Initialize TokenMetadata and store it inside the Mint Account
  //     transaction.add(
  //       createInitializeInstruction({
  //         programId: TOKEN_2022_PROGRAM_ID,
  //         metadata: mintAccount.publicKey,
  //         updateAuthority: userPublicKey,
  //         mint: mintAccount.publicKey,
  //         mintAuthority: userPublicKey,
  //         name: metaData.name,
  //         symbol: metaData.symbol,
  //         uri: metaData.uri,
  //       })
  //     );

  //     // Add a custom metadata field
  //     transaction.add(
  //       createUpdateFieldInstruction({
  //         programId: TOKEN_2022_PROGRAM_ID,
  //         metadata: mintAccount.publicKey,
  //         updateAuthority: userPublicKey,
  //         field: metaData.additionalMetadata[0][0], // key
  //         value: metaData.additionalMetadata[0][1], // value
  //       })
  //     );

  //     if (removeMintAuthority) {
  //       console.log("Removing Mint Authority...");
  //       transaction.add(
  //         createSetAuthorityInstruction(
  //           mintAccount.publicKey, 
  //           userPublicKey, // Current Mint Authority
  //           AuthorityType.MintTokens, // Authority Type: Mint Authority (0)
  //           null, // New Authority (null = permanently removed)
  //           [], 
  //           TOKEN_2022_PROGRAM_ID 
  //         )
  //       );
  //     }

  //     if (removeFreezeAuthority) {
  //       console.log("Removing Freeze Authority...");
  //       transaction.add(
  //         createSetAuthorityInstruction(
  //           mintAccount.publicKey,
  //           userPublicKey, // Current Freeze Authority
  //           AuthorityType.FreezeAccount, // Authority Type: Freeze Authority (1)
  //           null, // New Authority (null = permanently removed)
  //           [], 
  //           TOKEN_2022_PROGRAM_ID 
  //         )
  //       );
  //     } 

  //     // Get the latest blockhash and set it on the transaction
  //     const { blockhash } = await connection.getLatestBlockhash();
  //     transaction.recentBlockhash = blockhash;
  //     transaction.feePayer = userPublicKey;

  //     // Partial signing: The server signs only the Mint Account
  //     transaction.partialSign(mintAccount);

  //     // Serialize the transaction and send it to the frontend
  //     const serializedTransaction = transaction.serialize({
  //         requireAllSignatures: false,
  //         verifySignatures: false
  //     });

  //     await initializeBondingCurve(mintAccount.publicKey, userPublicKey);

  //     console.log("Transaction prepared and partially signed");

  //     res.json({
  //         transaction: serializedTransaction.toString('base64'),
  //         mintPublicKey: mintAccount.publicKey.toBase58(),
  //     });

  // } catch (error) {
  //     console.error("Error creating mint:", error);
  //     res.status(500).send("Failed to create mint");
  // }






});
