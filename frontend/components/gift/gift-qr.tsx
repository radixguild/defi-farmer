"use client";

import { QRCodeSVG } from "qrcode.react";

/**
 * QR for a gift destination (a bare address, or a BIP-21 URI).
 *
 * Deliberately NOT theme-aware. The rest of the app inverts in dark mode (and
 * this app defaults to dark); this stays black-on-white always, because an
 * inverted QR is a scanning compatibility gamble on the donor's camera app and
 * the downside is a failed gift. `marginSize={4}` is the quiet zone the QR
 * spec requires — the container padding is cosmetic and does not substitute
 * for it, since a scanner reads the SVG's own bounds when the image is saved
 * or screenshotted.
 *
 * `value` must already be validated by lib/gift. This renders whatever it is
 * handed, so handing it an unvalidated address just produces a scannable
 * wrong answer.
 */
export function GiftQr({ value, label }: { value: string; label: string }) {
  return (
    <div className="shrink-0 rounded-lg bg-white p-2">
      <QRCodeSVG
        value={value}
        size={148}
        level="M"
        marginSize={4}
        bgColor="#ffffff"
        fgColor="#000000"
        title={label}
      />
    </div>
  );
}
