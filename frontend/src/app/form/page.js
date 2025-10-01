"use client";

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import * as solanaWeb3 from "@solana/web3.js";
import { buildLUTModel } from "@/app/utils";

import { useWallet as useWalletFromShell } from "@/app/AppShell";
import { useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";
import { useDarkMode } from "@/app/AppShell";

/* =========================
   Validation / Sanitizers
   ========================= */
const NAME_REGEX = /^[A-Za-z0-9 ._\-]{1,32}$/;
const SYMBOL_REGEX = /^[A-Z0-9]{1,10}$/;
const DESC_MAX_LEN = 500;
const TRIP_NAME_REGEX = /^[A-Za-z0-9 ._\-]{1,24}$/;

const URI_REGEX = /^(https?:\/\/|ipfs:\/\/|ar:\/\/).+/i;
const MAX_ICON_BYTES = 512 * 1024;
const ALLOWED_ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];

// Use env if you can (recommended): process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "YOUR_TURNSTILE_SITE_KEY";

/** Remove control chars; normalize spaces; NFC normalize. */
function cleanText(s) {
  if (typeof s !== "string") return "";
  const nfc = s.normalize?.("NFC") ?? s;
  const noCtrl = nfc.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return noCtrl.replace(/\s+/g, " ").trim();
}

function spotPriceSOLPerToken(modelObj, x0) {
  if (!modelObj || !Number.isFinite(x0)) return null;
  const DX = 0.01;
  const x1 = Math.min(modelObj.X_MAX, x0 + DX);
  if (x1 <= x0) return null;
  const tokens = modelObj.tokens_between(x0, x1);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return (x1 - x0) / tokens;
}

