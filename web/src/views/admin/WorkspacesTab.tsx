// Workspaces tab of the system-admin console: deployment stats (GET /api/admin/stats) as cards over
// the workspace table (GET /api/admin/servers) with hard-delete (DELETE /api/admin/servers/:id —
// cascades server-side; the confirm dialog is the only guard, deleting any workspace is the
// sysadmin's call).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../../ConfirmModal.tsx";
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
      {stats && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          <div className="card" style={{ flex: "1 1 150px", marginBottom: 0 }}>
            <h3>{stats.users.total}</h3>
            <div className="meta">{t("admin.workspaces.statsUsers")} · {t("admin.workspaces.disabledCount", { count: stats.users.disabled })}</div>
          </div>
          <div className="card" style={{ flex: "1 1 150px", marginBottom: 0 }}>
            <h3>{stats.servers}</h3>
            <div className="meta">{t("admin.workspaces.statsServers")}</div>
          </div>
          <div className="card" style={{ flex: "1 1 150px", marginBottom: 0 }}>
            <h3>{stats.agents.active}/{stats.agents.total}</h3>
            <div className="meta">{t("admin.workspaces.statsAgents")}</div>
          </div>
          <div className="card" style={{ flex: "1 1 150px", marginBottom: 0 }}>
            <h3>{stats.machines.online}/{stats.machines.total}</h3>
            <div className="meta">{t("admin.workspaces.statsMachines")}</div>
          </div>
        </div>
      )}
      {err && <div className="form-err" style={{ marginBottom: 12 }}>{err}</div>}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr style={{ textAlign: "left", borderBottom: "1px solid var(--hair-strong)" }}>
          <th style={{ padding: "6px 8px" }}>{t("admin.workspaces.name")}</th><th style={{ padding: "6px 8px" }}>{t("admin.workspaces.slug")}</th><th style={{ padding: "6px 8px" }}>{t("admin.workspaces.owner")}</th><th style={{ padding: "6px 8px" }}>{t("admin.workspaces.members")}</th><th style={{ padding: "6px 8px" }}>{t("admin.workspaces.agents")}</th><th style={{ padding: "6px 8px" }}>{t("admin.workspaces.created")}</th><th></th>
        </tr></thead>
        <tbody>{servers.map((srv) => (
          <tr key={srv.id} style={{ borderBottom: "1px solid var(--hair)" }}>
            <td style={{ padding: "6px 8px" }}>{srv.name}</td>
            <td style={{ padding: "6px 8px" }}>{srv.slug}</td>
            <td style={{ padding: "6px 8px" }}>{srv.ownerName ?? "—"}</td>
            <td style={{ padding: "6px 8px" }}>{srv.memberCount}</td>
            <td style={{ padding: "6px 8px" }}>{srv.agentCount}</td>
            <td style={{ padding: "6px 8px" }}>{new Date(srv.createdAt).toLocaleDateString()}</td>
            <td style={{ whiteSpace: "nowrap", padding: "6px 8px", textAlign: "right" }}>
              <button className="danger-btn" disabled={busy} onClick={() => remove(srv)}>{t("admin.workspaces.delete")}</button>
            </td>
          </tr>))}</tbody>
      </table>
      {servers.length === 0 && !err && <div className="empty">{t("admin.workspaces.empty")}</div>}
    </div>
  );
}
