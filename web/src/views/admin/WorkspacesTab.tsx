// Workspaces tab of the system-admin console: deployment stats (GET /api/admin/stats) as cards over
// the workspace table (GET /api/admin/servers) with hard-delete (DELETE /api/admin/servers/:id —
// cascades server-side; the confirm dialog is the only guard, deleting any workspace is the
// sysadmin's call).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../../ConfirmModal.tsx";
import { StatCard } from "./StatCard.tsx";
import { AdminTable } from "./AdminTable.tsx";
import { RowMenu } from "./RowMenu.tsx";
import type { AdminApi } from "../Admin.tsx";

export function WorkspacesTab({ api }: { api: AdminApi }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [stats, setStats] = useState<any>(null);
  const [servers, setServers] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = async () => {
    setErr("");
    const [s, srv] = await Promise.all([api("GET", "/api/admin/stats"), api("GET", "/api/admin/servers")]);
    if (s?.error || srv?.error) { setErr(s?.error || srv?.error); return; }
    setStats(s);
    setServers(srv?.servers ?? []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  const remove = async (srv: any) => {
    if (!(await confirm({ title: t("admin.workspaces.deleteConfirm", { name: srv.name }), message: t("admin.workspaces.deleteMessage"), confirmLabel: t("admin.workspaces.delete"), danger: true }))) return;
    setBusy(true); setErr("");
    try {
      const r = await api("DELETE", `/api/admin/servers/${srv.id}`);
      if (r?.error) { setErr(r.error); return; }
      await load();
    } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="adm-head">
        <h1>{t("admin.tab.workspaces")}</h1>
      </div>
      {err && <div className="form-err" style={{ marginBottom: 12 }}>{err}</div>}
      {stats && (
        <div className="adm-stats">
          <StatCard label={t("admin.stats.totalUsers")} value={stats.users.total} note={t("admin.workspaces.disabledCount", { count: stats.users.disabled })} />
          <StatCard label={t("admin.workspaces.statsServers")} value={stats.servers} />
          <StatCard label={t("admin.workspaces.statsAgents")} value={`${stats.agents.active}/${stats.agents.total}`} />
          <StatCard label={t("admin.workspaces.statsMachines")} value={`${stats.machines.online}/${stats.machines.total}`} />
        </div>
      )}
      <AdminTable
        cols={[t("admin.workspaces.name"), t("admin.workspaces.slug"), t("admin.workspaces.owner"), t("admin.workspaces.members"), t("admin.workspaces.agents"), t("admin.workspaces.created"), { label: "", right: true }]}
        empty={!err ? t("admin.workspaces.empty") : undefined}
      >
        {servers.map((srv) => (
          <tr key={srv.id}>
            <td>{srv.name}</td>
            <td>{srv.slug}</td>
            <td>{srv.ownerName ?? "—"}</td>
            <td>{srv.memberCount}</td>
            <td>{srv.agentCount}</td>
            <td>{new Date(srv.createdAt).toLocaleDateString()}</td>
            <td style={{ textAlign: "right" }}>
              <RowMenu ariaLabel={srv.name} disabled={busy} items={[
                { label: t("admin.menu.deleteWorkspace"), danger: true, onClick: () => remove(srv) },
              ]} />
            </td>
          </tr>
        ))}
      </AdminTable>
    </div>
  );
}
