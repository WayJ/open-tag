// System-admin console shell (deployment-level; see docs/authorization.md). Rendered by AdminRoute
// in main.tsx — a TOP-LEVEL route outside the workspace Layout, so it owns its full-viewport frame.
// Tabs are URL-driven (/admin/:section): deep links, refresh, and back/forward all work; tab switches
// go through useNavigate (client-side), never history.pushState.
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "../store.tsx";
import { UsersTab } from "./admin/UsersTab.tsx";
import { InvitesTab } from "./admin/InvitesTab.tsx";
import { WorkspacesTab } from "./admin/WorkspacesTab.tsx";
import { AuditTab } from "./admin/AuditTab.tsx";
import { SettingsTab } from "./admin/SettingsTab.tsx";

const TABS = ["users", "invites", "workspaces", "audit", "settings"] as const;
export type AdminTab = (typeof TABS)[number];
// The store's api helper, passed down instead of re-fetched per tab (single token/session source).
export type AdminApi = (m: string, p: string, b?: unknown) => Promise<any>;

export function Admin() {
  const { section } = useParams();
  const nav = useNavigate();
  const { t } = useTranslation();
  const { api } = useStore();
  const tab: AdminTab = (TABS as readonly string[]).includes(section ?? "") ? (section as AdminTab) : "users"; // unknown/absent section → users
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--canvas)" }}>
      <div className="head"><h1>{t("admin.title")}</h1><small>{t("admin.subtitle")}</small></div>
      <div role="tablist" style={{ display: "flex", gap: 4, padding: "0 20px", borderBottom: "1px solid var(--hair)" }}>
        {TABS.map((x) => (
          <button key={x} role="tab" aria-selected={x === tab} onClick={() => nav(`/admin/${x}`)}
            style={{ padding: "9px 14px", border: 0, background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: 14, color: x === tab ? "var(--ink)" : "var(--muted)", borderBottom: x === tab ? "2px solid var(--ink-2)" : "2px solid transparent" }}>
            {t(`admin.tab.${x}`)}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "16px 28px 24px" }}>
        {tab === "users" && <UsersTab api={api} />}
        {tab === "invites" && <InvitesTab api={api} />}
        {tab === "workspaces" && <WorkspacesTab api={api} />}
        {tab === "audit" && <AuditTab api={api} />}
        {tab === "settings" && <SettingsTab api={api} />}
      </div>
    </div>
  );
}
