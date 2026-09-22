// /api/admin/* — the system-admin plane (gate 1.5: any logged-in user reaches here; every route
// inside requires systemRole === "system_admin"). Dispatched between gate 1 and gate 2 in index.ts.
import type { UserCtx } from "./ctx.js";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { hashPassword, isValidEmail, newKey } from "../auth.js";
import { isUuid, readJson, sendErr, sendJson } from "../util.js";
import { openRegistrationEnabled, setOpenRegistration } from "../systemSettings.js";
import { inviteStatus } from "../systemAdminPolicy.js";
import { logAudit } from "../audit.js";

/** Every schema table that carries a `serverId` column, in children-first FK dependency order —
 *  this array IS the workspace hard-delete path (the DELETE route loops it), and the reflection
 *  meta-test in systemAdmin.api.test.ts holds it against src/db/schema.ts so a newly added
 *  server-scoped table cannot silently miss its delete. Tables with no serverId column
 *  (message_mentions, reactions, channel_members) are cleared separately via subquery inArray. */
export const SERVER_DELETE_TABLES = [
  schema.agentActivityLog,      // serverId is a bare uuid (no FK) — direct column filter still clears it
  schema.artifactVersions,      // before artifacts + attachments (attachmentId FK, no cascade)
  schema.agentMessageDecisions, // messageId ×2 / agentId ×2 / channelId FKs
  schema.agentMessageObservations,
  schema.savedMessages,
  schema.attachments,           // before messages (messageId FK, no cascade)
  schema.messages,
  schema.causalEdges,           // before conversationTurns + agents
  schema.conversationTurns,
  schema.knowledge,             // agentId + createdByAgentId FKs → before agents
  schema.agentSessions,         // agentId + scopeId(channel) FKs
  schema.agentMemory,           // agentId FK
  schema.artifacts,             // channelId + createdByAgentId FKs
  schema.reminders,             // channelId FK
  schema.channels,              // channelMembers (no serverId) cleared just before this entry via subquery
  schema.agents,                // before machines (machineId FK)
  schema.machines,
  schema.joinLinks,
  schema.systemInvites,
  schema.serverSidebarPrefs,
  schema.serverMembers,
] as const;

