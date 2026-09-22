// Pure routing decision for /admin/* (no React/DOM; unit-tested like routing.ts). The invariant it
// encodes: the system-admin console must wait on the auth bootstrap (skeleton, never a flash of the
// console or a wrong redirect), hard-gate on authentication (login), bounce a non-sysadmin authed
// user back to their workspace, and render the console only for systemRole === "system_admin".
export type AdminRouteDecision = "skeleton" | "login" | "workspace" | "admin";

export function adminRouteDecision(s: { ready: boolean; authState: "loading" | "authed" | "anon"; systemRole: string | null }): AdminRouteDecision {
  if (!s.ready) return "skeleton";                         // bootstrap in flight → wait, don't flash/redirect yet
  if (s.authState !== "authed") return "login";            // anonymous → /login (same hard auth gate as /s/*)
  return s.systemRole === "system_admin" ? "admin" : "workspace"; // authed: sysadmin sees the console, everyone else goes home
}
