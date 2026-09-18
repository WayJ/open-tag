// Integration test for the server side of managed-memory sync (Task 3).
// Verifies: agentConfig carries memoryDigest (only when an agent_memory row exists), the daemon
// "agent:memory" uplink (tenant guard → whitelist/size validation → upsert with a server-computed
// digest), cross-side digest consistency against the shared daemonProtocol, and the first
// daemon-initiated RPC "memory:get" → "memory:data" round-trip (no-row and cross-tenant → files={}).
// Mirrors test/scopedSessions.integration.ts (real DB, direct function calls, fake ws for the RPC send).
// Requires infra up: `npm run infra` (pg :5433, redis :6380).
// Run: set -a; source .env; set +a; JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx --test --test-force-exit test/memorySync.integration.ts
import "../src/env.ts";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { agentConfig } from "../src/server/agentConfig.ts";
import { handleAgentMemoryUplink, handleMemoryGet } from "../src/server/ws.ts";
import { createServer } from "../src/server/core.ts";
import { memoryFilesDigest } from "../src/daemonProtocol.ts";

const ts = Date.now();
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

/** jsonb normalizes object key order (length, then bytewise) — compare file maps as sorted entries. */
const sameFiles = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

let ownerId = "";
let serverId = "";
let server2Id = "";
let agentId = "";
let agent2Id = "";
let machineId = "";

const memoryRow = async (aid: string) =>
  (await db.select().from(schema.agentMemory).where(eq(schema.agentMemory.agentId, aid)))[0];

const memoryRowCount = async (aid: string) =>
  (await db.select().from(schema.agentMemory).where(eq(schema.agentMemory.agentId, aid))).length;

/** Fake daemon conn capturing frames — enough for handleMemoryGet's conn.send reply. */
function fakeWs() {
  const frames: any[] = [];
  return {
    frames,
    send(data: string) { frames.push(JSON.parse(data)); },
  };
}

async function setup() {
  const [owner] = await db.insert(schema.users).values({
    name: `owner_mem_${ts}`,
    displayName: "Owner",
    email: `owner_mem_${ts}@agent-route.local`,
  }).returning();
  ownerId = owner!.id;

  const srv = await createServer(`memory-sync-${ts}`, `memory-sync-${ts}`, ownerId);
  serverId = srv.id;
  const srv2 = await createServer(`memory-sync-b-${ts}`, `memory-sync-b-${ts}`, ownerId);
  server2Id = srv2.id;

  const [agent] = await db.insert(schema.agents).values({
    serverId,
    name: `rememberer_${ts}`,
    displayName: "Rememberer",
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: ownerId,
  }).returning();
  agentId = agent!.id;

  // Cross-tenant agent on the second server — its rows must never leak to server1's daemons.
  const [agent2] = await db.insert(schema.agents).values({
    serverId: server2Id,
    name: `foreigner_${ts}`,
    displayName: "Foreigner",
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: ownerId,
  }).returning();
  agent2Id = agent2!.id;

  machineId = randomUUID();
}

