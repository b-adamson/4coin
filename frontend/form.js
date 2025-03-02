document.addEventListener('DOMContentLoaded', async () => {
  const { Transaction, Connection, Buffer } = solanaWeb3;

  const urlParams = new URLSearchParams(window.location.search);
  const walletAddress = urlParams.get('wallet');

  if (!walletAddress) {
    alert('Wallet address not found. Please connect your wallet.');
    window.location.href = 'index.html';
    return;
  }

  document.getElementById('wallet-address').value = walletAddress;
  console.log('Wallet address:', walletAddress);

  document.getElementById('metadata-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    console.log('Form submission started');
  
    const name = document.getElementById('name').value;
    const symbol = document.getElementById('symbol').value;
    const description = document.getElementById('description').value || ""; // Optional
    const iconFile = document.getElementById('icon').files[0] || null; // Optional
    const totalSupply = Number(document.getElementById('total-supply').value) || 1000000000; // Default: 1B
    const removeMintAuthority = document.getElementById('remove-mint-authority').checked;
    const removeFreezeAuthority = document.getElementById('remove-freeze-authority').checked;
    
    const statusMessage = document.getElementById('status-message');
    let metadataUri = '';

    // Handle icon upload only if provided
    if (iconFile) {
      statusMessage.textContent = 'Uploading metadata... Please wait.';
      const formData = new FormData();
      formData.append('name', name);
      formData.append('symbol', symbol);
      formData.append('description', description);
      formData.append('icon', iconFile);
      formData.append('walletAddress', walletAddress);

      try {
        const response = await fetch('http://localhost:3000/upload', { method: 'POST', body: formData });

        if (!response.ok) {
          throw new Error(`Upload failed: ${response.statusText}`);
        }
        const result = await response.json();
        if (result.metadataIpfsUri) {
          metadataUri = result.metadataIpfsUri;
          console.log('Metadata uploaded:', metadataUri);
          statusMessage.textContent = 'Metadata uploaded successfully. Creating token...';
        } else {
          throw new Error('Metadata upload succeeded but URI is missing.');
        }
      } catch (error) {
        console.error('Error uploading metadata:', error);
        statusMessage.textContent = 'Error uploading metadata. Please check the console for details.';
        return;
      }
    }

    // Step 2: Call the backend to create the unsigned transaction
    try {
      const tokenResponse = await fetch('http://localhost:3000/create-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          symbol,
          metadataUri,
          walletAddress,
          totalSupply,
          removeMintAuthority,
          removeFreezeAuthority
        })
      });

      const tokenResult = await tokenResponse.json();
      if (!tokenResult.transaction || !tokenResult.mintPublicKey) {
        throw new Error('Failed to create unsigned transaction.');
      }

      console.log(tokenResult);

      // Deserialize the transaction
      const transactionBuffer = Uint8Array.from(atob(tokenResult.transaction), c => c.charCodeAt(0));
      const transaction = Transaction.from(transactionBuffer);

      console.log('Transaction recentBlockhash:', transaction.recentBlockhash);
      console.log('Transaction fee payer:', transaction.feePayer.toBase58());
      console.log('Number of instructions:', transaction.instructions.length);

      transaction.instructions.forEach((instruction, index) => {
        console.log(`Instruction ${index + 1}: Program ID - ${instruction.programId.toBase58()}`);
      });

      // Ask the user to sign the transaction with their wallet (Phantom)
      const signedTransaction = await window.solana.signTransaction(transaction);
      const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
      const txid = await connection.sendRawTransaction(signedTransaction.serialize());
      console.log('Transaction submitted:', txid);

      statusMessage.innerHTML = `
        <p>Token created successfully!</p>
        <p>Mint Address: <a href="https://explorer.solana.com/address/${tokenResult.mintPublicKey}?cluster=devnet" target="_blank">${tokenResult.mintPublicKey}</a></p>
        <p>Transaction ID: <a href="https://explorer.solana.com/tx/${txid}?cluster=devnet" target="_blank">${txid}</a></p>
      `;

    } catch (error) {
      console.error('Error creating token:', error);
      statusMessage.textContent = 'Error creating token. Check console for details.';
    }
  });
});
