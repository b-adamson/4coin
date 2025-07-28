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

    const doInitialBuy = document.getElementById("buy-initial-checkbox").checked;
    const initialSol = parseFloat(document.getElementById("initial-sol").value || "0");

    // Build request payload
    const body = {
      walletAddress,
      mintPubkey,
      mintSecretKey: Array.from(mintKeypair.secretKey),
      name,
      symbol,
      metadataUri,
      amount: 1_000_000_000 * 10 ** 6, // Adjust decimals if needed
    };

    if (doInitialBuy && initialSol > 0) {
      body.initialBuyLamports = Math.floor(initialSol * solanaWeb3.LAMPORTS_PER_SOL);
    }

    // 1️⃣ Call backend
    const prepRes = await fetch("http://127.0.0.1:4000/prepare-mint-and-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const prep = await prepRes.json();

    if (!prepRes.ok || !prep.txBase64) {
      status.textContent = "❌ Preparation failed: " + (prep.error || "No transaction returned");
      return;
    }

    // 2️⃣ Deserialize backend tx
    const rawTx = Uint8Array.from(atob(prep.txBase64), (c) => c.charCodeAt(0));
    const tx = solanaWeb3.VersionedTransaction.deserialize(rawTx);

    // Simulate
    try {
      const simResult = await conn.simulateTransaction(tx);
      console.log("📦 Simulation logs:", simResult.value.logs);
      if (simResult.value.err) {
        console.warn("⚠️ Simulation error:", simResult.value.err);
        status.textContent = "⚠️ Simulation detected an error. Check console logs.";
        return;
      }
    } catch (simErr) {
      console.error("Simulation failed:", simErr);
    }

    // 3️⃣ Sign + Send
    let sig;
    try {
      sig = await window.solana.signAndSendTransaction(tx);
      status.textContent = "🚀 Submitted transaction… waiting for confirmation…";

      await conn.confirmTransaction(sig, "confirmed");

      // Ensure pool ATA exists
      await waitForAccount(conn, new solanaWeb3.PublicKey(prep.poolTokenAccount));

      status.innerHTML = `
        ✅ <b>Token & Pool launched!</b><br>
        Mint Address: <code>${prep.mint}</code><br>
        Transaction: <a target="_blank" href="https://explorer.solana.com/tx/${sig}?cluster=devnet">${sig}</a><br>
        Pool Token Account: <code>${prep.poolTokenAccount}</code><br>
        ${doInitialBuy ? "✅ Initial buy executed in the same transaction" : ""}
      `;
    } catch (error) {
      console.error("❌ Phantom signAndSendTransaction failed:", error);
      status.textContent = "❌ Transaction signing failed: " + error.message;
    }


  });
})();
