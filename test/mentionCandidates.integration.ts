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
import { EventEmitter } from "node:events";
import { Readable, type IncomingMessage } from "node:stream";
import type { ServerResponse } from "node:http";
import { db, schema } from "../src/db/index.ts";
import { mentionCandidates } from "../src/server/core.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";

// In-process HTTP harness (same shape as test/channelAccessB2.integration.ts): full gate stack, no port.
function makeReq(method: string, path: string, token: string, sid: string): IncomingMessage {
  const readable = Readable.from([] as Buffer[]);
  return Object.assign(readable, { method, url: path, headers: { authorization: `Bearer ${token}`, "x-server-id": sid, "content-type": "application/json" } }) as unknown as IncomingMessage;
}
function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let status = 0; let raw = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0, headersSent: false,
    setHeader(_n: string, _v: unknown) {},
    writeHead(code: number) { status = code; this.statusCode = code; },
    end(d?: string | Buffer) { raw = d ? String(d) : ""; emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  const body = () => { try { return JSON.parse(raw); } catch { return raw; } };
  return { res, status: () => status, body };
}
async function apiGet(path: string, token: string, sid: string): Promise<{ status: number; body: any }> {
  const { res, status, body } = makeRes();
  await handleApi(makeReq("GET", path, token, sid), res, new URL(path, "http://localhost:7777"), "GET");
  return { status: status(), body: body() };
}

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

  console.log("\n[4] route: shape, kind/avatarUrl mapping, and existence-hiding auth negatives");
  const reqToken = signUser(requesterId);
  const pub = await apiGet(`/api/channels/${pubId}/mention-candidates`, reqToken, serverId);
  check("public channel 200 with candidates[]", pub.status === 200 && Array.isArray(pub.body?.candidates));
  const shapeOk = (pub.body?.candidates ?? []).every((c: any) => typeof c.id === "string" && typeof c.name === "string" && ("avatarUrl" in c) && (c.kind === "agent" || c.kind === "human") && typeof c.member === "boolean");
  check("candidate shape: id/name/avatarUrl/kind(human not user)/member", shapeOk);
  check("route excludes requester and flags members like the core fn", !(pub.body?.candidates ?? []).some((c: any) => c.id === requesterId) && (pub.body?.candidates ?? []).some((c: any) => c.id === a1 && c.member === true));
  const priv = await apiGet(`/api/channels/${privId}/mention-candidates`, reqToken, serverId);
  check("private channel 200, members only", priv.status === 200 && (priv.body?.candidates ?? []).every((c: any) => [a1].includes(c.id)));
  const thread = await apiGet(`/api/channels/${threadId}/mention-candidates`, reqToken, serverId);
  check("thread 200 reaching the workspace", thread.status === 200 && (thread.body?.candidates ?? []).some((c: any) => c.id === a2 && c.member === false));
  // Auth negatives — existence-hiding 404s, never 403 (IDOR-B2 convention).
  const h2Token = signUser(otherHumanId);
  const h2priv = await apiGet(`/api/channels/${privId}/mention-candidates`, h2Token, serverId);
  check("non-member human on a private channel → 404", h2priv.status === 404);
  const cross = await apiGet(`/api/channels/00000000-0000-4000-8000-000000000000/mention-candidates`, reqToken, serverId);
  check("cross-tenant channel uuid → 404", cross.status === 404);
  const nonUuid = await apiGet(`/api/channels/not-a-uuid/mention-candidates`, reqToken, serverId);
  check("non-uuid → 404", nonUuid.status === 404);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });
