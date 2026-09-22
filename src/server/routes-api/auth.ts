// Auto-extracted from the former routes-api.ts monolith — bodies are verbatim.
import type { BaseCtx, UserCtx } from "./ctx.js";
import { and, count, eq, or } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { devLoginEnabled, hashPassword, isValidEmail, passwordError, safeEqual, setupToken, signUser, verifyPassword } from "../auth.js";
import { DESC_TOO_LONG, createServer, descTooLong } from "../core.js";
import { REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS, clientIp, rateLimit } from "../ratelimit.js";
import { readJson, sendErr, sendJson } from "../util.js";
import { inviteStatus, maskEmail, registrationDecision } from "../systemAdminPolicy.js";
import { openRegistrationEnabled } from "../systemSettings.js";
import { logAudit } from "../audit.js";

export async function handlePublicAuth(ctx: BaseCtx): Promise<boolean> {
  const { req, res, url, method, p } = ctx;

  // ---- auth ----
  // Dev-login: public username→JWT shortcut for local development ONLY. Gated behind ALLOW_DEV_LOGIN (default off),
  // so production never exposes it. When disabled it 404s — indistinguishable from a non-existent route (no endpoint leak).
  if (p === "/api/auth/dev-login" && method === "POST") {
    if (!devLoginEnabled()) return (sendErr(res, 404, "not found"), true);
    const b = await readJson(req);
    const name = String(b.name ?? "you").trim();
    if (!name || name.length > 64) return (sendErr(res, 400, "invalid name"), true);
    let u = (await db.select().from(schema.users).where(eq(schema.users.name, name)))[0];
    if (!u) [u] = await db.insert(schema.users).values({ name, displayName: name, email: `${name}@dev.local` }).returning();
    // Multi-tenant: each user has isolated data — ensure the user has their own server (creates an empty one if absent, zero channels/agents; "you" owns the seeded default workspace)
    const mine = (await db.select().from(schema.servers).where(eq(schema.servers.ownerId, u!.id)))[0];
    if (!mine) await createServer(`${name}'s workspace`, `u-${u!.id.slice(0, 8)}`, u!.id);
    if (!u) return (sendErr(res, 500, "dev-login failed"), true);
    return (sendJson(res, 200, { token: signUser(u!.id), user: { id: u!.id, name: u!.name, displayName: u!.displayName, systemRole: u!.systemRole ?? null } }), true);
  }
  // First-deploy admin setup: one-time, token-gated. Disabled (404) unless ADMIN_SETUP_TOKEN is configured.
  // First-run guard: only initializes the seeded default-workspace owner while it still has no password — so it
  // self-closes (410) once an admin password exists. This unblocks the seeded "you" admin after dev-login is turned off,
  // without ever hard-coding a default password. Placed BEFORE the auth gate (the operator has no JWT yet).
  if (p === "/api/auth/setup" && method === "POST") {
    const tok = setupToken();
    if (!tok) return (sendErr(res, 404, "not found"), true);
    const rl = rateLimit("auth:setup", clientIp(req), 5);
    if (!rl.ok) return (sendErr(res, 429, "too many requests", { retryAfter: rl.retryAfter }), true);
    const b = await readJson(req);
    if (!safeEqual(String(b.token ?? ""), tok)) return (sendErr(res, 403, "invalid setup token"), true);
    const ws = (await db.select().from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0];
    if (!ws) return (sendErr(res, 409, "no default workspace; run seed first"), true);
    const admin = (await db.select().from(schema.users).where(eq(schema.users.id, ws.ownerId)))[0];
    if (!admin) return (sendErr(res, 409, "default workspace owner missing"), true);
    if (admin.passwordHash) return (sendErr(res, 410, "already initialized"), true);
    const pwErr = passwordError(b.password);
    if (pwErr) return (sendErr(res, 400, pwErr), true);
    const patch: Record<string, unknown> = { passwordHash: hashPassword(String(b.password)) };
    if (b.email !== undefined) {
      if (!isValidEmail(b.email)) return (sendErr(res, 400, "invalid email"), true);
      if (b.email !== admin.email) {
        const dup = (await db.select().from(schema.users).where(eq(schema.users.email, b.email)))[0];
        if (dup) return (sendErr(res, 409, "email already in use"), true);
        patch.email = b.email;
      }
    }
    if (typeof b.displayName === "string" && b.displayName.trim()) patch.displayName = b.displayName.trim();
    await db.update(schema.users).set(patch).where(eq(schema.users.id, admin.id));
    return (sendJson(res, 200, { token: signUser(admin.id), user: { id: admin.id, name: admin.name, email: (patch.email as string) ?? admin.email } }), true);
  }
  // Public registration-state probe: the /register page uses it to disable the form upfront.
  // The server-side 403 on POST /api/auth/register remains the enforcement; this is UX only.
  if (p === "/api/auth/config" && method === "GET") {
    return (sendJson(res, 200, { openRegistration: await openRegistrationEnabled() }), true);
  }
  // System-invite info (public, no auth): the /invite/:token landing page uses this to render
  // "X invited you to join workspace Y" before the user has an account. Email is masked — an
  // unauthenticated visitor holding a leaked token must not recover the full address.
  if (p === "/api/auth/system-invite-info" && method === "GET") {
    const tok = url.searchParams.get("token") ?? "";
    const link = tok ? (await db.select().from(schema.systemInvites).where(eq(schema.systemInvites.token, tok)))[0] : undefined;
    const status = inviteStatus(link);
    if (status !== "valid") return (sendJson(res, 200, { valid: false, reason: status }), true);
    const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, link!.serverId)))[0];
    if (!srv) return (sendJson(res, 200, { valid: false, reason: "server_gone" }), true);
    const inviter = link!.createdByUserId ? (await db.select().from(schema.users).where(eq(schema.users.id, link!.createdByUserId)))[0] : null;
    return (sendJson(res, 200, { valid: true, email: maskEmail(link!.email), serverName: srv.name, serverSlug: srv.slug, inviterName: inviter?.displayName || inviter?.name || null, role: link!.role }), true);
  }
  // Accept a system invite (public): creates the account (the register-closed path), joins the
  // target workspace with the granted role, auto-joins #all, and signs the new user in.
  if (p === "/api/auth/accept-system-invite" && method === "POST") {
    const rl = rateLimit("auth:sysinvite", clientIp(req), 10);
    if (!rl.ok) return (sendErr(res, 429, "too many requests", { retryAfter: rl.retryAfter }), true);
    const b = await readJson(req);
    const link = b.token ? (await db.select().from(schema.systemInvites).where(eq(schema.systemInvites.token, String(b.token))))[0] : undefined;
    const status = inviteStatus(link);
    // Any non-usable token — never existed, revoked (hard-deleted), expired, or already used — is a
    // 410 "invite link gone" to the landing page; the reason rides in `code`. (404 would invite the
    // client to treat a dead invite link as a wrong URL rather than a spent one.)
    if (status !== "valid") return (sendErr(res, 410, status === "expired" ? "invite expired" : status === "used" ? "invite already used" : "invalid invite", { code: `invite_${status}` }), true);
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 64) return (sendErr(res, 400, "invalid name", { code: "auth_register_name_invalid" }), true);
    const pwErr = passwordError(b.password);
    if (pwErr) return (sendErr(res, 400, pwErr, { code: "auth_password_invalid" }), true);
    const email = link!.email;
    const dup = (await db.select().from(schema.users).where(or(eq(schema.users.email, email), eq(schema.users.name, name))))[0];
    if (dup) return (sendErr(res, 409, dup.email === email ? "email already registered" : "username already taken", { code: dup.email === email ? "auth_register_email_taken" : "auth_register_username_taken" }), true);
    const [u] = await db.insert(schema.users).values({ name, displayName: name, email, passwordHash: hashPassword(String(b.password)) }).returning();
    await db.insert(schema.serverMembers).values({ serverId: link!.serverId, userId: u!.id, role: link!.role });
    await db.update(schema.systemInvites).set({ acceptedAt: new Date() }).where(eq(schema.systemInvites.id, link!.id));
    const all = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, link!.serverId), eq(schema.channels.name, "all"))))[0];
    if (all) await db.insert(schema.channelMembers).values({ channelId: all.id, memberType: "user", memberId: u!.id }).onConflictDoNothing();
    await logAudit("invite.accepted", { targetUserId: u!.id, targetServerId: link!.serverId, metadata: { ip: clientIp(req) } });
    return (sendJson(res, 200, { token: signUser(u!.id), user: { id: u!.id, name: u!.name } }), true);
  }
  if (p === "/api/auth/register" && method === "POST") {
    const rl = rateLimit("auth:register", clientIp(req), REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS);
    if (!rl.ok) return (sendErr(res, 429, "too many registrations from this IP — please try again later", { code: "auth_rate_limited", retryAfter: rl.retryAfter }), true);
    const [countRow] = await db.select({ cnt: count() }).from(schema.users);
    const decision = registrationDecision(Number(countRow?.cnt ?? 0), await openRegistrationEnabled());
    if (decision === "reject") return (sendErr(res, 403, "registration is closed — ask a system admin for an invite", { code: "auth_registration_closed" }), true);
    const b = await readJson(req);
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 64) return (sendErr(res, 400, "invalid name", { code: "auth_register_name_invalid" }), true);
    if (!isValidEmail(b.email)) return (sendErr(res, 400, "invalid email", { code: "auth_email_invalid" }), true);
    const pwErr = passwordError(b.password);
    if (pwErr) return (sendErr(res, 400, pwErr, { code: "auth_password_invalid" }), true);
    const dup = (await db.select().from(schema.users).where(or(eq(schema.users.email, b.email), eq(schema.users.name, name))))[0];
    if (dup) return (sendErr(res, 409, dup.email === b.email ? "email already registered" : "username already taken", { code: dup.email === b.email ? "auth_register_email_taken" : "auth_register_username_taken" }), true);
    const [u] = await db.insert(schema.users).values({ name, displayName: typeof b.displayName === "string" && b.displayName.trim() ? b.displayName.trim() : name, email: b.email, passwordHash: hashPassword(String(b.password)), systemRole: decision === "bootstrap" ? "system_admin" : null }).returning();
    await createServer(`${name}'s workspace`, `u-${u!.id.slice(0, 8)}`, u!.id); // Create personal workspace on registration (aligned with dev-login; without it, entering the app with no server causes bootstrap to crash)
    await logAudit("user.registered", { targetUserId: u!.id, metadata: { bootstrap: decision === "bootstrap", ip: clientIp(req) } });
    return (sendJson(res, 200, { token: signUser(u!.id), user: { id: u!.id, name: u!.name } }), true);
  }
  // Login: return stable, user-actionable error codes. This intentionally distinguishes an unknown email from a
  // wrong password for self-hosted workspace UX; the endpoint remains rate-limited to reduce enumeration/brute-force abuse.
  if (p === "/api/auth/login" && method === "POST") {
    const rl = rateLimit("auth:login", clientIp(req));
    if (!rl.ok) return (sendErr(res, 429, "too many requests", { code: "auth_rate_limited", retryAfter: rl.retryAfter }), true);
    const b = await readJson(req);
    if (typeof b.email !== "string" || typeof b.password !== "string" || !b.email.trim() || !b.password.trim()) return (sendErr(res, 400, "email and password required", { code: "auth_login_fields_required" }), true);
    if (!isValidEmail(b.email)) return (sendErr(res, 400, "invalid email", { code: "auth_email_invalid" }), true);
    const u = (await db.select().from(schema.users).where(eq(schema.users.email, b.email)))[0];
    if (!u) return (sendErr(res, 404, "email not found", { code: "auth_login_email_not_found" }), true);
    if (!verifyPassword(b.password, u.passwordHash)) return (sendErr(res, 401, "password incorrect", { code: "auth_login_password_wrong" }), true);
    if (u.disabledAt) return (sendErr(res, 403, "account disabled", { code: "auth_account_disabled" }), true);
    await logAudit("user.login", { targetUserId: u.id, metadata: { ip: clientIp(req) } });
    return (sendJson(res, 200, { token: signUser(u.id), user: { id: u.id, name: u.name } }), true);
  }
  // Invite info (public, no auth required): the /join/:token landing page uses this to display "X invited you to join workspace Y"
  if (p === "/api/auth/invite-info" && method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    const link = token ? (await db.select().from(schema.joinLinks).where(eq(schema.joinLinks.token, token)))[0] : undefined;
    if (!link) return (sendJson(res, 200, { valid: false }), true);
    const expired = !!link.expiresAt && new Date(link.expiresAt as any).getTime() < Date.now();
    const exhausted = link.maxUses != null && link.useCount >= link.maxUses;
    const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, link.serverId)))[0];
    const inviter = link.createdByUserId ? (await db.select().from(schema.users).where(eq(schema.users.id, link.createdByUserId)))[0] : null;
    return (sendJson(res, 200, { valid: !expired && !exhausted && !!srv, serverName: srv?.name, serverSlug: srv?.slug, inviterName: inviter?.displayName || inviter?.name || null, role: link.role }), true);
  }
  return false;
}

