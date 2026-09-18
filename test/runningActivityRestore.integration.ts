// Real DB integration: page-refresh restore of in-progress agent runs. runningAgentRunsInChannel
// aggregates unclaimed agent_activity_log rows (messageId IS NULL) per agent+streamId so a freshly
// loaded client can rebuild the live "agent working" card. Verifies the aggregation and every
// liveness guard: claimed rows drop out, deactivated agents hide, offline machines hide, stale
// (over-age) rows hide, and multiple agents/streams stay separate runs.
// Requires infra up: `npm run infra` (pg :5433, redis :6380) + `npm run db:push`.
// Run: npx tsx test/runningActivityRestore.integration.ts
// (Use an isolated DB, e.g. DATABASE_URL=postgres://opentag:opentag@localhost:5433/opentag_test — never the live DB.)
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { RUNNING_RUN_MAX_AGE_MS, runningAgentRunsInChannel } from "../src/server/agentActivity.ts";

const ts = Date.now();
let serverId = "", ownerId = "", machineId = "", channelA = "", channelB = "";
const agentIds: string[] = [];
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function setup() {
  const [u] = await db.insert(schema.users).values({ name: `owner_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  ownerId = u!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  const [m] = await db.insert(schema.machines).values({ serverId, userId: ownerId, name: `m_${ts}`, apiKeyHash: `hash_${ts}`, apiKeyPrefix: `hash_${ts}`.slice(0, 14), status: "online" }).returning();
  machineId = m!.id;
  const [ca] = await db.insert(schema.channels).values({ serverId, name: `a_${ts}`, type: "channel" }).returning();
  const [cb] = await db.insert(schema.channels).values({ serverId, name: `b_${ts}`, type: "channel" }).returning();
  channelA = ca!.id; channelB = cb!.id;
  const rows = await db.insert(schema.agents).values([
    { serverId, machineId, name: `live_${ts}`, displayName: "Live", status: "active" },
    { serverId, machineId, name: `sleep_${ts}`, displayName: "Sleepy", status: "sleeping" },
    { serverId, machineId, name: `nomach_${ts}`, displayName: "NoMachine", status: "active", machineId: null },
  ]).returning();
  agentIds.push(...rows.map((r) => r.id));
}

async function cleanup() {
  await db.delete(schema.agentActivityLog).where(eq(schema.agentActivityLog.serverId, serverId));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.machines).where(eq(schema.machines.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

const row = (agentId: string, streamId: string, channelId: string, ms: number, text: string) =>
  ({ serverId, agentId, ts: ms, kind: "text" as const, text, channelId, streamId, runSeq: null as number | null, messageId: null as string | null });

async function main() {
  await setup();
  const [liveAgent, sleepingAgent, noMachineAgent] = agentIds as [string, string, string];

  console.log("\n[1] unclaimed rows aggregate per agent+stream with items and displayName");
  await db.insert(schema.agentActivityLog).values([
    row(liveAgent, "s1", channelA, ts + 1, "turn"),
    row(liveAgent, "s1", channelA, ts + 2, "reading files"),
    row(liveAgent, "s2", channelA, ts + 3, "second run same agent"),
  ]);
  let runs = await runningAgentRunsInChannel(serverId, channelA);
  check("two runs for the live agent", runs.length === 2 && runs.every((r) => r.agentId === liveAgent));
  check("items ordered and grouped per stream", runs.find((r) => r.streamId === "s1")?.items.map((i) => i.text).join("|") === "turn|reading files");
  check("displayName surfaced for the client bubble", runs[0]?.agentName === "Live");
  check("startedAt is the first row ts", runs.find((r) => r.streamId === "s1")?.startedAt === ts + 1);
  check("other channel sees none of these runs", (await runningAgentRunsInChannel(serverId, channelB)).length === 0);

  console.log("\n[2] liveness guards hide runs that cannot still be running");
  await db.insert(schema.agentActivityLog).values([
    row(sleepingAgent, "s3", channelA, ts + 4, "sleeping agent run"),
    row(noMachineAgent, "s4", channelA, ts + 5, "agent without machine"),
    row(liveAgent, "s5", channelA, Date.now() - RUNNING_RUN_MAX_AGE_MS - 60_000, "stale orphaned run"),
  ]);
  runs = await runningAgentRunsInChannel(serverId, channelA);
  check("sleeping agent hidden", !runs.some((r) => r.agentId === sleepingAgent));
  check("machine-less agent shown while an online machine exists (unbound daemon topology, e.g. seed:dev)", runs.some((r) => r.agentId === noMachineAgent && r.streamId === "s4"));
  check("over-age orphan hidden", !runs.some((r) => r.streamId === "s5"));
  check("live agent's runs unaffected", runs.filter((r) => r.agentId === liveAgent).length === 2);

  await db.update(schema.machines).set({ status: "offline" }).where(eq(schema.machines.id, machineId));
  check("machine offline hides bound and unbound runs alike (no online machine left)", (await runningAgentRunsInChannel(serverId, channelA)).length === 0);
  await db.update(schema.machines).set({ status: "online" }).where(eq(schema.machines.id, machineId));

  console.log("\n[3] a row claimed by a message drops out of the running set");
  const [msg] = await db.insert(schema.messages).values({ serverId, channelId: channelA, seq: 1, senderType: "agent", senderId: liveAgent, senderName: "Live", content: "reply", agentActivityStreamId: "s2", agentActivityState: "running" }).returning();
  await db.update(schema.agentActivityLog).set({ messageId: msg!.id }).where(eq(schema.agentActivityLog.streamId, "s2"));
  runs = await runningAgentRunsInChannel(serverId, channelA);
  check("claimed stream s2 no longer returned (its message owns the card now)", !runs.some((r) => r.streamId === "s2"));
  check("unclaimed s1 still returned", runs.some((r) => r.streamId === "s1"));
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });
