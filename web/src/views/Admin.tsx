// System-admin console shell (deployment-level; see docs/authorization.md). Rendered by AdminRoute
// in main.tsx — a TOP-LEVEL route outside the workspace Layout, so it owns its full-viewport frame:
// light sidebar (adm-side) + content frame (adm-main). Tabs are URL-driven (/admin/:section): deep
// links, refresh, and back/forward all work; tab switches go through Link/useNavigate (client-side),
// never history.pushState.
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Users, Mail, Layers, ScrollText, Settings, ArrowLeft } from "lucide-react";
import { useStore } from "../store.tsx";
import { UsersTab } from "./admin/UsersTab.tsx";
import { InvitesTab } from "./admin/InvitesTab.tsx";
import { WorkspacesTab } from "./admin/WorkspacesTab.tsx";
import { AuditTab } from "./admin/AuditTab.tsx";
import { SettingsTab } from "./admin/SettingsTab.tsx";

const TABS = ["users", "invites", "workspaces", "audit", "settings"] as const;
export type AdminTab = (typeof TABS)[number];
const ICONS: Record<AdminTab, typeof Users> = { users: Users, invites: Mail, workspaces: Layers, audit: ScrollText, settings: Settings };
// The store's api helper, passed down instead of re-fetched per tab (single token/session source).
export type AdminApi = (m: string, p: string, b?: unknown) => Promise<any>;

export function Admin() {
  const { section } = useParams();
  const { t } = useTranslation();
  const { me, slug, api } = useStore();
  const tab: AdminTab = (TABS as readonly string[]).includes(section ?? "") ? (section as AdminTab) : "users"; // unknown/absent section → users
  const name = me?.displayName || me?.name || "?";
  return (
    <div className="adm">
      <aside className="adm-side">
        <div className="logo">◧ open-tag · {t("admin.title")}</div>
        <div className="adm-sec">{t("admin.navGroup")}</div>
        <nav role="tablist">
          {TABS.map((x) => {
            const Icon = ICONS[x];
            return (
              <Link key={x} to={`/admin/${x}`} role="tab" aria-selected={x === tab} className={x === tab ? "on" : undefined}>
                <Icon size={15} />
                {t(`admin.tab.${x}`)}
              </Link>
            );
          })}
        </nav>
        <div className="foot">
          <Link to={`/s/${slug}/channel`}>
            <ArrowLeft size={15} />
            {t("admin.backToWorkspace")}
          </Link>
          <div className="who">
            <span className="adm-av g-lav">{name.charAt(0).toUpperCase()}</span>
            <span className="who-t">
              <span className="nm">{name}</span>
              <small>{t("admin.users.sysAdmin")}</small>
            </span>
          </div>
        </div>
      </aside>
      <main className="adm-main">
        {tab === "users" && <UsersTab api={api} />}
        {tab === "invites" && <InvitesTab api={api} />}
        {tab === "workspaces" && <WorkspacesTab api={api} />}
        {tab === "audit" && <AuditTab api={api} />}
        {tab === "settings" && <SettingsTab api={api} />}
      </main>
    </div>
  );
}
