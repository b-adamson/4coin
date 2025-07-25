(async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const walletAddress = urlParams.get("wallet");

  function waitForAccount(connection, pubkey, maxRetries = 20, delayMs = 1000) {
    return new Promise(async (resolve, reject) => {
      for (let i = 0; i < maxRetries; i++) {
        const info = await connection.getAccountInfo(pubkey);
        if (info !== null) return resolve(info);
        await new Promise((r) => setTimeout(r, delayMs));
      }
      reject(new Error("Account not found after waiting"));
    });
  }

  function decodeBase64VersionedTx(base64) {
    const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

    const sigCount = raw[0]; // only works for <= 127 sigs (valid for Phantom etc.)
    const sigs = [];

    let offset = 1;
    for (let i = 0; i < sigCount; i++) {
      sigs.push(raw.slice(offset, offset + 64));
      offset += 64;
    }

    const msgBytes = raw.slice(offset);
    const msg = solanaWeb3.Message.from(msgBytes);

    return new solanaWeb3.VersionedTransaction({
      message: msg,
      signatures: sigs,
    });
  }

  function decodeBase64Tx(base64) {
    const rawBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return new solanaWeb3.VersionedTransaction(rawBytes);
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (!walletAddress) {
    alert("Wallet address not found. Please connect your wallet first.");
    window.location.href = "index.html";
    throw new Error("No wallet in query param");
  }

  const provider = window.solana;
  if (!provider?.isPhantom) {
    alert("Please open this page in a browser with the Phantom wallet extension.");
    window.location.href = "index.html";
    throw new Error("Phantom not detected");
  }

  await provider.connect({ onlyIfTrusted: true });

  console.log("🔑 Wallet:", walletAddress);
  document.getElementById("wallet-address").value = walletAddress;

  document.getElementById("metadata-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = document.getElementById("status-message");
    status.textContent = "";

    const name = document.getElementById("name").value.trim();
    const symbol = document.getElementById("symbol").value.trim();
    const desc = document.getElementById("description").value.trim();
    const icon = document.getElementById("icon").files[0] || null;

    let metadataUri = "";

    if (icon) {
      status.textContent = "📤 Uploading icon & metadata to IPFS…";

      const fd = new FormData();
      fd.append("name", name);
      fd.append("symbol", symbol);
      fd.append("description", desc);
      fd.append("icon", icon);
      fd.append("walletAddress", walletAddress);

      const res = await fetch("http://localhost:4000/upload", {
        method: "POST",
        body: fd,
      });

      const json = await res.json();

      if (!res.ok) {
        status.textContent = "❌ Upload failed: " + json.error;
        return;
      }

      metadataUri = json.metadataIpfsUri;
    }

    const conn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");

    // 1️⃣ Generate a new mint keypair for this token
    const mintKeypair = solanaWeb3.Keypair.generate();
    const mintPubkey = mintKeypair.publicKey.toBase58();

    localStorage.setItem("mintSecret", JSON.stringify(Array.from(mintKeypair.secretKey)));

    // 2️⃣ Ask backend to prepare mint+pool setup
    status.textContent = "⚙️ Preparing mint + pool transaction…";

    const prepRes = await fetch("http://127.0.0.1:4000/prepare-mint-and-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress,
        mintPubkey,
        mintSecretKey: Array.from(mintKeypair.secretKey),
        name,
        symbol,
        metadataUri,
        amount: 1_000_000_000 * 10 ** 6,
      }),
    });

    const prep = await prepRes.json();

    if (!prepRes.ok || !prep.txBase64) {
      status.textContent = "❌ Preparation failed: " + (prep.error || "No transaction returned");
      return;
    }

    // Deserialize backend transaction
    const rawTx = Uint8Array.from(atob(prep.txBase64), (c) => c.charCodeAt(0));
    const tx = solanaWeb3.VersionedTransaction.deserialize(rawTx);

    // DO NOT update blockhash here — use backend's blockhash to keep signatures valid
    let sig1;
    try {
      sig1 = await window.solana.signAndSendTransaction(tx);
      console.log("🚀 Signed and sent:", sig1);

      await conn.confirmTransaction(sig1, "confirmed");

      await waitForAccount(conn, new solanaWeb3.PublicKey(prep.poolTokenAccount));

      const parsedInfo = await conn.getParsedAccountInfo(new solanaWeb3.PublicKey(prep.poolTokenAccount));
      const tokenAccountData = parsedInfo.value.data;
      const actualMint = tokenAccountData.parsed.info.mint;
    } catch (error) {
      console.error("❌ Phantom signAndSendTransaction failed:", error);
      status.textContent = "❌ Transaction signing failed: " + error.message;
      return;
    }

    // 3️⃣ Mint into the pool token account 
    status.textContent = "💸 Minting tokens into pool…";

    const mintToRes = await fetch("http://127.0.0.1:4000/mint-to-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress,
        mintPubkey,
        poolTokenAccount: prep.poolTokenAccount,
        amount: 1_000_000_000 * 10 ** 6,
      }),
    });

    const mintTo = await mintToRes.json();

    const tx2 = solanaWeb3.Transaction.from(
      Uint8Array.from(atob(mintTo.tx), (c) => c.charCodeAt(0))
    );

    const signedTx2 = await window.solana.signTransaction(tx2);
    const sig2 = await conn.sendRawTransaction(signedTx2.serialize());
    await conn.confirmTransaction(sig2, "confirmed");

    // 🎉 Done!
    status.innerHTML = `
      ✅ <b>Token & Pool launched!</b><br>
      Mint Address: <code>${prep.mint}</code><br>
      Mint Tx: <a target="_blank" href="https://explorer.solana.com/tx/${sig1}?cluster=custom">${sig1}</a><br>
      MintTo Tx: <a target="_blank" href="https://explorer.solana.com/tx/${sig2}?cluster=custom">${sig2}</a><br>
      Pool Token Account: <code>${prep.poolTokenAccount}</code>
    `;
  });
})();
