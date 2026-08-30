/**
 * Team Memory Sync Module
 *
 * Implements team memory with:
 * - Visibility ACL (public/team/private/restricted)
 * - Borrow/import with MAX_IMPORTED_AGENTS limit
 * - 3-phase conflict resolution (from Co-Engram research)
 * - Writer-sharded event log for cross-machine sync
 * - Multi-perspective retention (contradictions coexist)
 */

import type { Engram, EngramVisibility } from "../index.js";

// 3-phase conflict resolution stages
export type ConflictStage = "auto" | "escalate" | "timeout";
export type Verdict = "keep_new" | "keep_old" | "merge" | "archive";

export interface ConflictRecord {
  id: string;
  engramId: string;
  newEngram: Engram;
  oldEngram: Engram;
  stage: ConflictStage;
  confidence: number | null;
  verdict: Verdict | null;
  resolutionState: "pending" | "resolved" | "escalated";
  expiresAt: number | null;
  perspective: string;  // Which viewpoint this conflict represents
  createdAt: number;
}

export interface TeamSyncEvent {
  id: string;
  timestamp: number;
  origin: string;       // Machine/user identifier
  action: "create" | "update" | "share" | "import" | "reinforce" | "decay";
  engramId: string;
  engramSnapshot: Engram;
  actor: string;
}

export interface VisibilityTransition {
  from: EngramVisibility;
  to: EngramVisibility;
  allowed: boolean;
  reason?: string;
}

// Visibility gate rules (from Co-Engram research)
const VISIBILITY_GATE: Record<EngramVisibility, EngramVisibility[]> = {
  public: ["team", "restricted", "public"],
  team: ["public", "restricted", "team"],
  restricted: ["public", "team", "restricted"],
  private: ["public", "team", "restricted", "private"],  // private can go anywhere
};

/**
 * Visibility transition validator
 * Prevents any → private conversion (would be hidden deletion in shared storage)
 */
export function validateVisibilityTransition(
  from: EngramVisibility,
  to: EngramVisibility,
  enforceGate: boolean = true
): VisibilityTransition {
  if (!enforceGate) {
    return { from, to, allowed: true };
  }

  if (from === to) {
    return { from, to, allowed: true };
  }

  // Forbidden: any non-private → private
  if (to === "private" && from !== "private") {
    return {
      from,
      to,
      allowed: false,
      reason: "Visibility gate: conversion to private is forbidden (would hide from team)"
    };
  }

  // Check if transition is in allowed list
  const allowed = VISIBILITY_GATE[from]?.includes(to) ?? false;

  return {
    from,
    to,
    allowed,
    reason: allowed ? undefined : `Visibility gate: ${from} → ${to} not allowed`
  };
}

/**
 * Conflict resolver with 3-phase workflow
 */
export class ConflictResolver {
  private conflicts: Map<string, ConflictRecord> = new Map();
  private autoThreshold: number;

  constructor(autoThreshold: number = 0.8) {
    this.autoThreshold = autoThreshold;
  }