export async function handleAuthedAuth(ctx: UserCtx): Promise<boolean> {
  const { req, res, method, p, userId } = ctx;
  // Accept invite (requires auth): join a workspace via a join-link token. Idempotent.
  if (p === "/api/auth/accept-invite" && method === "POST") {
    const b = await readJson(req);
    const link = b.token ? (await db.select().from(schema.joinLinks).where(eq(schema.joinLinks.token, String(b.token))))[0] : undefined;
    if (!link) return (sendErr(res, 404, "invalid invite"), true);
    if (link.expiresAt && new Date(link.expiresAt as any).getTime() < Date.now()) return (sendErr(res, 410, "invite expired"), true);
    if (link.maxUses != null && link.useCount >= link.maxUses) return (sendErr(res, 410, "invite exhausted"), true);
    const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, link.serverId)))[0];
    if (!srv) return (sendErr(res, 404, "server gone"), true);
    const existing = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, link.serverId), eq(schema.serverMembers.userId, userId))))[0];
    if (!existing) {
      await db.insert(schema.serverMembers).values({ serverId: link.serverId, userId, role: link.role });
      await db.update(schema.joinLinks).set({ useCount: link.useCount + 1 }).where(eq(schema.joinLinks.id, link.id));
      const all = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, link.serverId), eq(schema.channels.name, "all"))))[0];
      if (all) await db.insert(schema.channelMembers).values({ channelId: all.id, memberType: "user", memberId: userId }).onConflictDoNothing();
    }
    return (sendJson(res, 200, { serverSlug: srv.slug, serverId: srv.id, already: !!existing }), true);
  }

  if (p === "/api/auth/me" && method === "GET") {
    const u = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    return (u ? sendJson(res, 200, { id: u.id, name: u.name, displayName: u.displayName, email: u.email, description: u.description, avatarUrl: u.avatarUrl, systemRole: u.systemRole ?? null }) : sendErr(res, 404, "not found"), true);
  }
  if (p === "/api/auth/me" && method === "PATCH") {
    const b = await readJson(req); const patch: Record<string, unknown> = {};
    if (descTooLong(b.description)) return (sendErr(res, 400, DESC_TOO_LONG), true);
    for (const k of ["displayName", "description", "avatarUrl"]) if (b[k] !== undefined) patch[k] = b[k];
    if (Object.keys(patch).length) await db.update(schema.users).set(patch).where(eq(schema.users.id, userId));
    const u = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    return (sendJson(res, 200, { id: u!.id, name: u!.name, displayName: u!.displayName, email: u!.email, description: u!.description }), true);
  }
  return false;
}
