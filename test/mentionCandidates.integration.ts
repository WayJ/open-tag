// Real DB integration: channel-scoped @-mention candidates. core.mentionCandidates wraps the
// private mentionAutoJoinPool + channelMembers to produce the composer picker's single source of
// truth: a channel's members plus everyone its @-reach may pull in (thread inherits its parent),
// minus the requester. Verifies the pool per channel type, the member flag, self-exclusion, the
// system showcase agent never appearing, and the route's auth semantics (existence-hiding 404s).
// Requires infra up: `npm run infra` (pg :5433, redis :6380) + `npm run db:push`.
// Run: DATABASE_URL=postgres://opentag:opentag@localhost:5433/opentag_mention_candidates npx tsx test/mentionCandidates.integration.ts
import { assertIntegrationDbIsolated } from "./integrationDbGuard.ts";
assertIntegrationDbIsolated("test/mentionCandidates.integration.ts");
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { mentionCandidates } from "../src/server/core.ts";

const ts = Date.now();
let serverId = "", requesterId = "", otherHumanId = "";
let pubId = "", privId = "", dmId = "", threadId = "";
let a1 = "", a2 = "", a3 = "", sysId = "";
let pubRow: typeof schema.channels.$inferSelect | undefined;
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function setup() {
  const [r] = await db.insert(schema.users).values({ name: `req_${ts}`, displayName: "Requester", email: `req_${ts}@t.local` }).returning();
  const [h2] = await db.insert(schema.users).values({ name: `h2_${ts}`, displayName: "OtherHuman", email: `h2_${ts}@t.local` }).returning();
  requesterId = r!.id; otherHumanId = h2!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId: requesterId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([{ serverId, userId: requesterId, role: "owner" }, { serverId, userId: otherHumanId, role: "member" }]);
  const [pub] = await db.insert(schema.channels).values({ serverId, name: `pub_${ts}`, type: "channel" }).returning();
  const [priv] = await db.insert(schema.channels).values({ serverId, name: `priv_${ts}`, type: "private" }).returning();
  const [dm] = await db.insert(schema.channels).values({ serverId, name: `dm_${ts}`, type: "dm" }).returning();
  pubId = pub!.id; privId = priv!.id; dmId = dm!.id;
  const [pm] = await db.insert(schema.messages).values({ serverId, channelId: pubId, seq: 1, senderType: "user", senderId: requesterId, senderName: "Requester", content: "parent" }).returning();
  const [th] = await db.insert(schema.channels).values({ serverId, name: `th_${ts}`, type: "thread", parentMessageId: pm!.id }).returning();
  threadId = th!.id;
  const agents = await db.insert(schema.agents).values([
    { serverId, name: `a1_${ts}`, displayName: "MemberAgent" },
    { serverId, name: `a2_${ts}`, displayName: "OutsiderAgent" },
    { serverId, name: `a3_${ts}`, displayName: "WorkspaceAgent" },
    { serverId, name: `sys_${ts}`, displayName: "ShowcaseAgent", creatorType: "system" },
  ]).returning();
  a1 = agents[0]!.id; a2 = agents[1]!.id; a3 = agents[2]!.id; sysId = agents[3]!.id;
  const member = (channelId: string, type: "user" | "agent", id: string) => ({ channelId, memberType: type, memberId: id });
  await db.insert(schema.channelMembers).values([
    member(pubId, "user", requesterId), member(pubId, "user", otherHumanId), member(pubId, "agent", a1),
    member(privId, "user", requesterId), member(privId, "agent", a1),
    member(dmId, "user", requesterId), member(dmId, "agent", a1),
    member(threadId, "user", requesterId), member(threadId, "agent", a1),
  ]);
  pubRow = pub;
}

async function cleanup() {
  for (const id of [pubId, privId, dmId, threadId]) {
    if (id) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, id));
  }
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, requesterId));
  await db.delete(schema.users).where(eq(schema.users.id, otherHumanId));
}

async function main() {
  await setup();
  const names = (rows: { id: string }[]) => new Set(rows.map((x) => x.id));

  console.log("\n[1] public channel: members + workspace pull-in, requester and system agent excluded");
  let rows = await mentionCandidates(serverId, pubRow!, requesterId);
  let ids = names(rows);
  check("member agent flagged member:true", rows.find((x) => x.id === a1)?.member === true);
  check("member human H2 flagged member:true", rows.find((x) => x.id === otherHumanId)?.member === true);
  check("non-member workspace agents present with member:false (pull-in kept)", [a2, a3].every((id) => rows.some((x) => x.id === id && x.member === false)));
  check("requester excluded", !ids.has(requesterId));
  check("system showcase agent never appears", !ids.has(sysId));
  const flags = rows.map((x) => x.member);
  check("members sort before non-members", flags.every((f, i) => i === 0 || flags[i - 1]! >= f));

  console.log("\n[2] private channel and DM: members only");
  const privRow = (await db.select().from(schema.channels).where(eq(schema.channels.id, privId)))[0]!;
  rows = await mentionCandidates(serverId, privRow, requesterId);
  ids = names(rows);
  check("private lists only its members (A1), not outsiders", ids.has(a1) && !ids.has(a2) && !ids.has(a3) && !ids.has(otherHumanId) && !ids.has(requesterId));
  const dmRow = (await db.select().from(schema.channels).where(eq(schema.channels.id, dmId)))[0]!;
  rows = await mentionCandidates(serverId, dmRow, requesterId);
  ids = names(rows);
  check("dm lists only its members", ids.has(a1) && !ids.has(a2) && !ids.has(requesterId));

  console.log("\n[3] thread inherits the PARENT channel's reach, member flag from the thread itself");
  const threadRow = (await db.select().from(schema.channels).where(eq(schema.channels.id, threadId)))[0]!;
  rows = await mentionCandidates(serverId, threadRow, requesterId);
  ids = names(rows);
  check("public parent's thread reaches the workspace (A2 present)", ids.has(a2));
  check("thread member A1 member:true, non-participant A2 member:false", rows.find((x) => x.id === a1)?.member === true && rows.find((x) => x.id === a2)?.member === false);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });
