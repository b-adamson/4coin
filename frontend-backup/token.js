const urlParams = new URLSearchParams(window.location.search);
const mint = urlParams.get("mint");
const walletAddress = urlParams.get("wallet");
const statusEl = document.getElementById("status");

const navEl = document.getElementById("nav");
if (navEl) {
  if (walletAddress) {
    navEl.innerHTML = `<a href="home.html?wallet=${walletAddress}">🏠 Home</a>`;
  } else {
    navEl.innerHTML = `<a href="index.html">🏠 Home</a>`;
  }
}

console.log("DEBUG mint:", mint);
console.log("DEBUG walletAddress:", walletAddress);

async function loadToken() {
  statusEl.textContent = "🔍 Loading token info...";
  try {
    const res = await fetch(`http://localhost:4000/token-info?mint=${mint}`);
    const token = await res.json();

    if (!res.ok) {
      statusEl.textContent = "❌ Token not found.";
      return;
    }

    const metaRes = await fetch(token.metadataUri);
    const meta = await metaRes.json();

    document.getElementById("token-name").textContent = meta.name;
    document.getElementById("token-desc").textContent = meta.description || token.symbol;
    document.getElementById("token-icon").src = meta.image;

    document.getElementById("trade-box").style.display = "block";
    statusEl.textContent = "";

    // Add Solana Explorer link for the mint
    const explorerLink = `https://explorer.solana.com/address/${mint}?cluster=devnet`;
    const mintLinkHtml = `
      <p>
        <b>Mint:</b> 
        <a href="${explorerLink}" target="_blank">${mint}</a>
      </p>
    `;
    statusEl.insertAdjacentHTML("beforebegin", mintLinkHtml);

    // BUY handler
    document.getElementById("buy-btn").onclick = async () => {
      const amtSol = parseFloat(document.getElementById("trade-amount").value);
      if (!amtSol || amtSol <= 0) {
        statusEl.textContent = "❌ Enter a valid amount.";
        return;
      }
      statusEl.textContent = `💸 Buying ${amtSol} SOL worth of ${meta.symbol}...`;

      try {
        const buyRes = await fetch("http://localhost:4000/buy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            walletAddress,
            mintPubkey: mint,
            amount: Math.floor(amtSol * solanaWeb3.LAMPORTS_PER_SOL),
          }),
        });

        const buyData = await buyRes.json();
        if (!buyRes.ok || !buyData.txBase64) {
          throw new Error(buyData.error || "Unknown buy error");
        }

        const txBytes = Uint8Array.from(atob(buyData.txBase64), (c) => c.charCodeAt(0));
        const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
        const conn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");
        const sim = await conn.simulateTransaction(tx);
        console.log("Simulation logs:", sim.value.logs);
        if (sim.value.err) {
            throw new Error("Simulation failed: " + JSON.stringify(sim.value.err));
        }

        const sig = await window.solana.signAndSendTransaction(tx);
        
        await conn.confirmTransaction(sig, "confirmed");

        statusEl.innerHTML = `✅ Buy successful!<br>
          <a target="_blank" href="https://explorer.solana.com/tx/${sig}?cluster=devnet">View Transaction</a>`;
      } catch (err) {
        console.error("Buy transaction error:", err);
        statusEl.textContent = "❌ Buy failed: " + (err.message || err.toString());
      }
    };

    // SELL handler
    document.getElementById("sell-btn").onclick = async () => {
      const amtSol = parseFloat(document.getElementById("trade-amount").value);
      if (!amtSol || amtSol <= 0) {
        statusEl.textContent = "❌ Enter a valid amount.";
        return;
      }
      statusEl.textContent = `💸 Selling tokens for ${amtSol} SOL...`;

      try {
        const sellRes = await fetch("http://localhost:4000/sell", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            walletAddress,
            mintPubkey: mint,
            amount: Math.floor(amtSol * solanaWeb3.LAMPORTS_PER_SOL),
          }),
        });

        const sellData = await sellRes.json();
        if (!sellRes.ok || !sellData.txBase64) {
          throw new Error(sellData.error || "Unknown sell error");
        }

        const txBytes = Uint8Array.from(atob(sellData.txBase64), (c) => c.charCodeAt(0));
        const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
const conn = new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed");
        
 const sim = await conn.simulateTransaction(tx);
    console.log("Simulation logs:", sim.value.logs);
        const sig = await window.solana.signAndSendTransaction(tx);
        

       
        await conn.confirmTransaction(sig, "confirmed");

        statusEl.innerHTML = `✅ Sell successful!<br>
          <a target="_blank" href="https://explorer.solana.com/tx/${sig}?cluster=devnet">View Transaction</a>`;
      } catch (err) {
        console.error("Sell transaction error:", err);
        statusEl.textContent = "❌ Sell failed: " + (err.message || err.toString());
      }
    };
  } catch (err) {
    console.error("Error loading token:", err);
    statusEl.textContent = "❌ Failed to load token.";
  }
}

loadToken();
