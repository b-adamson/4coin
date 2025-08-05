"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function IndexPage() {
  const [connecting, setConnecting] = useState(false);
  const router = useRouter();

  const handleConnect = async (e) => {
    e.preventDefault();
    if (typeof window === "undefined") return;

    if (window.solana && window.solana.isPhantom) {
      try {
        setConnecting(true);
        const response = await window.solana.connect();
        const walletAddress = response.publicKey.toString();
        console.log("Wallet connected:", walletAddress);

        router.push(`/home?wallet=${walletAddress}`);
      } catch (error) {
        console.error("Wallet connection failed:", error);
        setConnecting(false);
      }
    } else {
      alert("Please install Phantom Wallet from https://phantom.app");
    }
  };

  return (
    <main style={{ textAlign: "center", marginTop: "5rem" }}>
      <h1>Connect Your Wallet</h1>
      <a
        href="#"
        onClick={handleConnect}
        style={{
          display: "inline-block",
          color: "#0000ee",
          textDecoration: "underline",
          fontSize: "18px", // larger text
          fontWeight: "bold", // bold text
          cursor: "pointer",
        }}
      >
        [{connecting ? "Connecting..." : "Connect Wallet"}]
      </a>
    </main>
  );
}