export async function handleAdminRoutes(ctx: UserCtx, systemRole: string | null): Promise<boolean> {
  if (!ctx.p.startsWith("/api/admin/")) return false;
  if (systemRole !== "system_admin") return (sendErr(ctx.res, 403, "system admin required"), true);

  if (ctx.p === "/api/admin/settings" && ctx.method === "GET") {
    return (sendJson(ctx.res, 200, { openRegistration: await openRegistrationEnabled() }), true);
  }
  if (ctx.p === "/api/admin/settings" && ctx.method === "PATCH") {
    const b = await readJson(ctx.req);
    if (typeof b.openRegistration !== "boolean") return (sendErr(ctx.res, 400, "openRegistration boolean required"), true);
    const before = await openRegistrationEnabled();
    await setOpenRegistration(b.openRegistration, ctx.userId);
    await logAudit("settings.open_registration_changed", { actorUserId: ctx.userId, metadata: { from: before, to: b.openRegistration } });
    return (sendJson(ctx.res, 200, { openRegistration: b.openRegistration }), true);
  }

  if (ctx.p === "/api/admin/users" && ctx.method === "GET") {
    const q = (ctx.url.searchParams.get("q") ?? "").toLowerCase();
    const rows = await db.select().from(schema.users);
    const mems = await db.select({ userId: schema.serverMembers.userId }).from(schema.serverMembers);
    const counts = new Map<string, number>();
    for (const m of mems) counts.set(m.userId, (counts.get(m.userId) ?? 0) + 1);
    const users = rows
      .filter((u) => !q || u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : 1)
      .map((u) => ({ id: u.id, name: u.name, displayName: u.displayName, email: u.email, systemRole: u.systemRole ?? null, disabledAt: u.disabledAt, createdAt: u.createdAt, workspaceCount: counts.get(u.id) ?? 0 }));
    return (sendJson(ctx.res, 200, { users }), true);
  }
  {
    const m = /^\/api\/admin\/users\/([^/]+)$/.exec(ctx.p);
    if (m && ctx.method === "PATCH") {
      if (!isUuid(m[1]!)) return (sendErr(ctx.res, 404, "not found"), true);
      const target = (await db.select().from(schema.users).where(eq(schema.users.id, m[1]!)))[0];
      if (!target) return (sendErr(ctx.res, 404, "user not found"), true);
      const b = await readJson(ctx.req);
      const patch: Record<string, unknown> = {};
      if (b.disabled !== undefined) {
        if (typeof b.disabled !== "boolean") return (sendErr(ctx.res, 400, "disabled must be boolean"), true);
        if (target.id === ctx.userId) return (sendErr(ctx.res, 400, "cannot disable yourself"), true);
        patch.disabledAt = b.disabled ? new Date() : null;
      }
      if (b.systemRole !== undefined) {
        if (b.systemRole !== null && b.systemRole !== "system_admin") return (sendErr(ctx.res, 400, "systemRole must be system_admin or null"), true);
        if (target.id === ctx.userId && b.systemRole === null) return (sendErr(ctx.res, 400, "cannot demote yourself"), true);
        patch.systemRole = b.systemRole;
      }
      if (!Object.keys(patch).length) return (sendErr(ctx.res, 400, "nothing to update"), true);
      await db.update(schema.users).set(patch).where(eq(schema.users.id, target.id));
      if ("disabledAt" in patch) await logAudit(patch.disabledAt ? "user.disabled" : "user.enabled", { actorUserId: ctx.userId, targetUserId: target.id });
      if ("systemRole" in patch) await logAudit("user.system_role_changed", { actorUserId: ctx.userId, targetUserId: target.id, metadata: { from: target.systemRole ?? null, to: patch.systemRole as string | null } });
      return (sendJson(ctx.res, 200, { ok: true }), true);
    }
    const rm = /^\/api\/admin\/users\/([^/]+)\/reset-password$/.exec(ctx.p);
    if (rm && ctx.method === "POST") {
      if (!isUuid(rm[1]!)) return (sendErr(ctx.res, 404, "not found"), true);
      const target = (await db.select().from(schema.users).where(eq(schema.users.id, rm[1]!)))[0];
      if (!target) return (sendErr(ctx.res, 404, "user not found"), true);
      const temp = cryptoRandomBytes(9).toString("base64url"); // 12 chars, url-safe
      await db.update(schema.users).set({ passwordHash: hashPassword(temp) }).where(eq(schema.users.id, target.id));
      await logAudit("user.password_reset", { actorUserId: ctx.userId, targetUserId: target.id });
      return (sendJson(ctx.res, 200, { tempPassword: temp }), true);
    }
  }

  if (ctx.p === "/api/admin/invites" && ctx.method === "GET") {
    const rows = await db.select().from(schema.systemInvites);
    const srvs = await db.select({ id: schema.servers.id, name: schema.servers.name }).from(schema.servers);
    const nameById = new Map(srvs.map((s) => [s.id, s.name]));
    const statusOf = (r: typeof rows[number]) => { const s = inviteStatus(r); return s === "used" ? "accepted" : s === "expired" ? "expired" : "pending"; };
    return (sendJson(ctx.res, 200, { invites: rows.map((r) => ({ ...r, serverName: nameById.get(r.serverId) ?? null, status: statusOf(r) })) }), true);
  }
  if (ctx.p === "/api/admin/invites" && ctx.method === "POST") {
    const b = await readJson(ctx.req);
    if (!isValidEmail(b.email)) return (sendErr(ctx.res, 400, "invalid email"), true);
    if (!isUuid(String(b.serverId ?? ""))) return (sendErr(ctx.res, 400, "invalid serverId"), true);
    const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, String(b.serverId))))[0];
    if (!srv) return (sendErr(ctx.res, 404, "server not found"), true);
    if (b.role !== undefined && !["member", "admin"].includes(String(b.role))) return (sendErr(ctx.res, 400, "role must be member or admin"), true);
    const days = b.expiresInDays != null ? Number(b.expiresInDays) : 7;
    if (!Number.isFinite(days) || days <= 0 || days > 90) return (sendErr(ctx.res, 400, "expiresInDays must be in (0, 90]"), true);
    // Dup check must consider PENDING rows only: an email can carry an accepted row (history) plus a
    // live pending one; reading "the first row" could return the accepted one, skip the 409, and blow
    // up the insert on the pending-email partial unique index with a 500.
    const dup = (await db.select().from(schema.systemInvites).where(and(eq(schema.systemInvites.email, String(b.email).toLowerCase()), isNull(schema.systemInvites.acceptedAt))))[0];
    if (dup && inviteStatus(dup) !== "expired") return (sendErr(ctx.res, 409, "a pending invite for this email already exists"), true);
    // Stale-row cleanup before insert: delete by (email, pending) unconditionally rather than by
    // dup.id — closes the delete-then-insert window where a row could slip in between the read
    // and the delete and still trip the pending-email partial unique index with a 500.
    await db.delete(schema.systemInvites).where(and(eq(schema.systemInvites.email, String(b.email).toLowerCase()), isNull(schema.systemInvites.acceptedAt)));
    const [inv] = await db.insert(schema.systemInvites).values({
      email: String(b.email).toLowerCase(), token: newKey("inv_"), serverId: srv.id,
      role: b.role != null ? String(b.role) : "member", createdByUserId: ctx.userId,
      expiresAt: new Date(Date.now() + days * 86_400_000),
    }).returning();
    await logAudit("invite.created", { actorUserId: ctx.userId, targetServerId: srv.id, metadata: { email: inv!.email } });
    return (sendJson(ctx.res, 200, { invite: inv, url: `/invite/${inv!.token}` }), true);
  }
  {
    const m = /^\/api\/admin\/invites\/([^/]+)$/.exec(ctx.p);
    if (m && ctx.method === "DELETE") {
      if (!isUuid(m[1]!)) return (sendErr(ctx.res, 404, "not found"), true);
      const inv = (await db.select().from(schema.systemInvites).where(eq(schema.systemInvites.id, m[1]!)))[0];
      if (!inv) return (sendErr(ctx.res, 404, "invite not found"), true);
      if (inv.acceptedAt) return (sendErr(ctx.res, 409, "invite already accepted"), true);
      await db.delete(schema.systemInvites).where(eq(schema.systemInvites.id, inv.id));
      await logAudit("invite.revoked", { actorUserId: ctx.userId, metadata: { email: inv.email } });
      return (sendJson(ctx.res, 200, { ok: true }), true);
    }
  }

  if (ctx.p === "/api/admin/servers" && ctx.method === "GET") {
    const srvs = await db.select().from(schema.servers);
    const mems = await db.select({ serverId: schema.serverMembers.serverId }).from(schema.serverMembers);
    const ags = await db.select({ serverId: schema.agents.serverId }).from(schema.agents).where(isNull(schema.agents.deletedAt));
    const mc = new Map<string, number>(), ac = new Map<string, number>();
    for (const m of mems) mc.set(m.serverId, (mc.get(m.serverId) ?? 0) + 1);
    for (const a of ags) ac.set(a.serverId, (ac.get(a.serverId) ?? 0) + 1);
    const owners = new Map((await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)).map((u) => [u.id, u.name]));
    return (sendJson(ctx.res, 200, { servers: srvs.map((s) => ({ id: s.id, name: s.name, slug: s.slug, ownerName: owners.get(s.ownerId) ?? null, memberCount: mc.get(s.id) ?? 0, agentCount: ac.get(s.id) ?? 0, createdAt: s.createdAt })) }), true);
  }
  {
    const m = /^\/api\/admin\/servers\/([^/]+)$/.exec(ctx.p);
    if (m && ctx.method === "DELETE") {
      if (!isUuid(m[1]!)) return (sendErr(ctx.res, 404, "not found"), true);
      const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, m[1]!)))[0];
      if (!srv) return (sendErr(ctx.res, 404, "server not found"), true);
      // Hard-delete every row the workspace owns, children before parents. Enumerated from src/db/schema.ts
      // (FK graph audit 2026-09). Some serverId FKs carry onDelete: "cascade" (conversation_turns,
      // causal_edges, agent_message_observations) — those cascades would fire only when the servers row
      // itself is deleted, and every explicit delete below runs BEFORE that row goes, so they are a
      // backstop we never rely on: all other child tables (no cascade on their FKs) must be cleared
      // explicitly, hence the exhaustive set.
      // message/channel-scoped tables without a serverId column (message_mentions, reactions,
      // channel_members) are cleared via inArray SUBQUERIES — never a pre-collected id array: the array
      // form binds one parameter per element and Postgres caps a statement at 65,535 binds, so a large
      // workspace delete would 500; `in (select …)` is one statement, no bind explosion.
      // audit_logs.targetServerId references servers (NO ACTION): older rows referencing this server are
      // set to NULL (append-only history is kept; the row survives with its metadata).
      // NOTE: no daemon/agent processes are killed here — their server row is gone, so agent auth and
      // daemon reconnects against this server fail naturally on next use.
      await db.transaction(async (tx) => {
        await tx.delete(schema.messageMentions).where(inArray(schema.messageMentions.messageId,
          tx.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, srv.id))));
        await tx.delete(schema.reactions).where(inArray(schema.reactions.messageId,
          tx.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, srv.id))));
        for (const t of SERVER_DELETE_TABLES) {
          // channel_members has no serverId column — clear it via subquery right before its parent channels row
          if (t === schema.channels) {
            await tx.delete(schema.channelMembers).where(inArray(schema.channelMembers.channelId,
              tx.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, srv.id))));
          }
          await tx.delete(t).where(eq(t.serverId, srv.id));
        }
        // keep audit history: detach this server from old audit rows instead of deleting them
        await tx.update(schema.auditLogs).set({ targetServerId: null }).where(eq(schema.auditLogs.targetServerId, srv.id));
        await tx.delete(schema.servers).where(eq(schema.servers.id, srv.id));
      });
      // targetServerId deliberately omitted: audit_logs.target_server_id has an FK to servers.id and the
      // row is already gone — the id (plus name/slug) lives in metadata instead.
      await logAudit("server.deleted", { actorUserId: ctx.userId, metadata: { serverId: srv.id, name: srv.name, slug: srv.slug } });
      return (sendJson(ctx.res, 200, { ok: true }), true);
    }
  }

  if (ctx.p === "/api/admin/stats" && ctx.method === "GET") {
    const users = await db.select({ systemRole: schema.users.systemRole, disabledAt: schema.users.disabledAt }).from(schema.users);
    const [serverCount] = await db.select({ serverCount: count() }).from(schema.servers);
    const ags = await db.select({ activity: schema.agents.activity, deletedAt: schema.agents.deletedAt }).from(schema.agents);
    const machs = await db.select({ status: schema.machines.status }).from(schema.machines);
    return (sendJson(ctx.res, 200, {
      users: { total: users.length, disabled: users.filter((u) => u.disabledAt).length, systemAdmins: users.filter((u) => u.systemRole === "system_admin").length },
      servers: Number(serverCount?.serverCount ?? 0),
      agents: { total: ags.filter((a) => !a.deletedAt).length, active: ags.filter((a) => !a.deletedAt && ["thinking", "working"].includes(a.activity ?? "")).length },
      machines: { total: machs.length, online: machs.filter((x) => x.status === "online").length },
    }), true);
  }

  if (ctx.p === "/api/admin/audit-logs" && ctx.method === "GET") {
    // NaN (e.g. ?limit=abc) must not reach .limit() — pg would choke on the bind and 500; fall back to 50
    const rawLimit = Number(ctx.url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
    const ev = ctx.url.searchParams.get("event");
    const before = ctx.url.searchParams.get("before"); // createdAt ISO cursor
    const conds: any[] = [];
    if (ev) conds.push(eq(schema.auditLogs.event, ev));
    if (before && !Number.isNaN(Date.parse(before))) conds.push(lt(schema.auditLogs.createdAt, new Date(before)));
    const rows = await db.select().from(schema.auditLogs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.auditLogs.createdAt)).limit(limit);
    return (sendJson(ctx.res, 200, { logs: rows }), true);
  }

  // Prefix matched + guard passed but no route did: answer 404 here. Falling through to gate 2
  // would surface a misleading "x-server-id header required" 400 for an unmatched admin path.
  return (sendErr(ctx.res, 404, "not found"), true);
}
