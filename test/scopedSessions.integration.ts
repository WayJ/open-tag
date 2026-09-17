// Integration test for scoped sessions (Task 2): server-side scope resolution + protocol injection.
// Verifies: resolveScope pure mapping, agentConfig(ctx) scope resolution (thread/channel/dm/deleted/
// cross-server), agent_sessions sessionId pickup, and that the legacy dispatch path stamps the same
// scope onto both the agent:start config and the agent:deliver body.
// Mirrors test/channelArtifacts.integration.ts (real DB, direct function calls).
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run: npx tsx test/scopedSessions.integration.ts
import "../src/env.ts";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { agentConfig, resolveScope, type AgentScope } from "../src/server/agentConfig.ts";
import { createServer } from "../src/server/core.ts";
import { dispatchLegacyMessage, type ConversationTurnDispatchDeps, type DispatchMember } from "../src/server/conversationTurnDispatch.ts";

const ts = Date.now();
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let ownerId = "";
let serverId = "";
let server2Id = "";
let channelId = "";
let threadChannelId = "";
let dmChannelId = "";
let deletedChannelId = "";
let otherServerChannelId = "";
let agentId = "";
let agentName = "";

let seq = 0;
const insertMessage = async (chId: string, senderType: "user" | "agent", senderId: string, senderName: string, content: string) =>
  (await db.insert(schema.messages).values({
    seq: ++seq, serverId, channelId: chId, senderType, senderId, senderName, content,
  }).returning())[0]!;

async function setup() {
  const [owner] = await db.insert(schema.users).values({
    name: `owner_scoped_${ts}`,
    displayName: "Owner",
    email: `owner_scoped_${ts}@agent-route.local`,
  }).returning();
  ownerId = owner!.id;

  const srv = await createServer(`scoped-sessions-${ts}`, `scoped-sessions-${ts}`, ownerId);
  serverId = srv.id;
  const all = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, "all"))))[0]!;
  channelId = all.id;

  const [threadCh] = await db.insert(schema.channels).values({ serverId, name: `thread_${ts}`, type: "thread" }).returning();
  threadChannelId = threadCh!.id;
  const [dmCh] = await db.insert(schema.channels).values({ serverId, name: `dm_${ts}`, type: "dm" }).returning();
  dmChannelId = dmCh!.id;
  const [gone] = await db.insert(schema.channels).values({ serverId, name: `gone_${ts}`, type: "channel", deletedAt: new Date() }).returning();
  deletedChannelId = gone!.id;

  const [agent] = await db.insert(schema.agents).values({
    serverId,
    name: `worker_${ts}`,
    displayName: "Worker",
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: ownerId,
  }).returning();
  agentId = agent!.id;
  agentName = agent!.name;

  await db.insert(schema.channelMembers).values([
    { channelId, memberType: "agent", memberId: agentId },
    { channelId: threadChannelId, memberType: "agent", memberId: agentId },
  ]).onConflictDoNothing();

  // Cross-tenant channel on a second server — must never resolve into this agent's scope.
  const srv2 = await createServer(`scoped-sessions-b-${ts}`, `scoped-sessions-b-${ts}`, ownerId);
  server2Id = srv2.id;
  const [chB] = await db.insert(schema.channels).values({ serverId: srv2.id, name: `secret_${ts}`, type: "channel" }).returning();
  otherServerChannelId = chB!.id;
}

async function cleanup() {
  for (const sid of [serverId, server2Id]) {
    if (!sid) continue;
    const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, sid));
    await db.delete(schema.causalEdges).where(eq(schema.causalEdges.serverId, sid));
    await db.delete(schema.agentMessageObservations).where(eq(schema.agentMessageObservations.serverId, sid));
    await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, sid));
    await db.delete(schema.agentSessions).where(eq(schema.agentSessions.serverId, sid));
    for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
    await db.delete(schema.messages).where(eq(schema.messages.serverId, sid));
    await db.delete(schema.conversationTurns).where(eq(schema.conversationTurns.serverId, sid));
    const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, sid));
    for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
    await db.delete(schema.channels).where(eq(schema.channels.serverId, sid));
    await db.delete(schema.agents).where(eq(schema.agents.serverId, sid));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, sid));
    await db.delete(schema.servers).where(eq(schema.servers.id, sid));
  }
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

/** Deps for dispatchLegacyMessage that resolve targets through the REAL agentConfig(ctx) path and
 *  capture what the protocol layer would put on the wire. */
