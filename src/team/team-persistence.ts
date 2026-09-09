/**
 * Persistent team memory state — agent-level share/import relations.
 *
 * Mirrors TDB's runtime model (see docs/研究.md §4.3): each agent has one
 * relation file that owns:
 *   - sharedToTeam      : boolean flip — whole agent's L1 is team-visible
 *   - importedAgentIds  : list of (≤ maxImportedAgents) agents the reader has
 *                         explicitly bound to, used to expand their L1 into
 *                         the reader's recall (TDB two-step: share first, then
 *                         bind to read).
 *
 * Persistence: <dataDir>/team/agents/<sanitizedAgentId>.json, atomic single-tick
 * write (writeFileSync → .tmp → renameSync). No async between read and write
 * of the same key — matches the L1 single-tick invariant for decay status flips.
 *
 * NOT in this round: per-engram visibility, multi-machine sync (events are
 * appended but not consumed), 3-phase conflict resolution.
 */

import { existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeJsonAtomic } from "../setup/visualize-setup.js";
import { sanitizeAgentId } from "./team-identity.js";
import type { TeamEventStore, TeamSyncEvent } from "./team-memory.js";

export interface AgentRelationFile {
  schemaVersion: 1;
  agentId: string;
  sharedToTeam: boolean;
  importedAgentIds: string[];
  updatedAt: number;
}

export interface TeamPersistenceConfig {
  /** Resolved dataDir (already ~-expanded). Default: ~/.openclaw/memory-new */
  dataDir: string;
  /** Single-team v1; all agents in this gateway share one teamId. */
  teamId: string;
  /** Hard cap on importedAgentIds length. Default 2 (mirrors TDB MAX). */
  maxImportedAgents: number;
  /** Optional logger — used for one-shot warn when file ops fail. */
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

export interface MutationResult {
  ok: boolean;
  error?: string;
}

const DEFAULT_REL: Omit<AgentRelationFile, "agentId"> = {
  schemaVersion: 1,
  sharedToTeam: false,
  importedAgentIds: [],
  updatedAt: 0,
};

/**
 * Persistent team-memory state, per-agent relation files.
 */
export class TeamPersistence {
  private readonly cfg: TeamPersistenceConfig;
  private readonly events: TeamEventStore | undefined;
  private readonly relDir: string;
  /** In-process cache to avoid re-parsing on every read. Survives only the current process. */
  private cache: Map<string, AgentRelationFile> = new Map();

  constructor(cfg: TeamPersistenceConfig, events?: TeamEventStore) {
    this.cfg = cfg;
    this.events = events;
    this.relDir = join(this.cfg.dataDir, "team", "agents");
    try {
      mkdirSync(this.relDir, { recursive: true });
    } catch {
      // dir may already exist; ignore
    }
  }

  /** Read the relation file for one agent. Never throws — returns default on any error. */
  readRelation(agentId: string): AgentRelationFile {
    const sanitized = sanitizeAgentId(agentId);
    const cached = this.cache.get(sanitized);
    if (cached) return cached;

    const file = join(this.relDir, `${sanitized}.json`);
    let rel: AgentRelationFile;
    if (!existsSync(file)) {
      rel = { ...DEFAULT_REL, agentId, updatedAt: 0 };
    } else {
      try {
        const raw = readFileSync(file, "utf-8");
        const parsed = JSON.parse(raw) as Partial<AgentRelationFile>;
        rel = {
          schemaVersion: 1,
          agentId,
          sharedToTeam: parsed.sharedToTeam === true,
          importedAgentIds: Array.isArray(parsed.importedAgentIds)
            ? Array.from(new Set(parsed.importedAgentIds.filter((s) => typeof s === "string" && s.length > 0)))
            : [],
          updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
        };
      } catch (e) {
        this.cfg.logger?.warn?.(`[memory_new] team relation read failed for ${sanitized}: ${(e as Error).message}; using defaults`);
        rel = { ...DEFAULT_REL, agentId, updatedAt: 0 };
      }
    }
    this.cache.set(sanitized, rel);
    return rel;
  }

  /** Share (or unshare) the agent's whole memory with the team. Only the owner may flip it. */
  setSharedToTeam(agentId: string, on: boolean, actor: string): MutationResult {
    if (actor !== agentId) {
      return { ok: false, error: `only the agent itself can flip its sharedToTeam flag (actor=${actor})` };
    }
    const rel = this.readRelation(agentId);
    if (rel.sharedToTeam === on) return { ok: true };
    const next: AgentRelationFile = { ...rel, sharedToTeam: on, updatedAt: Date.now() };
    this.persist(agentId, next);
    this.fireEvent("share", agentId, next, actor);
    return { ok: true };
  }

  /** Add an agent to the reader's imported set. Actor must be the reader (self-binding only). */
  importAgent(actor: string, fromAgentId: string): MutationResult {
    if (actor === fromAgentId) {
      return { ok: false, error: "cannot import your own agent" };
    }
    if (!fromAgentId || !fromAgentId.trim()) {
      return { ok: false, error: "fromAgentId must be a non-empty string" };
    }
    const rel = this.readRelation(actor);
    if (rel.importedAgentIds.includes(fromAgentId)) {
      return { ok: true }; // idempotent
    }
    if (rel.importedAgentIds.length >= this.cfg.maxImportedAgents) {
      return {
        ok: false,
        error: `import limit reached: max ${this.cfg.maxImportedAgents} agents, have ${rel.importedAgentIds.length}`,
      };
    }
    const next: AgentRelationFile = {
      ...rel,
      importedAgentIds: [...rel.importedAgentIds, fromAgentId],
      updatedAt: Date.now(),
    };
    this.persist(actor, next);
    this.fireEvent("import", actor, next, actor);
    return { ok: true };
  }

  /** Remove an agent from the reader's imported set. */
  unimportAgent(actor: string, fromAgentId: string): MutationResult {
    const rel = this.readRelation(actor);
    if (!rel.importedAgentIds.includes(fromAgentId)) {
      return { ok: true }; // idempotent
    }
    const next: AgentRelationFile = {
      ...rel,
      importedAgentIds: rel.importedAgentIds.filter((id) => id !== fromAgentId),
      updatedAt: Date.now(),
    };
    this.persist(actor, next);
    this.fireEvent("import", actor, next, actor); // reuse 'import' action; semantic = mutate binding set
    return { ok: true };
  }

  /** Reader's current imported set (empty array if none). */
  listImportedAgentIds(actor: string): string[] {
    return this.readRelation(actor).importedAgentIds.slice();
  }

  /** All agents that have flipped their sharedToTeam flag to true. Reads every relation file. */
  async listSharedAgents(): Promise<string[]> {
    return this.scanAll((rel) => (rel.sharedToTeam ? rel.agentId : null)).filter((x): x is string => !!x);
  }

  /** Candidates for the actor to import: every other agent in the same gateway, excluding self. */
  async listImportableAgentIds(actor: string): Promise<string[]> {
    const fromConfig = await this.scanOpenclawAgentIds();
    const fromRelations = this.scanAll((rel) => rel.agentId);
    const all = new Set<string>([...fromConfig, ...fromRelations]);
    all.delete(actor);
    return Array.from(all).sort();
  }

  // -------- internals --------

  private persist(agentId: string, rel: AgentRelationFile): void {
    const sanitized = sanitizeAgentId(agentId);
    const file = join(this.relDir, `${sanitized}.json`);
    try {
      writeJsonAtomic(file, rel);
      this.cache.set(sanitized, rel);
    } catch (e) {
      this.cfg.logger?.warn?.(`[memory_new] team relation write failed for ${sanitized}: ${(e as Error).message}`);
    }
  }

  private fireEvent(action: TeamSyncEvent["action"], agentId: string, rel: AgentRelationFile, actor: string): void {
    if (!this.events) return;
    try {
      // events.append is async; we don't await — fire and forget, matches
      // existing markRecalled/reinforceRecalled behavior.
      void this.events.append({
        action,
        engramId: `agent-relation:${agentId}`,
        engramSnapshot: {
          id: `agent-relation:${agentId}`,
          kind: "fact",
          status: "active",
          visibility: "team",
          verification: "probable",
          content: JSON.stringify(rel),
          importance: 0.5,
          lastEffectiveAt: rel.updatedAt,
          metadata: { teamMemory: true, teamId: this.cfg.teamId },
          tags: ["team-memory"],
          contextTags: [],
          source: "team-persistence",
          createdAt: rel.updatedAt,
          updatedAt: rel.updatedAt,
          createdBy: actor,
          trustLevel: "direct",
          synapses: [],
        },
        actor,
      });
    } catch {
      // event log failures must never block the relation mutation
    }
  }

  private scanAll(visit: (rel: AgentRelationFile) => string | null | undefined): string[] {
    const out: Array<string | null> = [];
    try {
      const files = readdirSync(this.relDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        const agentId = f.replace(/\.json$/, "");
        const rel = this.readRelation(agentId);
        out.push(visit(rel));
      }
    } catch {
      // dir missing or unreadable — return what we have
    }
    return out.filter((x): x is string => typeof x === "string");
  }

  /**
   * Scan well-known openclaw.json profiles for `agents.entries.<id>` or
   * `agents.list[]` to discover what agents exist in this gateway.
   *
   * Single-team v1: all agents share one team. We look at both default and test
   * profiles' openclaw.json so the dev environment matches what the running
   * gateway sees.
   */
  private async scanOpenclawAgentIds(): Promise<string[]> {
    const home = homedir();
    const candidates = [
      join(home, ".openclaw", "openclaw.json"),
      join(home, ".openclaw-test", "openclaw.json"),
    ];
    const ids = new Set<string>();
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const raw = readFileSync(path, "utf-8");
        const cfg = JSON.parse(raw) as {
          agents?: { entries?: Record<string, unknown>; list?: Array<{ id?: string }> };
        };
        // agents.entries is a map (the legacy / current shape per openclaw.json);
        // agents.list is the array shape per SDK types.
        if (cfg.agents?.entries && typeof cfg.agents.entries === "object") {
          for (const id of Object.keys(cfg.agents.entries)) ids.add(id);
        }
        if (Array.isArray(cfg.agents?.list)) {
          for (const a of cfg.agents.list) if (a?.id) ids.add(a.id);
        }
      } catch {
        // skip malformed
      }
    }
    return Array.from(ids);
  }

  /** For tests / dashboard: read raw file paths (sanitized) of all known relation files. */
  _knownRelationFiles(): string[] {
    try {
      return readdirSync(this.relDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
  }
}
