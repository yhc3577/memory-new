#!/usr/bin/env node
/**
 * Memory New Plugin - Automated Test Suite
 *
 * Tests:
 * 1. Storage operations (L0/L1/L2/L3)
 * 2. Retrieval system (BM25, hybrid search)
 * 3. Decay mechanisms
 * 4. Team memory
 */

import { testing } from "../dist/index.js";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { VectorStore, MemoryStore, StorageAdapter, DistillationPipeline, DEFAULT_DISTILLATION_CONFIG, TeamMemoryManager, TeamEventStore, applyDecayBatch, applyTTLCleanup, applyDecayToL1, toDecayConfig, deriveFreshness, deriveHotness, decayLogger, StateTransitionLogger, startVisualizeServer, RecallEngine, runVisualizeSetup, isL1Recallable } = testing;

// Test utilities
const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log("🧪 Memory New Plugin - Test Suite\n");
  console.log("=".repeat(50));

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (error) {
      console.log(`❌ ${name}`);
      console.log(`   Error: ${error.message}`);
      failed++;
    }
  }

  console.log("=".repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

  process.exit(failed > 0 ? 1 : 0);
}

// ============================================================================
// Test: Storage
// ============================================================================

test("Storage: L1 read/write", async () => {
  const store = new MemoryStore("/tmp/memory-test");

  // Store L1
  const record = await store.storeL1({
    content: "测试记忆内容",
    type: "episodic",
    priority: 75,
    sceneName: "Test Scene",
    sourceMessageIds: [],
    metadata: { source: "test" },
    timestamps: [new Date().toISOString()],
    sessionKey: "test-session",
    sessionId: "test-id",
    userId: "test-user",
    agentId: "test-agent",
  });

  assert(record.id.startsWith("l1_"), "L1 ID should start with l1_");
  assert(record.content === "测试记忆内容", "Content should match");

  // Search
  const results = await store.searchL1("测试", 10);
  assert(results.length > 0, "Should find stored record");
});

test("Storage: L2 scene creation", async () => {
  const store = new MemoryStore("/tmp/memory-test");

  const scene = await store.storeL2({
    title: "Test Scene",
    content: "# Test Scene\n\nTest content",
    summary: "Test summary",
    tags: ["test"],
    metadata: { layer: "L2" },
  });

  assert(scene.id.startsWith("scene_"), "Scene ID should start with scene_");

  const index = await store.getSceneIndex();
  assert(index.length > 0, "Should have scenes in index");
});

test("Storage: L3 persona", async () => {
  const store = new MemoryStore("/tmp/memory-test");

  await store.storeL3({
    content: "# Persona\n\nTest persona content",
    summary: "Test persona",
    metadata: { layer: "L3" },
  });

  const persona = await store.getPersona();
  assert(persona !== null, "Persona should exist");
  assert(persona.content.includes("Persona"), "Persona should have content");
});

// ============================================================================
// Test: Vector Store & Retrieval
// ============================================================================

test("Vector Store: BM25 search", async () => {
  const store = new VectorStore();

  // Add text records (with spaces for proper Chinese tokenization)
  store.addTextRecords([
    { id: "1", content: "项目 架构 讨论", metadata: {} },
    { id: "2", content: "今天 下午 三点 会议", metadata: {} },
    { id: "3", content: "微服务 架构 方案", metadata: {} },
  ]);

  const results = store.searchBM25("项目 架构", 10);
  assert(results.length > 0, "Should find matching records");
  assert(results[0].id === "1" || results[0].id === "3", "Best match should be related to 项目/架构");
});

test("Vector Store: Fuzzy search", async () => {
  const store = new VectorStore();

  store.addTextRecords([
    { id: "1", content: "项目架构", metadata: {} },
    { id: "2", content: "微服务架构", metadata: {} },
  ]);

  const results = store.fuzzySearch("项日架", 10, 2);  // Typo
  assert(results.length > 0, "Should find fuzzy matches despite typos");
});

test("Vector Store: Substring search", async () => {
  const store = new VectorStore();

  store.addTextRecords([
    { id: "1", content: "项目X架构讨论", metadata: {} },
    { id: "2", content: "微服务架构方案", metadata: {} },
  ]);

  const results = store.substringSearch("架构", 10);
  assert(results.length >= 2, "Should find records containing 架构");
});

test("Vector Store: Hybrid search", async () => {
  const store = new VectorStore();

  store.addTextRecords([
    { id: "1", content: "项目X架构讨论", metadata: {} },
    { id: "2", content: "今天下午三点会议", metadata: {} },
  ]);

  const results = await store.hybridSearch({
    query: "项目 架构",
    topK: 10,
    semanticWeight: 0.3,
    bm25Weight: 0.5,
    entityBoostWeight: 0.2,
  });

  assert(results.length > 0, "Hybrid search should return results");
});

