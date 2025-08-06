// script.js
export default async function initForm(setWallet) {
  if (typeof window === "undefined") return;

  const urlParams = new URLSearchParams(window.location.search);
  const walletAddress = urlParams.get("wallet");

  if (!walletAddress) {
    alert("Wallet address not found. Please connect your wallet first.");
    window.location.href = "/";
    return;
  }

  const provider = window.solana;
  if (!provider?.isPhantom) {
    alert("Please open this page in a browser with the Phantom wallet extension.");
    window.location.href = "/";
    return;
  }

  try {
    await provider.connect({ onlyIfTrusted: true });
    setWallet(walletAddress);
  } catch (err) {
    console.error("Wallet connect failed:", err);
    window.location.href = "/";
  }
}
