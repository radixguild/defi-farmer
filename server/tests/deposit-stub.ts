/// Shared Gateway-stub pieces for deposit tests (not a test file itself).
///
/// The deposit guard (src/services/dex/deposit-guard.ts) reads each non-XRD
/// token's divisibility from the ledger and checks the dry-run's net XRD
/// outflow against the minimum. Stubs that drive buildAndPreview end to end use
/// these so their fixtures answer both like the Gateway would.

import type { GwEntityItem } from '../src/services/gateway';

export const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';

/// A FungibleResource entity-details item with the given divisibility.
export function fungibleItem(address: string, divisibility: number): GwEntityItem {
  return { address, details: { type: 'FungibleResource', divisibility } } as GwEntityItem;
}

/// Preview resource_changes for `account`: every XRD amount the manifest
/// withdraws from the account leaves it (the stub pool keeps it all, no change).
export function xrdOutflow(manifest: string, account: string): unknown[] {
  const re = new RegExp(`"withdraw" Address\\("${XRD}"\\) Decimal\\("([^"]+)"\\)`, 'g');
  const changes = [...manifest.matchAll(re)].map((m) => ({
    resource_address: XRD, component_entity: { entity_address: account }, amount: `-${m[1]}`,
  }));
  return changes.length ? [{ index: 0, resource_changes: changes }] : [];
}
