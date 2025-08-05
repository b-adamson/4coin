import { ensureWallet } from "@/app/utils"; 
import * as solanaWeb3 from "@solana/web3.js";

export default function initHome(setWallet) {
  if (typeof window === "undefined") return;

  (async () => {
    let walletAddress;
    try {
      walletAddress = await ensureWallet();
      setWallet(walletAddress);
    } catch (err) {
      console.error("❌ Wallet not available:", err);
      return;
    }

    const statusEl = document.getElementById("status");

    // Create coin button
    const createBtn = document.getElementById("create-coin-btn");
    if (createBtn) {
      createBtn.addEventListener("click", () => {
        window.location.href = `/form?wallet=${walletAddress}`;
      });
    }

    // Load tokens from backend
    async function loadTokens() {
      try {
        const res = await fetch("http://localhost:4000/tokens");
        const tokens = await res.json();

        const listEl = document.getElementById("token-list");
        listEl.innerHTML = "";

        if (!Array.isArray(tokens) || tokens.length === 0) {
          listEl.innerHTML = "<p>No tokens created yet.</p>";
          return;
        }

        for (const t of tokens) {
          try {
            const metaRes = await fetch(t.metadataUri);
            const meta = await metaRes.json();

            const card = document.createElement("div");
            card.className = "token-card";
            card.style.cssText = `
              border: 1px solid #ddd;
              border-radius: 8px;
              padding: 1rem;
              text-align: center;
              cursor: pointer;
              transition: transform 0.2s;
            `;

            card.innerHTML = `
              <img src="${meta.image}" alt="${t.name}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;" />
              <h4>${meta.name}</h4>
              <p>${meta.symbol}</p>
            `;

            card.onclick = () => {
              window.location.href = `/token?mint=${t.mint}&wallet=${walletAddress}`;
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

    // Search button
    const searchBtn = document.getElementById("search-button");
    if (searchBtn) {
      searchBtn.addEventListener("click", () => {
        const mint = document.getElementById("search-mint").value.trim();
        if (!mint) {
          statusEl.textContent = "❌ Please enter a mint address.";
          return;
        }
        window.location.href = `/token?mint=${mint}&wallet=${walletAddress}`;
      });
    }

    loadTokens();
  })();
}
