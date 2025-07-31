let walletAddress;

(async () => {
  walletAddress = await ensureWallet();
  const statusEl = document.getElementById("status");

  document.getElementById("create-coin-btn").addEventListener("click", () => {
    window.location.href = `form.html?wallet=${walletAddress}`;
  });

  async function loadTokens() {
    try {
      const res = await fetch("http://localhost:4000/tokens");
      const tokens = await res.json();

      const listEl = document.getElementById("token-list");
      listEl.innerHTML = "";

      if (tokens.length === 0) {
        listEl.innerHTML = "<p>No tokens created yet.</p>";
        return;
      }

      for (const t of tokens) {
        try {
          const metaRes = await fetch(t.metadataUri);
          const meta = await metaRes.json();

          const card = document.createElement("div");
          card.className = "token-card";
          card.innerHTML = `
            <img src="${meta.image}" alt="${t.name}" />
            <h4>${meta.name}</h4>
            <p>${meta.symbol}</p>
          `;
          card.onclick = () => {
            window.location.href = `token.html?mint=${t.mint}&wallet=${walletAddress}`;
          };

          listEl.appendChild(card);
        } catch (err) {
          console.warn("Metadata fetch failed for", t.mint, err);
        }
      }
    } catch (err) {
      console.error("Failed to load tokens:", err);
      statusEl.textContent = "❌ Failed to load token list.";
    }
  }

  document.getElementById("search-button").addEventListener("click", () => {
    const mint = document.getElementById("search-mint").value.trim();
    if (!mint) {
      statusEl.textContent = "❌ Please enter a mint address.";
      return;
    }
    window.location.href = `token.html?mint=${mint}&wallet=${walletAddress}`;
  });

  loadTokens();
})();
