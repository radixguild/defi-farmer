/// Concentrated-liquidity math for the range-based deposit builders.
///
/// Two protocols, two price bases — both VERIFIED against mainnet 2026-07-18
/// (docs/DEX-INTEGRATION.md, "Concentrated math"):
///   • Ociswap PrecisionPool:  price = 1.0001^tick            (token_y per token_x)
///   • CaviarNine QuantaSwap:   price = lower_limit·1.0005^(bin − active_bin)
///
/// Preview can't catch a *valid-but-wrong* range (the deposit still succeeds, just
/// in the wrong place), so every range can be expressed as a WIDTH in ticks/bins —
/// that path needs no price formula at all, only on-chain constants (active tick/bin,
/// spacing). The price-range path uses the verified bases; both are preview-gated.
///
/// Pure + parameterized (no network): the resolver feeds the on-chain constants, the
/// endpoint feeds the user's range, this decides ticks/bins + the per-bin split.

import { toScaled, fromScaled, mulDecimal, subDecimal, addDecimal, divByCount } from './decimal.js';
import type { BinPosition } from './rtm.js';

export const OCI_TICK_BASE = 1.0001;
export const CAV_TICK_BASE = 1.0005;

/// Ociswap PrecisionPool valid tick bounds (Uniswap-v3 bounds; the pool is the real
/// gate via preview, this is only a sanity clamp so we never emit an absurd i32).
export const OCI_MIN_TICK = -887272;
export const OCI_MAX_TICK = 887272;

/// Max bins a single QuantaSwap deposit may span. Real deposits use a few dozen;
/// this bounds the positions array so a pathological width can't make the builder
/// allocate a giant manifest (the pool's own per-tx limit is lower and preview-gated).
export const MAX_QUANTA_BINS = 200;

export interface TickRange {
  left: number;
  right: number;
}

// ─── Ociswap PrecisionPool — ticks ─────────────────────────────────────────────

/// price (token_y per token_x) at a tick.
export function ociTickToPrice(tick: number): number {
  return OCI_TICK_BASE ** tick;
}

/// tick (may be fractional) for a price. Snap before use.
export function ociPriceToTick(price: number): number {
  if (!(price > 0)) throw new Error(`ociPriceToTick: price must be > 0 (got ${price})`);
  return Math.log(price) / Math.log(OCI_TICK_BASE);
}

/// Exact current tick from the pool's `price_sqrt` (price = price_sqrt²), which is
/// authoritative even when `active_tick` has gone stale on a dead pool.
export function ociTickFromPriceSqrt(priceSqrt: number): number {
  if (!(priceSqrt > 0)) throw new Error(`ociTickFromPriceSqrt: price_sqrt must be > 0 (got ${priceSqrt})`);
  return (2 * Math.log(priceSqrt)) / Math.log(OCI_TICK_BASE);
}

function assertSpacing(spacing: number): void {
  if (!Number.isInteger(spacing) || spacing <= 0) throw new Error(`bad tick_spacing/bin_span: ${spacing}`);
}

/// Snap a (fractional) tick/bin to the spacing grid. `floor` widens down (lower
/// bound), `ceil` widens up (upper bound) — so the aligned range CONTAINS the request.
function snapToGrid(v: number, spacing: number, dir: 'floor' | 'ceil'): number {
  const q = v / spacing;
  const n = dir === 'floor' ? Math.floor(q) : Math.ceil(q);
  return n * spacing;
}

function clampTick(t: number): number {
  return Math.max(OCI_MIN_TICK, Math.min(OCI_MAX_TICK, t));
}

/// Ociswap range from explicit price bounds. Snaps to `tickSpacing` so the deposited
/// range == the displayed range (the pool accepts unaligned ticks, but we don't rely
/// on its internal snapping). left<right, at least one spacing wide.
export function ociTickRangeByPrice(loPrice: number, hiPrice: number, tickSpacing: number): TickRange {
  assertSpacing(tickSpacing);
  if (!(hiPrice > loPrice)) throw new Error(`ociTickRangeByPrice: need hiPrice > loPrice (${loPrice}, ${hiPrice})`);
  const left = clampTick(snapToGrid(ociPriceToTick(loPrice), tickSpacing, 'floor'));
  let right = clampTick(snapToGrid(ociPriceToTick(hiPrice), tickSpacing, 'ceil'));
  if (right <= left) right = clampTick(left + tickSpacing);
  if (right <= left) throw new Error('ociTickRangeByPrice: degenerate range after clamp');
  return { left, right };
}

