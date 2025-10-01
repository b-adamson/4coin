"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";

import {
  ConnectionProvider,
  WalletProvider,
  useWallet as useAdapterWallet,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { BackpackWalletAdapter } from "@solana/wallet-adapter-backpack";

// ✅ Wallet context
export const WalletContext = createContext({ wallet: "", setWallet: () => {} });
export const useWallet = () => useContext(WalletContext);

// ✅ Dark mode context
export const DarkModeContext = createContext({ dark: false, setDark: () => {} });
export const useDarkMode = () => useContext(DarkModeContext);

const Header = dynamic(() => import("@/app/components/Header"), { ssr: false });
const SiteBanner = dynamic(() => import("@/app/components/SiteBanner"), { ssr: false });

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
   const pathname = usePathname();
   const endpoint = "https://api.devnet.solana.com";
   const wallets = useMemo(
     () => [new PhantomWalletAdapter(), new BackpackWalletAdapter(), new SolflareWalletAdapter()],
     []
   );

  const [dark, setDark] = useState(() => {
      if (typeof window === "undefined") return false;
      const ls = localStorage.getItem("theme");
      if (ls === "dark") return true;
      if (ls === "light") return false;
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch {}
  }, [dark]);

  // if user hasn't explicitly chosen, follow OS changes live
  useEffect(() => {
    const ls = typeof window !== "undefined" ? localStorage.getItem("theme") : null;
    if (ls) return; // user has an explicit preference; don't override
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const handler = (e) => setDark(e.matches);
    mq?.addEventListener?.("change", handler);
    return () => mq?.removeEventListener?.("change", handler);
  }, []);

   return (
     <ConnectionProvider endpoint={endpoint}>
       <WalletProvider wallets={wallets} autoConnect>
         <WalletModalProvider>
           <WalletBridge>
             <DarkModeContext.Provider value={{ dark, setDark }}>
               {pathname === "/" && <SiteBanner />}
               <Header />
               {children}
             </DarkModeContext.Provider>
           </WalletBridge>
         </WalletModalProvider>
       </WalletProvider>
     </ConnectionProvider>
   );
 }