  /**
   * Detect and register a conflict between two versions of an engram
   */
  detectConflict(
    engramId: string,
    newEngram: Engram,
    oldEngram: Engram,
    perspective: string = "default"
  ): ConflictRecord {
    // Check if contradicts relationship exists
    const hasContradiction = oldEngram.synapses.some(
      s => s.targetId === engramId && s.type === "contradicts"
    ) || newEngram.synapses.some(
      s => s.targetId === oldEngram.id && s.type === "contradicts"
    );

    if (!hasContradiction && oldEngram.content === newEngram.content) {
      // No conflict if content is the same
      return {
        id: `conflict_${Date.now()}`,
        engramId,
        newEngram,
        oldEngram,
        stage: "auto",
        confidence: 1.0,
        verdict: "merge",
        resolutionState: "resolved",
        expiresAt: null,
        perspective,
        createdAt: Date.now()
      };
    }

    const conflict: ConflictRecord = {
      id: `conflict_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      engramId,
      newEngram,
      oldEngram,
      stage: "auto",
      confidence: this.estimateConfidence(newEngram, oldEngram),
      verdict: null,
      resolutionState: "pending",
      expiresAt: null,
      perspective,
      createdAt: Date.now()
    };

    this.conflicts.set(conflict.id, conflict);

    // Auto-resolve if confidence is high enough
    if (conflict.confidence !== null && conflict.confidence >= this.autoThreshold) {
      this.resolve(conflict.id);
    } else {
      // Escalate to human
      conflict.stage = "escalate";
      conflict.resolutionState = "escalated";
      conflict.expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
    }

    return conflict;
  }

  private estimateConfidence(newEngram: Engram, oldEngram: Engram): number {
    // Simple confidence estimation based on:
    // - Trust level (direct > external > automated > proposal)
    // - Verification status
    // - Importance difference

    const trustScores = { direct: 1.0, external: 0.7, automated: 0.5, proposal: 0.3 };
    const verificationScores = {
      verified: 1.0, probable: 0.8, plausible: 0.6, unverified: 0.4, refuted: 0.1
    };

    const newTrust = trustScores[newEngram.trustLevel] ?? 0.5;
    const oldTrust = trustScores[oldEngram.trustLevel] ?? 0.5;
    const newVerification = verificationScores[newEngram.verification] ?? 0.5;
    const oldVerification = verificationScores[oldEngram.verification] ?? 0.5;

    const trustDiff = Math.abs(newTrust - oldTrust);
    const verificationDiff = Math.abs(newVerification - oldVerification);

    // Higher confidence if one side clearly has stronger provenance
    const maxConfidence = Math.max(
      (newTrust + newVerification) / 2,
      (oldTrust + oldVerification) / 2
    );

    return maxConfidence - (trustDiff + verificationDiff) * 0.2;
  }

  /**
   * Resolve a conflict with given verdict
   */
  resolve(conflictId: string, verdict?: Verdict, resolvedBy?: string): ConflictRecord {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) {
      throw new Error(`Conflict ${conflictId} not found`);
    }

    // Auto-select verdict if not provided
    if (!verdict) {
      verdict = this.selectVerdict(conflict);
    }

    conflict.verdict = verdict;
    conflict.stage = "auto";
    conflict.resolutionState = "resolved";

    // Apply verdict effects
    this.applyVerdict(conflict, verdict, resolvedBy ?? "system");

    return conflict;
  }

  private selectVerdict(conflict: ConflictRecord): Verdict {
    const { newEngram, oldEngram, confidence } = conflict;

    if (confidence === null) return "archive";

    // High confidence: pick the stronger one
    if (confidence >= this.autoThreshold) {
      if (newEngram.importance > oldEngram.importance) {
        return "keep_new";
      } else if (oldEngram.importance > newEngram.importance) {
        return "keep_old";
      }
      return "merge";
    }

    // Medium confidence: prefer keeping old (status quo)
    if (confidence >= 0.5) {
      return "keep_old";
    }

    // Low confidence: archive for human review
    return "archive";
  }

  private applyVerdict(conflict: ConflictRecord, verdict: Verdict, resolvedBy: string): void {
    const { newEngram, oldEngram } = conflict;

    switch (verdict) {
      case "keep_new":
        oldEngram.verification = "refuted";
        oldEngram.status = "frozen";
        break;

      case "keep_old":
        newEngram.verification = "refuted";
        newEngram.status = "frozen";
        break;

      case "merge":
        // Merge content into old, delete new
        oldEngram.content = this.mergeContent(oldEngram.content, newEngram.content);
        oldEngram.updatedAt = Date.now();
        oldEngram.importance = Math.max(oldEngram.importance, newEngram.importance);
        newEngram.status = "forgotten";
        break;

      case "archive":
        // Both stay but marked as needing review
        conflict.stage = "escalate";
        conflict.resolutionState = "escalated";
        break;
    }
  }

  private mergeContent(oldContent: string, newContent: string): string {
    return `## Previous\n${oldContent}\n\n## Update\n${newContent}`;
  }

  /**
   * Process expired conflicts (phase 3: timeout degradation)
   */
  processExpired(): ConflictRecord[] {
    const now = Date.now();
    const expired: ConflictRecord[] = [];

    for (const conflict of this.conflicts.values()) {
      if (
        conflict.resolutionState === "escalated" &&
        conflict.expiresAt &&
        conflict.expiresAt < now
      ) {
        // Timeout: auto-archive
        conflict.stage = "timeout";
        conflict.verdict = "archive";
        conflict.resolutionState = "resolved";
        expired.push(conflict);
      }
    }

    return expired;
  }

  getConflict(engramId: string): ConflictRecord | undefined {
    for (const conflict of this.conflicts.values()) {
      if (conflict.engramId === engramId) {
        return conflict;
      }
    }
    return undefined;
  }

  listPendingConflicts(): ConflictRecord[] {
    return Array.from(this.conflicts.values())
      .filter(c => c.resolutionState === "pending" || c.resolutionState === "escalated");
  }
}

/**
 * Writer-sharded event log for cross-machine sync
 * Each machine writes to its own file, git-mergeable
 */
export class TeamEventStore {
  private machineId: string;
  private eventDir: string;
  private todayStr: string;
  private writeStream: any = null;
  private pendingEvents: TeamSyncEvent[] = [];

  constructor(machineId: string, eventDir: string = "~/.openclaw/memory-new/events") {
    this.machineId = machineId;
    this.eventDir = eventDir.replace("~", process.env.HOME || "/root");
    this.todayStr = this.getTodayStr();
  }

  private getTodayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  private getFilePath(): string {
    return `${this.eventDir}/${this.todayStr}/${this.machineId}.jsonl`;
  }

  /**
   * Append an event (write to today's file)
   */
  async append(event: Omit<TeamSyncEvent, "id" | "timestamp" | "origin">): Promise<TeamSyncEvent> {
    const fullEvent: TeamSyncEvent = {
      ...event,
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      timestamp: Date.now(),
      origin: this.machineId,
    };

    this.pendingEvents.push(fullEvent);

    // Flush if batch size reached or time elapsed
    if (this.pendingEvents.length >= 100) {
      await this.flush();
    }

    return fullEvent;
  }

