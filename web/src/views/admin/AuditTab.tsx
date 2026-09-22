// Audit tab of the system-admin console: the append-only system-plane trail (GET /api/admin/audit-logs),
// newest first, filterable by event, paginated with a createdAt cursor (`before=` = last row's ISO
// timestamp). Actor/target are user/server ids — the audit log is raw history, not a name directory.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdmPill } from "./AdmPill.tsx";
import { AdminTable } from "./AdminTable.tsx";
import type { AdminApi } from "../Admin.tsx";

// Mirrors src/server/audit.ts AuditEvent (11 events) — the select's options. Raw event identifiers
// are shown as-is (stable, greppable against the backend).
const EVENTS = [
  "user.registered", "user.login", "user.disabled", "user.enabled", "user.system_role_changed",
  "user.password_reset", "invite.created", "invite.accepted", "invite.revoked",
  "settings.open_registration_changed", "server.deleted",
] as const;

const shortId = (id?: string | null) => (id ? id.slice(0, 8) + "…" : "—");
const metaText = (m: unknown) => (m == null ? "" : JSON.stringify(m));

export function AuditTab({ api }: { api: AdminApi }) {
  const { t } = useTranslation();
  const [event, setEvent] = useState("");
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const PAGE = 50;
  const fetchPage = async (ev: string, before?: string) => {
    setLoading(true); setErr("");
    try {
      const r = await api("GET", `/api/admin/audit-logs?limit=${PAGE}${ev ? `&event=${encodeURIComponent(ev)}` : ""}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      if (r?.error) { setErr(r.error); if (!before) setLogs([]); return; }
      setLogs((prev) => before ? [...prev, ...(r?.logs ?? [])] : (r?.logs ?? []));
    } finally { setLoading(false); }
  };
  useEffect(() => { fetchPage(event); /* eslint-disable-next-line */ }, [event]);
  const loadMore = () => { const last = logs[logs.length - 1]; if (last?.createdAt) fetchPage(event, new Date(last.createdAt).toISOString()); };
  return (
    <div>
      <div className="adm-head">
        <h1>{t("admin.tab.audit")}</h1>
        <div className="acts">
          <select className="adm-input" aria-label={t("admin.audit.event")} value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="">{t("admin.audit.allEvents")}</option>
            {EVENTS.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
          </select>
        </div>
      </div>
      {err && <div className="form-err" style={{ marginBottom: 12 }}>{err}</div>}
      <AdminTable
        cols={[t("admin.audit.time"), t("admin.audit.event"), t("admin.audit.actor"), t("admin.audit.target"), t("admin.audit.metadata")]}
        empty={!loading && !err ? t("admin.audit.empty") : undefined}
      >
        {logs.map((l) => (
          <tr key={l.id}>
            <td style={{ whiteSpace: "nowrap" }}>{new Date(l.createdAt).toLocaleString()}</td>
            <td><AdmPill tone="neutral"><span className="adm-mono">{l.event}</span></AdmPill></td>
            <td title={l.actorUserId ?? ""}>{shortId(l.actorUserId)}</td>
            <td title={[l.targetUserId, l.targetServerId].filter(Boolean).join(" / ")}>
              {l.targetUserId || l.targetServerId ? <>{shortId(l.targetUserId)}{l.targetUserId && l.targetServerId ? " / " : ""}{shortId(l.targetServerId)}</> : "—"}
            </td>
            <td className="adm-mono" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }} title={metaText(l.metadata)}>{metaText(l.metadata) || "—"}</td>
          </tr>
        ))}
      </AdminTable>
      {logs.length > 0 && <button className="loadmore" disabled={loading} onClick={loadMore}>{t("admin.audit.loadMore")}</button>}
    </div>
  );
}