/// Ociswap range as a WIDTH: `below`/`above` grid steps around the interval that
/// currently holds the price. Formula-free (no 1.0001 needed) — anchored on the
/// current tick's grid cell. `below=above=0` → the single active spacing.
export function ociTickRangeByWidth(currentTick: number, tickSpacing: number, below: number, above: number): TickRange {
  assertSpacing(tickSpacing);
  if (below < 0 || above < 0 || !Number.isInteger(below) || !Number.isInteger(above)) {
    throw new Error(`ociTickRangeByWidth: below/above must be ≥0 integers (${below}, ${above})`);
  }
  const cell = snapToGrid(currentTick, tickSpacing, 'floor'); // lower edge of the active cell
  const left = clampTick(cell - below * tickSpacing);
  const right = clampTick(cell + (above + 1) * tickSpacing);
  if (right <= left) throw new Error('ociTickRangeByWidth: degenerate range after clamp');
  return { left, right };
}

// ─── CaviarNine QuantaSwap — bins ──────────────────────────────────────────────

/// On-chain anchor for a QuantaSwap pool's bin↔price mapping.
export interface QuantaAnchor {
  /// `tick_index.current` — a multiple of binSpan.
  activeBin: number;
  /// `bin_span`.
  binSpan: number;
  /// `lower_limit` = price(activeBin), token_y per token_x. Only needed for the
  /// price-range path; the width path ignores it.
  lowerLimit?: number;
}

/// price (token_y per token_x) at a bin.
export function cavBinToPrice(bin: number, a: QuantaAnchor): number {
  if (!(typeof a.lowerLimit === 'number' && a.lowerLimit > 0)) {
    throw new Error('cavBinToPrice: lowerLimit required');
  }
  return a.lowerLimit * CAV_TICK_BASE ** (bin - a.activeBin);
}

/// continuous bin index for a price (snap before use).
export function cavPriceToBin(price: number, a: QuantaAnchor): number {
  if (!(typeof a.lowerLimit === 'number' && a.lowerLimit > 0)) {
    throw new Error('cavPriceToBin: lowerLimit required');
  }
  if (!(price > 0)) throw new Error(`cavPriceToBin: price must be > 0 (got ${price})`);
  return a.activeBin + Math.log(price / a.lowerLimit) / Math.log(CAV_TICK_BASE);
}

function assertAnchor(a: QuantaAnchor): void {
  assertSpacing(a.binSpan);
  if (!Number.isInteger(a.activeBin) || a.activeBin < 0) throw new Error(`bad active_bin: ${a.activeBin}`);
  if (a.activeBin % a.binSpan !== 0) throw new Error(`active_bin ${a.activeBin} not a multiple of bin_span ${a.binSpan}`);
}

/// Inclusive list of on-grid bins in [loBin, hiBin] (multiples of binSpan, ≥0).
/// Rejects a pathologically wide span BEFORE looping (DoS guard).
function binList(loBin: number, hiBin: number, binSpan: number): number[] {
  const count = Math.floor((hiBin - loBin) / binSpan) + 1;
  if (count > MAX_QUANTA_BINS) {
    throw new Error(`range too wide: ${count} bins requested (max ${MAX_QUANTA_BINS})`);
  }
  const out: number[] = [];
  for (let b = loBin; b <= hiBin; b += binSpan) if (b >= 0) out.push(b);
  return out;
}

/// QuantaSwap bins from explicit price bounds (snapped to the binSpan grid so the
/// deposited range == the displayed range).
export function cavBinRangeByPrice(loPrice: number, hiPrice: number, a: QuantaAnchor): number[] {
  assertAnchor(a);
  if (!(hiPrice > loPrice)) throw new Error(`cavBinRangeByPrice: need hiPrice > loPrice (${loPrice}, ${hiPrice})`);
  const lo = snapToGrid(cavPriceToBin(loPrice, a), a.binSpan, 'floor');
  const hi = snapToGrid(cavPriceToBin(hiPrice, a), a.binSpan, 'ceil');
  const bins = binList(lo, hi, a.binSpan);
  if (bins.length === 0) throw new Error('cavBinRangeByPrice: empty bin range');
  return bins;
}

/// QuantaSwap bins as a WIDTH: `below`/`above` bins around the active bin.
/// Formula-free (no 1.0005 needed). `below=above=0` → the single active bin.
export function cavBinRangeByWidth(a: QuantaAnchor, below: number, above: number): number[] {
  assertAnchor(a);
  if (below < 0 || above < 0 || !Number.isInteger(below) || !Number.isInteger(above)) {
    throw new Error(`cavBinRangeByWidth: below/above must be ≥0 integers (${below}, ${above})`);
  }
  const lo = a.activeBin - below * a.binSpan;
  const hi = a.activeBin + above * a.binSpan;
  const bins = binList(lo, hi, a.binSpan);
  if (bins.length === 0) throw new Error('cavBinRangeByWidth: empty bin range');
  return bins;
}

/// Split `netX`/`netY` (the amounts that actually reach the pool, i.e. AFTER any fee)
/// across `bins` as a uniform-amount shape, honoring the on-chain rule: token_x only
/// in bins ≥ active, token_y only in bins ≤ active, the active bin holds both. The
/// truncation remainder goes to the bin nearest the active bin so the parts sum back
/// to exactly netX / netY (no dust, buckets == positions sum). Bins that would hold
/// nothing are dropped. The pool consumes the price-correct mix and returns change.
export function distributeQuanta(bins: number[], activeBin: number, netX: string, netY: string): BinPosition[] {
  const sorted = [...new Set(bins)].sort((p, q) => p - q);
  const xBins = sorted.filter((b) => b >= activeBin); // x-eligible (incl. active)
  const yBins = sorted.filter((b) => b <= activeBin); // y-eligible (incl. active)

  const hasX = toScaled(netX) > 0n;
  const hasY = toScaled(netY) > 0n;
  if (toScaled(netX) < 0n || toScaled(netY) < 0n) throw new Error('distributeQuanta: negative amount');
  if (hasX && xBins.length === 0) throw new Error('distributeQuanta: x amount but no bin ≥ active');
  if (hasY && yBins.length === 0) throw new Error('distributeQuanta: y amount but no bin ≤ active');
  if (!hasX && !hasY) throw new Error('distributeQuanta: both amounts zero');

  const xOf = new Map<number, string>();
  const yOf = new Map<number, string>();
  if (hasX) {
    const per = divByCount(netX, xBins.length);
    for (const b of xBins) xOf.set(b, per);
    const used = fromScaled(toScaled(per) * BigInt(xBins.length));
    const rem = subDecimal(netX, used);
    const near = Math.min(...xBins); // closest x-bin to active (xBins ≥ active)
    if (toScaled(rem) !== 0n) xOf.set(near, addDecimal(xOf.get(near)!, rem));
  }
  if (hasY) {
    const per = divByCount(netY, yBins.length);
    for (const b of yBins) yOf.set(b, per);
    const used = fromScaled(toScaled(per) * BigInt(yBins.length));
    const rem = subDecimal(netY, used);
    const near = Math.max(...yBins); // closest y-bin to active (yBins ≤ active)
    if (toScaled(rem) !== 0n) yOf.set(near, addDecimal(yOf.get(near)!, rem));
  }

  const positions: BinPosition[] = [];
  for (const b of sorted) {
    const ax = xOf.get(b) ?? '0';
    const ay = yOf.get(b) ?? '0';
    if (toScaled(ax) === 0n && toScaled(ay) === 0n) continue; // nothing to add here
    positions.push({ bin: b, amountX: ax, amountY: ay });
  }
  if (positions.length === 0) throw new Error('distributeQuanta: no non-empty positions');
  return positions;
}

/// Net that reaches the pool after the platform fee is spliced out of `amount`
/// (mirrors withdrawWithFee in manifests.ts exactly: fee = ⌊amount·rate⌋, taken only
/// if it rounds to > 0). Used so the QuantaSwap per-bin split sums to the post-fee bucket.
export function netAfterFee(amount: string, rate: string | undefined): string {
  if (!rate) return amount;
  const fee = mulDecimal(amount, rate);
  return toScaled(fee) > 0n ? subDecimal(amount, fee) : amount;
}
