// src/app/AppShell.jsx
"use client";

import { createContext, useContext, useMemo } from "react";
import dynamic from "next/dynamic";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css"; // you can override later
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
// Backpack adapter comes from its own package:
import { BackpackWalletAdapter } from "@solana/wallet-adapter-backpack";
import { useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";

const Header = dynamic(() => import("@/app/components/Header"), { ssr: false });

// ---- Compatibility context (wallet string) ----
export const WalletContext = createContext({ wallet: "", setWallet: () => {} });
export const useWallet = () => useContext(WalletContext);

// A tiny bridge that turns adapter state into your old shape.
function WalletBridge({ children }) {
  const { publicKey } = useAdapterWallet();
  const walletStr = publicKey?.toBase58() ?? "";
  return (
    <WalletContext.Provider value={{ wallet: walletStr, setWallet: () => {} }}>
      {children}
    </WalletContext.Provider>
  );
}

export default function AppShell({ children }) {
  const endpoint = "https://api.devnet.solana.com";
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new BackpackWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <WalletBridge>
            <Header />
            {children}
          </WalletBridge>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
