/**
 * Memory Decay Module
 *
 * Implements multiple independently-togglable decay mechanisms:
 * 1. TTL-based time decay (with safety threshold)
 * 2. Importance-driven half-life (Ebbinghaus curve)
 * 3. Access frequency weighting (hotness)
 * 4. State machine (draft→active→frozen→forgotten)
 * 5. Retrieval-time graph decay
 */

import type { Engram, EngramStatus, MemoryLayer } from "../index.js";

export interface DecayConfig {
  ttl: {
    enabled: boolean;
    retentionDays: number;
    safetyThreshold: number;      // Max 80% deletion per run
    minRetainL0: number;          // Min 50 L0 records
    minRetainL1: number;           // Min 20 L1 records
  };
  importance: {
    enabled: boolean;
    baseHalflifeDays: number;      // Default: 50
    kindMultipliers: Record<string, number>;  // kind → multiplier
  };
  accessFrequency: {
    enabled: boolean;
  };
  stateMachine: {
    enabled: boolean;
  };
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  ttl: {
    enabled: true,
    retentionDays: 30,
    safetyThreshold: 0.8,
    minRetainL0: 50,
    minRetainL1: 20,
  },
  importance: {
    enabled: true,
    baseHalflifeDays: 50,
    kindMultipliers: {
      observation: 0.6,
      hypothesis: 0.7,
      procedure: 0.8,
      fact: 1.0,
      pattern: 1.5,
    },
  },
  accessFrequency: {
    enabled: true,
  },
  stateMachine: {
    enabled: true,
  },
};

// Freshness derived type
export type Freshness = "fresh" | "aging" | "stale" | "forgotten";

/**
 * Derive freshness from Ebbinghaus curve (Co-Engram research)
 *
 * halflife = BASE × (importance + 0.1)^1.5 × kindMultiplier
 * freshness is a pure function of age and halflife
 */
export function deriveFreshness(
  lastEffectiveAt: number,
  importance: number,
  kind: string,
  config: DecayConfig
): Freshness {
  if (!config.importance.enabled) return "fresh";

  const ageMs = Date.now() - lastEffectiveAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  const kindMultiplier = config.importance.kindMultipliers[kind] ?? 1.0;
  const halflife = config.importance.baseHalflifeDays * Math.pow(importance + 0.1, 1.5) * kindMultiplier;

  if (ageDays <= halflife) return "fresh";
  if (ageDays <= halflife * 2) return "aging";
  if (ageDays <= halflife * 4) return "stale";
  return "forgotten";
}

/**
 * Recency score using Ebbinghaus curve
 * recency = 0.5^(ageDays / halflife)
 */
export function deriveRecency(lastEffectiveAt: number, halflifeDays: number): number {
  const ageDays = (Date.now() - lastEffectiveAt) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / halflifeDays);
}

/**
 * Hotness: combination of retrieval count and age
 * hotness = sigmoid(ln(1 + count)) × exp(-ln2 × ageDays / 7days)
 */
export function deriveHotness(retrievalCount: number, lastEffectiveAt: number): number {
  // sigmoid(ln(1 + count))
  const retrievalComponent = 1 / (1 + Math.exp(-Math.log(1 + retrievalCount)));

  // exp(-ln2 × ageDays / 7days) = 2^(-ageDays / 7)
  const ageDays = (Date.now() - lastEffectiveAt) / (1000 * 60 * 60 * 24);
  const ageComponent = Math.exp(-Math.LN2 * ageDays / 7);

  return retrievalComponent * ageComponent;
}

/**
 * LTP (Long-Term Potentiation): reinforce importance
 * LTP_GAIN = 0.1 per reinforcement event
 */
export const LTP_GAIN = 0.1;

/**
 * LTD (Long-Term Depression): decrease importance on failure
 * FAILURE_LOSS = 0.1 per failure event
 */
export const FAILURE_LOSS = 0.1;

/**
 * Apply LTP reinforcement to an engram
 */