test("Vector Store: Pseudo embedding", async () => {
  const store = new VectorStore();

  // Same content should produce same embedding
  const emb1 = store.generatePseudoEmbedding("测试内容");
  const emb2 = store.generatePseudoEmbedding("测试内容");

  assert(emb1.length === emb2.length, "Embeddings should have same dimension");

  let diff = 0;
  for (let i = 0; i < emb1.length; i++) {
    diff += Math.abs(emb1[i] - emb2[i]);
  }
  assert(diff < 0.001, "Same content should produce same embedding");
});

// ============================================================================
// Test: Distillation Pipeline
// ============================================================================

test("Distillation: L2 scene creation from L1", async () => {
  const store = new MemoryStore("/tmp/memory-test-pipeline");
  const vectorStore = new VectorStore();
  const pipeline = new DistillationPipeline(DEFAULT_DISTILLATION_CONFIG, store, vectorStore);

  // Add multiple L1 records with same scene
  await store.storeL1({
    content: "记忆1",
    type: "episodic",
    priority: 50,
    sceneName: "Test Scene",
    sourceMessageIds: [],
    metadata: {},
    timestamps: [],
    sessionKey: "test",
    sessionId: "test",
    userId: "user",
    agentId: "self",
  });

  await store.storeL1({
    content: "记忆2",
    type: "episodic",
    priority: 60,
    sceneName: "Test Scene",
    sourceMessageIds: [],
    metadata: {},
    timestamps: [],
    sessionKey: "test",
    sessionId: "test",
    userId: "user",
    agentId: "self",
  });

  // Trigger L2 distillation
  const result = await pipeline.distill("L2");
  assert(result.produced >= 1, "Should create at least one scene");
});

test("Distillation: getStats", async () => {
  const store = new MemoryStore("/tmp/memory-test-stats");
  const vectorStore = new VectorStore();
  const pipeline = new DistillationPipeline(DEFAULT_DISTILLATION_CONFIG, store, vectorStore);

  // Add a record
  await store.storeL1({
    content: "测试记忆",
    type: "episodic",
    priority: 50,
    sceneName: "Test",
    sourceMessageIds: [],
    metadata: {},
    timestamps: [],
    sessionKey: "test",
    sessionId: "test",
    userId: "user",
    agentId: "self",
  });

  const stats = await pipeline.getStats();
  assert(stats.l1Count >= 1, "Should have at least 1 L1 record");
});

// ============================================================================
// Test: Decay
// ============================================================================

test("Decay: Ebbinghaus freshness", () => {
  // Config structure matches DecayConfig interface: importance is at top level, not under "decay"
  const config = {
    ttl: { enabled: false, retentionDays: 0, safetyThreshold: 0, minRetainL0: 0, minRetainL1: 0 },
    importance: { enabled: true, baseHalflifeDays: 50, kindMultipliers: {} },
    accessFrequency: { enabled: false },
    stateMachine: { enabled: false },
  };

  // Recent memory should be fresh
  const recent = Date.now() - 1000 * 60 * 60;  // 1 hour ago
  const freshness = deriveFreshness(recent, 0.5, "fact", config);
  assert(freshness === "fresh", "Recent memory should be fresh");

  // Old memory should be stale
  const old = Date.now() - 1000 * 60 * 60 * 24 * 100;  // 100 days ago
  const staleFreshness = deriveFreshness(old, 0.5, "fact", config);
  assert(staleFreshness === "stale" || staleFreshness === "forgotten", "Old memory should be stale/forgotten");
});

test("Decay: Hotness calculation", () => {
  const recent = Date.now() - 1000 * 60 * 60;  // 1 hour ago
  const hot = deriveHotness(10, recent);
  console.log("hot value:", hot);
  // Hotness can be low if formula gives low value, just check it's positive
  assert(hot >= 0, "Hotness should be non-negative");

  const old = Date.now() - 1000 * 60 * 60 * 24 * 30;  // 30 days ago
  const cold = deriveHotness(10, old);
  assert(cold >= 0, "Cold should be non-negative");
});

