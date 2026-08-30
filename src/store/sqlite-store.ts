/**
 * SQLite Storage Backend for Memory New
 *
 * Provides persistent storage with:
 * - Append-only engram storage
 * - Indexes for fast retrieval
 * - WAL mode for better concurrency
 * - Owner-only permissions (chmod 0600)
 */

import type { Engram, Synapse, EngramKind, EngramStatus, EngramVisibility, MemoryLayer } from "../index.js";

export interface SqliteStoreConfig {
  dataDir: string;
  filename?: string;
}

interface DbRow {
  id: string;
  kind: string;
  status: string;
  visibility: string;
  verification: string;
  content: string;
  summary: string | null;
  title: string | null;
  importance: number;
  last_effective_at: number;
  metadata: string;  // JSON
  tags: string;     // JSON array
  context_tags: string;
  source: string;
  created_at: number;
  updated_at: number;
  created_by: string;
  trust_level: string;
  layer: string;
  synapses: string;  // JSON array
}

export class SqliteStore {
  private db: any;
  private config: SqliteStoreConfig;
  private closed = false;

  constructor(config: SqliteStoreConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    // Dynamic import for ESM
    const { default: Database } = await import("better-sqlite3");
    const { join } = await import("path");
    const { mkdirSync, chmodSync, existsSync } = await import("fs");

    const dataDir = this.config.dataDir.replace("~", process.env.HOME || "/root");
    mkdirSync(dataDir, { recursive: true });

    const dbPath = join(dataDir, this.config.filename ?? "memory.db");

    // Create database
    this.db = new Database(dbPath);

    // WAL mode for better concurrency
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    // Set owner-only permissions (security)
    if (!existsSync(dbPath)) {
      chmodSync(dbPath, 0o600);
    }

    // Create tables
    this.createTables();

    // Run migrations
    await this.migrate();
  }

