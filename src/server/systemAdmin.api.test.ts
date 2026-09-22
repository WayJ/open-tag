// src/server/systemAdmin.api.test.ts
// Real-server API tests for the system-admin plane (pattern: agentLifecycle.api.test.ts).
// Runs against the WORKTREE db — creates its own users via direct db inserts.
import "../env.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { and, eq, getTableColumns, getTableName } from "drizzle-orm";
import { db, schema, sql } from "../db/index.js";
import { hashPassword, signUser } from "./auth.js";
import { promoteSystemAdminsFromEnv } from "./systemSettings.js";
import { SERVER_DELETE_TABLES } from "./routes-api/admin.js";
import { logAudit } from "./audit.js";

let serverProcess: ChildProcess | null = null;
let base = "";
const suffix = randomUUID().slice(0, 8);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function startServer(): Promise<string> {
  const port = await freePort();
  const chunks: string[] = [];
  serverProcess = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout?.on("data", (chunk) => chunks.push(String(chunk)));
  serverProcess.stderr?.on("data", (chunk) => chunks.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (serverProcess.exitCode != null) throw new Error(`server exited ${serverProcess.exitCode}: ${chunks.join("")}`);
    try { if ((await fetch(`${base}/health`)).ok) return base; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${chunks.join("")}`);
}

function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(base + pathname, init);
}
async function insertUser(opts: { email: string; name: string; password: string; systemRole?: string | null; disabledAt?: Date | null }) {
  const [u] = await db.insert(schema.users).values({
    name: opts.name, displayName: opts.name, email: opts.email,
    passwordHash: hashPassword(opts.password),
    systemRole: opts.systemRole ?? null, disabledAt: opts.disabledAt ?? null,
  }).returning();
  return u!;
}

before(async () => { base = await startServer(); });
after(async () => { if (serverProcess?.pid) serverProcess.kill("SIGTERM"); await sql.end(); });

test("disabled user: login 403, existing JWT rejected at gate 1, me exposes systemRole", async () => {
  const admin = await insertUser({ email: `sa1-${suffix}@t.local`, name: `sa1${suffix}`, password: "password-1", systemRole: "system_admin" });
  const victim = await insertUser({ email: `vi1-${suffix}@t.local`, name: `vi1${suffix}`, password: "password-1" });

  const meRes = await api("/api/auth/me", { headers: { authorization: `Bearer ${signUser(admin.id)}` } });
  assert.equal(meRes.status, 200);
  assert.equal(((await meRes.json()) as any).systemRole, "system_admin");

  const okRes = await api("/api/auth/me", { headers: { authorization: `Bearer ${signUser(victim.id)}` } });
  assert.equal(okRes.status, 200);

  await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, victim.id));
  const rej = await api("/api/auth/me", { headers: { authorization: `Bearer ${signUser(victim.id)}` } });
  assert.equal(rej.status, 401);

  const loginRes = await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: victim.email, password: "password-1" }) });
  assert.equal(loginRes.status, 403);
  assert.equal(((await loginRes.json()) as any).code, "auth_account_disabled");
});

test("registration gate: obeys openRegistration toggle; admin can flip it; config reflects it", async () => {
  const admin = await insertUser({ email: `sa2-${suffix}@t.local`, name: `sa2${suffix}`, password: "password-1", systemRole: "system_admin" });
  const hdr = { authorization: `Bearer ${signUser(admin.id)}`, "content-type": "application/json" };

  // establish the precondition explicitly (no order dependence on earlier runs/tests)
  assert.equal((await api("/api/admin/settings", { method: "PATCH", headers: hdr, body: JSON.stringify({ openRegistration: true }) })).status, 200);
  try {
    assert.equal(((await (await api("/api/auth/config")).json()) as any).openRegistration, true);
    const reg1 = await api("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `rg1${suffix}`, email: `rg1-${suffix}@t.local`, password: "password-1" }) });
    assert.equal(reg1.status, 200);

    const patch = await api("/api/admin/settings", { method: "PATCH", headers: hdr, body: JSON.stringify({ openRegistration: false }) });
    assert.equal(patch.status, 200);
    assert.equal(((await (await api("/api/auth/config")).json()) as any).openRegistration, false);
    const reg2 = await api("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `rg2${suffix}`, email: `rg2-${suffix}@t.local`, password: "password-1" }) });
    assert.equal(reg2.status, 403);
    assert.equal(((await reg2.json()) as any).code, "auth_registration_closed");

    // non-admin cannot PATCH settings
    const plebTok = signUser((await insertUser({ email: `pl2-${suffix}@t.local`, name: `pl2${suffix}`, password: "password-1" })).id);
    assert.equal((await api("/api/admin/settings", { method: "PATCH", headers: { authorization: `Bearer ${plebTok}`, "content-type": "application/json" }, body: JSON.stringify({ openRegistration: true }) })).status, 403);
  } finally {
    // restore for later batches — must run even if an assert above threw
    await api("/api/admin/settings", { method: "PATCH", headers: hdr, body: JSON.stringify({ openRegistration: true }) });
  }
});

test("admin users: list, disable/enable, grant/revoke sysadmin, self-guard, reset password", async () => {
  const admin = await insertUser({ email: `sa3-${suffix}@t.local`, name: `sa3${suffix}`, password: "password-1", systemRole: "system_admin" });
  const hdr = { authorization: `Bearer ${signUser(admin.id)}`, "content-type": "application/json" };
  const pleb = await insertUser({ email: `pl3-${suffix}@t.local`, name: `pl3${suffix}`, password: "password-1" });

  const forb = await api("/api/admin/users", { headers: { authorization: `Bearer ${signUser(pleb.id)}` } });
  assert.equal(forb.status, 403);

  const list: any = await (await api("/api/admin/users", { headers: hdr })).json();
  const row = list.users.find((x: any) => x.id === pleb.id);
  assert.ok(row && row.systemRole === null && row.workspaceCount === 0 && row.disabledAt === null);

  await api(`/api/admin/users/${pleb.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ disabled: true }) });
  assert.equal((await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: pleb.email, password: "password-1" }) })).status, 403);
  await api(`/api/admin/users/${pleb.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ disabled: false }) });
  assert.equal((await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: pleb.email, password: "password-1" }) })).status, 200);

  assert.equal((await api(`/api/admin/users/${admin.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ disabled: true }) })).status, 400);
  assert.equal((await api(`/api/admin/users/${admin.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ systemRole: null }) })).status, 400);

  await api(`/api/admin/users/${pleb.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ systemRole: "system_admin" }) });
  assert.equal(((await (await api("/api/auth/me", { headers: { authorization: `Bearer ${signUser(pleb.id)}` } })).json()) as any).systemRole, "system_admin");
  await api(`/api/admin/users/${pleb.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ systemRole: null }) });

  const rst = await api(`/api/admin/users/${pleb.id}/reset-password`, { method: "POST", headers: hdr });
  assert.equal(rst.status, 200);
  const temp = ((await rst.json()) as any).tempPassword as string;
  assert.ok(typeof temp === "string" && temp.length >= 10);
  assert.equal((await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: pleb.email, password: "password-1" }) })).status, 401);
  assert.equal((await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: pleb.email, password: temp }) })).status, 200);

  // unmatched /api/admin/* path (guard passed) → 404 inside the handler, never gate-2's misleading 400
  assert.equal((await api("/api/admin/nonexistent", { headers: hdr })).status, 404);
});

test("system invites: create → info → accept creates account & joins workspace; dup pending 409; revoked/expired 410; non-admin 403", async () => {
  const admin = await insertUser({ email: `sa4-${suffix}@t.local`, name: `sa4${suffix}`, password: "password-1", systemRole: "system_admin" });
  const hdr = { authorization: `Bearer ${signUser(admin.id)}`, "content-type": "application/json" };
  const srv = (await db.select().from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0]!;

  const inv: any = await (await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: `in4-${suffix}@t.local`, serverId: srv.id, role: "member" }) })).json();
  assert.ok(inv.invite?.token && inv.url?.includes("/invite/"));

  assert.equal((await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: `in4-${suffix}@t.local`, serverId: srv.id }) })).status, 409);

  const info: any = await (await api(`/api/auth/system-invite-info?token=${inv.invite.token}`)).json();
  assert.equal(info.valid, true);
  assert.ok(!info.email.includes(`in4-${suffix}`)); // masked
  assert.equal(info.serverSlug, "open-tag");

  const acc = await api("/api/auth/accept-system-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inv.invite.token, name: `in4${suffix}`, password: "password-1" }) });
  assert.equal(acc.status, 200);
  const { token: newTok }: any = await acc.json();
  const me: any = await (await api("/api/auth/me", { headers: { authorization: `Bearer ${newTok}` } })).json();
  assert.equal(me.email, `in4-${suffix}@t.local`);
  const newMem = (await db.select().from(schema.serverMembers).where(eq(schema.serverMembers.userId, me.id)))[0];
  assert.ok(newMem && newMem.serverId === srv.id && newMem.role === "member");
  // joined #all
  const allCh = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, srv.id), eq(schema.channels.name, "all"))))[0]!;
  const cm = (await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, allCh.id), eq(schema.channelMembers.memberId, me.id))))[0];
  assert.ok(cm);

  const usedRes = await api("/api/auth/accept-system-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inv.invite.token, name: "x", password: "password-1" }) });
  assert.equal(usedRes.status, 410);
  assert.equal(((await usedRes.json()) as any).code, "invite_used");

  const inv2: any = await (await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: `in5-${suffix}@t.local`, serverId: srv.id, expiresInDays: 0.00001 }) })).json();
  await new Promise((r) => setTimeout(r, 1100)); // expiresInDays 0.00001 = ~0.86s — let it actually lapse
  const expRes = await api("/api/auth/accept-system-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inv2.invite.token, name: "y", password: "password-1" }) });
  assert.equal(expRes.status, 410);
  assert.equal(((await expRes.json()) as any).code, "invite_expired");
  // re-invite after expiry replaces the stale row (pending-email unique index must not 500)
  const inv2b: any = await (await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: `in5-${suffix}@t.local`, serverId: srv.id }) })).json();
  assert.ok(inv2b.invite?.token && inv2b.invite.token !== inv2.invite.token);

  const inv3: any = await (await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: `in6-${suffix}@t.local`, serverId: srv.id }) })).json();
  assert.equal((await api(`/api/admin/invites/${inv3.invite.id}`, { method: "DELETE", headers: hdr })).status, 200);
  const revRes = await api("/api/auth/accept-system-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inv3.invite.token, name: "z", password: "password-1" }) });
  assert.equal(revRes.status, 410);
  assert.equal(((await revRes.json()) as any).code, "invite_not_found");
  assert.equal((await api(`/api/admin/invites/${inv3.invite.id}`, { method: "DELETE", headers: hdr })).status, 404);

  // an accepted invite leaves room for a fresh pending one on the same email; while that pending
  // lives, another create must 409 (regression: the dup check used to read the first row only —
  // possibly the accepted one — skip the 409, and blow up on the pending-email unique index with a 500)
  assert.equal((await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: `in4-${suffix}@t.local`, serverId: srv.id }) })).status, 200);
  assert.equal((await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: `in4-${suffix}@t.local`, serverId: srv.id }) })).status, 409);

  // admin list shows statuses
  const list: any = await (await api("/api/admin/invites", { headers: hdr })).json();
  assert.ok(list.invites.some((i: any) => i.id === inv.invite.id && i.status === "accepted"));
  assert.ok(!list.invites.some((i: any) => i.id === inv3.invite.id)); // revoked = hard-deleted

  const pleb = await insertUser({ email: `pl4-${suffix}@t.local`, name: `pl4${suffix}`, password: "password-1" });
  assert.equal((await api("/api/admin/invites", { method: "POST", headers: { authorization: `Bearer ${signUser(pleb.id)}`, "content-type": "application/json" }, body: JSON.stringify({ email: "x@y.zz", serverId: srv.id }) })).status, 403);

  // accepting an invite whose email is already registered → 409 (fresh username, so it's the email that clashes)
  const plebInv: any = await (await api("/api/admin/invites", { method: "POST", headers: hdr, body: JSON.stringify({ email: pleb.email, serverId: srv.id }) })).json();
  const dupAcc = await api("/api/auth/accept-system-invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: plebInv.invite.token, name: `zz${suffix}`, password: "password-1" }) });
  assert.equal(dupAcc.status, 409);
  assert.equal(((await dupAcc.json()) as any).code, "auth_register_email_taken");
});

test("admin servers/stats/audit: list counts, delete cascades, gate-2 rejection, audit rows exist", async () => {
  const admin = await insertUser({ email: `sa5-${suffix}@t.local`, name: `sa5${suffix}`, password: "password-1", systemRole: "system_admin" });
  const hdr = { authorization: `Bearer ${signUser(admin.id)}`, "content-type": "application/json" };
  const srv = (await db.select().from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0]!;

  // throwaway workspace: server + #all channel + membership + one message + one message-scoped child row
  const [tmp] = await db.insert(schema.servers).values({ name: `tmp-${suffix}`, slug: `tmp-${suffix}`, ownerId: admin.id }).returning();
  const [ch] = await db.insert(schema.channels).values({ serverId: tmp!.id, name: "all", type: "channel" }).returning();
  await db.insert(schema.serverMembers).values({ serverId: tmp!.id, userId: admin.id, role: "owner" });
  await db.insert(schema.channelMembers).values({ channelId: ch!.id, memberType: "user", memberId: admin.id });
  // seq: hand-picked out of Redis's range (same convention as conversationTurns.integration.test.ts)
  const [msg] = await db.insert(schema.messages).values({ seq: 9_000_001, serverId: tmp!.id, channelId: ch!.id, senderType: "user", senderId: admin.id, senderName: admin.name, content: "hello tmp" }).returning();
  await db.insert(schema.reactions).values({ messageId: msg!.id, memberType: "user", memberId: admin.id, emoji: "+1" }); // message-scoped child
  // Fill EVERY remaining server-scoped table with real rows so the DELETE transaction is proven
  // against each FK (an empty table can't surface a missed/out-of-order delete). Insertion order
  // follows the FK dependency graph; the DELETE must clear all of these without a FK violation.
  const [mach] = await db.insert(schema.machines).values({ serverId: tmp!.id, userId: admin.id, name: "m", apiKeyHash: "h", apiKeyPrefix: "sk_m" }).returning();
  const [ag] = await db.insert(schema.agents).values({ serverId: tmp!.id, machineId: mach!.id, name: "bot", displayName: "bot" }).returning();
  await db.insert(schema.channelMembers).values({ channelId: ch!.id, memberType: "agent", memberId: ag!.id });
  const [turn] = await db.insert(schema.conversationTurns).values({ serverId: tmp!.id, channelId: ch!.id, senderType: "user", senderId: admin.id, anchorMessageId: msg!.id, triggerMessageId: msg!.id, latestMessageId: msg!.id, firstSeq: 1, lastSeq: 1, dispatchAfter: new Date(), causalRootId: randomUUID() }).returning();
  await db.insert(schema.causalEdges).values({ serverId: tmp!.id, rootTurnId: turn!.id, parentTurnId: turn!.id, sourceAgentId: ag!.id, targetAgentId: ag!.id, depth: 1, outcome: "accepted" });
  await db.insert(schema.messageMentions).values({ messageId: msg!.id, mentionType: "agent", mentionId: ag!.id, mentionName: "bot" });
  await db.insert(schema.savedMessages).values({ serverId: tmp!.id, memberType: "user", memberId: admin.id, messageId: msg!.id });
  await db.insert(schema.agentMessageDecisions).values({ messageId: msg!.id, agentId: ag!.id, serverId: tmp!.id, channelId: ch!.id });
  await db.insert(schema.agentMessageObservations).values({ messageId: msg!.id, agentId: ag!.id, serverId: tmp!.id });
  await db.insert(schema.agentActivityLog).values({ serverId: tmp!.id, agentId: ag!.id, ts: Date.now(), kind: "status", messageId: msg!.id, channelId: ch!.id });
  const [att] = await db.insert(schema.attachments).values({ serverId: tmp!.id, messageId: msg!.id, channelId: ch!.id, filename: "f.txt", storageKey: "/tmp/f.txt" }).returning();
  const [art] = await db.insert(schema.artifacts).values({ serverId: tmp!.id, channelId: ch!.id, name: "art", createdByType: "user", createdByUserId: admin.id }).returning();
  await db.insert(schema.artifactVersions).values({ artifactId: art!.id, serverId: tmp!.id, channelId: ch!.id, version: 1, attachmentId: att!.id, createdByType: "user" });
  await db.insert(schema.agentSessions).values({ serverId: tmp!.id, agentId: ag!.id, scopeType: "channel", scopeId: ch!.id });
  await db.insert(schema.agentMemory).values({ serverId: tmp!.id, agentId: ag!.id, files: { "MEMORY.md": "x" }, memoryDigest: "a".repeat(64) });
  await db.insert(schema.knowledge).values({ serverId: tmp!.id, createdByAgentId: ag!.id, title: "t", content: "c", searchText: "t c" });
  await db.insert(schema.reminders).values({ serverId: tmp!.id, ownerType: "user", ownerId: admin.id, channelId: ch!.id, content: "r", remindAt: new Date() });
  await db.insert(schema.serverSidebarPrefs).values({ serverId: tmp!.id, userId: admin.id, prefs: {} });
  await db.insert(schema.joinLinks).values({ serverId: tmp!.id, token: `jl_${suffix}`, createdByUserId: admin.id });
  await db.insert(schema.systemInvites).values({ email: `tmpin-${suffix}@t.local`, token: `invt_${suffix}`, serverId: tmp!.id });

  const list: any = await (await api("/api/admin/servers", { headers: hdr })).json();
  const tmpRow = list.servers.find((s: any) => s.id === tmp!.id);
  assert.ok(tmpRow && tmpRow.memberCount === 1 && tmpRow.agentCount === 1);

  // pre-existing audit row referencing this server: must SURVIVE the delete with targetServerId nulled
  await logAudit("invite.created", { actorUserId: admin.id, targetServerId: tmp!.id, metadata: { tag: `batchd-audit-${suffix}` } });

  assert.equal((await api(`/api/admin/servers/${tmp!.id}`, { method: "DELETE", headers: hdr })).status, 200);
  assert.equal((await db.select().from(schema.servers).where(eq(schema.servers.id, tmp!.id))).length, 0);
  assert.equal((await db.select().from(schema.channels).where(eq(schema.channels.serverId, tmp!.id))).length, 0);
  assert.equal((await db.select().from(schema.messages).where(eq(schema.messages.serverId, tmp!.id))).length, 0);
  assert.equal((await db.select().from(schema.reactions).where(eq(schema.reactions.messageId, msg!.id))).length, 0); // message-scoped child cleared
  assert.equal((await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, ch!.id))).length, 0); // channel-scoped child cleared
  assert.equal((await db.select().from(schema.serverMembers).where(eq(schema.serverMembers.serverId, tmp!.id))).length, 0);
  // every FK-bearing child table the workspace filled must be cleared (a miss would have 500'd the DELETE above)
  const scopedTables: [string, { serverId: any }][] = [
    ["machines", schema.machines], ["agents", schema.agents], ["conversation_turns", schema.conversationTurns],
    ["causal_edges", schema.causalEdges], ["agent_sessions", schema.agentSessions], ["agent_memory", schema.agentMemory],
    ["knowledge", schema.knowledge], ["reminders", schema.reminders], ["artifacts", schema.artifacts],
    ["artifact_versions", schema.artifactVersions], ["attachments", schema.attachments], ["saved_messages", schema.savedMessages],
    ["agent_message_decisions", schema.agentMessageDecisions], ["agent_message_observations", schema.agentMessageObservations],
    ["agent_activity_log", schema.agentActivityLog], ["server_sidebar_prefs", schema.serverSidebarPrefs],
    ["join_links", schema.joinLinks], ["system_invites", schema.systemInvites],
  ];
  for (const [name, t] of scopedTables) {
    assert.equal((await db.select().from(t as any).where(eq(t.serverId, tmp!.id))).length, 0, `rows left in ${name}`);
  }
  assert.equal((await db.select().from(schema.messageMentions).where(eq(schema.messageMentions.messageId, msg!.id))).length, 0);
  // the audit row we planted before the delete survives, detached (targetServerId nulled, not deleted)
  const planted = (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.event, "invite.created")))
    .filter((r) => (r.metadata as any)?.tag === `batchd-audit-${suffix}`);
  assert.equal(planted.length, 1);
  assert.equal(planted[0]!.targetServerId, null);
  // member JWT still valid globally, but server-scoped API now 403 (gate 2 membership gone)
  const scoped = await api("/api/channels", { headers: { authorization: `Bearer ${signUser(admin.id)}`, "x-server-id": tmp!.id } });
  assert.equal(scoped.status, 403); // "not a member of this server"
  // delete twice → 404
  assert.equal((await api(`/api/admin/servers/${tmp!.id}`, { method: "DELETE", headers: hdr })).status, 404);

  const stats: any = await (await api("/api/admin/stats", { headers: hdr })).json();
  assert.ok(typeof stats.users.total === "number" && typeof stats.servers === "number" && typeof stats.agents.total === "number" && typeof stats.machines.online === "number");

  // guarantee a fresh user.login row exists regardless of earlier tests (no order dependence)
  assert.equal((await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: admin.email, password: "password-1" }) })).status, 200);
  const logs: any = await (await api("/api/admin/audit-logs?event=server.deleted&limit=10", { headers: hdr })).json();
  assert.ok(logs.logs.length >= 1 && logs.logs[0].event === "server.deleted");
  // pagination: non-paged list has user.login events
  const all: any = await (await api("/api/admin/audit-logs?limit=200", { headers: hdr })).json();
  assert.ok(all.logs.some((l: any) => l.event === "user.login"));
  // garbage limit must fall back (50), not crash the pg bind → 500
  assert.equal((await api("/api/admin/audit-logs?limit=abc", { headers: hdr })).status, 200);
});

test("SYSTEM_ADMIN_EMAILS promotion: idempotent, promote-only", async () => {
  const u = await insertUser({ email: `envp-${suffix}@t.local`, name: `envp${suffix}`, password: "password-1" });
  process.env.SYSTEM_ADMIN_EMAILS = u.email;
  try {
    await promoteSystemAdminsFromEnv();
    await promoteSystemAdminsFromEnv(); // twice — idempotent
    const row = (await db.select().from(schema.users).where(eq(schema.users.id, u.id)))[0]!;
    assert.equal(row.systemRole, "system_admin");
    delete process.env.SYSTEM_ADMIN_EMAILS;
    await promoteSystemAdminsFromEnv();
    const row2 = (await db.select().from(schema.users).where(eq(schema.users.id, u.id)))[0]!;
    assert.equal(row2.systemRole, "system_admin"); // promote-only: clearing env must not demote
  } finally { delete process.env.SYSTEM_ADMIN_EMAILS; }
});

// Reflection meta-test: hold the admin workspace-delete table set against the live schema, so a
// newly added table with a serverId column cannot silently miss its delete (rows left behind, or a
// FK violation 500ing the whole DELETE). SERVER_DELETE_TABLES drives the actual delete loop in
// routes-api/admin.ts — this checks that loop's input, not a hand-copied list.
test("meta: every schema table with a serverId column is covered by the admin server-delete set", () => {
  const covered = new Set(SERVER_DELETE_TABLES.map((t) => getTableName(t)));
  const missing = Object.values(schema)
    .filter((t) => { try { return "serverId" in getTableColumns(t as never); } catch { return false; } })
    .map((t) => getTableName(t as never))
    .filter((name) => !covered.has(name));
  assert.deepEqual(missing, [],
    "schema tables with a serverId column missing from SERVER_DELETE_TABLES (src/server/routes-api/admin.ts) — add the table children-first or the workspace DELETE leaks rows / FK-fails");
});