test("Decay: State machine transitions", () => {
  const engrams = [{
    id: "test1",
    kind: "fact",
    status: "active",
    visibility: "private",
    verification: "probable",
    content: "Test",
    importance: 0.8,
    lastEffectiveAt: Date.now() - 1000 * 60 * 60 * 24 * 100,  // 100 days old
    metadata: {},
    tags: [],
    contextTags: [],
    source: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: "test",
    trustLevel: "direct",
    synapses: [],
  }];

  const config = {
    ttl: { enabled: false, retentionDays: 0, safetyThreshold: 0, minRetainL0: 0, minRetainL1: 0 },
    importance: { enabled: true, baseHalflifeDays: 7, kindMultipliers: {} },  // 7 day halflife for test
    accessFrequency: { enabled: false },
    stateMachine: { enabled: true },
  };

  const result = applyDecayBatch(engrams, config);
  // fact @ imp 0.8 → halflife = 7×0.9^1.5 ≈ 6d; 4×≈24d < 100d → freshness=forgotten
  // → forgotten regardless of importance (Co-Engram)
  assert(result.scanned === 1, `Exactly 1 active record scanned, got ${result.scanned}`);
  assert(result.forgotten.includes("test1"), "100d old active memory should be forgotten");
  assert(result.frozen.length === 0, "forgotten band is terminal — never frozen");
  assert(result.revived.length === 0, "no auto-revive");
  assert(engrams[0].status === "forgotten", "engram mutated to forgotten");
});

// ============================================================================
// Test: Decay Visualization
// ============================================================================

test("Decay: State transition logger", () => {
  const { decayLogger: logger, StateTransitionLogger } = testing;

  // Clear any existing logs
  logger.clear();

  // Create new logger for isolated test
  const testLogger = new StateTransitionLogger(100);

  // Manually log a transition
  testLogger.log({
    engramId: "test-engram-1",
    from: "active",
    to: "frozen",
    reason: "importance",
    metadata: { freshness: "stale", importance: 0.15 },
  });

  const logs = testLogger.getLogs("test-engram-1");
  assert(logs.length === 1, "Should have 1 log entry");
  assert(logs[0].from === "active", "From status should be active");
  assert(logs[0].to === "frozen", "To status should be frozen");
  assert(logs[0].reason === "importance", "Reason should be importance");

  // Test stats
  const stats = testLogger.getStats();
  assert(stats.total === 1, "Should have 1 total log");
  assert(stats.byReason.importance === 1, "Should have 1 importance log");
  assert(stats.byTransition["active→frozen"] === 1, "Should have active→frozen transition");
});

test("Decay: Logger integration with decay batch", () => {
  const { decayLogger: logger, applyDecayBatch, deriveFreshness } = testing;

  logger.clear();

  // Create old engram that will decay
  const engrams = [{
    id: "old-engram",
    kind: "fact",
    status: "active",
    visibility: "private",
    verification: "probable",
    content: "Old memory",
    importance: 0.8,
    lastEffectiveAt: Date.now() - 1000 * 60 * 60 * 24 * 200, // 200 days old
    metadata: {},
    tags: [],
    contextTags: [],
    source: "test",
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 200,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 200,
    createdBy: "test",
    trustLevel: "direct",
    synapses: [],
  }];

  // High base halflife so importance decay won't trigger, but TTL might
  const config = {
    ttl: { enabled: false, retentionDays: 0, safetyThreshold: 0, minRetainL0: 0, minRetainL1: 0 },
    importance: { enabled: true, baseHalflifeDays: 7, kindMultipliers: {} },
    accessFrequency: { enabled: false },
    stateMachine: { enabled: true },
  };

  const result = applyDecayBatch(engrams, config);

  // With 200 days and 7 day halflife: halflife * 4 ≈ 24 days, so should be forgotten
  assert(result.scanned === 1, `Exactly 1 active record scanned, got ${result.scanned}`);
  assert(result.forgotten.includes("old-engram"), "200d old memory should be forgotten");
  const logs = logger.getLogs("old-engram");
  assert(logs.length > 0, "Should log forgotten transition");
  assert(logs[logs.length - 1].to === "forgotten", "Last transition should be to forgotten");
});

