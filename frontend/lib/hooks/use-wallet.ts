"use client";

import { useContext } from "react";
import { WalletContext } from "@/lib/radix-provider";

export function useWallet() {
  return useContext(WalletContext);
}