export default function FormPage() {
  const { wallet } = useWalletFromShell();
  const { publicKey, connected, sendTransaction, signTransaction } = useAdapterWallet();

  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Dev must not be anonymous; require trip name
  const [tripCode, setTripCode] = useState("");
  const [tripName, setTripName] = useState("");

  const [doInitialBuy, setDoInitialBuy] = useState(false);
  const [cfToken, setCfToken] = useState("");

  const { dark } = useDarkMode();

  const cfRef = useRef(null);
  const cfWidgetIdRef = useRef(null);

  // Use CSS variables so it stays in sync with your theme file
  const inputStyle = {
    width: "100%",
    padding: "0.5rem",
    borderRadius: 6,
    border: "1px solid var(--input-border)",
    background: "var(--input-bg)",
    color: "var(--fg)",
  };

  const hintStyle = { color: "var(--meta)" };

  const conn = useMemo(
    () => new solanaWeb3.Connection("https://api.devnet.solana.com", "confirmed"),
    []
  );

  // Render (or re-render) Turnstile
  const renderCaptcha = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!cfRef.current || !window?.turnstile) return;
    try {
      if (cfWidgetIdRef.current != null) {
        window.turnstile.remove(cfWidgetIdRef.current);
      }
    } catch {}
    cfRef.current.innerHTML = "";
    cfWidgetIdRef.current = window.turnstile.render(cfRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token) => setCfToken(token || ""),
      theme: dark ? "dark" : "light",
      appearance: "always",
    });
  }, [dark]);

  // Load Turnstile script once; (re-)render widget when ready and on theme flip
  useEffect(() => {
    if (typeof window === "undefined") return;

    function ensureScript(cb) {
      const id = "cf-turnstile-script";
      const existing = document.getElementById(id);
      if (existing) {
        if (window.turnstile) cb();
        else existing.addEventListener("load", cb, { once: true });
        return;
      }
      const s = document.createElement("script");
      s.id = id;
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      s.async = true;
      s.defer = true;
      s.addEventListener("load", cb, { once: true });
      document.head.appendChild(s);
    }

    ensureScript(() => {
      if (!window.turnstile) return;
      renderCaptcha();
    });

    return () => {
      try {
        if (cfWidgetIdRef.current != null) {
          window.turnstile?.remove?.(cfWidgetIdRef.current);
        }
      } catch {}
      cfWidgetIdRef.current = null;
    };
  }, [renderCaptcha]);

  // Trip preview
  useEffect(() => {
    let abort = false;
    (async () => {
      if (!wallet) return;
      try {
        const res = await fetch(`http://localhost:4000/tripcode?wallet=${wallet}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!abort) setTripCode(data.tripCode || "");
      } catch {}
    })();
    return () => {
      abort = true;
    };
  }, [wallet]);

  const setError = (msg) => {
    setStatus(`❌ ${msg}`);
    setSubmitting(false);
    setCfToken("");
    try {
      renderCaptcha();
    } catch {}
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setStatus("");
    setSubmitting(true);

    if (!connected || !publicKey || !wallet) return setError("Please connect your wallet first.");
    if (!TURNSTILE_SITE_KEY || TURNSTILE_SITE_KEY === "YOUR_TURNSTILE_SITE_KEY")
      return setError("Captcha not configured: set NEXT_PUBLIC_TURNSTILE_SITE_KEY.");
    if (!cfToken) return setError("Please complete the captcha.");

    // raw values
    const rawName = e.target.name.value;
    const rawSymbol = e.target.symbol.value;
    const rawDesc = e.target.description.value;
    const iconFile = e.target.icon.files[0] || null;
    const rawInitialSol = doInitialBuy ? e.target["initial-sol"].value : "";

    // sanitize
    const name = cleanText(rawName);
    const symbol = cleanText(rawSymbol).toUpperCase();
    const description = cleanText(rawDesc);
    const tripNameClean = cleanText(tripName);

    // numeric
    const initialSol = doInitialBuy ? parseFloat(String(rawInitialSol || "0")) : 0;
    const initialBuyLamports =
      doInitialBuy && Number.isFinite(initialSol) && initialSol > 0
        ? Math.round(initialSol * solanaWeb3.LAMPORTS_PER_SOL)
        : 0;

    /* ======= VALIDATION ======= */
    if (!name || !symbol) return setError("Name and Symbol are required.");
    if (!NAME_REGEX.test(name)) return setError("Name must be 1–32 chars: letters, numbers, spaces, . _ -");
    if (!SYMBOL_REGEX.test(symbol)) return setError("Symbol must be 1–10 chars: UPPERCASE letters and digits only.");
    if (description.length > DESC_MAX_LEN) return setError(`Description too long (max ${DESC_MAX_LEN} chars).`);
    // Creator must not be anonymous
    if (!tripNameClean) return setError("You must enter a display name.");
    if (!TRIP_NAME_REGEX.test(tripNameClean)) {
      return setError("Trip name: 1–24 chars using letters, numbers, spaces, . _ -");
    }
    if (iconFile) {
      if (!ALLOWED_ICON_TYPES.includes(iconFile.type)) return setError("Icon must be PNG/JPG/WEBP/GIF/SVG.");
      if (iconFile.size > MAX_ICON_BYTES) return setError("Icon too large (max 512KB).");
    }
    if (doInitialBuy) {
      if (!Number.isFinite(initialSol) || initialSol <= 0) return setError("Initial SOL must be positive.");
      if (initialSol < 0.00001) return setError("Initial SOL is too small.");
      if (initialSol > 50) return setError("Initial SOL is too large for devnet.");
    }

    try {
      setStatus("📤 Uploading icon & metadata");

      // /upload — include cfToken in multipart body (server validates token from headers/body as needed)
      const fd = new FormData();
      fd.append("name", name);
      fd.append("symbol", symbol);
      fd.append("description", description);
      if (iconFile) fd.append("icon", iconFile);
      fd.append("walletAddress", wallet);

      const uploadRes = await fetch("http://localhost:4000/upload", { method: "POST", body: fd });
      const uploadData = await uploadRes.json().catch(() => ({}));
      if (!uploadRes.ok || !uploadData?.metadataIpfsUri) {
        return setError("Upload failed: " + (uploadData?.error || "no metadata URI"));
      }

      const metadataUri = String(uploadData.metadataIpfsUri);
      if (!URI_REGEX.test(metadataUri) || metadataUri.length > 300) {
        return setError("Invalid metadata URI (must be http(s)/ipfs/ar and < 300 chars).");
      }

      // create mint
      const mintKeypair = solanaWeb3.Keypair.generate();

      setStatus("⚙️ Preparing mint + pool transaction…");

      // /prepare-mint-and-pool — include cfToken in JSON body
      const prepRes = await fetch("http://127.0.0.1:4000/prepare-mint-and-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: wallet,
          mintPubkey: mintKeypair.publicKey.toBase58(),
          mintSecretKey: Array.from(mintKeypair.secretKey),
          name,
          symbol,
          metadataUri,
          amount: 1_000_000_000 * 10 ** 6,
          cfToken,
          initialBuyLamports,
        }),
      });

      const prep = await prepRes.json().catch(() => ({}));
      if (!prepRes.ok || !prep?.txBase64) {
        return setError("Preparation failed: " + (prep?.error || "No transaction returned"));
      }

      // simulate (best effort)
      try {
        const rawTx = Uint8Array.from(atob(prep.txBase64), (c) => c.charCodeAt(0));
        const tx = solanaWeb3.VersionedTransaction.deserialize(rawTx);
        const simulation = await conn.simulateTransaction(tx);
        console.log("simulate:", simulation);
      } catch {}

      // === wallet-agnostic sign & send (adapter) ===
      let sigstr = "";
      try {
        const rawTx = Uint8Array.from(atob(prep.txBase64), (c) => c.charCodeAt(0));
        const tx = solanaWeb3.VersionedTransaction.deserialize(rawTx);

        // Preferred: wallet signs, your RPC sends
        try {
          sigstr = await sendTransaction(tx, conn, { preflightCommitment: "confirmed" });
        } catch (primaryErr) {
          // Fallback: sign locally, then send raw
          if (typeof signTransaction !== "function") throw primaryErr;
          const signed = await signTransaction(tx);
          const wire = signed.serialize();
          sigstr = await conn.sendRawTransaction(wire, {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
        }
      } catch (err) {
        return setError("Transaction signing failed: " + (err?.message || String(err)));
      }

      setStatus("🚀 Submitted transaction… waiting for confirmation…");
      await conn.confirmTransaction(sigstr, "confirmed");

      // save token
      const saveRes = await fetch("http://127.0.0.1:4000/save-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mint: prep.mint,
          pool: prep.pool,
          poolTokenAccount: prep.poolTokenAccount,
          name,
          symbol,
          metadataUri,
          sig: sigstr,
          creator: wallet,
          tripName: tripNameClean,
          tripCode: tripCode,
        }),
      });
      const saveJson = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok) throw new Error(saveJson?.error || "save-token failed");

      // optional initial buy (unchanged preview math)
      if (initialBuyLamports > 0) {
        const model = await buildLUTModel(9);
        const budgetSOL = initialBuyLamports / solanaWeb3.LAMPORTS_PER_SOL;
        const tokensWhole = model.tokens_between(0, budgetSOL);
        const tokenAmountBase = Math.round(tokensWhole * 10 ** 9);
        console.log("Initial buy tokens (base units):", tokenAmountBase);

        await fetch("http://localhost:4000/update-holdings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sig: sigstr,
            wallet, // attribute to creator
            mint: prep.mint,
            type: "buy",
            tokenAmountBase,
            solLamports: initialBuyLamports,
            lbOptIn: true,
            lbDisplayName: tripNameClean,
            priceSOLPerToken: (() => {
              const x0 = 0;
              const p = spotPriceSOLPerToken(model, x0);
              return Number.isFinite(p) ? p : null;
            })(),
          }),
        }).catch(() => {});
      }

      setStatus(
        `✅ <b>Token launched!</b><br><br>
        <a class="chan-link" href="/token?mint=${prep.mint}&wallet=${wallet}" target="_blank" style="font-size:18px;">${name}</a><br>`
      );
    } catch (err) {
      console.error("Form submission error:", err);
      setError("An unexpected error occurred while creating the token.");
    } finally {
      setSubmitting(false);
      setCfToken("");
      try {
        renderCaptcha();
      } catch {}
    }
  };

  return (
    <main style={{ maxWidth: "600px", margin: "0 auto", padding: "0" }}>
      <h1 style={{ marginBottom: "2rem", textAlign: "center" }}>Create Token</h1>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <input type="hidden" name="wallet-address" value={wallet || ""} />

        <div>
          <label htmlFor="name">Name</label>
          <input type="text" name="name" placeholder="Token name" required style={inputStyle} maxLength={32} />
          <small style={hintStyle}>1–32 chars: letters, numbers, spaces, . _ -</small>
        </div>

        <div>
          <label htmlFor="symbol">Symbol</label>
          <input type="text" name="symbol" placeholder="TOKEN" required style={inputStyle} maxLength={10} />
          <small style={hintStyle}>1–10 chars: UPPERCASE letters &amp; digits</small>
        </div>

        <div>
          <label htmlFor="description">Description (optional)</label>
          <textarea
            name="description"
            placeholder="Token description"
            style={{ ...inputStyle, minHeight: "80px" }}
            maxLength={DESC_MAX_LEN}
          />
          <small style={hintStyle}>Up to {DESC_MAX_LEN} characters (off-chain via URI)</small>
        </div>

        <div>
          <label htmlFor="icon">Icon</label>
          <input
            type="file"
            name="icon"
            accept={ALLOWED_ICON_TYPES.join(",")}
            style={{ ...inputStyle, padding: "0.35rem" }}
          />
          <small style={hintStyle}> PNG/JPG/WEBP/GIF/SVG, ≤ 512KB</small>
        </div>

        {/* Tripcode Section (creator cannot be anonymous) */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <input
            type="text"
            value={tripCode ? `!!${tripCode}` : ""}
            readOnly
            style={{ ...inputStyle, width: 140, fontFamily: "monospace" }}
          />
          <input
            type="text"
            value={tripName}
            onChange={(e) => setTripName(e.target.value)}
            placeholder="Enter trip name…"
            required
            maxLength={24}
            style={{ ...inputStyle, flex: 1 }}
          />
        </div>

        {/* Do Initial Buy */}
        <div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span>Do Initial Buy?</span>
            <input
              type="checkbox"
              checked={doInitialBuy}
              onChange={(e) => setDoInitialBuy(e.target.checked)}
              style={{ margin: 0 }}
            />
          </label>

          {doInitialBuy && (
            <input
              type="number"
              name="initial-sol"
              placeholder="SOL amount (e.g. 0.005)"
              step="any"
              max="50"
              required
              style={{ ...inputStyle, marginTop: "0.5rem" }}
            />
          )}
        </div>

        {/* Captcha */}
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div ref={cfRef} id="cf-turnstile" style={{ minHeight: 70 }} aria-label="Captcha" />
        </div>

        <div style={{ textAlign: "center", marginTop: "1rem" }}>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => !submitting && e.currentTarget.closest("form").requestSubmit()}
            onKeyDown={(e) => {
              if (!submitting && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                e.currentTarget.closest("form").requestSubmit();
              }
            }}
            className="chan-link"
            style={{
              fontSize: "18px",
              fontWeight: "bold",
              cursor: submitting ? "not-allowed" : "pointer",
              color: submitting ? "#666" : undefined,
              textDecoration: "underline",
            }}
          >
            {submitting ? "[Creating…]" : "[Create Token]"}
          </span>
        </div>
      </form>

      <p
        id="status-message"
        style={{ marginTop: "1.5rem", textAlign: "center", color: "var(--fg)" }}
        dangerouslySetInnerHTML={{ __html: status }}
      />
    </main>
  );
}
