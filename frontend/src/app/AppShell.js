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

   // Dark mode state lives here
   const [dark, setDark] = useState(false);
   useEffect(() => {
     document.documentElement.classList.toggle("dark", dark);
   }, [dark]);

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
