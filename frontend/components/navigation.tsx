"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Compass, BarChart3, Settings, ShieldCheck, Wallet, Gift } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { isGiftPageLive } from "@/lib/gift";

const baseNavItems = [
  { href: "/", label: "Home", icon: Home },
  { href: "/discover", label: "Discover", icon: Compass },
  { href: "/validators", label: "Validators", icon: ShieldCheck },
  { href: "/positions", label: "Positions", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

// The gift link uses the SAME truth condition as the /gift route, which 404s
// when no destination is configured — so a dark tip jar is simply unlinked,
// never a nav entry that leads to a 404. Evaluated once at module load, which
// is exact rather than merely cheap: NEXT_PUBLIC_* is inlined at build time,
// so this is a constant in the bundle and cannot drift from the route's guard.
//
// Shown on mobile too, deliberately. Upstream hid its gift link behind
// `hidden sm:flex` and quietly made the page unreachable on every phone.
const navItems = isGiftPageLive()
  ? [...baseNavItems, { href: "/gift", label: "Gifts", icon: Gift }]
  : baseNavItems;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background md:hidden">
      <div className="flex items-center justify-around h-16">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center gap-1 px-3 py-2 text-xs transition-colors",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-5 w-5" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function SideNav() {
  const pathname = usePathname();

  return (
    <nav className="hidden md:flex fixed left-0 top-0 bottom-0 w-56 flex-col border-r bg-background p-4 z-50">
      <Link href="/" className="text-xl font-bold mb-8 px-3">
        DeFi Farmer
      </Link>
      <div className="flex flex-col gap-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-muted text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
      <div className="mt-auto px-3 pb-2 space-y-3">
        <ThemeToggle />
      </div>
    </nav>
  );
}
