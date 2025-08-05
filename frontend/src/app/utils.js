export async function ensureWallet() {
  let walletAddress = null;

  if (window.solana?.isPhantom) {
    try {
      const resp = await window.solana.connect({ onlyIfTrusted: true });
      walletAddress = resp.publicKey.toBase58();
    } catch (e) {
      console.warn("Wallet not connected, redirecting...");
      window.location.href = "/";
      return null;
    }
  } else {
    window.location.href = "/";
    return null;
  }

  if (!walletAddress) {
    window.location.href = "/";
    return null;
  }

  // Update Home link (Next.js path instead of .html file)
  const homeLink = document.getElementById("home-link");
  if (homeLink) {
    homeLink.href = `/home?wallet=${walletAddress}`;
  }

  return walletAddress;
}

export async function disconnectWallet(router, setWallet) {
  try {
    if (window.solana?.isPhantom) {
      await window.solana.disconnect();
    }
    setWallet("");
    router.push("/"); // back to index
  } catch (err) {
    console.error("Error disconnecting wallet:", err);
  }
}
