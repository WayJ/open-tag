// src/server/systemAdminPolicy.ts
// Pure decision functions for the system-admin plane. No db imports — unit-testable in CI (no infra),
// wired into routes by auth.ts / admin.ts. See docs/superpowers/specs/2026-09-22-system-admin-plane-design.md.

export type RegistrationDecision = "bootstrap" | "allow" | "reject";

/** Registration gate: an empty users table (fresh unseeded deploy) bootstraps the FIRST registrant as
 *  system_admin regardless of the toggle; after that the openRegistration setting decides. */
export function registrationDecision(userCount: number, openRegistration: boolean): RegistrationDecision {
  if (userCount === 0) return "bootstrap";
  return openRegistration ? "allow" : "reject";
}

/** Mask an email for public invite-info: keep first+last local char and first domain char + TLD. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 2) return email; // too short to mask meaningfully
  const [local, domain] = [email.slice(0, at), email.slice(at + 1)];
  const dot = domain.lastIndexOf(".");
  if (dot < 1 || dot + 2 > domain.length) return email; // no sane TLD split — leave as-is
  const tld = domain.slice(dot);
  const domHead = domain.slice(0, dot);
  if (local.length < 3 || domHead.length < 2) return email;
  return `${local[0]}***${local[local.length - 1]}@${domHead[0]}***${tld}`;
}

export type InviteStatus = "valid" | "not_found" | "expired" | "used";
export function inviteStatus(
  invite: { expiresAt: Date | string | null; acceptedAt: Date | string | null } | null | undefined,
  now = Date.now(),
): InviteStatus {
  if (!invite) return "not_found";
  if (invite.acceptedAt != null) return "used";
  if (invite.expiresAt != null && new Date(invite.expiresAt as any).getTime() < now) return "expired";
  return "valid";
}