async function cleanup() {
  for (const sid of [serverId, server2Id]) {
    if (!sid) continue;
    await db.delete(schema.agentMemory).where(eq(schema.agentMemory.serverId, sid));
    const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, sid));
    for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
    await db.delete(schema.channels).where(eq(schema.channels.serverId, sid));
    await db.delete(schema.agents).where(eq(schema.agents.serverId, sid));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, sid));
    await db.delete(schema.servers).where(eq(schema.servers.id, sid));
  }
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function main() {
  await setup();

  console.log("\n[1] agentConfig: no agent_memory row → config carries no memoryDigest key");
  const cfg0 = await agentConfig(agentId);
  check("config resolves", !!cfg0);
  check("no row → no memoryDigest key", !!cfg0 && !("memoryDigest" in cfg0));

  console.log("\n[2] valid agent:memory uplink → row upsert (files + digest + machineId + updatedAt)");
  const files1 = { "MEMORY.md": "# hello\n", "notes/2026-09-17.md": "day note" };
  await handleAgentMemoryUplink(serverId, machineId, { type: "agent:memory", agentId, files: files1 });
  const row1 = await memoryRow(agentId);
  check("row exists with the uploaded files", !!row1 && sameFiles(row1!.files, files1));
  check("uploadedByMachineId recorded", row1?.uploadedByMachineId === machineId);
  check("updatedAt set", !!row1?.updatedAt);
  const cfg1 = await agentConfig(agentId);
  check("config now carries memoryDigest == row digest", cfg1?.memoryDigest === row1?.memoryDigest);

  console.log("\n[3] cross-side consistency: server-computed digest == shared daemonProtocol digest");
  check("row digest == memoryFilesDigest(same input)", row1?.memoryDigest === memoryFilesDigest(files1));

  console.log("\n[4] second uplink, different content → same row updated (still exactly one row)");
  const files2 = { "MEMORY.md": "# hello, edited\n", "personality.md": "concise", "notes/a.md": "x" };
  await handleAgentMemoryUplink(serverId, machineId, { type: "agent:memory", agentId, files: files2 });
  const rows = await db.select().from(schema.agentMemory).where(eq(schema.agentMemory.agentId, agentId));
  check("still exactly one row for the agent", rows.length === 1);
  check("files updated in place", sameFiles(rows[0]!.files, files2));
  check("digest recomputed for the new content", rows[0]!.memoryDigest === memoryFilesDigest(files2));
  check("config digest follows the update", (await agentConfig(agentId))?.memoryDigest === rows[0]!.memoryDigest);

  console.log("\n[5] tenant guard: uplink naming another server's agent → dropped, no row");
  const before = await memoryRowCount(agentId);
  await handleAgentMemoryUplink(serverId, machineId, { type: "agent:memory", agentId: agent2Id, files: files1 });
  check("no row created for the cross-tenant agent", await memoryRowCount(agent2Id) === 0);
  check("own agent's row untouched", await memoryRowCount(agentId) === before);

  console.log("\n[6] validation: illegal entry name / over-512KB → dropped, no row");
  await handleAgentMemoryUplink(serverId, machineId, { type: "agent:memory", agentId, files: { "README.md": "not whitelisted" } });
  check("non-whitelisted name → no row", await memoryRowCount(agentId) === before);
  await handleAgentMemoryUplink(serverId, machineId, { type: "agent:memory", agentId, files: { "notes/../evil.md": "traversal" } });
  check("path traversal → no row", await memoryRowCount(agentId) === before);
  await handleAgentMemoryUplink(serverId, machineId, {
    type: "agent:memory", agentId,
    files: { "MEMORY.md": "x".repeat(400 * 1024), "personality.md": "x".repeat(200 * 1024) },
  });
  check("over-512KB total → no row", await memoryRowCount(agentId) === before);

  console.log("\n[7] memory:get RPC → memory:data {requestId, files} round-trip");
  const ws1 = fakeWs();
  await handleMemoryGet(serverId, { type: "memory:get", requestId: "req-1", agentId }, ws1 as any);
  check("replies exactly one memory:data frame", ws1.frames.length === 1 && ws1.frames[0]?.type === "memory:data");
  check("requestId echoed", ws1.frames[0]?.requestId === "req-1");
  check("files match the stored snapshot", sameFiles(ws1.frames[0]?.files ?? {}, files2));

  console.log("\n[8] memory:get: no row → files={} (never times out silently)");
  const ws2 = fakeWs();
  await handleMemoryGet(serverId, { type: "memory:get", requestId: "req-2", agentId: randomUUID() }, ws2 as any);
  check("unknown agentId → one frame with files={}", ws2.frames.length === 1 && ws2.frames[0]?.type === "memory:data" && JSON.stringify(ws2.frames[0]?.files) === "{}");
  check("requestId echoed on the empty reply", ws2.frames[0]?.requestId === "req-2");

  console.log("\n[9] memory:get cross-tenant: another server's row never leaks (files={})");
  const foreignFiles = { "MEMORY.md": "# foreign secrets\n" };
  await handleAgentMemoryUplink(server2Id, machineId, { type: "agent:memory", agentId: agent2Id, files: foreignFiles });
  check("foreign row really exists on server2", await memoryRowCount(agent2Id) === 1);
  const ws3 = fakeWs();
  await handleMemoryGet(serverId, { type: "memory:get", requestId: "req-3", agentId: agent2Id }, ws3 as any);
  check("server1 daemon asking for server2's agent → files={} (no leak)", ws3.frames.length === 1 && ws3.frames[0]?.type === "memory:data" && JSON.stringify(ws3.frames[0]?.files) === "{}");
  const ws4 = fakeWs();
  await handleMemoryGet(server2Id, { type: "memory:get", requestId: "req-4", agentId: agent2Id }, ws4 as any);
  check("its own server still gets the files", JSON.stringify(ws4.frames[0]?.files) === JSON.stringify(foreignFiles));
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });
