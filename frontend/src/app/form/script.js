// script.js
export default async function initForm(setWallet) {
  if (typeof window === "undefined") return;

  const provider = window.solana;
  if (!provider?.isPhantom) {
    alert("Please install the Phantom wallet extension.");
    return;
  }

  try {
    // silent restore if already approved
    const resp = await provider.connect({ onlyIfTrusted: true });
    if (resp?.publicKey) {
      setWallet(resp.publicKey.toBase58());
    }
  } catch (err) {
    console.warn("Phantom silent connect failed:", err);
    // don’t redirect — let Header’s connect button handle it
  }
}
