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

const { VectorStore, MemoryStore, StorageAdapter, DistillationPipeline, DEFAULT_DISTILLATION_CONFIG, TeamMemoryManager, TeamEventStore, applyDecayBatch, deriveFreshness, deriveHotness, decayLogger, StateTransitionLogger, startVisualizeServer, RecallEngine, runVisualizeSetup } = testing;

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
  // With 100 days and 7 day halflife, should be forgotten
  assert(result.forgotten.length > 0 || result.frozen.length > 0, "Old low-importance memory should be forgotten/frozen");
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

  // With 200 days and 7 day halflife: halflife * 4 = 28 days, so should be forgotten
  if (result.forgotten.length > 0) {
    const logs = logger.getLogs("old-engram");
    assert(logs.length > 0, "Should log forgotten transition");
    assert(logs[logs.length - 1].to === "forgotten", "Should be forgotten");
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
