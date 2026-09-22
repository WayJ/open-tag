// System settings KV + first-admin bootstrap helpers. Default openRegistration=true (GitLab parity).
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { createLogger } from "../log.js";

const log = createLogger("server:settings");

export async function openRegistrationEnabled(): Promise<boolean> {
  const row = (await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, "openRegistration")))[0];
  return !row || (row.value as { enabled?: boolean })?.enabled !== false; // absent row = default true
}

export async function setOpenRegistration(enabled: boolean, byUserId: string): Promise<void> {
  await db.insert(schema.systemSettings)
    .values({ key: "openRegistration", value: { enabled }, updatedByUserId: byUserId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: { enabled }, updatedByUserId: byUserId, updatedAt: new Date() } });
}

/** Legacy-deploy escape hatch: SYSTEM_ADMIN_EMAILS=a@b.c,d@e.f promotes those existing users to
 *  system_admin at boot. Idempotent, promote-only (never demotes); unmatched emails are warned and skipped. */
export async function promoteSystemAdminsFromEnv(): Promise<void> {
  const raw = process.env.SYSTEM_ADMIN_EMAILS ?? "";
  const emails = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return;
  for (const email of emails) {
    const u = (await db.select().from(schema.users).where(eq(schema.users.email, email)))[0];
    if (u && u.systemRole !== "system_admin") {
      await db.update(schema.users).set({ systemRole: "system_admin" }).where(eq(schema.users.id, u.id));
      log.info("promoted user to system_admin", { email });
    } else if (!u) {
      log.warn("SYSTEM_ADMIN_EMAILS entry matched no user — skipped", { email });
    }
  }
}
