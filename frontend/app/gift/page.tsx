import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GiftDisclosure, GiftRails } from "@/components/gift/gift-rails";
import { isGiftPageLive } from "@/lib/gift";

export const metadata: Metadata = {
  title: "Gifts — DeFi Farmer",
  description:
    "DeFi Farmer is free and takes no fee. Gifts cover the bills. A gift buys nothing — no token, no priority, and no influence over what the app recommends.",
};

export default function GiftPage() {
  // The hard guard, at the route boundary: with no destination configured there
  // is nothing to send to, so the page does not exist at all. See lib/gift.
  // The nav link uses this same condition, so a dark page is also unlinked
  // rather than being a 404 someone can navigate into.
  if (!isGiftPageLive()) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Gifts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This app is free and charges no fee. Gifts are what cover the bills.
        </p>
      </div>

      <GiftDisclosure />
      <GiftRails />
    </div>
  );
}
