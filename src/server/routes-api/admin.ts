// /api/admin/* — the system-admin plane (gate 1.5: any logged-in user reaches here; every route
// inside requires systemRole === "system_admin"). Dispatched between gate 1 and gate 2 in index.ts.
import type { UserCtx } from "./ctx.js";
import { readJson, sendErr, sendJson } from "../util.js";
import { openRegistrationEnabled, setOpenRegistration } from "../systemSettings.js";
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
  return false;
}
