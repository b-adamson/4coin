"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ensureWallet, connectWallet, disconnectWallet } from "@/app/utils";

const Header = dynamic(() => import("@/app/components/Header"), { ssr: false });

// 👇 context export
export const WalletContext = createContext({ wallet: "", setWallet: () => {} });
export const useWallet = () => useContext(WalletContext);

export default function AppShell({ children }) {
  const [wallet, setWallet] = useState("");
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("__skip_silent_connect") === "1") {
      sessionStorage.removeItem("__skip_silent_connect");
      return;
    }
    (async () => {
      const addr = await ensureWallet({ onlyIfTrusted: true });
      if (addr) setWallet(addr);
    })();
  }, []);

  return (
    <WalletContext.Provider value={{ wallet, setWallet }}>
      <Header
        wallet={wallet}
        onConnect={async () => {
          const addr = await connectWallet();
          if (addr) setWallet(addr);
        }}
        onLogout={async () => {
          await disconnectWallet(router, setWallet);
          try { sessionStorage.setItem("__skip_silent_connect", "1"); } catch {}
        }}
      />
      {children}
    </WalletContext.Provider>
  );
}
