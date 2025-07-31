// utils.js
async function ensureWallet() {
  let walletAddress = null;

  if (window.solana?.isPhantom) {
    try {
      const resp = await window.solana.connect({ onlyIfTrusted: true });
      walletAddress = resp.publicKey.toBase58();
    } catch (e) {
      console.warn("Wallet not connected, redirecting...");
      window.location.href = "index.html";
    }
  } else {
    window.location.href = "index.html";
  }

  if (!walletAddress) {
    window.location.href = "index.html";
  }

  // Update Home link
  const homeLink = document.getElementById("home-link");
  if (homeLink) {
    homeLink.href = `home.html`;
  }

  return walletAddress;
}
