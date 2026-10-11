/// RotationManager — exit guards + weekly rotation review (advisor).
/// Protects positions from sudden drops and PROPOSES rotations with cooldown +
/// diversification enforcement. Non-custodial: it only writes proposals to
/// rotation_log for the user to act on — it never signs or submits.
///
/// v2: Integrated with Allocator for Kelly-criterion portfolio optimization.
/// The weeklyReview() method calls computeAllocation() + generateRotations().

import { CONFIG } from '../config.js';
import { getDb } from '../db/schema.js';
import type { Position } from '../db/schema.js';
import type { OpportunityScorer, ScoredPool } from './scorer.js';
import {
  computeAllocation,
  generateRotations,
  rebalanceNetBenefit,
  summarizePortfolio,
} from './allocator.js';
import type { AllocatorConfig } from './allocator.js';

export interface ExitSignal {
  positionId: number;
  poolAddress: string;
  reason: string;
  urgency: 'emergency' | 'warning';
}

export interface RotationProposal {
  fromPool: string;
  fromProtocol: string;
  toPool: string;
  toProtocol: string;
  amount: string;
  reason: string;
  estimatedGainBps: number;
  requiresApproval: boolean;
}

function allocatorConfig(): Partial<AllocatorConfig> {
  return {
    maxPoolFraction: 0.40,
    maxProtocolFraction: 0.60,
    kellyFraction: 0.5,
    riskFreeRate: 8,
    // Minimum XRD to bother rotating (dust threshold, not the approval threshold)
    minRotationAmount: 10,
    minRotationGainBps: CONFIG.MIN_REBALANCE_DIFF_BPS,
  };
}

export class RotationManager {
  private scorer: OpportunityScorer;

  constructor(scorer: OpportunityScorer) {
    this.scorer = scorer;
  }

  checkExitGuards(positions: Position[]): ExitSignal[] {
    const signals: ExitSignal[] = [];
    const db = getDb();
    for (const pos of positions) {
      if (pos.status !== 'active') continue;
      if (pos.entry_apy_bps != null && pos.entry_apy_bps > 0 && pos.apy_bps != null) {
        const dropPct = ((pos.entry_apy_bps - pos.apy_bps) / pos.entry_apy_bps) * 100;
        if (dropPct > CONFIG.APY_DROP_EXIT_PCT) {
          signals.push({
            positionId: pos.id, poolAddress: pos.pool_address,
            reason: `APY dropped ${dropPct.toFixed(1)}% from entry`, urgency: 'emergency',
          });
        }
      }
      const snapshots = db.prepare(
        `SELECT tvl FROM pool_snapshots WHERE pool_address = ? AND scanned_at >= datetime('now', '-1 day') ORDER BY scanned_at ASC LIMIT 1`
      ).get(pos.pool_address) as { tvl: string } | undefined;
      const latestSnapshot = db.prepare(
        `SELECT tvl FROM pool_snapshots WHERE pool_address = ? ORDER BY scanned_at DESC LIMIT 1`
      ).get(pos.pool_address) as { tvl: string } | undefined;
      if (snapshots && latestSnapshot) {
        const oldTvl = parseFloat(snapshots.tvl);
        const newTvl = parseFloat(latestSnapshot.tvl);
        if (oldTvl > 0) {
          const tvlDropPct = ((oldTvl - newTvl) / oldTvl) * 100;
          if (tvlDropPct > CONFIG.TVL_DROP_EXIT_PCT) {
            signals.push({
              positionId: pos.id, poolAddress: pos.pool_address,
              reason: `TVL dropped ${tvlDropPct.toFixed(1)}% in 24h`, urgency: 'emergency',
            });
          }
        }
      }
    }
    return signals;
  }

