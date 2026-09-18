// Integration test for the manual agent-migrate orchestration (POST /api/agents/:id/migrate).
// Spec: docs/superpowers/specs/2026-09-18-agent-migrate-design.md — six contract branches:
//   [1] validation order: unknown agent → 404; offline target machine → 409 machine-offline; no manageAgents → 403
//   [2] running agent + both machines online → agent:stop goes to the OLD machine's daemon, settle, then
//       rebind (machineId=new) + sessions cleared + inactive/offline
//   [3] stop refused by the old (online) machine's daemon → 503 stop-failed, machineId UNCHANGED (no rebind)
//   [4] old machine entirely offline + agent active → direct rebind (dead-machine flagship: no stop possible)
//   [5] sleeping agent on an online machine → skip stop, direct rebind; same machine → 200 idempotent
//       alreadyThere (even while that machine is offline — idempotence precedes the online check)
//   [6] cross-tenant target machine → 409 (no existence leak, same as offline)
// Mirrors test/agentCreateRequiresMachine.integration.ts (real DB, handleApi called directly with a JWT)
// + test/scopedSessions.integration.ts (fake daemon ws: registerDaemon/registerMachineConn + rpc:ack/nack).
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run:
//   set -a; source .env; set +a; JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx test/agentMigrate.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { signUser, newKey, hashToken } from "../src/server/auth.ts";
import { createServer } from "../src/server/core.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { AGENT_CONTROL_ACK_CAPABILITY, registerDaemon, registerDaemonCapabilities, registerMachineConn, resolveDaemonRequest, unregisterDaemon, unregisterMachineConn } from "../src/server/daemonHub.ts";

const ts = Date.now();
let failures = 0;
const check = (label: string, cond: boolean, detail = "") => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}${detail ? `  — ${detail}` : ""}`); if (!cond) failures++; };

function makeReq(o: { method: string; path: string; token: string; serverId: string; body?: object }): IncomingMessage {
  const s = o.body ? JSON.stringify(o.body) : "";
  const r = Readable.from(s ? [Buffer.from(s)] : ([] as Buffer[]));
  return Object.assign(r, { method: o.method, url: o.path, headers: { authorization: `Bearer ${o.token}`, "x-server-id": o.serverId, "content-type": "application/json" } }) as unknown as IncomingMessage;
}
function makeRes() {
  let status = 0, body = "";
  const em = new EventEmitter();
  const res = Object.assign(em, { statusCode: 0, headersSent: false, setHeader() {}, writeHead(c: number) { status = c; this.statusCode = c; }, end(d?: string | Buffer) { body = d ? String(d) : ""; em.emit("finish"); } }) as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => body };
}
async function apiCall(o: { method: string; path: string; token: string; serverId: string; body?: object }) {
  const PORT = Number(process.env.PORT ?? 7777);
  const { res, getStatus, getBody } = makeRes();
  const url = new URL(o.path, `http://localhost:${PORT}`);
  try { await handleApi(makeReq(o), res, url, o.method); }
  catch (e: unknown) { res.writeHead(500); res.end(JSON.stringify({ error: "internal", detail: e instanceof Error ? e.message : String(e) })); }
  let parsed: unknown; try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed as any };
}

/** Fake machine daemon: captures frames; answers every control RPC with rpc:ack or rpc:nack. */
function fakeMachineDaemon(mode: "ack" | "nack") {
  const frames: any[] = [];
  const ws: any = {
    readyState: 1,
    send(data: string) {
      const msg = JSON.parse(data); frames.push(msg);
      if (typeof msg.requestId === "string") {
        // Machine-targeted RPCs are bound to the exact connection that received the frame (daemonHub
        // sourceWs guard) — the fake must present itself as the source, or its ack is ignored.
        if (mode === "ack") resolveDaemonRequest(msg.requestId, { type: "rpc:ack", requestId: msg.requestId }, ws);
        else resolveDaemonRequest(msg.requestId, { type: "rpc:nack", requestId: msg.requestId, error: "stop refused by daemon" }, ws);
      }
    },
    close() {},
  };
  return { ws, frames };
}
function connectMachine(machineId: string, fake: { ws: any }, serverId: string) {
  registerDaemon(fake.ws, serverId);
  registerMachineConn(machineId, fake.ws);
  registerDaemonCapabilities(fake.ws, [AGENT_CONTROL_ACK_CAPABILITY]);
}
function disconnectMachine(machineId: string, fake: { ws: any }) {
  unregisterDaemon(fake.ws);
  unregisterMachineConn(fake.ws);
  void machineId;
}

let ownerId = "", memberId = "", ownerToken = "", memberToken = "";
let serverId = "", server2Id = "";
let oldMachineId = "", newMachineId = "", deadMachineId = "", refuseMachineId = "", foreignMachineId = "";
let runAgentId = "", stopFailAgentId = "", sleepAgentId = "", deadAgentId = "", idleAgentId = "";