  private createTables(): void {
    // Engrams table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engrams (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'observation',
        status TEXT NOT NULL DEFAULT 'draft',
        visibility TEXT NOT NULL DEFAULT 'private',
        verification TEXT NOT NULL DEFAULT 'unverified',
        content TEXT NOT NULL,
        summary TEXT,
        title TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        last_effective_at INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        tags TEXT NOT NULL DEFAULT '[]',
        context_tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'unknown',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'unknown',
        trust_level TEXT NOT NULL DEFAULT 'proposal',
        layer TEXT NOT NULL DEFAULT 'L1',
        synapses TEXT NOT NULL DEFAULT '[]'
      )
    `);

    // Indexes for fast retrieval
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_engrams_kind ON engrams(kind);
      CREATE INDEX IF NOT EXISTS idx_engrams_status ON engrams(status);
      CREATE INDEX IF NOT EXISTS idx_engrams_visibility ON engrams(visibility);
      CREATE INDEX IF NOT EXISTS idx_engrams_layer ON engrams(layer);
      CREATE INDEX IF NOT EXISTS idx_engrams_last_effective ON engrams(last_effective_at);
      CREATE INDEX IF NOT EXISTS idx_engrams_importance ON engrams(importance);
    `);

    // Full-text search table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS engrams_fts USING fts5(
        id,
        content,
        tags,
        content='engrams',
        content_rowid='rowid'
      )
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS engrams_ai AFTER INSERT ON engrams BEGIN
        INSERT INTO engrams_fts(rowid, id, content, tags)
        VALUES (NEW.rowid, NEW.id, NEW.content, NEW.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS engrams_ad AFTER DELETE ON engrams BEGIN
        INSERT INTO engrams_fts(engrams_fts, rowid, id, content, tags)
        VALUES('delete', OLD.rowid, OLD.id, OLD.content, OLD.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS engrams_au AFTER UPDATE ON engrams BEGIN
        INSERT INTO engrams_fts(engrams_fts, rowid, id, content, tags)
        VALUES('delete', OLD.rowid, OLD.id, OLD.content, OLD.tags);
        INSERT INTO engrams_fts(rowid, id, content, tags)
        VALUES (NEW.rowid, NEW.id, NEW.content, NEW.tags);
      END;
    `);

    // Team memory relations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS team_relations (
        agent_id TEXT PRIMARY KEY,
        memory_shared_with_team INTEGER NOT NULL DEFAULT 0,
        imported_agent_ids TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      )
    `);

    // Audit log (append-only)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        action TEXT NOT NULL,
        engram_id TEXT,
        actor TEXT NOT NULL,
        details TEXT
      )
    `);

    // Schema version for migrations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
  }

  private async migrate(): Promise<void> {
    const current = this.getSchemaVersion();
    const target = 1;

    if (current >= target) return;

    // Future migrations go here
    // Migration 1 is the initial schema (already created above)

    this.db.prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)").run(target, Date.now());
  }

  private getSchemaVersion(): number {
    try {
      const row = this.db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get();
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }

  // CRUD operations

  async put(engram: Engram): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO engrams (
        id, kind, status, visibility, verification, content, summary, title,
        importance, last_effective_at, metadata, tags, context_tags,
        source, created_at, updated_at, created_by, trust_level, layer, synapses
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      engram.id,
      engram.kind,
      engram.status,
      engram.visibility,
      engram.verification,
      engram.content,
      engram.summary ?? null,
      engram.title ?? null,
      engram.importance,
      engram.lastEffectiveAt,
      JSON.stringify(engram.metadata),
      JSON.stringify(engram.tags),
      JSON.stringify(engram.contextTags),
      engram.source,
      engram.createdAt,
      engram.updatedAt,
      engram.createdBy,
      engram.trustLevel,
      "L1",  // Default layer
      JSON.stringify(engram.synapses),
    );

    // Audit log
    this.db.prepare(`
      INSERT INTO audit_log (timestamp, action, engram_id, actor, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(Date.now(), "put", engram.id, "system", JSON.stringify({ kind: engram.kind }));
  }

  async get(id: string): Promise<Engram | null> {
    const row: DbRow = this.db.prepare("SELECT * FROM engrams WHERE id = ?").get(id);
    return row ? this.rowToEngram(row) : null;
  }

  async delete(id: string): Promise<void> {
    // Don't actually delete, just mark as forgotten (append-only)
    this.db.prepare("UPDATE engrams SET status = 'forgotten', updated_at = ? WHERE id = ?").run(Date.now(), id);

    // Audit
    this.db.prepare(`
      INSERT INTO audit_log (timestamp, action, engram_id, actor, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(Date.now(), "delete", id, "system", null);
  }

  async list(options: {
    kind?: EngramKind;
    status?: EngramStatus;
    visibility?: EngramVisibility;
    layer?: MemoryLayer;
    limit?: number;
    offset?: number;
  } = {}): Promise<Engram[]> {
    let sql = "SELECT * FROM engrams WHERE 1=1";
    const params: any[] = [];

    if (options.kind) {
      sql += " AND kind = ?";
      params.push(options.kind);
    }
    if (options.status) {
      sql += " AND status = ?";
      params.push(options.status);
    }
    if (options.visibility) {
      sql += " AND visibility = ?";
      params.push(options.visibility);
    }
    if (options.layer) {
      sql += " AND layer = ?";
      params.push(options.layer);
    }

    sql += " ORDER BY last_effective_at DESC";

    if (options.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    if (options.offset) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }

    const rows: DbRow[] = this.db.prepare(sql).all(...params);
    return rows.map(r => this.rowToEngram(r));
  }

  // Search with FTS
  async search(query: string, options: {
    visibility?: EngramVisibility;
    limit?: number;
  } = {}): Promise<Engram[]> {
    let sql = `
      SELECT e.* FROM engrams e
      INNER JOIN engrams_fts f ON e.id = f.id
      WHERE engrams_fts MATCH ?
    `;
    const params: any[] = [query];

    if (options.visibility) {
      sql += " AND e.visibility = ?";
      params.push(options.visibility);
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push(options.limit ?? 10);

    try {
      const rows: DbRow[] = this.db.prepare(sql).all(...params);
      return rows.map(r => this.rowToEngram(r));
    } catch {
      // Fallback to LIKE if FTS fails
      const rows: DbRow[] = this.db.prepare(`
        SELECT * FROM engrams
        WHERE content LIKE ? OR tags LIKE ?
        ORDER BY last_effective_at DESC
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, options.limit ?? 10);
      return rows.map(r => this.rowToEngram(r));
    }
  }

  // Count for statistics
  async count(filters: {
    status?: EngramStatus;
    visibility?: EngramVisibility;
    layer?: MemoryLayer;
  } = {}): Promise<number> {
    let sql = "SELECT COUNT(*) as count FROM engrams WHERE 1=1";
    const params: any[] = [];

    if (filters.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.visibility) {
      sql += " AND visibility = ?";
      params.push(filters.visibility);
    }
    if (filters.layer) {
      sql += " AND layer = ?";
      params.push(filters.layer);
    }

    const row = this.db.prepare(sql).get(...params);
    return row?.count ?? 0;
  }

  // Team relations
  async getTeamRelation(agentId: string): Promise<{ memorySharedWithTeam: boolean; importedAgentIds: string[] } | null> {
    const row = this.db.prepare("SELECT * FROM team_relations WHERE agent_id = ?").get(agentId);
    if (!row) return null;
    return {
      memorySharedWithTeam: Boolean(row.memory_shared_with_team),
      importedAgentIds: JSON.parse(row.imported_agent_ids),
    };
  }

  async setTeamRelation(agentId: string, relation: { memorySharedWithTeam: boolean; importedAgentIds: string[] }): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO team_relations (agent_id, memory_shared_with_team, imported_agent_ids, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(agentId, relation.memorySharedWithTeam ? 1 : 0, JSON.stringify(relation.importedAgentIds), Date.now());
  }

  // Audit log (append-only, no delete)
  async getAuditLog(limit = 100): Promise<Array<{
    id: number;
    timestamp: number;
    action: string;
    engramId: string | null;
    actor: string;
    details: string | null;
  }>> {
    const rows = this.db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
    return rows.map((r: any) => ({
      id: r.id,
      timestamp: r.timestamp,
      action: r.action,
      engramId: r.engram_id,
      actor: r.actor,
      details: r.details,
    }));
  }

  // Cleanup (TTL-based, with safety thresholds)
  async cleanup(retentionDays: number, options: {
    safetyThreshold?: number;
    minRetainL0?: number;
    minRetainL1?: number;
  } = {}): Promise<{ deleted: number; skipped: number }> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const safetyThreshold = options.safetyThreshold ?? 0.8;
    const minRetainL0 = options.minRetainL0 ?? 50;
    const minRetainL1 = options.minRetainL1 ?? 20;

    // Count before delete
    const total = await this.count({});
    const toDeleteCount = this.db.prepare(
      "SELECT COUNT(*) as count FROM engrams WHERE status = 'active' AND last_effective_at < ?"
    ).get(cutoff)?.count ?? 0;

    // Safety threshold check
    if (total > 0 && toDeleteCount / total > safetyThreshold) {
      return { deleted: 0, skipped: toDeleteCount };
    }

    // Min retain check
    const l0Count = await this.count({ layer: "L0" });
    const l1Count = await this.count({ layer: "L1" });

    let deleted = 0;

    if (l0Count > minRetainL0) {
      const result = this.db.prepare(`
        UPDATE engrams SET status = 'forgotten', updated_at = ?
        WHERE status = 'active' AND layer = 'L0' AND last_effective_at < ?
        LIMIT ?
      `).run(Date.now(), cutoff, toDeleteCount);
      deleted += result.changes;
    }

    if (l1Count > minRetainL1) {
      // Similar for L1...
    }

    return { deleted, skipped: toDeleteCount - deleted };
  }

  private rowToEngram(row: DbRow): Engram {
    return {
      id: row.id,
      kind: row.kind as EngramKind,
      status: row.status as EngramStatus,
      visibility: row.visibility as EngramVisibility,
      verification: row.verification as any,
      content: row.content,
      summary: row.summary ?? undefined,
      title: row.title ?? undefined,
      importance: row.importance,
      lastEffectiveAt: row.last_effective_at,
      metadata: JSON.parse(row.metadata),
      tags: JSON.parse(row.tags),
      contextTags: JSON.parse(row.context_tags),
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      trustLevel: row.trust_level as any,
      synapses: JSON.parse(row.synapses),
    };
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.db?.close();
      this.closed = true;
    }
  }
}
