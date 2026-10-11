// The Radix dApp Toolkit renders `<radix-connect-button>` as a custom element, so
// TypeScript needs it declared as an intrinsic JSX element.
//
// ⚠️ This MUST live under `React.JSX`, not a bare global `namespace JSX`. React 19
// removed the global JSX namespace and moved it into the React namespace, so the
// old `declare namespace JSX` form silently stops being picked up — the symptom is
// `TS2339: Property 'radix-connect-button' does not exist on type
// 'JSX.IntrinsicElements'` at the usage site in components/connect-wallet-button.tsx,
// which reads like a missing import rather than a moved namespace.
import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "radix-connect-button": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}