async function insertMachine(sid: string, uid: string, name: string, status: "online" | "offline") {
  const key = newKey("sk_machine_");
  const [m] = await db.insert(schema.machines).values({ serverId: sid, userId: uid, name, apiKeyHash: hashToken(key), apiKeyPrefix: key.slice(0, 14), status, isComputer: false }).returning();
  return m!.id;
}
async function insertAgent(sid: string, machineId: string | null, name: string, status: string, activity: string, sessionId: string | null) {
  const [a] = await db.insert(schema.agents).values({
    serverId: sid, machineId, name, displayName: name, runtime: "claude", model: "sonnet",
    status, activity, sessionId, creatorType: "user", creatorId: ownerId,
  }).returning();
  return a!.id;
}
const agentRow = async (id: string) => (await db.select().from(schema.agents).where(eq(schema.agents.id, id)))[0]!;

async function setup() {
  const [owner] = await db.insert(schema.users).values({ name: `own_mig_${ts}`, displayName: "Owner", email: `own_mig_${ts}@t.local` }).returning();
  ownerId = owner!.id; ownerToken = signUser(ownerId);
  const [member] = await db.insert(schema.users).values({ name: `mem_mig_${ts}`, displayName: "Member", email: `mem_mig_${ts}@t.local` }).returning();
  memberId = member!.id; memberToken = signUser(memberId);

  const srv = await createServer(`agent-migrate-${ts}`, `agent-migrate-${ts}`, ownerId);
  serverId = srv.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: memberId, role: "member" });

  // Second server (same owner) — for the cross-tenant machine-existence check.
  const srv2 = await createServer(`agent-migrate-b-${ts}`, `agent-migrate-b-${ts}`, ownerId);
  server2Id = srv2.id;

  oldMachineId = await insertMachine(serverId, ownerId, `old_${ts}`, "online");
  newMachineId = await insertMachine(serverId, ownerId, `new_${ts}`, "online");
  deadMachineId = await insertMachine(serverId, ownerId, `dead_${ts}`, "offline");   // no daemon conn, status offline
  refuseMachineId = await insertMachine(serverId, ownerId, `refuse_${ts}`, "online");
  foreignMachineId = await insertMachine(server2Id, ownerId, `foreign_${ts}`, "online");

  // Agents (status pre-set as if the daemons had reported it).
  runAgentId = await insertAgent(serverId, oldMachineId, `runner_${ts}`, "active", "working", "sess-run-legacy");
  stopFailAgentId = await insertAgent(serverId, refuseMachineId, `stickler_${ts}`, "active", "working", null);
  sleepAgentId = await insertAgent(serverId, oldMachineId, `sleeper_${ts}`, "sleeping", "sleeping", "sess-sleep");
  deadAgentId = await insertAgent(serverId, deadMachineId, `stranded_${ts}`, "active", "working", null);
  idleAgentId = await insertAgent(serverId, deadMachineId, `homer_${ts}`, "inactive", "offline", null);

  // Scoped + legacy session pointers on the run agent — migrate must clear BOTH.
  await db.insert(schema.agentSessions).values([
    { serverId, agentId: runAgentId, scopeType: "channel", scopeId: (await db.select().from(schema.channels).where(eq(schema.channels.serverId, serverId)))[0]!.id, sessionId: "sess-run-chan" },
  ]);
}

async function cleanup() {
  for (const sid of [serverId, server2Id]) {
    if (!sid) continue;
    await db.delete(schema.agentSessions).where(eq(schema.agentSessions.serverId, sid)).catch(() => {});
    await db.delete(schema.agents).where(eq(schema.agents.serverId, sid)).catch(() => {});
    await db.delete(schema.machines).where(eq(schema.machines.serverId, sid)).catch(() => {});
    const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, sid)).catch(() => []);
    for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id)).catch(() => {});
    await db.delete(schema.channels).where(eq(schema.channels.serverId, sid)).catch(() => {});
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, sid)).catch(() => {});
    await db.delete(schema.servers).where(eq(schema.servers.id, sid)).catch(() => {});
  }
  await db.delete(schema.users).where(eq(schema.users.id, ownerId)).catch(() => {});
  await db.delete(schema.users).where(eq(schema.users.id, memberId)).catch(() => {});
}

