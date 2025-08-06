export default function initToken(setMint, setWallet) {
  if (typeof window === "undefined") return;

  (async () => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const mint = urlParams.get("mint");
      const walletAddress = urlParams.get("wallet");

      setMint(mint || "");
      setWallet(walletAddress || "");

      // Update nav link
      const navEl = document.getElementById("nav");
      if (navEl) {
        if (walletAddress) {
          navEl.innerHTML = `<a href="/home?wallet=${walletAddress}">🏠 Home</a>`;
        } else {
          navEl.innerHTML = `<a href="/">🏠 Home</a>`;
        }
      }
    } catch (err) {
      console.error("initToken failed:", err);
    }
  })();
}
