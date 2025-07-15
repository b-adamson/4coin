(async () => {
  /* ===== Your existing async code goes here ===== */

  const urlParams     = new URLSearchParams(window.location.search);
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
      status.textContent = "📤  Uploading icon & metadata to IPFS…";
      const fd = new FormData();
      fd.append("name", name);
      fd.append("symbol", symbol);
      fd.append("description", desc);
      fd.append("icon", icon);
      fd.append("walletAddress", walletAddress);

      const res  = await fetch("http://127.0.0.1:4000/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) { status.textContent = "Upload failed: " + json.error; return; }
      metadataUri = json.metadataIpfsUri;
    }

    status.textContent = "⚙️  Building pool transaction…";
    const poolRes = await fetch("http://127.0.0.1:4000/create-pool", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress,
        name,
        symbol,
        metadataUri,
        initialSol: 100000000
      }),
    });
    const { tx: base64Tx, error } = await poolRes.json();
    if (!poolRes.ok || !base64Tx) { status.textContent = error || "Server error."; return; }

    const txBytes     = Uint8Array.from(atob(base64Tx), (c) => c.charCodeAt(0));
    const transaction = solanaWeb3.Transaction.from(txBytes);
    const signedTx    = await provider.signTransaction(transaction);

    const conn = new solanaWeb3.Connection("http://127.0.0.1:8899", "confirmed");
    const sig  = await conn.sendRawTransaction(signedTx.serialize());
    await conn.confirmTransaction(sig, "confirmed");

    status.innerHTML =
      `✅ <b>Token & pool launched!</b><br>` +
      `Tx: <a target="_blank" href="https://explorer.solana.com/tx/${sig}?cluster=custom">${sig}</a>`;
  });

})();