async function main() {
  await setup();
  const oldFake = fakeMachineDaemon("ack");
  const newFake = fakeMachineDaemon("ack");
  const refuseFake = fakeMachineDaemon("nack");
  connectMachine(oldMachineId, oldFake, serverId);
  connectMachine(newMachineId, newFake, serverId);
  connectMachine(refuseMachineId, refuseFake, serverId);

  const migrate = (agentId: string, machineId: string, token = ownerToken) =>
    apiCall({ method: "POST", path: `/api/agents/${agentId}/migrate`, token, serverId, body: { machineId } });

  console.log("\n[1] validation order: unknown agent → 404 · offline target → 409 · no manageAgents → 403");
  const r1a = await migrate(`${"00000000-0000-0000-0000-000000000000"}`, newMachineId);
  console.log(`     → unknown agent: ${r1a.status} ${JSON.stringify(r1a.body)}`);
  check("unknown agent → 404", r1a.status === 404);
  const r1b = await migrate(runAgentId, deadMachineId);
  console.log(`     → offline target: ${r1b.status} ${JSON.stringify(r1b.body)}`);
  check("offline target → 409", r1b.status === 409);
  check("409 mentions machine-offline", /machine-offline/i.test(String(r1b.body?.error ?? r1b.body?.error)));
  const r1c = await migrate(runAgentId, newMachineId, memberToken);
  console.log(`     → member (no cap): ${r1c.status} ${JSON.stringify(r1c.body)}`);
  check("member without manageAgents → 403", r1c.status === 403);

  console.log("\n[2] running agent, both machines online → stop to OLD machine, settle, rebind + sessions cleared");
  const r2 = await migrate(runAgentId, newMachineId);
  console.log(`     → ${r2.status} ${JSON.stringify(r2.body)}`);
  check("200 ok", r2.status === 200 && r2.body?.ok === true);
  check("agent:stop was sent to the OLD machine's daemon", oldFake.frames.some((f) => f.type === "agent:stop" && f.agentId === runAgentId));
  check("no agent:stop went to the NEW machine's daemon", !newFake.frames.some((f) => f.type === "agent:stop" && f.agentId === runAgentId));
  const a2 = await agentRow(runAgentId);
  check("machineId rebound to the new machine", a2.machineId === newMachineId, `machineId=${a2.machineId}`);
  check("status inactive", a2.status === "inactive");
  check("activity offline", a2.activity === "offline");
  check("legacy agents.sessionId cleared", a2.sessionId === null);
  check("scoped agent_sessions rows deleted", (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.agentId, runAgentId))).length === 0);

  console.log("\n[3] old machine online but daemon refuses stop → 503 stop-failed, machineId unchanged");
  const r3 = await migrate(stopFailAgentId, newMachineId);
  console.log(`     → ${r3.status} ${JSON.stringify(r3.body)}`);
  check("503 stop-failed", r3.status === 503, `status=${r3.status}`);
  check("machineId NOT rebound", (await agentRow(stopFailAgentId)).machineId === refuseMachineId);

  console.log("\n[4] old machine entirely offline + agent active → skip stop, direct rebind (dead-machine flagship)");
  const deadFramesBefore = oldFake.frames.length;
  const r4 = await migrate(deadAgentId, newMachineId);
  console.log(`     → ${r4.status} ${JSON.stringify(r4.body)}`);
  check("200 ok despite active status", r4.status === 200 && r4.body?.ok === true);
  check("machineId rebound", (await agentRow(deadAgentId)).machineId === newMachineId);
  check("no stop frame was sent anywhere for the dead-machine agent", oldFake.frames.length === deadFramesBefore || !oldFake.frames.slice(deadFramesBefore).some((f) => f.type === "agent:stop" && f.agentId === deadAgentId));

  console.log("\n[5] sleeping agent on an online machine → skip stop, direct rebind; same machine → idempotent alreadyThere");
  const r5 = await migrate(sleepAgentId, newMachineId);
  console.log(`     → sleeping migrate: ${r5.status} ${JSON.stringify(r5.body)}`);
  check("200 ok, no stop required", r5.status === 200);
  check("no agent:stop sent for the sleeping agent", !oldFake.frames.some((f) => f.type === "agent:stop" && f.agentId === sleepAgentId));
  check("machineId rebound", (await agentRow(sleepAgentId)).machineId === newMachineId);
  // Idempotence precedes the online check: the agent sits on the OFFLINE dead machine → must still 200.
  const r5b = await migrate(idleAgentId, deadMachineId);
  console.log(`     → same-machine (offline machine): ${r5b.status} ${JSON.stringify(r5b.body)}`);
  check("same machine → 200 alreadyThere even though that machine is offline", r5b.status === 200 && r5b.body?.alreadyThere === true);
  check("machineId untouched by the idempotent call", (await agentRow(idleAgentId)).machineId === deadMachineId);

  console.log("\n[6] cross-tenant target machine → 409 (no existence leak)");
  const r6 = await migrate(sleepAgentId, foreignMachineId);
  console.log(`     → ${r6.status} ${JSON.stringify(r6.body)}`);
  check("cross-tenant target → 409", r6.status === 409);
  check("machineId unchanged after the 409", (await agentRow(sleepAgentId)).machineId === newMachineId);

  disconnectMachine(oldMachineId, oldFake);
  disconnectMachine(newMachineId, newFake);
  disconnectMachine(refuseMachineId, refuseFake);
}

main()
  .catch((e) => { console.error("ERROR", e); failures++; })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup error", e));
    console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
    await db.$client.end?.();
    process.exit(failures ? 1 : 0);
  });