  /**
   * Force flush pending events
   */
  async flush(): Promise<void> {
    if (this.pendingEvents.length === 0) return;

    const { appendFileSync, mkdirSync, existsSync } = await import("fs");

    const filePath = this.getFilePath();
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const lines = this.pendingEvents.map(e => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(filePath, lines, "utf8");

    this.pendingEvents = [];
  }

  /**
   * Read events from a date range
   */
  async readEvents(fromDate: string, toDate: string, filter?: {
    engramId?: string;
    action?: TeamSyncEvent["action"];
  }): Promise<TeamSyncEvent[]> {
    const { readFileSync, existsSync } = await import("fs");
    const { readdirSync } = await import("fs");

    const events: TeamSyncEvent[] = [];

    // Parse dates
    const from = new Date(fromDate);
    const to = new Date(toDate);

    // Iterate through date range
    const current = new Date(from);
    while (current <= to) {
      const dateStr = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
      const dirPath = `${this.eventDir}/${dateStr}`;

      if (existsSync(dirPath)) {
        const files = readdirSync(dirPath).filter(f => f.endsWith(".jsonl"));

        for (const file of files) {
          const filePath = `${dirPath}/${file}`;
          const content = readFileSync(filePath, "utf8");
          const lines = content.split("\n").filter(l => l.trim());

          for (const line of lines) {
            try {
              const event: TeamSyncEvent = JSON.parse(line);

              // Apply filters
              if (filter?.engramId && event.engramId !== filter.engramId) continue;
              if (filter?.action && event.action !== filter.action) continue;

              events.push(event);
            } catch {
              // Skip malformed lines
            }
          }
        }
      }

      current.setDate(current.getDate() + 1);
    }

    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get latest state of an engram from event log
   */
  async getLatestState(engramId: string, since?: number): Promise<TeamSyncEvent | null> {
    const sinceStr = since
      ? new Date(since).toISOString().split("T")[0]
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const events = await this.readEvents(sinceStr, this.todayStr, { engramId });

    // Return last event for this engram
    const relevant = events.filter(e => e.engramId === engramId);
    return relevant.length > 0 ? relevant[relevant.length - 1] : null;
  }
}

/**
 * Team memory manager with borrow/import semantics
 */
export class TeamMemoryManager {
  private importedAgents: Map<string, string[]> = new Map();  // agentId → imported engram IDs
  private sharedByAgent: Map<string, Set<string>> = new Map(); // agentId → shared engram IDs
  private maxImportedAgents: number;

  constructor(maxImportedAgents: number = 2) {
    this.maxImportedAgents = maxImportedAgents;
  }

  /**
   * Share an engram with the team
   */
  share(engram: Engram, ownerId: string): { success: boolean; error?: string } {
    // Validate visibility transition
    const transition = validateVisibilityTransition(engram.visibility, "team");
    if (!transition.allowed) {
      return { success: false, error: transition.reason };
    }

    // Update engram visibility
    engram.visibility = "team";
    engram.updatedAt = Date.now();

    // Track shared engram
    if (!this.sharedByAgent.has(ownerId)) {
      this.sharedByAgent.set(ownerId, new Set());
    }
    this.sharedByAgent.get(ownerId)!.add(engram.id);

    return { success: true };
  }

  /**
   * Import another agent's memory into local context
   */
  import(
    fromAgentId: string,
    toAgentId: string,
    engramIds: string[]
  ): { success: boolean; error?: string; imported?: string[] } {
    // Check import limit
    const currentImports = this.importedAgents.get(toAgentId) ?? [];
    const newImports = engramIds.filter(id => !currentImports.includes(id));

    if (currentImports.length + newImports.length > this.maxImportedAgents) {
      return {
        success: false,
        error: `Import limit exceeded: max ${this.maxImportedAgents} agents, have ${currentImports.length}`
      };
    }

    // Add to imports
    const allImports = [...currentImports, ...newImports];
    this.importedAgents.set(toAgentId, allImports);

    return { success: true, imported: newImports };
  }

  /**
   * Get imported engram IDs for an agent
   */
  getImportedEngrams(agentId: string): string[] {
    return this.importedAgents.get(agentId) ?? [];
  }

  /**
   * Get shared engrams by an agent
   */
  getSharedEngrams(ownerId: string): string[] {
    return Array.from(this.sharedByAgent.get(ownerId) ?? []);
  }

  /**
   * Check if an engram is accessible to an agent (owned, shared with team, or imported)
   */
  canAccess(engram: Engram, agentId: string): boolean {
    // Owned by agent
    if (engram.createdBy === agentId) return true;

    // Shared with team
    if (engram.visibility === "team" || engram.visibility === "public") return true;

    // Imported
    const imported = this.importedAgents.get(agentId) ?? [];
    if (imported.includes(engram.id)) return true;

    return false;
  }
}
