// Invites tab of the system-admin console: create system invites via an inline form card (email +
// target workspace + role + expiry), share the /invite/<token> link from a link bar under the form,
// and revoke pending ones from the ⋯ row menu. Accepted/expired rows are history (server 409s
// revoking an accepted invite) and stay listed with their status.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../../ConfirmModal.tsx";
import { copyText } from "../../lib/clipboard.ts";
import { AdmPill } from "./AdmPill.tsx";
import { AdminTable } from "./AdminTable.tsx";
import { RowMenu } from "./RowMenu.tsx";
import type { AdminApi } from "../Admin.tsx";

const linkOf = (token: string) => `${location.origin}/invite/${token}`;

export function InvitesTab({ api }: { api: AdminApi }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [formOpen, setFormOpen] = useState(false); // create form collapses by default; ＋ toggles it
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [email, setEmail] = useState("");
  const [serverId, setServerId] = useState("");
  const [role, setRole] = useState("member");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState<string | null>(null); // full invite URL of the just-created link
  // Which copy button is in its "copied" flash: an invite id, or "created" for the link bar under
  // the form. A single boolean would light up every row's copy button at once.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [invites, setInvites] = useState<any[]>([]);
  const load = async () => {
    setErr("");
    const r = await api("GET", "/api/admin/invites");
    if (r?.error) { setErr(r.error); return; }
    setInvites(r?.invites ?? []);
  };
  useEffect(() => {
    (async () => {
      const s = await api("GET", "/api/admin/servers");
      if (s?.error) { setErr(s.error); await load(); return; } // dropdown can't be populated — surface why instead of silently disabling create
      const list = s?.servers ?? [];
      setServers(list);
      if (list[0]) setServerId((cur) => cur || list[0].id); // pre-select the first workspace, keep user's pick on reload
      await load();
    })();
    /* eslint-disable-next-line */
  }, []);
  const create = async () => {
    if (busy) return;
    if (!email.trim() || !serverId) return;
    setBusy(true); setErr(""); setCopiedId(null);
    try {
      const r = await api("POST", "/api/admin/invites", { email: email.trim(), serverId, role, expiresInDays: days ? Number(days) : undefined });
      if (r?.error) { setErr(r.error); return; } // e.g. 409 a pending invite for this email already exists
      setCreated(`${location.origin}${r.url}`);
      setEmail("");
      await load();
    } finally { setBusy(false); }
  };
  const copy = async (link: string, id: string) => {
    if (await copyText(link)) { setCopiedId(id); setTimeout(() => setCopiedId(null), 1500); }
    else window.prompt(t("members.copyLink"), link);
  };
  const revoke = async (inv: any) => {
    if (!(await confirm({ title: t("admin.invites.revokeConfirm", { email: inv.email }), message: t("admin.invites.revokeMessage"), confirmLabel: t("admin.invites.revoke"), danger: true }))) return;
    setErr("");
    const r = await api("DELETE", `/api/admin/invites/${inv.id}`);
    if (r?.error) setErr(r.error);
    await load();
  };
  return (
    <div>
      <div className="adm-head">
        <h1>{t("admin.tab.invites")}</h1>
        <div className="acts">
          <button className="adm-btn-primary" onClick={() => setFormOpen((v) => !v)}>{t("admin.invites.createCta")}</button>
        </div>
      </div>
      {formOpen && (
        <div className="adm-card" style={{ marginBottom: 16 }}>
          <div className="adm-form">
            <input className="adm-input" type="email" aria-label={t("admin.invites.email")} placeholder={t("admin.invites.email")} value={email} onChange={(e) => setEmail(e.target.value)} />
            <select className="adm-input" aria-label={t("admin.invites.workspace")} value={serverId} onChange={(e) => setServerId(e.target.value)}>
              {!servers.length && <option value="">{t("admin.invites.pickWorkspace")}</option>}
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select className="adm-input" aria-label={t("admin.invites.role")} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">{t("admin.invites.roleMember")}</option>
              <option value="admin">{t("admin.invites.roleAdmin")}</option>
            </select>
            <input className="adm-input" type="number" min="1" max="90" title={t("admin.invites.expires")} value={days} onChange={(e) => setDays(e.target.value)} />
            <button className="adm-btn-primary" disabled={busy || !email.trim() || !serverId} onClick={create}>{busy ? t("admin.invites.creating") : t("admin.invites.create")}</button>
          </div>
          {created && (
            <div className="adm-linkbar">
              <code>{created}</code>
              <button className="adm-btn-primary" onClick={() => copy(created, "created")}>{copiedId === "created" ? t("admin.invites.copied") : t("admin.invites.copy")}</button>
            </div>
          )}
        </div>
      )}
      {err && <div className="form-err" style={{ marginBottom: 12 }}>{err}</div>}
      <AdminTable
        cols={[t("admin.users.email"), t("admin.invites.workspace"), t("admin.invites.role"), t("admin.users.status"), t("admin.invites.expiresAt"), { label: "", right: true }]}
        empty={t("admin.invites.listEmpty")}
      >
        {invites.map((inv) => (
          <tr key={inv.id}>
            <td>{inv.email}</td>
            <td>{inv.serverName ?? ""}</td>
            <td>{t(inv.role === "admin" ? "admin.invites.roleAdmin" : "admin.invites.roleMember")}</td>
            <td><AdmPill tone={inv.status === "pending" ? "blue" : inv.status === "accepted" ? "green" : "neutral"}>{t(`admin.invites.status.${inv.status}`)}</AdmPill></td>
            <td>{new Date(inv.expiresAt).toLocaleDateString()}</td>
            <td style={{ textAlign: "right" }}>
              {inv.status === "pending" ? (
                <RowMenu ariaLabel={inv.email} items={[
                  { label: t("admin.menu.copyLink"), onClick: () => copy(linkOf(inv.token), inv.id) },
                  { label: t("admin.menu.revokeInvite"), danger: true, onClick: () => revoke(inv) },
                ]} />
              ) : "—"}
            </td>
          </tr>
        ))}
      </AdminTable>
    </div>
  );
}
