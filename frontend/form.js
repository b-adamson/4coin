(async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const walletAddress = urlParams.get("wallet");

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

    const name   = document.getElementById("name").value.trim();
    const symbol = document.getElementById("symbol").value.trim();
    const desc   = document.getElementById("description").value.trim();
    const icon   = document.getElementById("icon").files[0] || null;

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

    const conn = new solanaWeb3.Connection("http://127.0.0.1:8899", "confirmed");

    // 1️⃣ Generate a new mint keypair for this token
    const mintKeypair = solanaWeb3.Keypair.generate();
    const mintPubkey = mintKeypair.publicKey.toBase58();
    localStorage.setItem("mintSecret", JSON.stringify(Array.from(mintKeypair.secretKey)));

    // 2️⃣ Ask backend to prepare mint+pool setup
    status.textContent = "⚙️ Preparing mint + pool transaction…";

    const prepRes = await fetch("http://localhost:4000/prepare-mint-and-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress,
        mintPubkey,
      }),
    });

    const prep = await prepRes.json();
    if (!prepRes.ok || !prep.tx) {
      status.textContent = "❌ Preparation failed: " + prep.error;
      return;
    }

    const tx = solanaWeb3.Transaction.from(
      Uint8Array.from(atob(prep.tx), (c) => c.charCodeAt(0))
    );

    tx.partialSign(mintKeypair);

    const simulation = await conn.simulateTransaction(tx);
    console.log("🪵 Simulation logs:", simulation.value?.logs);
    console.log("🛑 Simulation error:", simulation.value?.err);

    const [signedTx] = await provider.signAllTransactions([tx]);
    const sig1 = await conn.sendRawTransaction(signedTx.serialize());
    await conn.confirmTransaction(sig1, "confirmed");

    // 3️⃣ Mint into the pool token account (optional TX2)
    status.textContent = "💸 Minting tokens into pool…";

    const mintToRes = await fetch("http://localhost:4000/mint-to-pool", {
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
    if (!mintToRes.ok || !mintTo.tx) {
      status.textContent = "❌ Minting failed: " + mintTo.error;
      return;
    }

    const tx2 = solanaWeb3.Transaction.from(
      Uint8Array.from(atob(mintTo.tx), (c) => c.charCodeAt(0))
    );
    const signedTx2 = await provider.signTransaction(tx2);
    const sig2 = await conn.sendRawTransaction(signedTx2.serialize());
    await conn.confirmTransaction(sig2, "confirmed");

    // 🎉 Done!
    status.innerHTML =
    `✅ <b>Token & Pool launched!</b><br>` +
    `Mint Address: <code>${prep.mint}</code><br>` +
    `Mint Tx: <a target="_blank" href="https://explorer.solana.com/tx/${sig1}?cluster=custom">${sig1}</a><br>` +
    `MintTo Tx: <a target="_blank" href="https://explorer.solana.com/tx/${sig2}?cluster=custom">${sig2}</a><br>` +
    `Pool Token Account: <code>${prep.poolTokenAccount}</code>`;

  });
})();