  /**
   * Weekly rotation review — v2: uses Kelly-criterion allocator.
   * 1. Compute optimal allocation targets from scored pools
   * 2. Generate ranked rotation instructions
   * 3. Map to RotationProposal (respecting cooldown, thresholds)
   * 4. Persist to rotation_log
   */
  weeklyReview(positions: Position[], scored: ScoredPool[]): RotationProposal[] {
    const db = getDb();
    const now = new Date().toISOString();
    const ac = allocatorConfig();

    // Portfolio health check
    const summary = summarizePortfolio(positions, ac);
    console.log(
      `[rotation] Portfolio: ${summary.totalValueXrd.toFixed(0)} XRD, ` +
      `${summary.poolCount} pools, diversification: ${summary.diversificationScore}/100, ` +
      `avg APY: ${summary.avgApy}%`,
    );
    if (summary.overConcentratedPools > 0) {
      console.warn(`[rotation] ${summary.overConcentratedPools} pool(s) over-concentrated`);
    }

    // Compute optimal allocation
    const targets = computeAllocation(scored, positions, ac);
    if (targets.length === 0) {
      console.log('[rotation] No viable targets — nothing to rotate');
      return [];
    }

    console.log(`[rotation] Allocator: ${targets.length} targets`);
    for (const t of targets.slice(0, 5)) {
      console.log(`  ${t.protocol} — ${t.allocationXrd.toFixed(0)} XRD @ ${t.expectedApy.toFixed(1)}% (kelly=${t.kellyFraction.toFixed(4)})`);
    }

    // Generate rotation instructions
    const instructions = generateRotations(positions, targets, ac);
    if (instructions.length === 0) {
      console.log('[rotation] Portfolio is optimal — no rotations needed');
      return [];
    }

    console.log(`[rotation] ${instructions.length} rotation instruction(s)`);

    // Convert to proposals + persist
    const proposals: RotationProposal[] = [];
    const thresholdXrd = parseFloat(CONFIG.AUTO_EXECUTE_THRESHOLD_XRD);

    // Idempotency across ticks/restarts: a pending 'proposed' row for the same
    // from→to move already surfaces in the UI. lastRotationReview is in-memory
    // (0 on every boot), so without this the first tick after each restart would
    // re-insert duplicate proposals for a standing rotation. (cooldown_until is
    // never written in advisor mode — nothing executes — so that guard is dead
    // but harmless; this dedup is what actually prevents the pile-up.)
    const pendingMove = db.prepare(
      "SELECT 1 FROM rotation_log WHERE from_pool = ? AND to_pool = ? AND status = 'proposed' LIMIT 1",
    );

    for (const inst of instructions) {
      const fromPos = positions.find(p =>
        p.pool_address === inst.fromPool && p.status === 'active'
      );
      if (fromPos?.cooldown_until && fromPos.cooldown_until > now) continue;
      if (fromPos?.classification === 'stable') continue;
      // Already proposed and still pending — don't duplicate it.
      if (pendingMove.get(inst.fromPool, inst.toPool)) continue;

      // Net-benefit gate (#5): the move must out-earn its own gas+fees+slippage
      // over the horizon — an APY-gap threshold can't see position size.
      const gate = rebalanceNetBenefit({
        gainBps: inst.expectedGainBps,
        amountXrd: inst.amountXrd,
        costs: { gasXrd: parseFloat(CONFIG.MAX_GAS_XRD) * 2 },
      });
      if (!gate.act) {
        console.log(
          `[rotation] Gate refused ${inst.fromPool.slice(0, 20)}…→${inst.toPool.slice(0, 20)}…: ` +
          `+${inst.expectedGainBps}bps on ${inst.amountXrd.toFixed(0)} XRD ≈ ${gate.gain} XRD/30d ` +
          `< costs ${gate.cost} XRD`,
        );
        continue;
      }

      const proposal: RotationProposal = {
        fromPool: inst.fromPool,
        fromProtocol: inst.fromProtocol,
        toPool: inst.toPool,
        toProtocol: inst.toProtocol,
        amount: inst.amountXrd.toString(),
        reason: `${inst.reason} [${inst.priority}]`,
        estimatedGainBps: inst.expectedGainBps,
        requiresApproval: inst.amountXrd >= thresholdXrd,
      };

      proposals.push(proposal);

      db.prepare(
        `INSERT INTO rotation_log (from_pool, to_pool, from_protocol, to_protocol, amount, reason, status) VALUES (?, ?, ?, ?, ?, ?, 'proposed')`
      ).run(proposal.fromPool, proposal.toPool, proposal.fromProtocol, proposal.toProtocol, proposal.amount, proposal.reason);
    }

    const autoCount = proposals.filter(p => !p.requiresApproval).length;
    console.log(`[rotation] ${proposals.length} proposals (${autoCount} within the auto-approve threshold)`);
    return proposals;
  }
}
