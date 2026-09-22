// Invites tab of the system-admin console: create system invites (email + target workspace + role +
// expiry), share the /invite/<token> link, and revoke pending ones. Accepted/expired rows are
// history (server 409s revoking an accepted invite) and stay listed with their status.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm, useEscClose } from "../../ConfirmModal.tsx";
import { copyText } from "../../lib/clipboard.ts";
import type { AdminApi } from "../Admin.tsx";

const linkOf = (token: string) => `${location.origin}/invite/${token}`;

export function InvitesTab({ api }: { api: AdminApi }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [email, setEmail] = useState("");
  const [serverId, setServerId] = useState("");
  const [role, setRole] = useState("member");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState<string | null>(null); // full invite URL of the just-created link
  const [copied, setCopied] = useState(false);
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
    setBusy(true); setErr(""); setCopied(false);
    try {
      const r = await api("POST", "/api/admin/invites", { email: email.trim(), serverId, role, expiresInDays: days ? Number(days) : undefined });
      if (r?.error) { setErr(r.error); return; } // e.g. 409 a pending invite for this email already exists
      setCreated(`${location.origin}${r.url}`);
      setEmail("");
      await load();
    } finally { setBusy(false); }
  };
  const copy = async (link: string) => {
    if (await copyText(link)) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
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
      <div className="inv-new">
        <input type="email" placeholder={t("admin.invites.email")} value={email} onChange={(e) => setEmail(e.target.value)} style={{ minWidth: 200 }} />
        <select value={serverId} onChange={(e) => setServerId(e.target.value)}>
          {!servers.length && <option value="">{t("admin.invites.pickWorkspace")}</option>}
          {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">{t("admin.invites.roleMember")}</option>
          <option value="admin">{t("admin.invites.roleAdmin")}</option>
        </select>
        <input type="number" min="1" max="90" title={t("admin.invites.expires")} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 90 }} />
        <button className="ok" disabled={busy || !email.trim() || !serverId} onClick={create}>{busy ? t("admin.invites.creating") : t("admin.invites.create")}</button>
      </div>
      {err && <div className="form-err" style={{ marginBottom: 12 }}>{err}</div>}
      {created && <CreatedInviteModal link={created} copied={copied} onCopy={() => copy(created)} onClose={() => setCreated(null)} />}
      <div className="inv-list">
        {invites.length === 0 ? <div className="empty">{t("admin.invites.listEmpty")}</div> : invites.map((inv) => (
          <div className="inv-item" key={inv.id}>
            <div className="inv-meta">
              <span className="inv-role">{t(`admin.invites.status.${inv.status}`)}</span>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inv.email}</span>
              <span className="inv-uses">{inv.serverName ?? ""} · {inv.role} · {t("admin.invites.createdAt")} {new Date(inv.createdAt).toLocaleDateString()} · {t("admin.invites.expiresAt")} {new Date(inv.expiresAt).toLocaleDateString()}</span>
            </div>
            <div className="inv-acts">
              {inv.status === "pending" && <>
                <button className="joinbtn" onClick={() => copy(linkOf(inv.token))}>{copied ? t("admin.invites.copied") : t("admin.invites.copy")}</button>
                <button className="joinbtn" style={{ color: "var(--error)" }} onClick={() => revoke(inv)}>{t("admin.invites.revoke")}</button>
              </>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// The invite link is the only thing the admin needs to hand over — copy it before closing.
function CreatedInviteModal({ link, copied, onCopy, onClose }: { link: string; copied: boolean; onCopy: () => void; onClose: () => void }) {
  useEscClose(onClose);
  const { t } = useTranslation();
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("admin.invites.createdTitle")}</h3>
        <p className="modal-note">{t("admin.invites.createdNote")}</p>
        <label>{t("admin.invites.linkLabel")}</label>
        <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <div className="acts">
          <button className="cancel" onClick={onClose}>{t("confirm.cancel")}</button>
          <button className="ok" onClick={onCopy}>{copied ? t("admin.invites.copied") : t("admin.invites.copy")}</button>
        </div>
      </div>
    </div>
  );
}
