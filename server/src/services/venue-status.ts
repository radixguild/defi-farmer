/// Venue status: which protocols the agent may still RECOMMEND.
///
/// A venue listed here keeps its scanner and its holdings/exit support — a user
/// who already holds a position there must still see it and be able to leave —
/// but its pools are excluded from discovery (scoring, /api/opportunities,
/// rotation targets). Only public, linkable sources back each entry.
///
/// This is a recommendation filter, not a deposit guard: it changes nothing in
/// dex/ (resolver pins, the deposit switch, the sign gate).

export type VenueStatusKind = 'exit-only' | 'unverified';

export interface VenueStatus {
  status: VenueStatusKind;
  /// Plain-language reason, written for the user.
  note: string;
  /// Public source for the note.
  source: string;
  checked: string;
}

export const VENUE_STATUS: Readonly<Record<string, VenueStatus>> = {
  // Covers CaviarNine's DEX pools AND its LSU Pool (LSULP): both are labelled
  // protocol 'caviarnine'.
  caviarnine: {
    status: 'exit-only',
    note:
      'Sunset. CaviarNine says it now builds Cantex on Canton. Existing positions still show ' +
      'here and can be exited; the farmer no longer recommends new deposits.',
    source: 'https://caviarnine.com',
    checked: '2026-11-19',
  },
  weft: {
    status: 'unverified',
    note:
      'Exploited. DefiLlama lists Weft V2 on 2026-08-30 (spot price manipulation). Its status ' +
      'since then is unverified. Existing positions still show; no new recommendations.',
    source: 'https://defillama.com/hacks',
    checked: '2026-11-19',
  },
};

export function venueStatus(protocol: string): VenueStatus | null {
  return VENUE_STATUS[protocol.toLowerCase()] ?? null;
}

/// May the agent recommend a pool from this protocol?
export function isDiscoverable(protocol: string): boolean {
  return venueStatus(protocol) === null;
}

/// Split a scanned set into what may be recommended and what may not. The
/// agent loop scores only `discoverable`.
export function splitDiscoverable<T extends { protocol: string }>(
  pools: T[],
): { discoverable: T[]; excluded: T[] } {
  const discoverable: T[] = [];
  const excluded: T[] = [];
  for (const p of pools) (isDiscoverable(p.protocol) ? discoverable : excluded).push(p);
  return { discoverable, excluded };
}
