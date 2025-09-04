export default function initToken(setMint, setWallet) {
  if (typeof window === "undefined") return;

  (async () => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const mint = urlParams.get("mint");
      const walletAddress = urlParams.get("wallet");

      setMint(mint || "");
      setWallet(walletAddress || "");

      const navEl = document.getElementById("nav");
      if (navEl) {
        navEl.innerHTML = `<a href="/home?wallet=${walletAddress || ""}">🏠 Home</a>`;
      }
    } catch (err) {
      console.error("initToken failed:", err);
    }
  })();
}
