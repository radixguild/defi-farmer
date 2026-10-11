import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "next-themes";
import { RadixProvider } from "@/lib/radix-provider";
import { BottomNav, SideNav } from "@/components/navigation";
import { PageTransition } from "@/components/page-transition";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  // Descriptive, not promotional. "Earn Yield" promised a return; "one click"
  // described a flow that does not exist — every deposit is a manifest the user
  // signs in their own wallet, and most tracked venues currently lose money
  // after impermanent loss.
  title: "DeFi Farmer — Radix yield dashboard",
  description:
    "Tracks yield across Radix DEXes, staking and lending, scored net of impermanent loss. Non-custodial: you sign every transaction in your own wallet.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: next-themes stamps the class on <html> before
    // hydration; the mismatch on that one attribute is expected.
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
          <RadixProvider>
            <SideNav />
            <div className="md:ml-56 pb-20 md:pb-0">
              <PageTransition>{children}</PageTransition>
            </div>
            <BottomNav />
          </RadixProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