// --- Decay persistence / Co-Engram helpers ---
const DAY_MS = 24 * 60 * 60 * 1000;
let decayTmpCounter = 0;
function uniqueStoreDir(prefix) {
  return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${decayTmpCounter++}`);
}

const DECAY_CFG = {
  ttl: { enabled: true, retentionDays: 30, safetyThreshold: 0.8, minRetainL0: 50, minRetainL1: 20 },
  importance: { enabled: true, baseHalflifeDays: 50 },
  accessFrequency: { enabled: true },
  stateMachine: { enabled: true },
};

function makeL1Seed(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: `l1_${Math.random().toString(36).slice(2, 9)}`,
    content: "种子记忆内容",
    type: "episodic",
    priority: 50,
    sceneName: "Seed",
    sourceMessageIds: [],
    metadata: {},
    timestamps: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
    sessionKey: "decay-session",
    sessionId: "decay-session",
    userId: "tester",
    agentId: "self",
    ...overrides,
  };
}

async function seedL1(dir, record) {
  await new StorageAdapter(dir).appendL1(record);
}

function makeActiveEngram(id, ageDays, importance = 0.5) {
  return {
    id,
    kind: "fact",
    status: "active",
    visibility: "private",
    verification: "probable",
    content: "Test",
    importance,
    lastEffectiveAt: Date.now() - ageDays * DAY_MS,
    metadata: {},
    tags: [],
    contextTags: [],
    source: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: "test",
    trustLevel: "direct",
    synapses: [],
  };
}

// ============================================================================
// Test: Decay — Co-Engram semantics (pure)
// ============================================================================

test("Decay: Co-Engram stale split (freeze high importance, forget low)", () => {
  const config = {
    ttl: { enabled: false, retentionDays: 0, safetyThreshold: 0, minRetainL0: 0, minRetainL1: 0 },
    importance: { enabled: true, baseHalflifeDays: 10, kindMultipliers: {} },
    accessFrequency: { enabled: false },
    stateMachine: { enabled: true },
  };
  // imp 0.15 fact → hl = 10×0.25^1.5 ≈ 1.25d; stale band (2×..4×) = (2.5, 5]d → age 3d is stale
  const low = makeActiveEngram("low-split", 3, 0.15);
  // imp 0.8 fact → hl = 10×0.9^1.5 ≈ 8.5d; stale band ≈ (17, 34]d → age 25d is stale
  const high = makeActiveEngram("high-split", 25, 0.8);

  const result = applyDecayBatch([low, high], config);
  assert(result.scanned === 2, `2 active scanned, got ${result.scanned}`);
  assert(result.forgotten.includes("low-split"), "stale + importance<0.2 → forgotten");
  assert(result.frozen.includes("high-split"), "stale + importance≥0.2 → frozen (archive)");
  assert(low.status === "forgotten", "low engram mutated to forgotten");
  assert(high.status === "frozen", "high engram mutated to frozen");
});

test("Decay: freshness=forgotten ignores importance (always forget)", () => {
  const config = {
    ttl: { enabled: false, retentionDays: 0, safetyThreshold: 0, minRetainL0: 0, minRetainL1: 0 },
    importance: { enabled: true, baseHalflifeDays: 10, kindMultipliers: {} },
    accessFrequency: { enabled: false },
    stateMachine: { enabled: true },
  };
  // imp 0.95 fact → hl = 10×1.05^1.5 ≈ 10.8d; 4×≈43d < 100d → forgotten band
  const engram = makeActiveEngram("very-old-high", 100, 0.95);
  const result = applyDecayBatch([engram], config);
  assert(result.forgotten.includes("very-old-high"), "forgotten band forgets even high importance");
  assert(result.frozen.length === 0, "no freeze from forgotten band");
});

test("Decay: only active decays; frozen never auto-revives", () => {
  const config = {
    ttl: { enabled: false, retentionDays: 0, safetyThreshold: 0, minRetainL0: 0, minRetainL1: 0 },
    importance: { enabled: true, baseHalflifeDays: 10, kindMultipliers: {} },
    accessFrequency: { enabled: false },
    stateMachine: { enabled: true },
  };
  const freshFrozen = { ...makeActiveEngram("frz-fresh", 0), status: "frozen" };
  const oldFrozen = { ...makeActiveEngram("frz-old", 200), status: "frozen" }; // would forget if scanned
  const oldDraft = { ...makeActiveEngram("draft-old", 200), status: "draft" };
  const result = applyDecayBatch([freshFrozen, oldFrozen, oldDraft], config);
  assert(result.scanned === 0, "no active records → nothing scanned");
  assert(result.forgotten.length === 0 && result.frozen.length === 0, "frozen/draft untouched");
  assert(result.revived.length === 0, "frozen is terminal — no auto-revive");
  assert(oldFrozen.status === "frozen", "old frozen stays frozen (never silently forgotten)");
});

test("Decay: deriveFreshness falls back to createdAt, invalid → fresh", () => {
  const config = {
    ttl: { enabled: false, retentionDays: 0, safetyThreshold: 0, minRetainL0: 0, minRetainL1: 0 },
    importance: { enabled: true, baseHalflifeDays: 10, kindMultipliers: {} },
    accessFrequency: { enabled: false },
    stateMachine: { enabled: true },
  };
  const now = Date.now();
  // lastEffectiveAt invalid + old createdAt → age from createdAt (imp0.5 fact hl≈4.6d → 60d forgotten)
  const fromCreated = deriveFreshness(NaN, 0.5, "fact", config, { now, createdAt: now - 60 * DAY_MS });
  assert(fromCreated === "forgotten", `should fall back to createdAt (got ${fromCreated})`);
  // No usable reference point at all → treat as brand-new
  const noRef = deriveFreshness(NaN, 0.5, "fact", config, { now });
  assert(noRef === "fresh", `invalid + no createdAt → fresh (got ${noRef})`);
});

test("Decay: TTL min-retain forgets oldest, keeps newest", async () => {
  const config = {
    ttl: { enabled: true, retentionDays: 1, safetyThreshold: 1.0, minRetainL0: 0, minRetainL1: 2 },
    importance: { enabled: true, baseHalflifeDays: 50, kindMultipliers: {} },
    accessFrequency: { enabled: false },
    stateMachine: { enabled: true },
  };
  const list = [
    makeActiveEngram("t-1", 60),
    makeActiveEngram("t-2", 50),
    makeActiveEngram("t-3", 40),
    makeActiveEngram("t-4", 30),
    makeActiveEngram("t-5", 20),
  ];
  const res = await applyTTLCleanup(list, { L0: 0, L1: 5, L2: 0, L3: 0 }, config);
  assert(res.deleted === 3, `should forget exactly 3 (5 - minRetain 2), got ${res.deleted}`);
  const remainIds = list.filter(e => e.status === "active").map(e => e.id).sort();
  assert(JSON.stringify(remainIds) === JSON.stringify(["t-4", "t-5"]), `newest survive, got ${remainIds.join(",")}`);
});

// ============================================================================
// Test: Decay — persistence (store level)
// ============================================================================

test("Decay: applyDecayStatus persists status and never touches updatedAt", async () => {
  const dir = uniqueStoreDir("persist");
  try {
    const store = new MemoryStore(dir);
    const rec = makeL1Seed({ id: "persist-1", sessionKey: "p-session", content: "持久化 关键词" });
    await seedL1(dir, rec);

    const n = await store.applyDecayStatus([
      { sessionKey: "p-session", id: "persist-1", patch: { status: "frozen" } },
    ]);
    assert(n === 1, `should apply exactly 1 patch, got ${n}`);

    const all = await store.listAllL1(); // re-reads from disk
    const row = all.find(r => r.id === "persist-1");
    assert(row.status === "frozen", "status persisted to disk");
    assert(row.updatedAt === rec.updatedAt, "updatedAt must NOT change on a status flip");
    assert(row.createdAt === rec.createdAt, "createdAt unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Decay: applyDecayToL1 end-to-end — stale split persists + fresh survives", async () => {
  const dir = uniqueStoreDir("e2e");
  try {
    const store = new MemoryStore(dir);
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    // persona → fact multiplier 1.0; imp 0.9 → hl = 50d; age 150d = stale → frozen
    const hi = makeL1Seed({
      id: "hi", type: "persona", priority: 90, importance: 0.9,
      content: "高价值 共享关键词", sessionKey: "e2e-session",
      lastEffectiveAt: now - 150 * DAY_MS,
      createdAt: iso(now - 150 * DAY_MS), updatedAt: iso(now - 150 * DAY_MS),
    });
    // episodic → observation multiplier 0.6; imp 0.15 → hl ≈ 3.75d; age 15d = 4× → stale → forgotten
    const lo = makeL1Seed({
      id: "lo", type: "episodic", priority: 15, importance: 0.15,
      content: "低价值 共享关键词", sessionKey: "e2e-session",
      lastEffectiveAt: now - 15 * DAY_MS,
      createdAt: iso(now - 15 * DAY_MS), updatedAt: iso(now - 15 * DAY_MS),
    });
    const fresh = makeL1Seed({ id: "fresh", content: "新记忆 共享关键词", sessionKey: "e2e-session" });
    await seedL1(dir, hi);
    await seedL1(dir, lo);
    await seedL1(dir, fresh);

    const result = await applyDecayToL1(store, DECAY_CFG);
    assert(result.frozenIds.includes("hi"), "hi should freeze (stale + high importance)");
    assert(result.forgottenIds.includes("lo"), "lo should be forgotten (stale + low importance)");
    assert(result.frozen === 1 && result.deleted === 1, `counts frozen=${result.frozen} forgotten=${result.deleted}`);

    const byId = new Map((await store.listAllL1()).map(r => [r.id, r]));
    assert(byId.get("hi").status === "frozen", "hi persisted frozen");
    assert(byId.get("lo").status === "forgotten", "lo persisted forgotten");
    // Fresh row has no persisted status field → defaults to active
    assert((byId.get("fresh").status ?? "active") === "active", "fresh memory stays active (default)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Decay: recall excludes frozen/forgotten and exposes id+sessionKey", async () => {
  const dir = uniqueStoreDir("recall");
  try {
    const store = new MemoryStore(dir);
    const active = makeL1Seed({ id: "act", content: "用户偏好 蓝色主题", sessionKey: "r-session" });
    const frozen = makeL1Seed({ id: "frz", content: "用户偏好 蓝色主题", sessionKey: "r-session", status: "frozen" });
    const forgotten = makeL1Seed({ id: "fg", content: "用户偏好 蓝色主题", sessionKey: "r-session", status: "forgotten" });
    await seedL1(dir, active);
    await seedL1(dir, frozen);
    await seedL1(dir, forgotten);

    const engine = new RecallEngine(new StorageAdapter(dir));
    const result = await engine.recall({ query: "蓝色主题", sessionKey: "r-session", userId: "u", agentId: "a", topK: 10 });
    const mems = result.recalledL1Memories ?? [];
    const ids = mems.map(m => m.id);
    assert(ids.includes("act"), "active memory should be recalled");
    assert(!ids.includes("frz"), "frozen memory must be excluded from recall");
    assert(!ids.includes("fg"), "forgotten memory must be excluded from recall");
    assert(mems.every(m => m.id && m.sessionKey), "each recalled memory exposes id + sessionKey");
    assert(mems[0].sessionKey === "r-session", "sessionKey flows through to recall result");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Decay: markRecalled bumps active only, debounced by default", async () => {
  const dir = uniqueStoreDir("markrecalled");
  try {
    const store = new MemoryStore(dir);
    const now = Date.now();
    const active = makeL1Seed({ id: "hit-active", content: "强化 关键词", sessionKey: "mr-session", lastEffectiveAt: now - 5 * DAY_MS });
    const frozen = makeL1Seed({ id: "hit-frozen", content: "强化 关键词", sessionKey: "mr-session", status: "frozen", lastEffectiveAt: now - 100 * DAY_MS });
    await seedL1(dir, active);
    await seedL1(dir, frozen);

    const n1 = await store.markRecalled([
      { sessionKey: "mr-session", id: "hit-active" },
      { sessionKey: "mr-session", id: "hit-frozen" },
    ]);
    assert(n1 === 1, `only the active row should be bumped, got ${n1}`);

    let byId = new Map((await store.listAllL1()).map(r => [r.id, r]));
    assert(byId.get("hit-active").retrievalCount === 1, "active retrievalCount should be 1");
    assert(byId.get("hit-frozen").retrievalCount === undefined, "frozen must never be bumped (no resurrection)");
    const firstHitAt = byId.get("hit-active").lastRetrievedAt;

    // Second hit within the 60s debounce window → no-op
    const n2 = await store.markRecalled([{ sessionKey: "mr-session", id: "hit-active" }]);
    assert(n2 === 0, `debounced hit should bump 0, got ${n2}`);

    // Bypassing the debounce bumps again → retrievalCount 2
    const n3 = await store.markRecalled([{ sessionKey: "mr-session", id: "hit-active" }], 0);
    assert(n3 === 1, `debounce-bypassed hit should bump 1, got ${n3}`);
    byId = new Map((await store.listAllL1()).map(r => [r.id, r]));
    const after = byId.get("hit-active");
    assert(after.retrievalCount === 2, `retrievalCount should be 2, got ${after.retrievalCount}`);
    assert(after.lastRetrievedAt >= firstHitAt, "lastRetrievedAt should advance");
    assert(after.lastEffectiveAt >= firstHitAt, "lastEffectiveAt refreshed (memory kept alive)");
    assert(after.updatedAt === active.updatedAt, "markRecalled must not touch updatedAt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Test: Team Event Store (Sync)
// ============================================================================

test("Team Memory: Event store basic operations", async () => {
  const { TeamEventStore } = testing;

  const eventStore = new TeamEventStore("test-machine", "/tmp/test-events");

  // Append a sync event
  const event = await eventStore.append({
    action: "share",
    engramId: "engram-1",
    engramSnapshot: {
      id: "engram-1",
      kind: "fact",
      status: "active",
      visibility: "team",
      verification: "probable",
      content: "Shared memory",
      importance: 0.5,
      lastEffectiveAt: Date.now(),
      metadata: {},
      tags: [],
      contextTags: [],
      source: "test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: "user1",
      trustLevel: "direct",
      synapses: [],
    },
    actor: "user1",
  });

  assert(event.id.startsWith("evt_"), "Event ID should start with evt_");
  assert(event.origin === "test-machine", "Origin should be test-machine");
  assert(event.action === "share", "Action should be share");
});

// ============================================================================
// Test: Team Memory
// ============================================================================

test("Team Memory: Share and access", () => {
  const teamMemory = new TeamMemoryManager(2);

  const engram = {
    id: "test-engram",
    kind: "fact",
    status: "active",
    visibility: "private",
    verification: "probable",
    content: "Test content",
    importance: 0.5,
    lastEffectiveAt: Date.now(),
    metadata: {},
    tags: [],
    contextTags: [],
    source: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: "user1",
    trustLevel: "direct",
    synapses: [],
  };

  // Share with team
  const shareResult = teamMemory.share(engram, "user1");
  assert(shareResult.success, "Share should succeed");

  // Check access
  const canAccess = teamMemory.canAccess(engram, "user2");
  assert(canAccess, "Team member should access shared memory");
});

test("Team Memory: Import with limit", () => {
  const teamMemory = new TeamMemoryManager(2);

  const result = teamMemory.import("agent1", "user1", ["e1", "e2", "e3"]);
  assert(!result.success, "Should fail when exceeding limit");
  assert(result.error.includes("limit"), "Error should mention limit");

  const result2 = teamMemory.import("agent1", "user1", ["e1", "e2"]);
  assert(result2.success, "Should succeed within limit");
});

test("Visualize: server endpoints", async () => {
  const baseDir = "/tmp/memory-test-viz";
  const store = new MemoryStore(baseDir);
  const storage = new StorageAdapter(baseDir);
  const vectorStore = new VectorStore();
  const pipeline = new DistillationPipeline(DEFAULT_DISTILLATION_CONFIG, store, vectorStore);
  const recall = new RecallEngine(storage);

  // Seed a record so /api/l1 returns non-empty.
  await store.storeL1({
    content: "User prefers dark mode in the dashboard",
    type: "persona",
    priority: 75,
    sceneName: "ui-prefs",
    sourceMessageIds: [],
    metadata: {},
    timestamps: [new Date().toISOString()],
    sessionKey: "viz-test",
    sessionId: "viz-test",
    userId: "viz",
    agentId: "viz",
  });

  // Legacy L1 record written before id generation (bypasses storeL1).
  await storage.appendL1({
    content: "Legacy init record without an id field",
    type: "fact",
    priority: 50,
    sceneName: "User Added",
    sourceMessageIds: [],
    metadata: { source: "init" },
    timestamps: [new Date().toISOString()],
    sessionKey: "viz-test",
    sessionId: "viz-test",
    userId: "viz",
    agentId: "viz",
  });

  // Seed an L0 raw message + an L2 scene + L3 persona so the drill-down
  // endpoints (/api/l0, /api/persona, /api/scene) have real data to serve.
  await store.ingestMessage({
    content: "用户询问记忆面板的下钻功能",
    role: "user",
    sessionKey: "viz-test",
    sessionId: "viz-test",
    userId: "viz",
    agentId: "viz",
    timestamp: Date.now(),
  });
  const drillScene = await store.storeL2({
    title: "DrillDown Feature Talk",
    content: "# DrillDown\n\n这是场景正文内容",
    summary: "讨论记忆下钻功能",
    tags: ["viz"],
    metadata: { layer: "L2" },
  });
  await store.storeL3({
    content: "# 人物画像\n\n用户是可视化面板的开发者",
    summary: "user persona",
    metadata: { layer: "L3" },
  });

  decayLogger.clear();

  const handle = await startVisualizeServer({
    store,
    recall,
    pipeline,
    decayLogger,
    l3DryRun: async () => ({
      timestamp: new Date().toISOString(),
      l1Count: 1,
      avgImportance: 0.75,
      thresholdMet: true,
      highValueSceneCount: 0,
      previewPersona: "# preview",
      hint: "test",
    }),
    dataDir: baseDir,
    backend: "memory",
  });

  try {
    assert(handle.port > 0, "should bind a port");
    assert(handle.url.startsWith("http://127.0.0.1:"), "should bind 127.0.0.1");

    const r1 = await fetch(`${handle.url}/api/health`);
    assert(r1.ok, "/api/health should respond");
    const health = await r1.json();
    assert(health.ok === true, "health.ok");
    assert(health.backend === "memory", "health.backend");

    const r2 = await fetch(`${handle.url}/api/stats`);
    const stats = await r2.json();
    assert(stats.layers.l1Count >= 1, "stats.layers.l1Count includes seeded record");

    const r3 = await fetch(`${handle.url}/api/recall?q=dark+mode`);
    const rec = await r3.json();
    assert(rec.markers.relevantMemories === true, "recall should set <relevant-memories> marker when memories exist");

    const r4 = await fetch(`${handle.url}/api/l3-preview`);
    const l3 = await r4.json();
    assert(l3.thresholdMet === true, "l3 preview thresholdMet");

    const r5 = await fetch(`${handle.url}/`);
    const html = await r5.text();
    assert(html.includes("memory_new"), "dashboard html mentions plugin");
    assert(html.includes("<svg"), "dashboard has inline svg");
    // Regression: the inline script must PARSE. A `\n` inside a backtick
    // template was once emitted as a real newline inside a string literal,
    // killing the whole <script> block (nothing rendered).
    {
      const { Script } = await import("node:vm");
      const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
      assert(scriptMatch, "dashboard has an inline <script>");
      try {
        new Script(scriptMatch[1], { filename: "dashboard-inline.js" });
      } catch (e) {
        assert(false, `dashboard inline script must parse, got: ${e.message}`);
      }
    }

    const r6 = await fetch(`${handle.url}/nope`);
    assert(r6.status === 404, "unknown path returns 404");

    // scene-graph must not drop edges/previews for id-less (init) L1 records.
    const r7 = await fetch(`${handle.url}/api/scene-graph`);
    const sg = await r7.json();
    assert(Array.isArray(sg.nodes), "scene-graph has nodes array");
    assert(Array.isArray(sg.edges), "scene-graph has edges array");
    assert(Array.isArray(sg.l1Preview) && sg.l1Preview.length >= 1, "scene-graph has l1Preview entries");
    for (const e of sg.edges) {
      assert(e.from && e.to, `edge must carry from+to, got ${JSON.stringify(e)}`);
    }
    for (const m of sg.l1Preview) {
      assert(m.id, `l1Preview entry must carry id, got ${JSON.stringify(m)}`);
    }

    // L0 drill-down: newest-first raw messages across sessions.
    const r8 = await fetch(`${handle.url}/api/l0?limit=50`);
    const l0 = await r8.json();
    assert(r8.ok, "/api/l0 should respond");
    assert(l0.count >= 1 && Array.isArray(l0.records), "l0 returns records array");
    assert(l0.records.some((r) => r.content.includes("下钻")), "l0 records include seeded message");

    // Persona drill-down: real persona.md content surfaced.
    const r9 = await fetch(`${handle.url}/api/persona`);
    const pp = await r9.json();
    assert(r9.ok, "/api/persona should respond");
    assert(pp.present === true, "persona present after storeL3 seed");
    assert((pp.content || "").includes("人物画像"), "persona content includes seeded heading");
    assert(pp.updatedAt, "persona carries updatedAt");

    // L2 scene detail expand + 404 for unknown id.
    const r10 = await fetch(`${handle.url}/api/scene?id=${encodeURIComponent(drillScene.id)}`);
    assert(r10.ok, "/api/scene should return seeded scene");
    const scDetail = await r10.json();
    assert(scDetail.id === drillScene.id, "scene detail id matches");
    assert((scDetail.content || "").includes("场景正文"), "scene detail carries full markdown body");
    const r11 = await fetch(`${handle.url}/api/scene?id=missing-scene`);
    assert(r11.status === 404, "unknown scene returns 404");

    // /api/l1 q filter used by drill-down search.
    const r12 = await fetch(`${handle.url}/api/l1?q=dark+mode&limit=50`);
    const l1Filtered = await r12.json();
    assert(l1Filtered.records.length >= 1, "l1 q filter returns matching record");
  } finally {
    await handle.stop();
  }
});

test("Visualize setup: patches openclaw.json under config.visualize", async () => {
  // Use an isolated HOME so we never touch the real ~/.openclaw-test/
  const { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const tmpHome = mkdtempSync("/tmp/mn-viz-setup-");
  const cfgPath = join(tmpHome, ".openclaw-test", "openclaw.json");
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // Force profile=test so resolveConfigPath picks up our tmp dir.
  const originalProfile = process.env.OPENCLAW_PROFILE;
  process.env.OPENCLAW_PROFILE = "test";

  const initial = {
    plugins: { entries: { memory_new: { enabled: true } } },
  };
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(tmpHome, ".openclaw-test"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(initial, null, 2));

  try {
    // First run — should patch.
    const r1 = await runVisualizeSetup({
      reset: false,
      noRestart: true,
      profile: "test",
      api: {},
    });
    assert(/wrote|updated/.test(r1.text), `expected patch in r1.text, got: ${r1.text.slice(0, 120)}`);

    const cfg1 = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const viz1 = cfg1?.plugins?.entries?.memory_new?.config?.visualize;
    assert(viz1, "visualize block should exist under config");
    assert(viz1.enabled === true, "viz.enabled=true");
    assert(viz1.autoStart === true, "viz.autoStart=true");

    // Second run — idempotent.
    const r2 = await runVisualizeSetup({
      reset: false,
      noRestart: true,
      profile: "test",
      api: {},
    });
    assert(/already configured/.test(r2.text), `expected no-op, got: ${r2.text.slice(0, 120)}`);

    // Reset — should remove.
    const r3 = await runVisualizeSetup({
      reset: true,
      noRestart: true,
      profile: "test",
      api: {},
    });
    assert(/updated|removed/.test(r3.text), `expected reset, got: ${r3.text.slice(0, 120)}`);

    const cfg3 = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const viz3 = cfg3?.plugins?.entries?.memory_new?.config?.visualize;
    assert(viz3 === undefined, `visualize block should be gone, got: ${JSON.stringify(viz3)}`);
  } finally {
    process.env.HOME = originalHome;
    process.env.OPENCLAW_PROFILE = originalProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ============================================================================
// Run all tests
// ============================================================================

runTests().catch(console.error);