async function captureDispatch(channelIdOfMsg: string) {
  const agentMember: DispatchMember = { type: "agent", id: agentId, name: agentName, displayName: "Worker" };
  const startCfgs: Record<string, unknown>[] = [];
  const deliverMsgs: Record<string, unknown>[] = [];
  let startCtx: { channelId: string } | undefined;
  const deps: ConversationTurnDispatchDeps<{ ok: true; cfg?: { scope?: AgentScope } }> = {
    channelMembers: async () => [agentMember],
    parseMentions: () => [agentMember],
    agentStartTarget: async (_serverId, _agentId, ctx) => {
      startCtx = ctx;
      return { ok: true as const, machineId: null, cfg: await agentConfig(agentId, ctx) };
    },
    sendAgentStart: (_serverId, target) => { startCfgs.push((target as { cfg: Record<string, unknown> }).cfg); return true; },
    sendAgentDeliver: (_serverId, _target, message) => { deliverMsgs.push(message); return true; },
    markAgentUnavailable: async () => {},
    finalizeAgentActivityRun: async () => {},
  };
  const msg = await insertMessage(channelIdOfMsg, "user", ownerId, `owner_scoped_${ts}`, `@${agentName} ping`);
  await dispatchLegacyMessage({ msg, channel: (await db.select().from(schema.channels).where(eq(schema.channels.id, channelIdOfMsg)))[0], members: [agentMember], mentions: [agentMember], asTask: false }, deps);
  return { startCfgs, deliverMsgs, startCtx };
}

async function main() {
  await setup();

  console.log("\n[1] resolveScope: pure channel-row → scope-kind mapping");
  check("thread row → {type:'thread', id}", same(resolveScope({ type: "thread", id: "t1" }), { type: "thread", id: "t1" }));
  check("channel row → {type:'channel', id}", same(resolveScope({ type: "channel", id: "c1" }), { type: "channel", id: "c1" }));

  console.log("\n[2] dispatch a thread message (cold start) → agent:start config + deliver body carry thread scope");
  const threadRun = await captureDispatch(threadChannelId);
  check("agentStartTarget received the channel ctx", same(threadRun.startCtx, { channelId: threadChannelId }));
  check("agent:start config.scope = {thread, threadChannelId, sessionId:null}", same(threadRun.startCfgs[0]?.scope, { type: "thread", id: threadChannelId, sessionId: null }));
  check("agent:deliver body carries the same scope", same(threadRun.deliverMsgs[0]?.scope, { type: "thread", id: threadChannelId, sessionId: null }));
  check("cold start leaves top-level sessionId key in place (rollout compat)", threadRun.startCfgs[0] ? "sessionId" in threadRun.startCfgs[0] : false);

  console.log("\n[3] channel top-level message → channel scope");
  const channelRun = await captureDispatch(channelId);
  check("agent:start config.scope.type = channel on the channel id", same(channelRun.startCfgs[0]?.scope, { type: "channel", id: channelId, sessionId: null }));
  check("agent:deliver body carries the same channel scope", same(channelRun.deliverMsgs[0]?.scope, { type: "channel", id: channelId, sessionId: null }));

  console.log("\n[4] preset agent_sessions row → config.scope.sessionId picks up its value");
  await db.insert(schema.agentSessions).values({
    serverId, agentId, scopeType: "thread", scopeId: threadChannelId, sessionId: "sess-thread-42",
  });
  const scopedCfg = await agentConfig(agentId, { channelId: threadChannelId });
  check("thread scope sessionId comes from agent_sessions row", scopedCfg?.scope?.sessionId === "sess-thread-42");
  check("scope id/type unchanged", scopedCfg?.scope?.type === "thread" && scopedCfg?.scope?.id === threadChannelId);

  console.log("\n[5] dm / deleted / cross-server channels resolve per contract");
  const dmCfg = await agentConfig(agentId, { channelId: dmChannelId });
  check("dm → channel scope on the dm channel id", same(dmCfg?.scope, { type: "channel", id: dmChannelId, sessionId: null }));
  const deletedCfg = await agentConfig(agentId, { channelId: deletedChannelId });
  check("deleted channel → no scope field (LEGACY)", !!deletedCfg && !("scope" in deletedCfg));
  const crossCfg = await agentConfig(agentId, { channelId: otherServerChannelId });
  check("other server's channel → no scope field (tenant isolation)", !!crossCfg && !("scope" in crossCfg));

  console.log("\n[6] manual restart (no channel ctx) → config has no scope, top-level sessionId untouched");
  const plainCfg = await agentConfig(agentId);
  check("no ctx → no scope field", !!plainCfg && !("scope" in plainCfg));
  check("no ctx → top-level sessionId key still present", !!plainCfg && "sessionId" in plainCfg);
  const legacyAfterScoped = await agentConfig(agentId);
  check("agent_sessions row does not leak into the ctx-less config", legacyAfterScoped?.scope === undefined);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });
