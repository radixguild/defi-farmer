import { Opportunity } from "@/lib/types";

/**
 * Fallback data for `mock-forced` / `mock-degraded` modes.
 *
 * These were previously invented at 8–24% APY on $0.4M–$5.2M pools. No such
 * pool exists on Radix: the whole chain holds ~$1.3M TVL, Ociswap's largest
 * pool is ~$13k, and every LP pool we track is net-negative after IL. A demo
 * that renders double-digit green APYs teaches the reader something false
 * about the product, so these mirror real magnitudes observed on
 * 2026-07-25 — including the negative net figures, which are the point.
 */
export const mockOpportunities: Opportunity[] = [
  {
    // Realized drift of the LSULP redemption ratio over a trailing 30 days,
    // read from the ledger 2026-07-25. Independently brackets native staking's
    // 6.06%, which is the cross-check that validates both derivations.
    pool_address: "component_rdx1cppy08xgra5tv5melsjtj79c0ngvrlmzl8hhs7vwtzknp9xxs63mfp",
    protocol: "caviarnine",
    pool_name: "LSULP liquid staking (realized, trailing 30d)",
    score: 63.1,
    apy_7d_ma: 6.11,
    net_apy_ma_7d: 6.11,
    estimated_il: 0,
    il_risk_score: 0,
    risk_adjusted_return: 0.53,
    tvl_usd: 340401,
    is_stable: false,
    yield_kind: "staking",
    computed_at: "2026-07-25T10:45:00Z",
  },
  {
    // IL-free by construction. Figures from the live ledger on 2026-07-25:
    // 4.85B XRD staked against the 300M/yr emission = 6.18% gross, less the
    // 2% median validator fee.
    pool_address: "native_xrd_staking",
    protocol: "radix",
    pool_name: "XRD staking",
    score: 62.4,
    apy_7d_ma: 6.06,
    net_apy_ma_7d: 6.06,
    estimated_il: 0,
    il_risk_score: 0,
    risk_adjusted_return: 6.06,
    tvl_usd: 4930994.76,
    is_stable: false,
    yield_kind: "staking",
    computed_at: "2026-07-25T09:23:59Z",
  },
  {
    // Realized supply yield, 30d. Ranks ABOVE DFP2-XRD's higher 5.6% net
    // precisely because it carries no impermanent loss — the risk-adjusted
    // ordering the app is built to surface.
    pool_address: "weft-v2:resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd",
    protocol: "weft",
    pool_name: "XRD lending (realized, trailing 30d)",
    score: 55.2,
    apy_7d_ma: 4.67,
    net_apy_ma_7d: 4.67,
    estimated_il: 0,
    il_risk_score: 0,
    risk_adjusted_return: -0.14,
    tvl_usd: 63964,
    is_stable: false,
    yield_kind: "lending",
    computed_at: "2026-07-25T10:45:00Z",
  },
  {
    pool_address: "component_rdx1cpj25l4f8v2n4xl2auhwsagwmt5mmxsavxttmkpl90cr2qnyejqcmt",
    protocol: "ociswap",
    pool_name: "DFP2-XRD",
    score: 41.94,
    apy_7d_ma: 1.59,
    net_apy_ma_7d: -1.34,
    estimated_il: -2.94,
    il_risk_score: 51,
    risk_adjusted_return: -10.81,
    tvl_usd: 3915.53,
    is_stable: false,
    yield_kind: "amm-lp",
    computed_at: "2026-07-25T09:23:59Z",
  },
  {
    pool_address: "component_rdx1czy2naejcqx8gv46zdsex2syuxrs4jnqzug58e66zr8wglxzvu97qr",
    protocol: "ociswap",
    pool_name: "XRD-hUSDC",
    score: 45.62,
    apy_7d_ma: 3.43,
    net_apy_ma_7d: -14.29,
    estimated_il: -17.72,
    il_risk_score: 26,
    risk_adjusted_return: -41.94,
    tvl_usd: 1322.77,
    is_stable: false,
    yield_kind: "amm-lp",
    computed_at: "2026-07-25T09:23:59Z",
  },
  {
    pool_address: "component_rdx1cpcd3wxrwgtldnrtkz995dzj6zhsqg2sym9tpqgmg7g9wsuu00jn65",
    protocol: "ociswap",
    pool_name: "xwBTC-XRD",
    score: 41.7,
    apy_7d_ma: 2.11,
    net_apy_ma_7d: -8.26,
    estimated_il: -10.37,
    il_risk_score: 54,
    risk_adjusted_return: -20.17,
    tvl_usd: 715.31,
    is_stable: false,
    yield_kind: "amm-lp",
    computed_at: "2026-07-25T09:23:59Z",
  },
  {
    pool_address: "component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky",
    protocol: "caviarnine",
    pool_name: "hSOL-XRD",
    score: 51.16,
    apy_7d_ma: 0,
    net_apy_ma_7d: -20.54,
    estimated_il: -20.54,
    il_risk_score: 57,
    risk_adjusted_return: -37.62,
    tvl_usd: 38.99,
    is_stable: false,
    yield_kind: "amm-lp",
    computed_at: "2026-07-25T09:23:59Z",
  },
  {
    pool_address: "component_rdx1crwdzvlv7djtkug9gmvp9ejun0gm0w6cvkpfqycw8fcp4gg82eftjc",
    protocol: "defiplaza",
    pool_name: "xETH-XRD",
    score: 53.34,
    apy_7d_ma: 0,
    net_apy_ma_7d: -14.37,
    estimated_il: -14.37,
    il_risk_score: 49,
    risk_adjusted_return: -31.35,
    tvl_usd: 0,
    is_stable: false,
    yield_kind: "amm-lp",
    computed_at: "2026-07-25T09:23:59Z",
  },
];
