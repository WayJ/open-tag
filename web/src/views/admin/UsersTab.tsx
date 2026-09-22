// Users tab of the system-admin console: deployment-wide user list (GET /api/admin/users?q=) with
// disable/enable, sysadmin promote/demote (PATCH), and password reset (POST → temp password shown
// ONCE in a modal). Self-guards live server-side ("cannot disable yourself" 400) and surface here.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm, useEscClose } from "../../ConfirmModal.tsx";
import { copyText } from "../../lib/clipboard.ts";
import type { AdminApi } from "../Admin.tsx";

export function UsersTab({ api }: { api: AdminApi }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
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
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input placeholder={t("admin.users.search")} value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()} style={{ flex: 1, maxWidth: 320 }} />
      </div>
      {err && <div className="form-err" style={{ marginBottom: 12 }}>{err}</div>}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr style={{ textAlign: "left", borderBottom: "1px solid var(--hair-strong)" }}>
          <th style={{ padding: "6px 8px" }}>{t("admin.users.email")}</th><th style={{ padding: "6px 8px" }}>{t("admin.users.role")}</th><th style={{ padding: "6px 8px" }}>{t("admin.users.status")}</th><th style={{ padding: "6px 8px" }}>{t("admin.users.workspaces")}</th><th style={{ padding: "6px 8px" }}>{t("admin.users.created")}</th><th></th>
        </tr></thead>
        <tbody>{users.map((u) => (
          <tr key={u.id} style={{ borderBottom: "1px solid var(--hair)" }}>
            <td style={{ padding: "6px 8px" }}>{u.email}</td>
            <td style={{ padding: "6px 8px" }}>{u.systemRole === "system_admin" ? t("admin.users.sysAdmin") : "—"}</td>
            <td style={{ padding: "6px 8px" }}>{u.disabledAt ? t("admin.users.disabled") : t("admin.users.active")}</td>
            <td style={{ padding: "6px 8px" }}>{u.workspaceCount}</td>
            <td style={{ padding: "6px 8px" }}>{new Date(u.createdAt).toLocaleDateString()}</td>
            <td style={{ whiteSpace: "nowrap", padding: "6px 8px", textAlign: "right" }}>
              <button className="action-btn" disabled={busy} onClick={() => patch(u.id, { disabled: !u.disabledAt })}>{u.disabledAt ? t("admin.users.enable") : t("admin.users.disable")}</button>{" "}
              <button className="action-btn" disabled={busy} onClick={() => patchRole(u)}>{u.systemRole ? t("admin.users.demote") : t("admin.users.promote")}</button>{" "}
              <button className="action-btn" disabled={busy} onClick={() => resetPw(u)}>{t("admin.users.resetBtn")}</button>
            </td>
          </tr>))}</tbody>
      </table>
      {users.length === 0 && !err && <div className="empty">{t("admin.users.empty")}</div>}
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
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
