// Append-only system-plane audit trail. Call sites await it; failures surface in tests.
import { db, schema } from "../db/index.js";

export type AuditEvent =
  | "user.registered" | "user.login" | "user.disabled" | "user.enabled" | "user.system_role_changed"
  | "user.password_reset" | "invite.created" | "invite.accepted" | "invite.revoked"
  | "settings.open_registration_changed" | "server.deleted";

export async function logAudit(event: AuditEvent, opts: {
  actorUserId?: string | null; targetUserId?: string | null; targetServerId?: string | null;
  metadata?: Record<string, unknown>;
} = {}): Promise<void> {
  await db.insert(schema.auditLogs).values({ event, ...opts });
}
