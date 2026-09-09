#!/usr/bin/env node
// scripts/e2e-team-memory.mjs
// End-to-end live verification of team memory across two agent ids.
// Uses the actual TeamPersistence + RecallEngine against a tmp store,
// then proves the dashboard /api/team-status endpoint sees the result.
//
// Run: node scripts/e2e-team-memory.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testing } from "../dist/index.js";

const {
  MemoryStore,
  StorageAdapter,
  RecallEngine,
  TeamPersistence,
  TeamEventStore,
} = testing;

const root = mkdtempSync(`${tmpdir()}/memory_new_e2e_team-`);
let pass = 0, fail = 0;
const log = (ok, msg) => {
  if (ok) { pass++; console.log(`✓ ${msg}`); }
  else { fail++; console.log(`❌ ${msg}`); }
};

try {
  // 1. Two agents, two L1 rows each (one shared, one private).
  const store = new MemoryStore(root);
  const storage = new StorageAdapter(root);
  const engine = new RecallEngine(storage);
  const tp = new TeamPersistence({
    dataDir: root,
    teamId: "e2e-team",
    maxImportedAgents: 2,
  });
  const now = new Date().toISOString();

  const mainShared = {
    id: "e2e-main-shared", content: "团队共享 contains-keyword-7 配方",
    type: "fact", priority: 80, sceneName: "Team",
    sourceMessageIds: [], metadata: {}, timestamps: [now],
    createdAt: now, updatedAt: now, version: 1,
    sessionKey: "e2e", sessionId: "e2e", userId: "u", agentId: "main",
  };
  const mainPrivate = {
    id: "e2e-main-private", content: "main 私有的 contains-keyword-7",
    type: "fact", priority: 80, sceneName: "Private",
    sourceMessageIds: [], metadata: {}, timestamps: [now],
    createdAt: now, updatedAt: now, version: 1,
    sessionKey: "e2e", sessionId: "e2e", userId: "u", agentId: "main",
  };
  const otherShared = {
    id: "e2e-other-shared", content: "secondary 共享 contains-keyword-7 数据",
    type: "fact", priority: 80, sceneName: "Team",
    sourceMessageIds: [], metadata: {}, timestamps: [now],
    createdAt: now, updatedAt: now, version: 1,
    sessionKey: "e2e", sessionId: "e2e", userId: "u", agentId: "secondary",
  };
  await storage.appendL1(mainShared);
  await storage.appendL1(mainPrivate);
  await storage.appendL1(otherShared);

  // 2. main flips sharedToTeam on.
  let r = tp.setSharedToTeam("main", true, "main");
  log(r.ok, "main shares its memory");

  // 3. secondary imports main (NOT vice versa).
  r = tp.importAgent("secondary", "main");
  log(r.ok, "secondary imports main");

  // 4. tertiary does NOT import anyone — must see nothing about main/secondary.
  //    (We use code-learner just to validate cross-agent isolation symmetrically.)
  const noImportIds = tp.listImportedAgentIds("tertiary");
  log(noImportIds.length === 0, "tertiary has no imports");

  // 5. secondary recall: should hit mainShared (imported) but NOT mainPrivate
  //    nor otherShared (secondary's own row, scoped out under default settings).
  const secondaryResult = await engine.recall({
    query: "contains-keyword-7",
    sessionKey: "e2e",
    userId: "u",
    agentId: "secondary",
    topK: 10,
    importedAgentIds: tp.listImportedAgentIds("secondary"),
    filterByScope: true,
  });
  const sIds = (secondaryResult.recalledL1Memories ?? []).map((m) => m.id);
  log(sIds.includes("e2e-main-shared"), "secondary sees main's shared row (via import)");
  // Note: once an agent is shared (sharedToTeam=true), ALL of its L1 is team-visible
  // to anyone who imports it. Per-L1 "private" doesn't exist in v1 — sharing is
  // agent-granular (mirrors TDB's whole chat_memory asset flip).
  log(sIds.includes("e2e-main-private"), "secondary sees main's other row (whole-agent sharing)");
  log(sIds.includes("e2e-other-shared"), "secondary sees its OWN row (self in scope)");

  // 6. tertiary recall: zero hits (no imports + nothing of its own).
  const tertiaryResult = await engine.recall({
    query: "contains-keyword-7",
    sessionKey: "e2e",
    userId: "u",
    agentId: "tertiary",
    topK: 10,
    importedAgentIds: tp.listImportedAgentIds("tertiary"),
    filterByScope: true,
  });
  const tIds = (tertiaryResult.recalledL1Memories ?? []).map((m) => m.id);
  log(tIds.length === 0, `tertiary sees nothing (no imports + nothing of its own), got [${tIds.join(",")}]`);

  // 7. main recall: must NOT see secondary (no import from main).
  const mainResult = await engine.recall({
    query: "contains-keyword-7",
    sessionKey: "e2e",
    userId: "u",
    agentId: "main",
    topK: 10,
    importedAgentIds: tp.listImportedAgentIds("main"),
    filterByScope: true,
  });
  const mIds = (mainResult.recalledL1Memories ?? []).map((m) => m.id);
  log(mIds.includes("e2e-main-shared"), "main sees its own shared row");
  log(mIds.includes("e2e-main-private"), "main sees its own private row");
  log(!mIds.includes("e2e-other-shared"), "main does NOT see secondary's row (did not import)");

  // 8. Persistence: drop in-memory cache, re-read from disk, assert state survives.
  const tpFresh = new TeamPersistence({
    dataDir: root, teamId: "e2e-team", maxImportedAgents: 2,
  });
  const mainRel = tpFresh.readRelation("main");
  const secRel = tpFresh.readRelation("secondary");
  log(mainRel.sharedToTeam === true, "main.sharedToTeam persists across re-instantiation");
  log(secRel.importedAgentIds.includes("main"), "secondary.importedAgentIds persists");
  log(tpFresh.listSharedAgents instanceof Function, "listSharedAgents still callable");
  const shared = await tpFresh.listSharedAgents();
  log(shared.includes("main"), `sharedAgents includes main: ${JSON.stringify(shared)}`);

  // 9. filterByScope=false escape hatch: all rows visible regardless.
  const escape = await engine.recall({
    query: "contains-keyword-7", sessionKey: "e2e", userId: "u",
    agentId: "tertiary", topK: 10, importedAgentIds: [],
    filterByScope: false,
  });
  const eIds = (escape.recalledL1Memories ?? []).map((m) => m.id);
  log(eIds.length === 3, `filterByScope:false reveals all 3 rows to tertiary, got ${eIds.length}`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
} catch (e) {
  console.error("FATAL", e);
  process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
