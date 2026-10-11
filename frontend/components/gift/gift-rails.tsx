import Link from "next/link";
import { Bitcoin, Coins } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BtcGiftCard } from "@/components/gift/btc-gift-card";
import { XrdGiftCard } from "@/components/gift/xrd-gift-card";
import { giftDestination } from "@/lib/gift";

/**
 * The gift rails. Callers supply their own framing, but NOT the disclosure —
 * GiftDisclosure ships with the rails on purpose. "A gift buys nothing" has to
 * appear wherever gifts are asked for, and a caller that forgot it would be
 * the bug.
 *
 * Each rail is a plain `&&` on its own destination: unset or invalid resolves
 * to null in lib/gift, so an unconfigured rail renders nothing and there is no
 * placeholder to leak. Safe to embed on a page that does NOT itself 404 when
 * gifts are dark — the rails simply disappear. Use isGiftPageLive() to decide
 * whether to show a heading.
 *
 * Apostrophes below are written literally rather than as &apos;. That is
 * deliberate: SWC drops the leading whitespace of any JSX text node containing
 * an HTML entity, which upstream hit as "nothing.No token" in a production
 * build. No entity, no bug, no {" "} workaround to maintain.
 */
export function GiftRails() {
  const xrd = giftDestination("xrd");
  const btc = giftDestination("btc");

  return (
    <>
      {xrd && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wide text-muted-foreground">
              <Coins className="h-4 w-4" />
              XRD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <XrdGiftCard address={xrd} />
          </CardContent>
        </Card>
      )}

      {btc && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wide text-muted-foreground">
              <Bitcoin className="h-4 w-4" />
              Bitcoin
            </CardTitle>
          </CardHeader>
          <CardContent>
            <BtcGiftCard address={btc} />
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Gifts go to bigdev, who builds and runs this app. There is no treasury, no DAO and no
        company behind it — it is one person paying for a VPS.
      </p>
    </>
  );
}

/**
 * The honest-copy disclosure. Rendered above the rails on every surface that
 * asks for a gift — this is the claim the page exists to NOT overstate.
 *
 * The middle paragraph is the one that matters for THIS app specifically: the
 * product is a ranking, so the thing a donor might reasonably fear buying is
 * a place in it. Say plainly that they cannot.
 *
 * ⚠ COUPLED TO CONFIG: "no platform fee" below is true only while
 * PLATFORM_FEE_RATE / PLATFORM_FEE_COMPONENT are unset on the server (they are
 * — see .env.example; the fee splice exists but is disabled by default and
 * fails safe). If Stream C is ever switched on, this paragraph becomes false
 * and MUST change in the same commit.
 */
export function GiftDisclosure() {
  return (
    <Card>
      <CardContent className="space-y-3 pb-5 pt-5 text-sm leading-relaxed">
        <p>
          <strong>A gift buys nothing.</strong> No token, no equity, no priority, no vote, no
          refund, and no claim on anything this app does later. It is a thank-you, not a
          purchase.
        </p>
        <p className="text-muted-foreground">
          <strong className="text-foreground">Gifts do not affect what the app recommends.</strong>{" "}
          Nothing on{" "}
          <Link href="/discover" className="text-primary hover:underline">
            Discover
          </Link>{" "}
          or the{" "}
          <Link href="/validators" className="text-primary hover:underline">
            validator board
          </Link>{" "}
          is paid placement, and no pool, protocol or validator can buy a listing, a ranking or a
          mention. That independence is the only thing this app has worth having — it is not for
          sale, to a donor or to anyone else.
        </p>
        <p className="text-muted-foreground">
          There is no platform fee. Nothing is added to the deposit or withdraw manifests you
          sign, and the app never holds your funds — it builds a transaction, you sign it in your
          own wallet, and the money goes straight to the venue.
        </p>
      </CardContent>
    </Card>
  );
}
