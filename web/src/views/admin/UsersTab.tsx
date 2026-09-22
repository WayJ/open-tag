// Users tab of the system-admin console: KPI stat cards (GET /api/admin/stats) over the
// deployment-wide user list (GET /api/admin/users?q=) with disable/enable, sysadmin promote/demote
// (PATCH), and password reset (POST → temp password shown ONCE in a modal). Row actions live in a
// ⋯ kebab menu (RowMenu). Self-guards live server-side ("cannot disable yourself" 400) and surface
// in the form-err line under the head.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useConfirm, useEscClose } from "../../ConfirmModal.tsx";
import { copyText } from "../../lib/clipboard.ts";
import { AdmPill } from "./AdmPill.tsx";
import { StatCard } from "./StatCard.tsx";
import { AdminTable } from "./AdminTable.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { avatarTone, avatarInitial } from "./avatar.ts";
import type { AdminApi } from "../Admin.tsx";

export function UsersTab({ api }: { api: AdminApi }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tempPw, setTempPw] = useState<{ email: string; pw: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const load = async () => {
    setErr("");
    const r = await api("GET", `/api/admin/users?q=${encodeURIComponent(q)}`);
    if (r?.error) { setErr(r.error); setUsers([]); return; }
    setUsers(r?.users ?? []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    (async () => { const r = await api("GET", "/api/admin/stats"); if (!r?.error) setStats(r); })(); // KPI cards; on failure they just stay hidden
    /* eslint-disable-next-line */
  }, []);
  const patch = async (id: string, body: unknown) => {
    setBusy(true); setErr("");
    try {
      const r = await api("PATCH", `/api/admin/users/${id}`, body);
      if (r?.error) { setErr(r.error); return; }
      await load();
    } finally { setBusy(false); }
  };
  // Promote/demote grant deployment-level admin — an accidental click must not go straight through
  // (reversible, but high blast radius). Disable/enable stays unconfirmed: trivially reversible.
  const patchRole = async (u: any) => {
    const promote = !u.systemRole;
    if (!(await confirm({ title: t(promote ? "admin.users.promoteConfirm" : "admin.users.demoteConfirm", { email: u.email }), message: t(promote ? "admin.users.promoteMessage" : "admin.users.demoteMessage"), confirmLabel: t(promote ? "admin.users.promote" : "admin.users.demote") }))) return;
    await patch(u.id, { systemRole: promote ? "system_admin" : null });
  };
  const resetPw = async (u: any) => {
    if (!(await confirm({ title: t("admin.users.resetConfirm", { email: u.email }), message: t("admin.users.resetMessage"), confirmLabel: t("admin.users.resetBtn"), danger: true }))) return;
    setBusy(true); setErr("");
    try {
      const r = await api("POST", `/api/admin/users/${u.id}/reset-password`);
      if (r?.error) { setErr(r.error); return; }
      if (r?.tempPassword) { setCopied(false); setTempPw({ email: u.email, pw: r.tempPassword }); }
    } finally { setBusy(false); }
  };
  const copyPw = async () => {
    if (!tempPw) return;
    if (await copyText(tempPw.pw)) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
    else window.prompt(t("admin.users.copy"), tempPw.pw);
  };
  return (
    <div>
      <div className="adm-head">
        <h1>{t("admin.tab.users")}</h1>
        <div className="acts">
          <input className="adm-input" placeholder={t("admin.users.search")} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()} />
          <button className="adm-btn-primary" onClick={() => nav("/admin/invites")}>{t("admin.users.inviteCta")}</button>
        </div>
      </div>
      {err && <div className="form-err" style={{ marginBottom: 12 }}>{err}</div>}
      {stats && (
        <div className="adm-stats">
          <StatCard label={t("admin.stats.totalUsers")} value={stats.users.total} />
          <StatCard label={t("admin.stats.disabledUsers")} value={stats.users.disabled} />
          <StatCard label={t("admin.users.sysAdmin")} value={stats.users.systemAdmins} />
          <StatCard label={t("admin.workspaces.statsServers")} value={stats.servers} />
        </div>
      )}
      <AdminTable
        cols={[t("admin.users.email"), t("admin.users.role"), t("admin.users.status"), t("admin.users.workspaces"), t("admin.users.created"), { label: "", right: true }]}
        empty={!err ? t("admin.users.empty") : undefined}
      >
        {users.map((u) => (
          <tr key={u.id}>
            <td>
              <span className={"adm-av " + avatarTone(u.email)}>{avatarInitial(u.email)}</span>
              <span className="adm-email">{u.email}</span>
            </td>
            <td>{u.systemRole === "system_admin" ? <AdmPill tone="blue">{t("admin.users.sysAdmin")}</AdmPill> : "—"}</td>
            <td>{u.disabledAt ? <AdmPill tone="red">{t("admin.users.disabled")}</AdmPill> : <AdmPill tone="green">{t("admin.users.active")}</AdmPill>}</td>
            <td>{u.workspaceCount}</td>
            <td>{new Date(u.createdAt).toLocaleDateString()}</td>
            <td style={{ textAlign: "right" }}>
              <RowMenu ariaLabel={u.email} disabled={busy} items={[
                { label: u.disabledAt ? t("admin.menu.enableUser") : t("admin.menu.disableUser"), onClick: () => patch(u.id, { disabled: !u.disabledAt }) },
                { label: u.systemRole ? t("admin.menu.demote") : t("admin.menu.promote"), sep: true, onClick: () => patchRole(u) },
                { label: t("admin.menu.resetPassword"), onClick: () => resetPw(u) },
              ]} />
            </td>
          </tr>
        ))}
      </AdminTable>
      {tempPw && <TempPasswordModal email={tempPw.email} pw={tempPw.pw} copied={copied} onCopy={copyPw} onClose={() => setTempPw(null)} />}
    </div>
  );
}

// The temp password is shown exactly once (the server never returns it again) — copy it before closing.
function TempPasswordModal({ email, pw, copied, onCopy, onClose }: { email: string; pw: string; copied: boolean; onCopy: () => void; onClose: () => void }) {
  useEscClose(onClose);
  const { t } = useTranslation();
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal adm-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("admin.users.tempPwTitle", { email })}</h3>
        <p><code>{pw}</code></p>
        <p className="modal-note">{t("admin.users.tempPwNote")}</p>
        <div className="acts">
          <button className="cancel" onClick={onClose}>{t("confirm.cancel")}</button>
          <button className="ok" onClick={onCopy}>{copied ? t("admin.users.copied") : t("admin.users.copy")}</button>
        </div>
      </div>
    </div>
  );
}
