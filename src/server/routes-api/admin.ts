// /api/admin/* — the system-admin plane (gate 1.5: any logged-in user reaches here; every route
// inside requires systemRole === "system_admin"). Dispatched between gate 1 and gate 2 in index.ts.
import type { UserCtx } from "./ctx.js";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { hashPassword, isValidEmail, newKey } from "../auth.js";
import { isUuid, readJson, sendErr, sendJson } from "../util.js";
import { openRegistrationEnabled, setOpenRegistration } from "../systemSettings.js";
import { inviteStatus } from "../systemAdminPolicy.js";
import { logAudit } from "../audit.js";

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

  // Prefix matched + guard passed but no route did: answer 404 here. Falling through to gate 2
  // would surface a misleading "x-server-id header required" 400 for an unmatched admin path.
  return (sendErr(ctx.res, 404, "not found"), true);
}
