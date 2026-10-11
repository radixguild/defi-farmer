import { RotationEntry } from "@/lib/types";

export const mockRotationPending: RotationEntry[] = [
  {
    id: 1,
    from_pool: "pool_rdx1c7pqw2m4j9xk6h3nf5s0v8yrtzl1ba2ud7e8gc4m6kxn0q3wp",
    to_pool: "pool_rdx1c5dkfdtsgk8rjx3jqzztfmkk4qrm0ax9jmtgh3asl8a7m2c4p",
    from_protocol: "caviarnine",
    to_protocol: "ociswap",
    amount_xrd: 3000,
    reason: "Higher yield opportunity detected: XRD/USDC (18.4% vs 22.7% but lower risk)",
    status: "pending",
    proposed_at: "2026-05-04T18:00:00Z",
  },
];
