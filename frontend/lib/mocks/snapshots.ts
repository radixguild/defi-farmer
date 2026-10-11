import { PoolSnapshot } from "@/lib/types";

function generateSnapshots(
  poolAddress: string,
  baseApy: number,
  baseTvl: number
): PoolSnapshot[] {
  const snapshots: PoolSnapshot[] = [];
  const now = new Date("2026-05-05T10:00:00Z");

  // 720 hourly points = the chart's widest (30d) range, matching what
  // /api/snapshots returns. At 168 the mock could only ever fill 7 days, so
  // the degraded path still showed "30d" as 7 days.
  for (let i = 719; i >= 0; i--) {
    const time = new Date(now.getTime() - i * 60 * 60 * 1000);
    const apyVariation = (Math.sin(i * 0.3) * 2 + Math.cos(i * 0.1) * 1.5) * (baseApy * 0.05);
    const tvlVariation = (Math.sin(i * 0.2) * 0.05 + Math.cos(i * 0.05) * 0.03) * baseTvl;

    snapshots.push({
      pool_address: poolAddress,
      apy_7d_ma: Math.max(0.5, baseApy + apyVariation),
      tvl_usd: Math.max(100000, baseTvl + tvlVariation),
      scanned_at: time.toISOString(),
    });
  }

  return snapshots;
}

export const mockSnapshotsMap: Record<string, PoolSnapshot[]> = {
  pool_rdx1c5dkfdtsgk8rjx3jqzztfmkk4qrm0ax9jmtgh3asl8a7m2c4p: generateSnapshots(
    "pool_rdx1c5dkfdtsgk8rjx3jqzztfmkk4qrm0ax9jmtgh3asl8a7m2c4p",
    18.4,
    2450000
  ),
  pool_rdx1c4kj8f3e5qh2l9g7nm0v8xtrcyzap6sjw2k4d7fy3hut9p5rq: generateSnapshots(
    "pool_rdx1c4kj8f3e5qh2l9g7nm0v8xtrcyzap6sjw2k4d7fy3hut9p5rq",
    14.2,
    1800000
  ),
  pool_rdx1c7pqw2m4j9xk6h3nf5s0v8yrtzl1ba2ud7e8gc4m6kxn0q3wp: generateSnapshots(
    "pool_rdx1c7pqw2m4j9xk6h3nf5s0v8yrtzl1ba2ud7e8gc4m6kxn0q3wp",
    22.7,
    890000
  ),
  pool_rdx1c2bnt5x8k7qm3j6wl9h0v4yrfz1sa5pd2e6tg8cn0kuw7j4xp: generateSnapshots(
    "pool_rdx1c2bnt5x8k7qm3j6wl9h0v4yrfz1sa5pd2e6tg8cn0kuw7j4xp",
    5.8,
    5200000
  ),
};