export function applyReinforcement(engram: Engram, gain: number = LTP_GAIN): Engram {
  return {
    ...engram,
    importance: Math.min(1.0, engram.importance + gain),
    lastEffectiveAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Apply LTD failure penalty to an engram
 */
export function applyFailure(engram: Engram, loss: number = FAILURE_LOSS): Engram {
  return {
    ...engram,
    importance: Math.max(0.0, engram.importance - loss),
    lastEffectiveAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * State machine transitions
 * draft → active → frozen → forgotten
 */
export type StateTransition =
  | { from: "draft"; to: "active" }
  | { from: "active"; to: "frozen" }
  | { from: "active"; to: "forgotten" }
  | { from: "frozen"; to: "active" }   // Revive
  | { from: "frozen"; to: "forgotten" }
  | { from: "forgotten"; to: never };  // Terminal

const VALID_TRANSITIONS: Record<EngramStatus, EngramStatus[]> = {
  draft: ["active"],
  active: ["frozen", "forgotten"],
  frozen: ["active", "forgotten"],
  forgotten: [],  // Terminal
};

/**
 * Validate and apply state transition
 */
export function transitionStatus(engram: Engram, to: EngramStatus): {
  success: boolean;
  engram?: Engram;
  error?: string;
} {
  const allowed = VALID_TRANSITIONS[engram.status] ?? [];

  if (!allowed.includes(to)) {
    return {
      success: false,
      error: `Invalid transition: ${engram.status} → ${to}`
    };
  }

  return {
    success: true,
    engram: {
      ...engram,
      status: to,
      updatedAt: Date.now(),
    },
  };
}

/**
 * Graph decay for multi-hop retrieval (from TDB research)
 */
export interface GraphDecayOptions {
  hop: number;
  decay: number;           // 0-1, multiplicative per hop
  minScore: number;
  maxNodes?: number;
}

/**
 * Apply decay to a node score in graph traversal
 */
export function applyGraphDecay(
  currentScore: number,
  hop: number,
  options: GraphDecayOptions
): number {
  const decayed = currentScore * Math.pow(options.decay, hop);

  if (decayed < options.minScore) {
    return 0;
  }

  return decayed;
}

/**
 * Decay batch processor (Deep Dreaming stage from Co-Engram research)
 *
 * Process rules:
 * - freshness=forgotten → forget
 * - freshness=stale && importance < 0.2 → archive (frozen)
 * - freshness=stale && importance ≥ 0.2 → no-op
 * - freshness=aging/fresh → no-op
 */
export interface DecayBatchResult {
  forgotten: string[];    // IDs set to forgotten
  frozen: string[];        // IDs set to frozen
  revived: string[];      // IDs revived from frozen
  total: number;
}

export function applyDecayBatch(
  engrams: Engram[],
  config: DecayConfig
): DecayBatchResult {
  const result: DecayBatchResult = {
    forgotten: [],
    frozen: [],
    revived: [],
    total: engrams.length,
  };

  for (const engram of engrams) {
    // Skip already forgotten
    if (engram.status === "forgotten") continue;

    if (!config.stateMachine.enabled) continue;

    const freshness = deriveFreshness(
      engram.lastEffectiveAt,
      engram.importance,
      engram.kind,
      config
    );

    switch (freshness) {
      case "forgotten":
        engram.status = "forgotten";
        result.forgotten.push(engram.id);
        break;

      case "stale":
        if (engram.importance < 0.2) {
          engram.status = "frozen";
          result.frozen.push(engram.id);
        }
        break;

      case "aging":
      case "fresh":
        // Check if reviving from frozen
        if (engram.status === "frozen") {
          engram.status = "active";
          result.revived.push(engram.id);
        }
        break;
    }
  }

  return result;
}

/**
 * TTL-based cleanup with safety thresholds (TDB research)
 */
export interface CleanupResult {
  deleted: number;
  skipped: number;
  errors: string[];
}

export async function applyTTLCleanup(
  engrams: Engram[],
  layerCounts: Record<MemoryLayer, number>,
  config: DecayConfig
): Promise<CleanupResult> {
  const result: CleanupResult = {
    deleted: 0,
    skipped: 0,
    errors: [],
  };

  if (!config.ttl.enabled) {
    return result;
  }

  const cutoff = Date.now() - config.ttl.retentionDays * 24 * 60 * 60 * 1000;
  const total = engrams.filter(e => e.status !== "forgotten").length;

  // Calculate how many we'd delete
  const toDelete = engrams.filter(
    e => e.status === "active" &&
      e.lastEffectiveAt < cutoff
  );

  // Safety threshold check
  if (total > 0 && toDelete.length / total > config.ttl.safetyThreshold) {
    result.errors.push(
      `Safety threshold exceeded: would delete ${toDelete.length}/${total} (${(toDelete.length / total * 100).toFixed(1)}%)`
    );
    result.skipped = toDelete.length;
    return result;
  }

  // Min retain checks per layer
  const deletableByLayer = new Map<MemoryLayer, Engram[]>();

  for (const engram of toDelete) {
    const layer = (engram.metadata?.layer as MemoryLayer) ?? "L1";
    if (!deletableByLayer.has(layer)) {
      deletableByLayer.set(layer, []);
    }
    deletableByLayer.get(layer)!.push(engram);
  }

  for (const [layer, items] of deletableByLayer) {
    const minRetain = layer === "L0"
      ? config.ttl.minRetainL0
      : config.ttl.minRetainL1;

    const currentCount = layerCounts[layer] ?? 0;
    const wouldDelete = items.length;
    const wouldRemain = currentCount - wouldDelete;

    if (wouldRemain < minRetain) {
      // Don't delete all - keep at least minRetain
      const canDelete = currentCount - minRetain;
      for (let i = 0; i < canDelete; i++) {
        items[i].status = "forgotten";
        result.deleted++;
      }
      result.skipped += wouldDelete - canDelete;
    } else {
      for (const engram of items) {
        engram.status = "forgotten";
        result.deleted++;
      }
    }
  }

  return result;
}

/**
 * REM (Rapid Eye Movement) sleep: promote low-level kinds to higher-level
 * observation → fact → pattern → procedure → hypothesis
 */
export function applyREMPromotion(engrams: Engram[]): {
  promoted: Array<{ id: string; from: string; to: string }>;
} {
  const promoted: Array<{ id: string; from: string; to: string }> = [];

  // Kind evolution ladder
  const ladder: Record<string, string> = {
    observation: "fact",
    fact: "pattern",
    pattern: "procedure",
    // hypothesis is top, doesn't evolve
  };

  for (const engram of engrams) {
    if (engram.status !== "active") continue;

    const nextKind = ladder[engram.kind];
    if (!nextKind) continue;

    // Promote if has enough evidence (synapses supporting it)
    const supportingSynapses = engram.synapses.filter(s => s.type === "supports").length;
    if (supportingSynapses >= 3) {
      engram.kind = nextKind as Engram["kind"];
      engram.updatedAt = Date.now();
      promoted.push({ id: engram.id, from: engram.kind, to: nextKind });
    }
  }

  return { promoted };
}
